const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const geo = require('./lib/geo');

// Load local environment variables from .env if present
try {
    // eslint-disable-next-line global-require
    require('dotenv').config();
} catch (e) {
    // dotenv is optional; environment variables can be set by the host
}

const app = express();
const PORT = 3001;
const SECRET_KEY = 'bloodlink_secret_key_2025';
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============ DATABASE (persisted to data.json) ============
const users = {
    donors: [],
    receivers: [],
    hospitals: []
};

const bloodRequests = [];
const donations = [];
const notifications = [];
const chatThreads = [];
const smsLogs = [];
const bloodInventory = {
    'A+': 0, 'A-': 0, 'B+': 0, 'B-': 0,
    'O+': 0, 'O-': 0, 'AB+': 0, 'AB-': 0
};

const DONATION_COOLDOWN_DAYS = 56;
// Keep this SMS text short, plain English, and ASCII-only so it is not auto-localised.
const SMS_ALERT_TEXT = 'Urgent blood needed. Please open BloodLink chatbot and reply YES or NO to the hospital request.';

// ============ SMS (Twilio) ============
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';

function normalizePhoneToE164(phoneRaw) {
    const s = String(phoneRaw || '').trim();
    if (!s) return null;
    // Keep leading +, strip other non-digits.
    const cleaned = (s.startsWith('+') ? '+' : '') + s.replace(/[^\d]/g, '');
    if (cleaned.startsWith('+')) {
        // +<country><number>, 8..15 digits after +
        const digits = cleaned.slice(1);
        if (/^\d{8,15}$/.test(digits)) return `+${digits}`;
        return null;
    }
    // Default to India if user entered 10-digit mobile.
    if (/^\d{10}$/.test(cleaned)) return `+91${cleaned}`;
    // If they typed country code without + (e.g., 91xxxxxxxxxx)
    if (/^\d{11,15}$/.test(cleaned)) return `+${cleaned}`;
    return null;
}

function isTwilioConfigured() {
    return Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER);
}

