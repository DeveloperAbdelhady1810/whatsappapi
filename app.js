const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const mime = require('mime-types');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

// ---------------------------------------------------------------------------
// Config (env vars, with defaults that preserve original local behavior)
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const COUNTRY_CODE = process.env.COUNTRY_CODE !== undefined ? process.env.COUNTRY_CODE : '2';
const SESSIONS_ROOT = process.env.SESSIONS_ROOT || './.sessions';
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS, 10) || 5;
const SENDER_ID_RE = /^[a-zA-Z0-9_-]{1,50}$/;

if (!API_KEY) {
    console.warn('WARNING: API_KEY is not set. All endpoints are UNPROTECTED. Set API_KEY in your environment.');
}

if (!fs.existsSync(SESSIONS_ROOT)) fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

// ---------------------------------------------------------------------------
// Logging (file + in-memory ring buffer for /logs)
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const LOG_BUFFER_MAX = 200;
const logBuffer = [];

function logMessage(entry) {
    const record = { timestamp: new Date().toISOString(), ...entry };

    logBuffer.unshift(record);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.length = LOG_BUFFER_MAX;

    const logFile = path.join(LOG_DIR, `messages-${record.timestamp.slice(0, 10)}.log`);
    fs.appendFile(logFile, JSON.stringify(record) + '\n', (err) => {
        if (err) console.error('Failed to write log file:', err);
    });

    const tag = record.status === 'success' ? 'SUCCESS' : 'FAILED';
    console.log(`[${tag}] [${record.sender}] ${record.type} -> ${record.phone}${record.error ? ' | ' + record.error : ''}`);
}

// ---------------------------------------------------------------------------
// Multi-session WhatsApp client manager (Baileys — pure Node.js WebSocket
// implementation, no browser). Each "sender" is an independently connected
// WhatsApp number with its own auth folder under SESSIONS_ROOT/<sender>.
// ---------------------------------------------------------------------------
let DisconnectReason;
let baileysLib = null; // lazy-loaded once, shared across all sessions

async function loadBaileys() {
    if (baileysLib) return baileysLib;
    // @whiskeysockets/baileys is a pure ESM package (no CommonJS build), so it
    // must be loaded via dynamic import() rather than require() — require()
    // only transparently handles ESM on newer Node versions (22+), and fails
    // with ERR_REQUIRE_ESM on older ones (e.g. Node 20, as seen on Hostinger).
    baileysLib = await import('@whiskeysockets/baileys');
    DisconnectReason = baileysLib.DisconnectReason;
    return baileysLib;
}

// sender -> { sender, state, latestQr, meInfo, sock, startedAt, authPath }
const sessions = new Map();

function sessionSummary(session) {
    return {
        sender: session.sender,
        state: session.state,
        me: session.meInfo,
        uptimeSeconds: Math.floor((Date.now() - session.startedAt) / 1000),
    };
}

async function startSock(session) {
    const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = await loadBaileys();

    const { state: authState, saveCreds } = await useMultiFileAuthState(session.authPath);
    // WhatsApp rejects connections using a stale protocol version (405 Method Not
    // Allowed), so always fetch the current one instead of relying on the
    // library's baked-in default.
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: authState,
        version,
        logger: pino({ level: 'warn' }),
        // Required as of Baileys 7.x for reliable message retries/quoted-message
        // resolution. This app doesn't keep a message store, so there's nothing
        // to return, but the callback must exist.
        getMessage: async () => undefined,
    });
    session.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            session.state = 'qr';
            session.latestQr = qr;
            console.log(`[${session.sender}] QR RECEIVED - visit /qr?sender=${session.sender} to scan`);
        }

        if (connection === 'open') {
            session.state = 'ready';
            session.latestQr = null;
            session.meInfo = sock.user && sock.user.id ? sock.user.id.split(':')[0].split('@')[0] : null;
            console.log(`[${session.sender}] Client is ready!`);
        }

        if (connection === 'close') {
            if (session.loggingOut) return; // logout path already tore this session down
            session.state = 'disconnected';
            const statusCode = lastDisconnect && lastDisconnect.error
                ? new Boom(lastDisconnect.error).output.statusCode
                : undefined;
            console.error(`[${session.sender}] Connection closed. Status code:`, statusCode, '| Error:', lastDisconnect && lastDisconnect.error);

            if (statusCode !== DisconnectReason.loggedOut) {
                startSock(session).catch((err) => console.error(`[${session.sender}] FATAL: reconnect failed:`, err && err.stack ? err.stack : err));
            } else {
                console.error(`[${session.sender}] Logged out. Call /sessions/logout?sender=${session.sender} then /sessions/create again to re-scan.`);
            }
        }
    });
}

