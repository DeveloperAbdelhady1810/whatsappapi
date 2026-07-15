const express = require('express');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');

// ---------------------------------------------------------------------------
// Config (env vars, with defaults that preserve original local behavior)
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const COUNTRY_CODE = process.env.COUNTRY_CODE !== undefined ? process.env.COUNTRY_CODE : '2';
const HEADLESS = process.env.HEADLESS !== 'false'; // default true
const CHROME_PATH = process.env.CHROME_PATH || undefined;
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
// WhatsApp client
// ---------------------------------------------------------------------------
let state = 'initializing'; // initializing | qr | authenticated | ready | disconnected
let latestQr = null;
let meInfo = null;
let client = null;
const startedAt = Date.now();

// NOTE: --single-process / --no-zygote are deliberately omitted — that combo is
// known to cause Chromium to crash immediately with no stderr output inside
// restricted/namespaced containers (exactly the "Code: null" failure this app
// hit on Hostinger).
const baseArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

// Resolve which Chromium binary to launch:
// 1. CHROME_PATH env var, if set (points at a system-installed Chrome).
// 2. @sparticuz/chromium's bundled portable binary on Linux — avoids relying on
//    Puppeteer's own postinstall Chrome download, which several hosts (incl.
//    Hostinger shared/cloud) skip or block during `npm install`.
// 3. Otherwise fall back to Puppeteer's own bundled Chrome (local dev).
async function resolvePuppeteerOptions() {
    if (CHROME_PATH) {
        return { args: baseArgs, headless: HEADLESS, executablePath: CHROME_PATH };
    }
    if (process.platform === 'linux') {
        // @sparticuz/chromium extracts its binary into os.tmpdir(). Many shared
        // hosts (incl. this one) mount /tmp as noexec, which makes the extracted
        // binary un-spawnable (EACCES). Redirect extraction into a writable AND
        // executable directory inside the app itself by overriding TMPDIR, which
        // os.tmpdir() honors.
        const chromiumTmpDir = path.join(__dirname, '.chromium-tmp');
        if (!fs.existsSync(chromiumTmpDir)) fs.mkdirSync(chromiumTmpDir, { recursive: true });
        process.env.TMPDIR = chromiumTmpDir;

        const { default: chromium } = await import('@sparticuz/chromium');
        const executablePath = await chromium.executablePath();
        return { args: [...chromium.args, ...baseArgs], headless: HEADLESS, executablePath };
    }
    return { args: baseArgs, headless: HEADLESS };
}

async function startWhatsAppClient() {
    const puppeteerOptions = await resolvePuppeteerOptions();

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
        puppeteer: puppeteerOptions,
    });

    client.on('qr', (qr) => {
        state = 'qr';
        latestQr = qr;
        console.log('QR RECEIVED - visit /qr to scan');
    });

    client.on('authenticated', () => {
        state = 'authenticated';
        latestQr = null;
    });

    client.on('ready', () => {
        state = 'ready';
        meInfo = client.info ? client.info.wid && client.info.wid.user : null;
        console.log('Client is ready!');
    });

    client.on('auth_failure', (msg) => {
        state = 'disconnected';
        console.error('Authentication failure:', msg);
    });

    client.on('disconnected', (reason) => {
        state = 'disconnected';
        meInfo = null;
        console.error('Client disconnected:', reason);
    });

    await client.initialize();
}

startWhatsAppClient().catch((err) => {
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
    return `${COUNTRY_CODE}${phone}@c.us`;
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
        const response = await client.sendMessage(jid, message);
        logMessage({ phone, type: 'text', status: 'success', messageId: response.id ? response.id._serialized : undefined });
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
        const mediaInMessage = /^https?:\/\//i.test(media)
            ? await MessageMedia.fromUrl(media)
            : MessageMedia.fromFilePath(media);

        const response = await client.sendMessage(jid, mediaInMessage, { caption: message });
        logMessage({ phone, type: 'media', status: 'success', messageId: response.id ? response.id._serialized : undefined });
        res.status(202).send('Sent');
    } catch (err) {
        logMessage({ phone, type: 'media', status: 'failed', error: err.message || String(err) });
        res.status(404).send({ error: 'Failed to send message' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