function getTwilioClient() {
    // Lazy require so local dev doesn't crash if dependency missing.
    // If you enable Twilio, install it: npm i twilio
    // eslint-disable-next-line global-require
    const twilio = require('twilio');
    return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

function isDonorEligible(donor) {
    if (donor.isEligible === false) return false;
    if (!donor.lastDonationDate) return true;
    const daysSince = (Date.now() - new Date(donor.lastDonationDate).getTime()) / (1000 * 60 * 60 * 24);
    return daysSince >= DONATION_COOLDOWN_DAYS;
}

function findSuitableDonors(bloodType) {
    return users.donors.filter(d => d.bloodType === bloodType && isDonorEligible(d));
}

function findSuitableDonorsWithinKm(hospital, bloodType, radiusKm = geo.ALERT_RADIUS_KM) {
    const hCoords = geo.getHospitalCoords(hospital);
    return findSuitableDonors(bloodType)
        .map(donor => {
            const dCoords = geo.getDonorCoords(donor);
            if (!dCoords) return null;
            const distanceKm = geo.haversineKm(hCoords.lat, hCoords.lng, dCoords.lat, dCoords.lng);
            if (distanceKm > radiusKm) return null;
            return { donor, distanceKm: Math.round(distanceKm * 10) / 10 };
        })
        .filter(Boolean)
        .sort((a, b) => a.distanceKm - b.distanceKm);
}

async function sendSmsAlert(phone, donorId, requestId, hospitalId) {
    const e164 = normalizePhoneToE164(phone);
    const log = {
        id: uuidv4(),
        phone: (phone || '').trim(),
        e164,
        message: SMS_ALERT_TEXT,
        donorId,
        requestId,
        hospitalId,
        sentAt: new Date().toISOString(),
        status: 'pending'
    };
    smsLogs.push(log);
    saveData();

    if (!e164) {
        log.status = 'skipped_invalid_phone';
        saveData();
        console.log(`[SMS skipped] Invalid phone: "${log.phone}"`);
        return log;
    }

    if (!isTwilioConfigured()) {
        log.status = 'sent_simulated';
        saveData();
        console.log(`[SMS → ${e164}] ${SMS_ALERT_TEXT}`);
        return log;
    }

    try {
        const client = getTwilioClient();
        const msg = await client.messages.create({
            from: TWILIO_FROM_NUMBER,
            to: e164,
            body: SMS_ALERT_TEXT
        });
        log.status = 'sent';
        log.provider = 'twilio';
        log.providerMessageSid = msg.sid;
        saveData();
        console.log(`[SMS (Twilio) → ${e164}] sid=${msg.sid}`);
        return log;
    } catch (err) {
        log.status = 'failed';
        log.provider = 'twilio';
        log.error = String(err && err.message ? err.message : err);
        saveData();
        console.log(`[SMS failed → ${e164}] ${log.error}`);
        return log;
    }
}

function getOrCreateChatThread(request, hospital, donor) {
    let thread = chatThreads.find(t => t.requestId === request.id && t.donorId === donor.id);
    if (thread) return thread;
    thread = {
        id: uuidv4(),
        requestId: request.id,
        hospitalId: hospital.id,
        donorId: donor.id,
        hospitalName: hospital.name,
        donorName: donor.name,
        bloodType: request.bloodType,
        status: 'open',
        messages: [{
            id: uuidv4(),
            senderType: 'system',
            text: 'You are connected with the hospital. Reply here after the alert. If you agree to donate, the hospital will send meeting and donation process details.',
            createdAt: new Date().toISOString()
        }],
        createdAt: new Date().toISOString()
    };
    chatThreads.push(thread);
    return thread;
}

function addChatMessage(threadId, senderType, text, senderName) {
    const thread = chatThreads.find(t => t.id === threadId);
    if (!thread) return null;
    const msg = {
        id: uuidv4(),
        senderType,
        senderName: senderName || null,
        text,
        createdAt: new Date().toISOString()
    };
    thread.messages.push(msg);
    thread.updatedAt = msg.createdAt;
    return msg;
}

function donorHasAgreedToThread(thread) {
    if (thread.status === 'agreed') return true;
    return notifications.some(n =>
        n.donorResponse === 'yes' &&
        n.donorId === thread.donorId &&
        (n.chatThreadId === thread.id || n.requestId === thread.requestId)
    );
}

function openChatForDonorAgreement(request, hospital, donor, note) {
    const thread = getOrCreateChatThread(request, hospital, donor);
    thread.status = 'agreed';
    if (note) note.chatThreadId = thread.id;

    const alreadyNotified = thread.messages.some(m =>
        m.senderType === 'donor' && String(m.text).toLowerCase().includes('agreed')
    );
    if (!alreadyNotified) {
        addChatMessage(thread.id, 'donor', `${donor.name} agreed to come and donate.`, donor.name);
    }
    const hasSystemHint = thread.messages.some(m =>
        m.senderType === 'system' && String(m.text).includes('meeting point')
    );
    if (!hasSystemHint) {
        addChatMessage(
            thread.id,
            'system',
            'Chat is open. Hospital can now send meeting point and donation process details.',
            null
        );
    }
    return thread;
}

/** Repair chats when donor said YES but thread was missing from saved data. */
function syncChatThreadsFromNotifications() {
    let changed = false;
    for (const note of notifications) {
        if (note.donorResponse !== 'yes' || !note.requestId || !note.hospitalId) continue;
        const request = bloodRequests.find(r => r.id === note.requestId);
        const donor = users.donors.find(d => d.id === note.donorId);
        const hospital = users.hospitals.find(h => h.id === note.hospitalId);
        if (!request || !donor || !hospital) continue;

        const existing = chatThreads.find(t => t.requestId === request.id && t.donorId === donor.id);
        if (!existing || existing.status !== 'agreed') {
            openChatForDonorAgreement(request, hospital, donor, note);
            changed = true;
        } else if (!note.chatThreadId) {
            note.chatThreadId = existing.id;
            changed = true;
        }
    }
    if (changed) saveData();
}

function sanitizeDonor(donor) {
    const { password, ...safe } = donor;
    return { ...safe, eligible: isDonorEligible(donor) };
}

function buildChatbotMessage(hospital, request, donor) {
    const patient = request.patientName || 'Emergency patient';
    const reason = request.reason || 'Medical emergency';
    return (
        `Hello ${donor.name},\n\n` +
        `🩸 URGENT BLOOD REQUIRED\n\n` +
        `${hospital.name} urgently needs ${request.bloodType} blood.\n` +
        `Units required: ${request.units}\n` +
        `Patient: ${patient}\n` +
        `Urgency: ${request.urgency}\n` +
        `Reason: ${reason}\n\n` +
        `You are within 30 km of the hospital.\n` +
        `An SMS was sent to your registered mobile.\n\n` +
        `Can you donate? Reply YES to open chat with the hospital, or NO.\n\n` +
        `— BloodLink Chatbot (${hospital.name})`
    );
}

function normalizeEmail(email) {
    return (email || '').trim().toLowerCase();
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            users,
            bloodRequests,
            donations,
            notifications,
            chatThreads,
            smsLogs,
            bloodInventory
        }, null, 2));
    } catch (err) {
        console.error('Failed to save data:', err.message);
    }
}

function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) return;
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        users.donors = data.users?.donors || [];
        users.receivers = data.users?.receivers || [];
        users.hospitals = data.users?.hospitals || [];
        bloodRequests.length = 0;
        bloodRequests.push(...(data.bloodRequests || []));
        donations.length = 0;
        donations.push(...(data.donations || []));
        notifications.length = 0;
        notifications.push(...(data.notifications || []));
        chatThreads.length = 0;
        chatThreads.push(...(data.chatThreads || []));
        smsLogs.length = 0;
        smsLogs.push(...(data.smsLogs || []));
        if (data.bloodInventory) Object.assign(bloodInventory, data.bloodInventory);
        users.donors.forEach(d => { d.email = normalizeEmail(d.email); });
        users.receivers.forEach(r => { r.email = normalizeEmail(r.email); });
        users.hospitals.forEach(h => { h.email = normalizeEmail(h.email); });
        console.log('Loaded saved data from data.json');
        syncChatThreadsFromNotifications();
    } catch (err) {
        console.error('Could not load data.json:', err.message);
    }
}

loadData();

const HOSPITAL_CATALOG_FILE = path.join(__dirname, 'hospital-catalog.json');
const HOSPITAL_CATALOG_WB_FILE = path.join(__dirname, 'hospital-catalog-west-bengal.json');
let hospitalCatalog = [];
let hospitalCatalogWB = [];

