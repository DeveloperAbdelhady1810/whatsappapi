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
const SESSION_PATH = process.env.SESSION_PATH || './.wwebjs_auth';

if (!API_KEY) {
    console.warn('WARNING: API_KEY is not set. All endpoints are UNPROTECTED. Set API_KEY in your environment.');
}

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
    console.log(`[${tag}] ${record.type} -> ${record.phone}${record.error ? ' | ' + record.error : ''}`);
}

// ---------------------------------------------------------------------------
// WhatsApp client (Baileys — pure Node.js WebSocket implementation, no browser)
// ---------------------------------------------------------------------------
let state = 'initializing'; // initializing | qr | ready | disconnected
let latestQr = null;
let meInfo = null;
let sock = null;
const startedAt = Date.now();

let DisconnectReason;

async function startSock() {
    // @whiskeysockets/baileys is a pure ESM package (no CommonJS build), so it
    // must be loaded via dynamic import() rather than require() — require()
    // only transparently handles ESM on newer Node versions (22+), and fails
    // with ERR_REQUIRE_ESM on older ones (e.g. Node 20, as seen on Hostinger).
    const {
        default: makeWASocket,
        useMultiFileAuthState,
        fetchLatestBaileysVersion,
        DisconnectReason: DR,
    } = await import('@whiskeysockets/baileys');
    DisconnectReason = DR;

    const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    // WhatsApp rejects connections using a stale protocol version (405 Method Not
    // Allowed), so always fetch the current one instead of relying on the
    // library's baked-in default.
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        auth: authState,
        version,
        logger: pino({ level: 'warn' }),
        // Required as of Baileys 7.x for reliable message retries/quoted-message
        // resolution. This app doesn't keep a message store, so there's nothing
        // to return, but the callback must exist.
        getMessage: async () => undefined,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            state = 'qr';
            latestQr = qr;
            console.log('QR RECEIVED - visit /qr to scan');
        }

        if (connection === 'open') {
            state = 'ready';
            latestQr = null;
            meInfo = sock.user && sock.user.id ? sock.user.id.split(':')[0].split('@')[0] : null;
            console.log('Client is ready!');
        }

        if (connection === 'close') {
            state = 'disconnected';
            const statusCode = lastDisconnect && lastDisconnect.error
                ? new Boom(lastDisconnect.error).output.statusCode
                : undefined;
            console.error('Connection closed. Status code:', statusCode, '| Error:', lastDisconnect && lastDisconnect.error);

            if (statusCode !== DisconnectReason.loggedOut) {
                startSock().catch((err) => console.error('FATAL: reconnect failed:', err && err.stack ? err.stack : err));
            } else {
                console.error('Logged out. Delete the session folder and restart to re-scan the QR code.');
            }
        }
    });
}

startSock().catch((err) => {
    state = 'disconnected';
    console.error('FATAL: client initialization failed:', err && err.stack ? err.stack : err);
});

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

// --- Remote QR scanning page -------------------------------------------------
app.get('/qr', requireApiKey, async (req, res) => {
    res.set('Content-Type', 'text/html');

    if (state === 'ready') {
        return res.send(`<html><body style="font-family:sans-serif;text-align:center;margin-top:10%">
            <h1>&#9989; Connected</h1>
            <p>WhatsApp client is ready${meInfo ? ` (number: ${meInfo})` : ''}.</p>
        </body></html>`);
    }

    if (!latestQr) {
        return res.send(`<html><head><meta http-equiv="refresh" content="3"></head>
            <body style="font-family:sans-serif;text-align:center;margin-top:10%">
            <h1>Waiting for QR code...</h1>
            <p>Status: ${state}. This page refreshes automatically.</p>
        </body></html>`);
    }

    try {
        const qrImage = await QRCode.toDataURL(latestQr);
        res.send(`<html><head><meta http-equiv="refresh" content="5"></head>
            <body style="font-family:sans-serif;text-align:center;margin-top:5%">
            <h1>Scan with WhatsApp</h1>
            <img src="${qrImage}" alt="QR Code" />
            <p>Status: ${state}. This page refreshes automatically.</p>
        </body></html>`);
    } catch (err) {
        res.status(500).send('Failed to render QR code');
    }
});

