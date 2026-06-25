require('dotenv').config();
const crypto = require('crypto');
if (!global.crypto) global.crypto = crypto;

const { default: makeWASocket, proto, initAuthCreds, BufferJSON, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const http = require('http');
const pino = require('pino');
const { Redis } = require('@upstash/redis');

// Prevent silent crashes
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

let latestQRImage = null;
let botStatus = 'Starting up...';
let currentSock = null;
let reconnecting = false;

// ─── Upstash Redis Auth State ──────────────────────────────────────────────────
const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function useRedisAuthState() {
    const write = async (data, id) => {
        const serialized = JSON.stringify(data, BufferJSON.replacer);
        await redis.set(`baileys:${id}`, serialized);
    };

    const read = async (id) => {
        const raw = await redis.get(`baileys:${id}`);
        if (!raw) return null;
        const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
        return JSON.parse(str, BufferJSON.reviver);
    };

    const creds = (await read('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await read(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? write(value, key) : redis.del(`baileys:${key}`));
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: () => write(creds, 'creds'),
    };
}

// ─── Web Server ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    if (req.url === '/reconnect') {
        if (!reconnecting) {
            reconnecting = true;
            latestQRImage = null;
            botStatus = 'Reconnecting...';
            if (currentSock) {
                try { currentSock.end(); } catch (e) {}
            }
            setTimeout(() => {
                reconnecting = false;
                startBot();
            }, 2000);
        }
        res.writeHead(302, { Location: '/qr' });
        res.end();
        return;
    }

    if (req.url === '/qr') {
        if (latestQRImage) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
                <html>
                <head>
                    <title>KIE Bot QR</title>
                    <meta http-equiv="refresh" content="15">
                    <style>
                        * { margin:0; padding:0; box-sizing:border-box; }
                        body { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; background:#111; color:#fff; font-family:sans-serif; }
                        img { width:220px; height:220px; border-radius:10px; }
                        .title { font-size:15px; margin-bottom:16px; opacity:0.9; }
                        .sub { font-size:11px; margin-top:12px; opacity:0.4; }
                        .btn { margin-top:16px; padding:10px 24px; background:#25D366; color:#fff; border:none; border-radius:8px; font-size:14px; cursor:pointer; text-decoration:none; }
                    </style>
                </head>
                <body>
                    <p class="title">Scan with WhatsApp → Linked Devices</p>
                    <img src="${latestQRImage}" />
                    <p class="sub">Page refreshes every 15 seconds</p>
                    <a class="btn" href="/reconnect">Get New QR</a>
                </body>
                </html>
            `);
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
                <html>
                <head>
                    <meta http-equiv="refresh" content="5">
                    <style>
                        * { margin:0; padding:0; }
                        body { display:flex; flex-direction:column; gap:20px; align-items:center; justify-content:center; height:100vh; background:#111; color:#fff; font-family:sans-serif; font-size:18px; }
                        .btn { padding:10px 24px; background:#25D366; color:#fff; border:none; border-radius:8px; font-size:14px; cursor:pointer; text-decoration:none; }
                    </style>
                </head>
                <body>
                    <span>${botStatus} — refreshing...</span>
                    <a class="btn" href="/reconnect">Force Reconnect</a>
                </body>
                </html>
            `);
        }
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(botStatus);
    }
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
    console.log(`Server running on port ${port}. Open your Railway URL + /qr to scan`);
});

// ─── Bot ───────────────────────────────────────────────────────────────────────
async function startBot() {
    const { state, saveCreds } = await useRedisAuthState();
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WhatsApp v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false
    });

    currentSock = sock;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            botStatus = 'QR ready. Open /qr in browser or scan terminal to connect.';
            try {
                latestQRImage = await QRCode.toDataURL(qr);
                console.log('QR generated! Open your Railway URL + /qr to scan, or scan the one below:');
                qrcodeTerminal.generate(qr, { small: true });
            } catch (e) {
                console.error('QR error:', e);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.error('Connection closed. Error:', lastDisconnect?.error);
            console.log('Reconnecting:', shouldReconnect);
            
            if (shouldReconnect) {
                latestQRImage = null;
                botStatus = 'Reconnecting...';
                // Wait 5 seconds before trying again to avoid spamming
                setTimeout(startBot, 5000);
            } else {
                botStatus = 'Logged out. Restart required.';
            }
        }

        if (connection === 'open') {
            latestQRImage = null;
            botStatus = 'Bot connected and running ✅';
            console.log('✅ Bot is online!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg || !msg.message || msg.key.fromMe) return;

        const isGroup = msg.key.remoteJid.endsWith('@g.us');
        if (isGroup) return;

        const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            '';

        if (!text) return;

        try {
            const prompt = `You are a personal assistant for someone who is currently offline or busy.
Reply to this WhatsApp message politely and helpfully on their behalf.
Keep the reply short like a real WhatsApp message.
Message: "${text}"`;

            const result = await model.generateContent(prompt);
            const response = result.response.text();

            await sock.sendMessage(msg.key.remoteJid, { text: response });
        } catch (error) {
            console.error('Gemini error:', error);
        }
    });
}

// ─── Entry Point ───────────────────────────────────────────────────────────────
async function main() {
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
        console.error('❌ UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is not set!');
        process.exit(1);
    }
    console.log('✅ Redis configured. Starting bot...');
    await startBot();
}

main().catch(console.error);