function loadHospitalCatalog() {
    try {
        const list = JSON.parse(fs.readFileSync(HOSPITAL_CATALOG_FILE, 'utf8'));
        hospitalCatalog = list.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    } catch (err) {
        console.error('Could not load hospital catalog:', err.message);
        hospitalCatalog = [];
    }
    try {
        hospitalCatalogWB = JSON.parse(fs.readFileSync(HOSPITAL_CATALOG_WB_FILE, 'utf8'));
        hospitalCatalogWB.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        console.log(`Loaded ${hospitalCatalogWB.length} West Bengal hospitals`);
    } catch (err) {
        console.error('Could not load West Bengal hospital catalog:', err.message);
        hospitalCatalogWB = [];
    }
}

function getAllHospitalNameSuggestions() {
    const registered = users.hospitals.map(h => h.name.trim()).filter(Boolean);
    return [...new Set([...hospitalCatalogWB, ...hospitalCatalog, ...registered])].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
}

/** Smart match: ranks hospitals by how well they match typed text (best first, then A–Z). */
function scoreHospitalMatch(name, query) {
    if (!query) return 1;
    const n = name.toLowerCase();
    const q = query.toLowerCase().trim();
    const words = q.split(/\s+/).filter(Boolean);

    if (n === q) return 1000;
    if (n.startsWith(q)) return 950 - n.length * 0.01;

    let pos = 0;
    let ordered = true;
    for (const w of words) {
        const idx = n.indexOf(w, pos);
        if (idx === -1) { ordered = false; break; }
        pos = idx + w.length;
    }
    if (ordered && words.length) return 850 - pos * 0.1;

    if (n.includes(q)) return 750;

    const nameWords = n.split(/[\s,]+/);
    let wordHits = 0;
    for (const w of words) {
        if (nameWords.some(nw => nw.startsWith(w) || nw.includes(w))) wordHits++;
    }
    if (wordHits > 0) return 500 + wordHits * 80;

    let qi = 0;
    for (let i = 0; i < n.length && qi < q.length; i++) {
        if (n[i] === q[qi]) qi++;
    }
    if (qi === q.length) return 350 + (q.length / Math.max(n.length, 1)) * 50;

    let overlap = 0;
    for (const c of q) if (n.includes(c)) overlap++;
    return (overlap / q.length) * 120;
}

const CITY_SEARCH_KEYS = [
    'west bengal', 'kolkata', 'howrah', 'siliguri', 'durgapur', 'darjeeling', 'jalpaiguri',
    'coochbehar', 'malda', 'murshidabad', 'nadia', 'north 24 parganas', 'south 24 parganas',
    'hooghly', 'purba bardhaman', 'paschim bardhaman', 'birbhum', 'bankura', 'purulia',
    'alipurduar', 'jhargram', 'kalimpong', 'mumbai', 'delhi', 'bangalore', 'chennai', 'hyderabad'
];

function smartSearchHospitals(names, query, limit = 500) {
    const q = (query || '').trim().toLowerCase();
    const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    if (!q) return sorted;

    if (q.length === 1) {
        return sorted.filter(name => name.toLowerCase().charAt(0) === q);
    }

    if (q === 'west bengal') {
        return sorted.filter(name => name.toLowerCase().includes('west bengal'));
    }

    if (CITY_SEARCH_KEYS.includes(q)) {
        return sorted.filter(name => name.toLowerCase().includes(q));
    }

    return sorted
        .map(name => ({ name, score: scoreHospitalMatch(name, q) }))
        .filter(item => item.score >= 100)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .slice(0, limit)
        .map(item => item.name);
}

loadHospitalCatalog();

// Static catalogs for browser
app.get('/hospital-catalog.json', (req, res) => {
    res.sendFile(HOSPITAL_CATALOG_FILE);
});
app.get('/hospital-catalog-west-bengal.json', (req, res) => {
    res.sendFile(HOSPITAL_CATALOG_WB_FILE);
});
app.get('/api/hospitals/catalog-info', (req, res) => {
    res.json({
        westBengal: hospitalCatalogWB.length,
        india: hospitalCatalog.length,
        total: getAllHospitalNameSuggestions().length,
        source: 'West Bengal list from Swasthya Sathi empanelled hospitals + major India hospitals'
    });
});

// ============ AUTH MIDDLEWARE ============
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Access denied' });
    }
    
    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
}

// ============ DONOR ROUTES ============

// Donor Registration
app.post('/api/donor/register', async (req, res) => {
    const { name, email, phone, bloodType, password, age, weight, lastDonationDate } = req.body;
    const normalizedEmail = normalizeEmail(email);
    const cleanPassword = (password || '').trim();
    const phoneTrim = (phone || '').trim();

    if (!normalizedEmail || !cleanPassword) {
        return res.status(400).json({ error: 'Email and password are required' });
    }
    if (!bloodType) {
        return res.status(400).json({ error: 'Please select a blood type' });
    }
    if (!phoneTrim) {
        return res.status(400).json({ error: 'Phone number is required to receive SMS alerts' });
    }

    if (users.donors.find(d => d.email === normalizedEmail)) {
        return res.status(400).json({ error: 'Email already registered' });
    }
    
    const hashedPassword = await bcrypt.hash(cleanPassword, 10);
    const lat = parseFloat(req.body.latitude);
    const lng = parseFloat(req.body.longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
        return res.status(400).json({ error: 'Location required. Enable GPS on registration (within 30 km alerts).' });
    }

    const donor = {
        id: uuidv4(),
        name: (name || '').trim(),
        email: normalizedEmail,
        phone: phoneTrim,
        address: (req.body.address || '').trim(),
        bloodType,
        password: hashedPassword,
        age,
        weight,
        latitude: lat,
        longitude: lng,
        lastDonationDate: lastDonationDate || null,
        totalDonations: 0,
        isEligible: true,
        createdAt: new Date().toISOString()
    };
    
    users.donors.push(donor);
    saveData();
    
    const token = jwt.sign({ id: donor.id, type: 'donor', email: donor.email }, SECRET_KEY);
    res.json({ success: true, token, donor: { id: donor.id, name: donor.name, email: donor.email, bloodType: donor.bloodType } });
});

