require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const QRCode = require('qrcode');
const http = require('http');
const pino = require('pino');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

let latestQRImage = null;
let botStatus = 'Starting up...';

// Web server — shows QR code and keeps Render alive
const server = http.createServer(async (req, res) => {
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
                        body { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; background:#111; color:#fff; font-family:sans-serif; overflow:hidden; }
                        img { width:220px; height:220px; border-radius:10px; }
                        .title { font-size:15px; margin-bottom:16px; opacity:0.9; }
                        .sub { font-size:11px; margin-top:12px; opacity:0.4; }
                    </style>
                </head>
                <body>
                    <p class="title">Scan with WhatsApp → Linked Devices</p>
                    <img src="${latestQRImage}" />
                    <p class="sub">Page refreshes every 15 seconds</p>
                </body>
                </html>
            `);
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
                <html>
                <head>
                    <meta http-equiv="refresh" content="5">
                    <style>* { margin:0; padding:0; } body { display:flex; align-items:center; justify-content:center; height:100vh; background:#111; color:#fff; font-family:sans-serif; font-size:18px; }</style>
                </head>
                <body>${botStatus} — refreshing...</body>
                </html>
            `);
        }
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(botStatus);
    }
});

server.listen(process.env.PORT || 3000, () => {
    console.log('Server running. Open your Render URL + /qr to scan');
});

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            botStatus = 'QR ready. Open /qr in browser to scan.';
            try {
                latestQRImage = await QRCode.toDataURL(qr);
                console.log('QR generated. Open /qr to scan it.');
            } catch (e) {
                console.error('QR error:', e);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                latestQRImage = null;
                botStatus = 'Reconnecting...';
                setTimeout(startBot, 3000);
            }
        }

        if (connection === 'open') {
            latestQRImage = null;
            botStatus = 'Bot connected and running';
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

startBot();