// --- Health / status ---------------------------------------------------------
app.get('/status', requireApiKey, (req, res) => {
    res.json({
        state,
        me: meInfo,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
});

// --- Logs ---------------------------------------------------------------------
app.get('/logs', requireApiKey, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, LOG_BUFFER_MAX);
    res.json(logBuffer.slice(0, limit));
});

// --- Send text message ---------------------------------------------------------
app.get('/send', requireApiKey, async (req, res) => {
    const phone = req.query.phone;
    const message = req.query.message;

    if (!phone || !message) {
        return res.status(400).send('phone and message are required');
    }
    if (state !== 'ready') {
        return res.status(503).send('WhatsApp client is not ready yet');
    }

    const jid = buildJid(phone);
    try {
        const response = await sock.sendMessage(jid, { text: message });
        logMessage({ phone, type: 'text', status: 'success', messageId: response.key.id });
        res.status(202).send('Sent');
    } catch (err) {
        logMessage({ phone, type: 'text', status: 'failed', error: err.message || String(err) });
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
    if (state !== 'ready') {
        return res.status(503).send('WhatsApp client is not ready yet');
    }

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

        const response = await sock.sendMessage(jid, messagePayload);
        logMessage({ phone, type: 'media', status: 'success', messageId: response.key.id });
        res.status(202).send('Sent');
    } catch (err) {
        logMessage({ phone, type: 'media', status: 'failed', error: err.message || String(err) });
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
    if (state !== 'ready') {
        return res.status(503).send('WhatsApp client is not ready yet');
    }

    const jid = buildJid(phone);
    try {
        const response = await sock.sendMessage(jid, {
            location: { degreesLatitude: lat, degreesLongitude: lng, name, address },
        });
        logMessage({ phone, type: 'location', status: 'success', messageId: response.key.id });
        res.status(202).send('Sent');
    } catch (err) {
        logMessage({ phone, type: 'location', status: 'failed', error: err.message || String(err) });
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
    if (state !== 'ready') {
        return res.status(503).send('WhatsApp client is not ready yet');
    }

    const jid = buildJid(phone);
    const waid = contactPhone.replace(/[^0-9]/g, '');
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${contactName}\nTEL;type=CELL;type=VOICE;waid=${waid}:+${waid}\nEND:VCARD`;

    try {
        const response = await sock.sendMessage(jid, {
            contacts: { displayName: contactName, contacts: [{ vcard }] },
        });
        logMessage({ phone, type: 'contact', status: 'success', messageId: response.key.id });
        res.status(202).send('Sent');
    } catch (err) {
        logMessage({ phone, type: 'contact', status: 'failed', error: err.message || String(err) });
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
    if (state !== 'ready') {
        return res.status(503).send('WhatsApp client is not ready yet');
    }

    const jid = buildJid(phone);
    try {
        const response = await sock.sendMessage(jid, {
            poll: { name: question, values, selectableCount: multiple ? values.length : 1 },
        });
        logMessage({ phone, type: 'poll', status: 'success', messageId: response.key.id });
        res.status(202).send('Sent');
    } catch (err) {
        logMessage({ phone, type: 'poll', status: 'failed', error: err.message || String(err) });
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
    if (state !== 'ready') {
        return res.status(503).send('WhatsApp client is not ready yet');
    }

    const jid = buildJid(phone);
    try {
        const isUrl = /^https?:\/\//i.test(media);
        const mediaContent = isUrl ? { url: media } : fs.readFileSync(media);

        const response = await sock.sendMessage(jid, { sticker: mediaContent });
        logMessage({ phone, type: 'sticker', status: 'success', messageId: response.key.id });
        res.status(202).send('Sent');
    } catch (err) {
        logMessage({ phone, type: 'sticker', status: 'failed', error: err.message || String(err) });
        res.status(404).send({ error: 'Failed to send message' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