// Donor Login
app.post('/api/donor/login', async (req, res) => {
    const normalizedEmail = normalizeEmail(req.body.email);
    const cleanPassword = (req.body.password || '').trim();
    const donor = users.donors.find(d => d.email === normalizedEmail);
    
    if (!donor) {
        return res.status(400).json({ error: 'Invalid email or password' });
    }
    
    const validPassword = await bcrypt.compare(cleanPassword, donor.password);
    if (!validPassword) {
        return res.status(400).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ id: donor.id, type: 'donor', email: donor.email }, SECRET_KEY);
    res.json({ success: true, token, donor: { id: donor.id, name: donor.name, email: donor.email, bloodType: donor.bloodType } });
});

// Get donor dashboard
app.get('/api/donor/dashboard', authenticateToken, (req, res) => {
    if (req.user.type !== 'donor') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    const donor = users.donors.find(d => d.id === req.user.id);
    if (!donor) {
        return res.status(401).json({ error: 'Account not found. Please log out and register again.' });
    }
    const nearbyRequests = bloodRequests.filter(r => r.status === 'active' && r.bloodType === donor.bloodType);
    const donorDonations = donations.filter(d => d.donorId === donor.id);
    const { password, ...donorSafe } = donor;
    
    const donorNotifications = notifications
        .filter(n => n.donorId === donor.id)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const donorChats = chatThreads
        .filter(t => t.donorId === donor.id)
        .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

    res.json({
        donor: donorSafe,
        nearbyRequests,
        donationHistory: donorDonations,
        chatbotMessages: donorNotifications,
        hospitalChats: donorChats,
        stats: {
            totalDonations: donor.totalDonations,
            nextEligibleDate: donor.lastDonationDate ? new Date(new Date(donor.lastDonationDate).getTime() + 56*24*60*60*1000) : null,
            requestsNearby: nearbyRequests.length,
            unreadAlerts: donorNotifications.filter(n => !n.read).length
        }
    });
});

// Donor responds to chatbot alert
app.post('/api/donor/notifications/:id/respond', authenticateToken, (req, res) => {
    if (req.user.type !== 'donor') {
        return res.status(403).json({ error: 'Access denied' });
    }
    const note = notifications.find(n => n.id === req.params.id && n.donorId === req.user.id);
    if (!note) {
        return res.status(404).json({ error: 'Message not found' });
    }
    const response = (req.body.response || '').toLowerCase();
    if (response !== 'yes' && response !== 'no') {
        return res.status(400).json({ error: 'Reply YES or NO' });
    }
    note.read = true;
    note.respondedAt = new Date().toISOString();
    note.donorResponse = response;

    let chatThreadId = note.chatThreadId;

    if (response === 'yes' && note.requestId) {
        const request = bloodRequests.find(r => r.id === note.requestId);
        const donor = users.donors.find(d => d.id === req.user.id);
        const hospital = users.hospitals.find(h => h.id === note.hospitalId);
        if (request && donor && hospital) {
            request.donors = request.donors || [];
            if (!request.donors.some(d => d.donorId === donor.id)) {
                request.donors.push({
                    donorId: donor.id,
                    donorName: donor.name,
                    donorBlood: donor.bloodType,
                    donorPhone: donor.phone,
                    committedAt: new Date().toISOString(),
                    viaChatbot: true
                });
            }
            const thread = openChatForDonorAgreement(request, hospital, donor, note);
            chatThreadId = thread.id;
        }
    }
    saveData();
    res.json({
        success: true,
        chatThreadId,
        message: response === 'yes'
            ? 'Thank you! Chat with the hospital is open below. They will send further instructions.'
            : 'Thank you for letting us know. Stay safe!'
    });
});

// Donor chat: list / send message
app.get('/api/donor/chats/:threadId', authenticateToken, (req, res) => {
    if (req.user.type !== 'donor') return res.status(403).json({ error: 'Access denied' });
    const thread = chatThreads.find(t => t.id === req.params.threadId && t.donorId === req.user.id);
    if (!thread) return res.status(404).json({ error: 'Chat not found' });
    res.json({ thread });
});

app.post('/api/donor/chats/:threadId/message', authenticateToken, (req, res) => {
    if (req.user.type !== 'donor') return res.status(403).json({ error: 'Access denied' });
    const thread = chatThreads.find(t => t.id === req.params.threadId && t.donorId === req.user.id);
    if (!thread) return res.status(404).json({ error: 'Chat not found' });
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Message required' });
    const donor = users.donors.find(d => d.id === req.user.id);
    addChatMessage(thread.id, 'donor', text, donor.name);
    saveData();
    res.json({ success: true, thread });
});

