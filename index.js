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

// Dynamisches Adressbuch aufbauen (z.B. marco -> 436601234567)
const ADDRESS_BOOK = {};
USER_NAMES.forEach((name, index) => {
  if (ALLOWED_USERS[index]) {
    ADDRESS_BOOK[name] = ALLOWED_USERS[index];
  }
});

// Optionales LID-Mapping aus ENV (Format: LID1:NUMMER1,LID2:NUMMER2)
const LID_MAPPING = {};
if (process.env.LID_MAPPING) {
  process.env.LID_MAPPING.split(",").forEach((pair) => {
    const [lid, num] = pair.split(":");
    if (lid && num) LID_MAPPING[lid.trim()] = num.trim();
  });
}

// Cache für Nachricht-Wiederholungen gegen Entschlüsselungsfehler
const msgRetryCounterCache = new NodeCache();

let sock;

/**
 * Wandelt JIDs und WhatsApp-LIDs zuverlässig in Telefonnummern um
 */
async function getPhoneNumberFromJid(keys, rawJid) {
  if (!rawJid) return "";

  // 1. Wenn es bereits eine Phone-Number-JID (@s.whatsapp.net) ist
  if (rawJid.includes("@s.whatsapp.net")) {
    return rawJid.split("@")[0].split(":")[0];
  }

  // 2. Falls es eine LID ist (@lid)
  if (rawJid.endsWith("@lid")) {
    const lidId = rawJid.split("@")[0].split(":")[0];

    // Im optionalen LID-Mapping nachschlagen
    if (LID_MAPPING[lidId]) {
      return LID_MAPPING[lidId];
    }

    // Versuchen, das Mapping aus dem Baileys Session-Store zu lesen
    try {
      if (keys && typeof keys.get === "function") {
        const lidMap = await keys.get("lid-mapping", [lidId]);
        if (lidMap && lidMap[lidId]) {
          return lidMap[lidId];
        }
      }
    } catch (err) {
      // Fallback ignorieren
    }

    return lidId;
  }

  return rawJid.split("@")[0].split(":")[0];
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(
    "./auth_info_baileys"
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

      // 1. Alt-JIDs bevorzugen (Baileys speichert dort oft die echte Handy-JID)
      let rawJid =
        msg.key.remoteJidAlt ||
        msg.key.participantAlt ||
        msg.key.participant ||
        msg.key.remoteJid ||
        "";

      // 2. Nummer/LID auflösen (state.keys wird korrekt übergeben)
      let senderNumber = await getPhoneNumberFromJid(state.keys, rawJid);

      // Falls immer noch eine Alt-JID mit Mobilnummer existiert
      const altJid = msg.key.remoteJidAlt || msg.key.participantAlt;
      if (altJid && altJid.includes("@s.whatsapp.net")) {
        senderNumber = altJid.split("@")[0].split(":")[0];
      }

      // Suffixe und Sonderzeichen entfernen
      senderNumber = senderNumber.replace(/[^0-9]/g, "");

      // 3. Empfänger-JID für die Antwort bestimmen
      const senderJid = msg.key.remoteJid;

      // 4. Nachrichtentext extrahieren
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        "";

      if (!text) continue; // Keine Textnachricht -> überspringen

      const pushName = msg.pushName || "Unbekannt";

      console.log(`Empfangen von Nummer: ${senderNumber}`);

      // 5. Zugriffsprüfung
      if (!ALLOWED_USERS.includes(senderNumber)) {
        console.log(`Zugriff verweigert für: ${senderNumber} (Name: ${pushName})`);
        continue;
      }

      console.log(
        `Nachricht von ${pushName} (Tel: ${senderNumber}): "${text}"`
      );

      // 6. An Home Assistant senden
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
          }
        );

        const responseText =
          haResponse.data?.response?.speech?.plain?.speech ||
          "Befehl ausgeführt.";

        await sock.sendMessage(senderJid, { text: responseText });
      } catch (error) {
        console.error(
          "Fehler bei Home Assistant:",
          error.response?.data || error.message
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
          `Fehler: Name "${recipient}" wurde im USER_MAPPING nicht gefunden.`
        );
        return res.status(404).json({
          error: `Name "${recipient}" wurde im USER_MAPPING nicht gefunden.`,
        });
      }
    }

    const targetJid = `${targetNumber}@s.whatsapp.net`;

    await sock.sendMessage(targetJid, { text: message });
    console.log(
      `Nachricht gesendet an ${recipient} (${targetNumber}): "${message}"`
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