async function createSession(sender) {
    const session = {
        sender,
        state: 'initializing',
        latestQr: null,
        meInfo: null,
        sock: null,
        startedAt: Date.now(),
        authPath: path.join(SESSIONS_ROOT, sender),
        loggingOut: false,
    };
    sessions.set(sender, session);
    try {
        await startSock(session);
    } catch (err) {
        session.state = 'disconnected';
        console.error(`[${sender}] FATAL: session initialization failed:`, err && err.stack ? err.stack : err);
    }
    return session;
}

async function logoutSession(session) {
    session.loggingOut = true;
    try {
        if (session.sock) {
            await session.sock.logout().catch(() => {});
        }
    } finally {
        sessions.delete(session.sender);
        fs.rmSync(session.authPath, { recursive: true, force: true });
    }
}

// Restore any sessions that already had an auth folder on disk (e.g. after a
// process restart), so existing connections don't require a fresh QR scan.
for (const entry of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (entry.isDirectory() && SENDER_ID_RE.test(entry.name)) {
        createSession(entry.name).catch((err) => console.error(`[${entry.name}] restore failed:`, err));
    }
}

process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION:', err && err.stack ? err.stack : err);
});

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err && err.stack ? err.stack : err);
});

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

function requireApiKey(req, res, next) {
    if (!API_KEY) return next(); // no key configured -> open (warned above)
    const provided = req.get('x-api-key') || req.query.key;
    if (provided !== API_KEY) {
        return res.status(401).send('Unauthorized');
    }
    next();
}

function buildJid(phone) {
    return `${COUNTRY_CODE}${phone}@s.whatsapp.net`;
}

// Resolves req.query.sender to a ready session, or writes an error response
// and returns null. Shared by every /send* endpoint.
function resolveReadySession(req, res) {
    const sender = req.query.sender;
    if (!sender) {
        res.status(400).send('sender is required (the session label chosen when it was created)');
        return null;
    }
    const session = sessions.get(sender);
    if (!session) {
        res.status(404).send(`No session named '${sender}'. Create one via /sessions/create?sender=${sender}`);
        return null;
    }
    if (session.state !== 'ready') {
        res.status(503).send(`Session '${sender}' is not ready yet (state: ${session.state})`);
        return null;
    }
    return session;
}

// --- Session management -------------------------------------------------------
app.get('/sessions', requireApiKey, (req, res) => {
    res.json(Array.from(sessions.values()).map(sessionSummary));
});

app.get('/sessions/create', requireApiKey, async (req, res) => {
    const sender = req.query.sender;
    if (!sender || !SENDER_ID_RE.test(sender)) {
        return res.status(400).send('sender is required and must match [a-zA-Z0-9_-]{1,50}');
    }
    if (sessions.has(sender)) {
        return res.status(409).send(`Session '${sender}' already exists`);
    }
    if (sessions.size >= MAX_SESSIONS) {
        return res.status(429).send(`Session limit reached (MAX_SESSIONS=${MAX_SESSIONS})`);
    }

    const session = await createSession(sender);
    res.status(201).json(sessionSummary(session));
});

app.get('/sessions/logout', requireApiKey, async (req, res) => {
    const sender = req.query.sender;
    const session = sender && sessions.get(sender);
    if (!session) {
        return res.status(404).send(`No session named '${sender}'`);
    }
    await logoutSession(session);
    res.json({ sender, status: 'logged out' });
});