// Donor commits to donate
app.post('/api/donor/commit/:requestId', authenticateToken, (req, res) => {
    if (req.user.type !== 'donor') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    const request = bloodRequests.find(r => r.id === req.params.requestId);
    if (!request) {
        return res.status(404).json({ error: 'Request not found' });
    }
    
    const donor = users.donors.find(d => d.id === req.user.id);
    if (!donor) {
        return res.status(401).json({ error: 'Account not found. Please log out and register again.' });
    }

    request.donors = request.donors || [];
    if (request.donors.some(d => d.donorId === donor.id)) {
        return res.status(400).json({ error: 'You already committed to this request' });
    }
    
    const commitment = {
        donorId: donor.id,
        donorName: donor.name,
        donorBlood: donor.bloodType,
        donorPhone: donor.phone,
        committedAt: new Date().toISOString()
    };
    
    request.donors.push(commitment);
    saveData();
    
    res.json({ success: true, message: 'You have committed to donate', request });
});

// ============ RECEIVER ROUTES ============

// Receiver Registration
app.post('/api/receiver/register', async (req, res) => {
    const { name, email, phone, password, address } = req.body;
    
    if (users.receivers.find(r => r.email === email)) {
        return res.status(400).json({ error: 'Email already registered' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const receiver = {
        id: uuidv4(),
        name,
        email,
        phone,
        password: hashedPassword,
        address,
        createdAt: new Date().toISOString()
    };
    
    users.receivers.push(receiver);
    saveData();
    
    const token = jwt.sign({ id: receiver.id, type: 'receiver', email: receiver.email }, SECRET_KEY);
    res.json({ success: true, token, receiver: { id: receiver.id, name: receiver.name, email: receiver.email } });
});

// Receiver Login
app.post('/api/receiver/login', async (req, res) => {
    const { email, password } = req.body;
    const receiver = users.receivers.find(r => r.email === email);
    
    if (!receiver) {
        return res.status(400).json({ error: 'Invalid credentials' });
    }
    
    const validPassword = await bcrypt.compare(password, receiver.password);
    if (!validPassword) {
        return res.status(400).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ id: receiver.id, type: 'receiver', email: receiver.email }, SECRET_KEY);
    res.json({ success: true, token, receiver: { id: receiver.id, name: receiver.name, email: receiver.email } });
});

// Create blood request
app.post('/api/receiver/request-blood', authenticateToken, (req, res) => {
    if (req.user.type !== 'receiver') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    const { bloodType, units, hospital, reason, urgency, dateNeeded } = req.body;
    const receiver = users.receivers.find(r => r.id === req.user.id);
    
    const request = {
        id: uuidv4(),
        receiverId: receiver.id,
        receiverName: receiver.name,
        bloodType,
        units: parseInt(units),
        hospital,
        reason,
        urgency: urgency || 'normal',
        dateNeeded: dateNeeded || new Date().toISOString(),
        status: 'active',
        donors: [],
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000) // 48 hours
    };
    
    bloodRequests.push(request);
    saveData();
    
    res.json({ success: true, request });
});

// Get receiver dashboard
app.get('/api/receiver/dashboard', authenticateToken, (req, res) => {
    if (req.user.type !== 'receiver') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    const receiverRequests = bloodRequests.filter(r => r.receiverId === req.user.id);
    
    res.json({
        requests: receiverRequests,
        stats: {
            totalRequests: receiverRequests.length,
            activeRequests: receiverRequests.filter(r => r.status === 'active').length,
            fulfilledRequests: receiverRequests.filter(r => r.status === 'fulfilled').length
        }
    });
});

// ============ HOSPITAL/BLOOD BANK ROUTES ============

// Which hospital names are already registered (for autocomplete UI)
app.get('/api/hospitals/registered', (req, res) => {
    res.json({
        names: users.hospitals.map(h => h.name.trim()).filter(Boolean)
    });
});

// Smart hospital search (best match first, then alphabetical)
app.get('/api/hospitals/suggestions', (req, res) => {
    const q = (req.query.q || '').trim();
    const registeredLower = new Set(users.hospitals.map(h => h.name.trim().toLowerCase()));
    const all = getAllHospitalNameSuggestions();
    const list = smartSearchHospitals(all, q, 500);

    res.json({
        hospitals: list.map(name => ({
            name,
            alreadyRegistered: registeredLower.has(name.toLowerCase())
        }))
    });
});

// Hospital Registration
app.post('/api/hospital/register', async (req, res) => {
    const { name, email, phone, password, address, licenseNumber } = req.body;
    const hospitalName = (name || '').trim();
    const normalizedEmail = normalizeEmail(email);
    const cleanPassword = (password || '').trim();

    if (!hospitalName) {
        return res.status(400).json({ error: 'Please select a hospital name from the list' });
    }
    if (!normalizedEmail || !cleanPassword) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    const allowedNames = getAllHospitalNameSuggestions();
    const nameMatch = allowedNames.find(n => n.toLowerCase() === hospitalName.toLowerCase());
    if (!nameMatch) {
        return res.status(400).json({ error: 'Please select a valid hospital name from the suggestions' });
    }

    if (users.hospitals.find(h => h.name.toLowerCase() === hospitalName.toLowerCase())) {
        return res.status(400).json({ error: 'This hospital is already registered. Please log in instead.' });
    }
    if (users.hospitals.find(h => h.email === normalizedEmail)) {
        return res.status(400).json({ error: 'Email already registered' });
    }
    
    const hashedPassword = await bcrypt.hash(cleanPassword, 10);
    let lat = parseFloat(req.body.latitude);
    let lng = parseFloat(req.body.longitude);
    const fallback = geo.coordsFromHospitalName(nameMatch);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
        lat = fallback.lat;
        lng = fallback.lng;
    }

    const hospital = {
        id: uuidv4(),
        name: nameMatch,
        email: normalizedEmail,
        phone: (phone || '').trim(),
        password: hashedPassword,
        address: (address || '').trim(),
        licenseNumber: (licenseNumber || '').trim(),
        latitude: lat,
        longitude: lng,
        verified: true,
        createdAt: new Date().toISOString()
    };
    
    users.hospitals.push(hospital);
    saveData();
    
    const token = jwt.sign({ id: hospital.id, type: 'hospital', email: hospital.email }, SECRET_KEY);
    res.json({ success: true, token, hospital: { id: hospital.id, name: hospital.name, email: hospital.email } });
});

