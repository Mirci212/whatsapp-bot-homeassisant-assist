const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

const HA_URL = process.env.HA_URL || 'http://192.168.1.XXX:8123';
const HA_TOKEN = process.env.HA_TOKEN;

// Erlaubte Einträge (Namen oder Telefonnummern), bereinigt von Leerzeichen
const ALLOWED_USERS = (process.env.ALLOWED_NUMBERS || '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry.length > 0);

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('--- QR CODE SCANNEN ---');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Verbindung getrennt. Reconnect:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('WhatsApp Bot ist erfolgreich verbunden!');
            console.log('Erlaubte Absender (Namen/Nummern):', ALLOWED_USERS);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const senderJid = msg.key.remoteJid; // z.B. 436601234567@s.whatsapp.net
        const senderNumber = senderJid.split('@')[0].toLowerCase();
        const pushName = (msg.pushName || '').trim().toLowerCase(); // WhatsApp-Profilname
        
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        // Sicherheitsprüfung: Prüfen ob Nummer ODER Name in der Erlaubnisliste ist
        const isNumberAllowed = ALLOWED_USERS.includes(senderNumber);
        const isNameAllowed = ALLOWED_USERS.includes(pushName);

        if (ALLOWED_USERS.length > 0 && !isNumberAllowed && !isNameAllowed) {
            console.log(`⛔ Zugriff verweigert für Nummer: "${senderNumber}" | Name: "${msg.pushName}"`);
            return;
        }

        console.log(`💬 Befehl von ${msg.pushName || senderNumber} (${senderNumber}): "${text}"`);

        try {
            const haResponse = await axios.post(
                `${HA_URL}/api/conversation/process`,
                { text: text, language: "de" },
                { headers: { Authorization: `Bearer ${HA_TOKEN}` } }
            );

            const responseText = haResponse.data?.response?.speech?.plain?.speech 
                || "Befehl ausgeführt, aber keine Rückmeldung erhalten.";

            await sock.sendMessage(senderJid, { text: responseText });

        } catch (error) {
            console.error('Fehler bei Home Assistant:', error.message);
            await sock.sendMessage(senderJid, { text: "❌ Fehler bei der Verbindung zu Home Assistant." });
        }
    });
}

startBot();