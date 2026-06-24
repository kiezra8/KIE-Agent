require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const http = require('http');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

let latestQR = null;
let botStatus = 'Waiting for QR code...';

// Web server — shows QR code in browser and keeps Render alive
const server = http.createServer((req, res) => {
    if (req.url === '/qr') {
        if (latestQR) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
                <html>
                <head>
                    <title>WhatsApp Bot QR</title>
                    <meta http-equiv="refresh" content="10">
                    <style>
                        body { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; background:#111; color:#fff; font-family:sans-serif; }
                        img { width:300px; height:300px; background:#fff; padding:10px; border-radius:10px; }
                        p { font-size:18px; margin-top:20px; }
                    </style>
                </head>
                <body>
                    <p>Scan this with WhatsApp → Linked Devices</p>
                    <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(latestQR)}" />
                    <p style="font-size:12px;opacity:0.5">Page refreshes every 10 seconds</p>
                </body>
                </html>
            `);
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
                <html>
                <head>
                    <meta http-equiv="refresh" content="5">
                    <style>body{display:flex;align-items:center;justify-content:center;height:100vh;background:#111;color:#fff;font-family:sans-serif;font-size:20px;}</style>
                </head>
                <body>${botStatus} (refreshing...)</body>
                </html>
            `);
        }
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(botStatus);
    }
});

server.listen(process.env.PORT || 3000, () => {
    console.log('Server running. Go to your Render URL + /qr to scan the QR code');
});

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    latestQR = qr;
    botStatus = 'QR code ready. Open /qr in your browser to scan.';
    console.log('QR ready! Go to your Render URL/qr to scan it');
});

client.on('ready', () => {
    latestQR = null;
    botStatus = 'Bot is connected and running';
    console.log('✅ Bot is online and ready.');
});

client.on('message', async msg => {
    const chat = await msg.getChat();

    if (!chat.isGroup) {
        try {
            const prompt = `You are a personal assistant for someone who is currently offline or busy.
Reply to this WhatsApp message politely and helpfully on their behalf.
Keep the reply short like a real WhatsApp message.
Message: "${msg.body}"`;

            const result = await model.generateContent(prompt);
            const response = result.response.text();

            await msg.reply(response);
        } catch (error) {
            console.error('Gemini error:', error);
        }
    }
});

client.initialize();