// Hospital Login
app.post('/api/hospital/login', async (req, res) => {
    const normalizedEmail = normalizeEmail(req.body.email);
    const cleanPassword = (req.body.password || '').trim();
    const hospital = users.hospitals.find(h => h.email === normalizedEmail);
    
    if (!hospital) {
        return res.status(400).json({ error: 'Invalid credentials' });
    }
    
    const validPassword = await bcrypt.compare(cleanPassword, hospital.password);
    if (!validPassword) {
        return res.status(400).json({ error: 'Invalid email or password' });
    }
    
    const token = jwt.sign({ id: hospital.id, type: 'hospital', email: hospital.email }, SECRET_KEY);
    res.json({ success: true, token, hospital: { id: hospital.id, name: hospital.name, email: hospital.email } });
});

// Get hospital dashboard
app.get('/api/hospital/dashboard', authenticateToken, (req, res) => {
    if (req.user.type !== 'hospital') {
        return res.status(403).json({ error: 'Access denied' });
    }

    const hospital = users.hospitals.find(h => h.id === req.user.id);
    const myRequests = bloodRequests.filter(r => r.hospitalId === req.user.id);
    const pendingRequests = myRequests.filter(r => r.status === 'active');
    const completedDonations = donations.filter(d => d.hospitalId === req.user.id && d.status === 'completed');
    const chatbotLog = notifications
        .filter(n => n.hospitalId === req.user.id)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 50);

    syncChatThreadsFromNotifications();

    const hospitalChats = chatThreads
        .filter(t => t.hospitalId === req.user.id)
        .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
        .map(t => ({
            ...t,
            donorAgreed: donorHasAgreedToThread(t)
        }));

    const hCoords = geo.getHospitalCoords(hospital);
    const donorDatabase = users.donors.map(d => {
        const safe = sanitizeDonor(d);
        const dCoords = geo.getDonorCoords(d);
        if (dCoords) {
            safe.distanceKm = Math.round(geo.haversineKm(hCoords.lat, hCoords.lng, dCoords.lat, dCoords.lng) * 10) / 10;
            safe.within30km = safe.distanceKm <= geo.ALERT_RADIUS_KM;
        } else {
            safe.distanceKm = null;
            safe.within30km = false;
        }
        return safe;
    });

    res.json({
        hospital: { id: hospital.id, name: hospital.name, address: hospital.address, latitude: hospital.latitude, longitude: hospital.longitude },
        inventory: bloodInventory,
        pendingRequests,
        donorDatabase,
        chatbotLog,
        hospitalChats,
        alertRadiusKm: geo.ALERT_RADIUS_KM,
        stats: {
            totalDonors: users.donors.length,
            eligibleDonors: users.donors.filter(isDonorEligible).length,
            totalRequests: myRequests.length,
            pendingRequests: pendingRequests.length,
            totalDonations: completedDonations.length,
            alertsSent: notifications.filter(n => n.hospitalId === req.user.id).length,
            bloodUnitsAvailable: Object.values(bloodInventory).reduce((a, b) => a + b, 0)
        },
        recentActivities: donations.filter(d => d.hospitalId === req.user.id).slice(-10)
    });
});

// Search suitable donors in hospital database
app.get('/api/hospital/donors/search', authenticateToken, (req, res) => {
    if (req.user.type !== 'hospital') {
        return res.status(403).json({ error: 'Access denied' });
    }
    const bloodType = req.query.bloodType;
    if (!bloodType) {
        return res.status(400).json({ error: 'bloodType query is required' });
    }
    const hospital = users.hospitals.find(h => h.id === req.user.id);
    const nearby = findSuitableDonorsWithinKm(hospital, bloodType).map(({ donor, distanceKm }) => ({
        ...sanitizeDonor(donor),
        distanceKm
    }));
    const suitable = findSuitableDonors(bloodType).map(sanitizeDonor);
    res.json({
        bloodType,
        alertRadiusKm: geo.ALERT_RADIUS_KM,
        nearbyCount: nearby.length,
        suitableCount: suitable.length,
        suitableDonors: nearby,
        allEligible: suitable
    });
});