// --- Remote QR scanning page -------------------------------------------------
app.get('/qr', requireApiKey, async (req, res) => {
    const sender = req.query.sender;
    if (!sender) {
        return res.status(400).send('sender is required, e.g. /qr?sender=main');
    }
    const session = sessions.get(sender);
    if (!session) {
        return res.status(404).send(`No session named '${sender}'. Create one via /sessions/create?sender=${sender}`);
    }

    res.set('Content-Type', 'text/html');

    if (session.state === 'ready') {
        return res.send(`<html><body style="font-family:sans-serif;text-align:center;margin-top:10%">
            <h1>&#9989; Connected</h1>
            <p>Session '${sender}' is ready${session.meInfo ? ` (number: ${session.meInfo})` : ''}.</p>
        </body></html>`);
    }

    if (!session.latestQr) {
        return res.send(`<html><head><meta http-equiv="refresh" content="3"></head>
            <body style="font-family:sans-serif;text-align:center;margin-top:10%">
            <h1>Waiting for QR code...</h1>
            <p>Session '${sender}' status: ${session.state}. This page refreshes automatically.</p>
        </body></html>`);
    }

    try {
        const qrImage = await QRCode.toDataURL(session.latestQr);
        res.send(`<html><head><meta http-equiv="refresh" content="5"></head>
            <body style="font-family:sans-serif;text-align:center;margin-top:5%">
            <h1>Scan with WhatsApp (${sender})</h1>
            <img src="${qrImage}" alt="QR Code" />
            <p>Status: ${session.state}. This page refreshes automatically.</p>
        </body></html>`);
    } catch (err) {
        res.status(500).send('Failed to render QR code');
    }
});

// --- Health / status ---------------------------------------------------------
app.get('/status', requireApiKey, (req, res) => {
    const sender = req.query.sender;
    if (!sender) {
        return res.json(Array.from(sessions.values()).map(sessionSummary));
    }
    const session = sessions.get(sender);
    if (!session) {
        return res.status(404).send(`No session named '${sender}'`);
    }
    res.json(sessionSummary(session));
});

// --- Logs ---------------------------------------------------------------------
app.get('/logs', requireApiKey, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, LOG_BUFFER_MAX);
    let entries = logBuffer;
    if (req.query.sender) entries = entries.filter((e) => e.sender === req.query.sender);
    res.json(entries.slice(0, limit));
});

// --- Send text message ---------------------------------------------------------
app.get('/send', requireApiKey, async (req, res) => {
    const phone = req.query.phone;
    const message = req.query.message;
    if (!phone || !message) {
        return res.status(400).send('phone and message are required');
    }
    const session = resolveReadySession(req, res);
    if (!session) return;

    const jid = buildJid(phone);
    try {
        const response = await session.sock.sendMessage(jid, { text: message });
        logMessage({ sender: session.sender, phone, type: 'text', status: 'success', messageId: response.key.id });
        res.status(202).send('Sent');
    } catch (err) {
        logMessage({ sender: session.sender, phone, type: 'text', status: 'failed', error: err.message || String(err) });
        res.status(404).send('Not Sent');
    }
});

// --- Send media message ---------------------------------------------------------
app.get('/sendMedia', requireApiKey, async (req, res) => {
    const phone = req.query.phone;
    const message = req.query.message;
    const media = req.query.media;
    if (!phone || !media) {
        return res.status(400).send('phone and media are required');
    }
    const session = resolveReadySession(req, res);
    if (!session) return;

    const jid = buildJid(phone);
    try {
        const isUrl = /^https?:\/\//i.test(media);
        const mediaContent = isUrl ? { url: media } : fs.readFileSync(media);
        const mimeType = mime.lookup(media) || 'application/octet-stream';

        let messagePayload;
        if (mimeType.startsWith('image/')) {
            messagePayload = { image: mediaContent, caption: message, mimetype: mimeType };
        } else if (mimeType.startsWith('video/')) {
            messagePayload = { video: mediaContent, caption: message, mimetype: mimeType };
        } else if (mimeType.startsWith('audio/')) {
            messagePayload = { audio: mediaContent, mimetype: mimeType };
        } else {
            messagePayload = { document: mediaContent, mimetype: mimeType, fileName: path.basename(media), caption: message };
        }

        const response = await session.sock.sendMessage(jid, messagePayload);
        logMessage({ sender: session.sender, phone, type: 'media', status: 'success', messageId: response.key.id });
        res.status(202).send('Sent');
    } catch (err) {
        logMessage({ sender: session.sender, phone, type: 'media', status: 'failed', error: err.message || String(err) });
        res.status(404).send({ error: 'Failed to send message' });
    }
});

