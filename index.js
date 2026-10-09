const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
} = require("@whiskeysockets/baileys");
const axios = require("axios");
const qrcode = require("qrcode-terminal");
const express = require("express");
const NodeCache = require("node-cache");
try {
  require("dotenv").config({ override: false });
} catch (e) {
  // In Docker/Portainer werden die Variablen direkt vom Container bereitgestellt
}

const HA_URL = process.env.HA_URL || "http://192.168.0.2:8123";
const HA_TOKEN = process.env.HA_TOKEN;
const CONVERSATION_AGENT = process.env.CONVERSATION_AGENT || null;
const WEBHOOK_PORT = process.env.PORT || 3000;

// Nummern und Namen einlesen
const ALLOWED_USERS = (process.env.ALLOWED_NUMBERS || "")
  .split(",")
  .map((num) => num.replace("+", "").trim().toLowerCase())
  .filter(Boolean);

const USER_NAMES = (process.env.USER_MAPPING || "")
  .split(",")
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

// Dynamisches Adressbuch aus Positionen aufbauen (z.B. marco -> 436601234567)
const ADDRESS_BOOK = {};
USER_NAMES.forEach((name, index) => {
  if (ALLOWED_USERS[index]) {
    ADDRESS_BOOK[name] = ALLOWED_USERS[index];
  }
});

// Cache für Nachricht-Wiederholungen gegen Entschlüsselungsfehler
const msgRetryCounterCache = new NodeCache();

let sock;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(
    "./auth_info_baileys",
  );

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    msgRetryCounterCache,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("--- QR CODE SCANNEN ---");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log("Verbindung getrennt. Reconnect:", shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("WhatsApp Bot ist erfolgreich verbunden!");
      console.log("Erlaubte Nummern:", ALLOWED_USERS);
      console.log("Namens-Mapping:", ADDRESS_BOOK);
    }
  });

  // 1. EINGEHENDE NACHRICHTEN (WhatsApp -> Home Assistant Assist)
  sock.ev.on("messages.upsert", async (m) => {
    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;

      // 1. Ursprüngliche JID ermitteln
      let rawJid =
        msg.key.participantAlt ||
        msg.key.remoteJidAlt ||
        msg.key.participant ||
        msg.key.remoteJid ||
        "";

      // 2. Falls es eine @lid ist, frag Baileys intern nach der echten @s.whatsapp.net JID
      if (rawJid.endsWith("@lid")) {
        try {
          // Das Gateway von Sebastian nutzt genau diesen Aufruf:
          const pnJid = await sock.signalRepository?.lidToJid(rawJid);
          if (pnJid) {
            rawJid = pnJid; // Bspw: 436505803032@s.whatsapp.net
          }
        } catch (err) {
          console.error("LID-Auflösung fehlgeschlagen:", err);
        }
      }

      // 3. Normalisieren & Telefonnummer extrahieren
      const normalizedJid = jidNormalizedUser(rawJid);
      const phoneNumber = normalizedJid
        .split("@")[0]
        .split(":")[0]
        .replace(/[^0-9]/g, "");

      console.log(
        `Nachricht empfangen von: ${phoneNumber} (Ursprung: ${msg.key.remoteJid})`,
      );

      // Prüfen
      if (!ALLOWED_USERS.includes(phoneNumber)) {
        console.log(`Zugriff verweigert für: ${phoneNumber}`);
        continue;
      }

      console.log(
        `Nachricht von ${pushName} (Tel: ${senderNumber}): "${text}"`,
      );

      try {
        const payload = {
          text: `[Absender: ${pushName}] ${text}`,
          language: "de",
        };

        if (CONVERSATION_AGENT) {
          payload.agent_id = CONVERSATION_AGENT;
        }

        const haResponse = await axios.post(
          `${HA_URL}/api/conversation/process`,
          payload,
          {
            headers: {
              Authorization: `Bearer ${HA_TOKEN}`,
              "Content-Type": "application/json",
            },
          },
        );

        const responseText =
          haResponse.data?.response?.speech?.plain?.speech ||
          "Befehl ausgeführt.";

        await sock.sendMessage(senderJid, { text: responseText });
      } catch (error) {
        console.error(
          "Fehler bei Home Assistant:",
          error.response?.data || error.message,
        );
        await sock.sendMessage(senderJid, {
          text: "Fehler bei der Verarbeitung in Home Assistant.",
        });
      }
    }
  });
}

// 2. WEBHOOK-SERVER (Home Assistant -> WhatsApp Push-Nachrichten)
const app = express();
app.use(express.json());

app.post("/send-message", async (req, res) => {
  const { message, recipient } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Keine Nachricht angegeben." });
  }

  if (!sock) {
    return res
      .status(503)
      .json({ error: "WhatsApp Bot ist noch nicht verbunden." });
  }

  if (!recipient) {
    return res
      .status(400)
      .json({ error: "Kein Empfänger (recipient) angegeben." });
  }

  try {
    const cleanRecipient = recipient.toLowerCase().trim();
    let targetNumber = ADDRESS_BOOK[cleanRecipient];

    // Falls kein Name gefunden wurde, prüfen wir, ob direkt eine gültige Nummer übergeben wurde
    if (!targetNumber) {
      const isNumeric = /^\+?\d+$/.test(cleanRecipient);
      if (isNumeric) {
        targetNumber = cleanRecipient.replace("+", "").trim();
      } else {
        console.error(
          `Fehler: Name "${recipient}" wurde im USER_MAPPING nicht gefunden.`,
        );
        return res.status(404).json({
          error: `Name "${recipient}" wurde im USER_MAPPING nicht gefunden.`,
        });
      }
    }

    const targetJid = `${targetNumber}@s.whatsapp.net`;

    await sock.sendMessage(targetJid, { text: message });
    console.log(
      `Nachricht gesendet an ${recipient} (${targetNumber}): "${message}"`,
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Fehler beim Senden via Webhook:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(WEBHOOK_PORT, () => {
  console.log(`Webhook-Server läuft auf Port ${WEBHOOK_PORT}`);
});

startBot();