// Hospital creates blood requirement (central control)
app.post('/api/hospital/blood-request', authenticateToken, (req, res) => {
    if (req.user.type !== 'hospital') {
        return res.status(403).json({ error: 'Access denied' });
    }
    const hospital = users.hospitals.find(h => h.id === req.user.id);
    const { bloodType, units, patientName, reason, urgency } = req.body;

    if (!bloodType || !units) {
        return res.status(400).json({ error: 'Blood type and units are required' });
    }

    const request = {
        id: uuidv4(),
        hospitalId: hospital.id,
        hospitalName: hospital.name,
        hospital: hospital.name,
        patientName: (patientName || '').trim() || 'Emergency patient',
        bloodType,
        units: parseInt(units, 10),
        reason: (reason || '').trim() || 'Medical emergency',
        urgency: urgency || 'high',
        status: 'active',
        createdBy: 'hospital',
        donors: [],
        notifiedDonors: [],
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    };

    bloodRequests.push(request);
    saveData();
    const nearby = findSuitableDonorsWithinKm(hospital, bloodType);
    res.json({
        success: true,
        request,
        suitableDonors: findSuitableDonors(bloodType).length,
        nearbyDonorsWithin30km: nearby.length
    });
});

// Hospital sends chatbot + SMS to eligible donors within 30 km only
app.post('/api/hospital/requests/:id/notify-donors', authenticateToken, (req, res) => {
    if (req.user.type !== 'hospital') {
        return res.status(403).json({ error: 'Access denied' });
    }
    const hospital = users.hospitals.find(h => h.id === req.user.id);
    const request = bloodRequests.find(r => r.id === req.params.id && r.hospitalId === req.user.id);

    if (!request) {
        return res.status(404).json({ error: 'Blood request not found' });
    }
    if (request.status !== 'active') {
        return res.status(400).json({ error: 'Request is no longer active' });
    }

    const nearby = findSuitableDonorsWithinKm(hospital, request.bloodType);
    if (nearby.length === 0) {
        const eligible = findSuitableDonors(request.bloodType).length;
        const withGps = users.donors.filter(d => d.bloodType === request.bloodType && geo.getDonorCoords(d)).length;
        return res.status(400).json({
            error: `No eligible ${request.bloodType} donors within ${geo.ALERT_RADIUS_KM} km. ` +
                `Eligible in database: ${eligible}, with GPS: ${withGps}. Donors must register with location enabled.`
        });
    }

    request.notifiedDonors = request.notifiedDonors || [];

    (async () => {
        const sent = [];
        for (const { donor, distanceKm } of nearby) {
            const thread = getOrCreateChatThread(request, hospital, donor);
            const message = buildChatbotMessage(hospital, request, donor);
            const smsLog = await sendSmsAlert(donor.phone, donor.id, request.id, hospital.id);

            const note = {
                id: uuidv4(),
                donorId: donor.id,
                donorName: donor.name,
                donorPhone: donor.phone,
                hospitalId: hospital.id,
                hospitalName: hospital.name,
                requestId: request.id,
                chatThreadId: thread.id,
                bloodType: request.bloodType,
                channel: 'chatbot',
                distanceKm,
                smsSent: smsLog && (smsLog.status === 'sent' || smsLog.status === 'sent_simulated'),
                smsStatus: smsLog ? smsLog.status : 'unknown',
                smsE164: smsLog ? smsLog.e164 : null,
                message,
                read: false,
                donorResponse: null,
                createdAt: new Date().toISOString()
            };
            notifications.push(note);
            addChatMessage(thread.id, 'hospital', message, hospital.name);

            if (!request.notifiedDonors.includes(donor.id)) {
                request.notifiedDonors.push(donor.id);
            }
            sent.push({
                donorId: donor.id,
                name: donor.name,
                phone: donor.phone,
                distanceKm,
                chatThreadId: thread.id,
                smsStatus: note.smsStatus,
                smsE164: note.smsE164
            });
        }

        request.lastNotifiedAt = new Date().toISOString();
        saveData();

        res.json({
            success: true,
            message: `Alerts sent to ${sent.length} donor(s) within ${geo.ALERT_RADIUS_KM} km (chatbot + SMS)`,
            sentCount: sent.length,
            radiusKm: geo.ALERT_RADIUS_KM,
            donors: sent,
            smsText: SMS_ALERT_TEXT,
            smsProvider: isTwilioConfigured() ? 'twilio' : 'simulated',
            preview: buildChatbotMessage(hospital, request, nearby[0].donor)
        });
    })().catch((err) => {
        console.error('notify-donors failed', err);
        res.status(500).json({ error: 'Failed to send donor alerts' });
    });
});

// Hospital chat with alerted donors
app.get('/api/hospital/chats/:threadId', authenticateToken, (req, res) => {
    if (req.user.type !== 'hospital') return res.status(403).json({ error: 'Access denied' });
    const thread = chatThreads.find(t => t.id === req.params.threadId && t.hospitalId === req.user.id);
    if (!thread) return res.status(404).json({ error: 'Chat not found' });
    res.json({ thread });
});

app.post('/api/hospital/chats/:threadId/message', authenticateToken, (req, res) => {
    if (req.user.type !== 'hospital') return res.status(403).json({ error: 'Access denied' });
    const thread = chatThreads.find(t => t.id === req.params.threadId && t.hospitalId === req.user.id);
    if (!thread) return res.status(404).json({ error: 'Chat not found' });
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Message required' });
    const hospital = users.hospitals.find(h => h.id === req.user.id);
    addChatMessage(thread.id, 'hospital', text, hospital.name);
    saveData();
    res.json({ success: true, thread });
});