// --- Send location message ---------------------------------------------------------
app.get('/sendLocation', requireApiKey, async (req, res) => {
    const phone = req.query.phone;
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const name = req.query.name;
    const address = req.query.address;
    if (!phone || Number.isNaN(lat) || Number.isNaN(lng)) {
        return res.status(400).send('phone, lat and lng are required');
    }
    const session = resolveReadySession(req, res);
    if (!session) return;

    const jid = buildJid(phone);
    try {
        const response = await session.sock.sendMessage(jid, {
            location: { degreesLatitude: lat, degreesLongitude: lng, name, address },
        });
        logMessage({ sender: session.sender, phone, type: 'location', status: 'success', messageId: response.key.id });
        res.status(202).send('Sent');
    } catch (err) {
        logMessage({ sender: session.sender, phone, type: 'location', status: 'failed', error: err.message || String(err) });
        res.status(404).send({ error: 'Failed to send message' });
    }
});

// --- Send contact (vCard) message ---------------------------------------------------------
app.get('/sendContact', requireApiKey, async (req, res) => {
    const phone = req.query.phone;
    const contactName = req.query.contactName;
    const contactPhone = req.query.contactPhone;
    if (!phone || !contactName || !contactPhone) {
        return res.status(400).send('phone, contactName and contactPhone are required');
    }
    const session = resolveReadySession(req, res);
    if (!session) return;

    const jid = buildJid(phone);
    const waid = contactPhone.replace(/[^0-9]/g, '');
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${contactName}\nTEL;type=CELL;type=VOICE;waid=${waid}:+${waid}\nEND:VCARD`;

    try {
        const response = await session.sock.sendMessage(jid, {
            contacts: { displayName: contactName, contacts: [{ vcard }] },
        });
        logMessage({ sender: session.sender, phone, type: 'contact', status: 'success', messageId: response.key.id });
        res.status(202).send('Sent');
    } catch (err) {
        logMessage({ sender: session.sender, phone, type: 'contact', status: 'failed', error: err.message || String(err) });
        res.status(404).send({ error: 'Failed to send message' });
    }
});

// --- Send poll message ---------------------------------------------------------
app.get('/sendPoll', requireApiKey, async (req, res) => {
    const phone = req.query.phone;
    const question = req.query.question;
    const options = req.query.options; // comma-separated
    const multiple = req.query.multiple === 'true';
    if (!phone || !question || !options) {
        return res.status(400).send('phone, question and options (comma-separated) are required');
    }
    const values = options.split(',').map((o) => o.trim()).filter(Boolean);
    if (values.length < 2) {
        return res.status(400).send('at least 2 options are required');
    }
    const session = resolveReadySession(req, res);
    if (!session) return;

    const jid = buildJid(phone);
    try {
        const response = await session.sock.sendMessage(jid, {
            poll: { name: question, values, selectableCount: multiple ? values.length : 1 },
        });
        logMessage({ sender: session.sender, phone, type: 'poll', status: 'success', messageId: response.key.id });
        res.status(202).send('Sent');
    } catch (err) {
        logMessage({ sender: session.sender, phone, type: 'poll', status: 'failed', error: err.message || String(err) });
        res.status(404).send({ error: 'Failed to send message' });
    }
});

// --- Send sticker message ---------------------------------------------------------
app.get('/sendSticker', requireApiKey, async (req, res) => {
    const phone = req.query.phone;
    const media = req.query.media;
    if (!phone || !media) {
        return res.status(400).send('phone and media are required');
    }
    const session = resolveReadySession(req, res);
    if (!session) return;

    const jid = buildJid(phone);
    try {
        const isUrl = /^https?:\/\//i.test(media);
        const mediaContent = isUrl ? { url: media } : fs.readFileSync(media);

        const response = await session.sock.sendMessage(jid, { sticker: mediaContent });
        logMessage({ sender: session.sender, phone, type: 'sticker', status: 'success', messageId: response.key.id });
        res.status(202).send('Sent');
    } catch (err) {
        logMessage({ sender: session.sender, phone, type: 'sticker', status: 'failed', error: err.message || String(err) });
        res.status(404).send({ error: 'Failed to send message' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
