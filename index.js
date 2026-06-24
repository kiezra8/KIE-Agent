require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const http = require('http');

// Keep-alive server so Render doesn't sleep
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is running');
});
server.listen(process.env.PORT || 3000, () => {
    console.log('Keep-alive server running');
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    console.log('Scan this QR code with your WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ Bot is online and ready.');
});

client.on('message', async msg => {
    const chat = await msg.getChat();

    // Only reply in private chats, not groups
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