app.post('/api/hospital/chats/:threadId/donation-info', authenticateToken, (req, res) => {
    if (req.user.type !== 'hospital') return res.status(403).json({ error: 'Access denied' });
    const thread = chatThreads.find(t => t.id === req.params.threadId && t.hospitalId === req.user.id);
    if (!thread) return res.status(404).json({ error: 'Chat not found' });
    if (!donorHasAgreedToThread(thread)) {
        return res.status(400).json({ error: 'Donor has not agreed yet. Wait for YES on the alert.' });
    }
    thread.status = 'agreed';
    const hospital = users.hospitals.find(h => h.id === req.user.id);
    const meetingTime = (req.body.meetingTime || 'As soon as possible').trim();
    const meetingPoint = (req.body.meetingPoint || hospital.address || 'Hospital reception').trim();
    const processInfo = (req.body.processInfo || 'Bring ID, eat light meal, rest 15 min after donation.').trim();

    const text =
        `✅ DONATION DETAILS — ${hospital.name}\n\n` +
        `Meeting: ${meetingPoint}\n` +
        `Time: ${meetingTime}\n\n` +
        `Process:\n${processInfo}\n\n` +
        `Contact hospital phone: ${hospital.phone || 'See reception'}`;

    addChatMessage(thread.id, 'hospital', text, hospital.name);
    saveData();
    res.json({ success: true, message: 'Donation instructions sent to donor', thread });
});

// Update blood inventory
app.post('/api/hospital/inventory/update', authenticateToken, (req, res) => {
    if (req.user.type !== 'hospital') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    const { bloodType, quantity, operation } = req.body;
    
    if (operation === 'add') {
        bloodInventory[bloodType] += parseInt(quantity);
    } else if (operation === 'remove') {
        bloodInventory[bloodType] = Math.max(0, bloodInventory[bloodType] - parseInt(quantity));
    }
    
    saveData();
    res.json({ success: true, inventory: bloodInventory });
});

// Verify and complete donation
app.post('/api/hospital/verify-donation', authenticateToken, (req, res) => {
    if (req.user.type !== 'hospital') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    const { requestId, donorId } = req.body;
    
    const request = bloodRequests.find(r => r.id === requestId);
    if (request) {
        const donorCommitment = request.donors.find(d => d.donorId === donorId);
        if (donorCommitment) {
            const donation = {
                id: uuidv4(),
                requestId,
                donorId,
                donorName: donorCommitment.donorName,
                bloodType: request.bloodType,
                hospitalId: req.user.id,
                verifiedAt: new Date().toISOString(),
                status: 'completed'
            };
            
            donations.push(donation);
            
            // Update donor stats
            const donor = users.donors.find(d => d.id === donorId);
            if (donor) {
                donor.totalDonations += 1;
                donor.lastDonationDate = new Date().toISOString();
            }
            
            // Update inventory
            bloodInventory[request.bloodType] += 1;
            
            // Check if request is fulfilled
            if (request.donors.length >= request.units) {
                request.status = 'fulfilled';
            }
            
            saveData();
            return res.json({ success: true, message: 'Donation verified and added to inventory' });
        }
    }
    
    res.status(404).json({ error: 'Request or donor not found' });
});

// ============ PUBLIC ROUTES ============

// Get all active requests (public)
app.get('/api/requests/active', (req, res) => {
    const active = bloodRequests.filter(r => r.status === 'active');
    res.json(active);
});

// Get single request (public share link)
app.get('/api/request/:id', (req, res) => {
    const request = bloodRequests.find(r => r.id === req.params.id);
    if (!request || request.status !== 'active') {
        return res.status(404).json({ error: 'Request not found or no longer active' });
    }
    res.json({
        ...request,
        donors: request.donors || [],
        expiresAt: new Date(request.expiresAt).getTime()
    });
});

// Anonymous donor commit via share link
app.post('/api/request/:id/commit', (req, res) => {
    const request = bloodRequests.find(r => r.id === req.params.id);
    if (!request) {
        return res.status(404).json({ error: 'Request not found' });
    }
    if (request.status !== 'active') {
        return res.status(400).json({ error: 'Request is not active' });
    }
    const { donorName, donorBlood, donorPhone } = req.body;
    request.donors = request.donors || [];
    request.donors.push({
        donorName: donorName || 'Anonymous',
        donorBlood: donorBlood || request.bloodType,
        donorPhone: donorPhone,
        committedAt: new Date().toISOString()
    });
    saveData();
    res.json({ success: true, hospital: request.hospital });
});

// Public emergency request page
app.get('/request/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'request.html'));
});

// Serve HTML pages
app.get('/portal/:type/:page', (req, res) => {
    let page = req.params.page;
    if (page.endsWith('.html')) page = page.slice(0, -5);
    res.sendFile(path.join(__dirname, 'public', req.params.type, page + '.html'));
});

app.get('/portal/:type', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', req.params.type, 'login.html'));
});

// Start server
app.listen(PORT, () => {
    console.log('\n========================================');
    console.log('🩸 BLOODLINK SYSTEM RUNNING');
    console.log('========================================');
    console.log(`🌐 http://localhost:${PORT}`);
    console.log('\n📋 PORTALS:');
    console.log(`   Donor:     http://localhost:${PORT}/portal/donor`);
    console.log(`   Receiver:  http://localhost:${PORT}/portal/receiver`);
    console.log(`   Hospital:  http://localhost:${PORT}/portal/hospital`);
    console.log('========================================\n');
});