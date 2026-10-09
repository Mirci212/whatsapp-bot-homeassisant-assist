const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const axios = require("axios");
const qrcode = require("qrcode-terminal");
const express = require("express");
const NodeCache = require("node-cache");
const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config({ override: false });
} catch (e) {
  // In Docker / Portainer werden ENV-Variablen direkt geladen
}

const HA_URL = process.env.HA_URL || "http://192.168.0.2:8123";
const HA_TOKEN = process.env.HA_TOKEN;
const CONVERSATION_AGENT = process.env.CONVERSATION_AGENT || null;
const WEBHOOK_PORT = process.env.PORT || 3000;

// -------------------------------------------------------------
// Parsing der ALLOWED_USERS (Format: Nummer:Name,Nummer:Name)
// -------------------------------------------------------------
const ALLOWED_USERS = []; // Liste erlaubter Nummern
const ADDRESS_BOOK = {};  // Name -> Nummer
const NUMBER_TO_NAME = {};// Nummer -> Name

if (process.env.ALLOWED_USERS) {
  const entries = process.env.ALLOWED_USERS.split(",");
  entries.forEach((entry) => {
    const [rawNum, rawName] = entry.split(":");
    if (rawNum && rawName) {
      const cleanNum = rawNum.replace(/[^0-9]/g, "").trim();
      const cleanName = rawName.trim().toLowerCase();

      if (cleanNum && cleanName) {
        ALLOWED_USERS.push(cleanNum);
        ADDRESS_BOOK[cleanName] = cleanNum;
        NUMBER_TO_NAME[cleanNum] = rawName.trim();
      }
    }
  });
}

// -------------------------------------------------------------
// Persistent LID-Cache System
// -------------------------------------------------------------
const LID_CACHE_FILE = path.join(__dirname, "auth_info_baileys", "lid_cache.json");
const autoLidMap = {};

if (fs.existsSync(LID_CACHE_FILE)) {
  try {
    const savedLids = JSON.parse(fs.readFileSync(LID_CACHE_FILE, "utf-8"));
    Object.assign(autoLidMap, savedLids);
    console.log("[LID-Cache] Geladen:", autoLidMap);
  } catch (e) {
    console.error("[LID-Cache] Fehler beim Laden:", e.message);
  }
}

function saveLidCache() {
  try {
    const dir = path.dirname(LID_CACHE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(LID_CACHE_FILE, JSON.stringify(autoLidMap, null, 2));
  } catch (e) {
    console.error("[LID-Cache] Fehler beim Speichern:", e.message);
  }
}

function registerLidMapping(lid, phone) {
  if (!lid || !phone) return;
  const cleanLid = lid.split("@")[0].split(":")[0];
  const cleanPhone = phone.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");

  // Verhindere das Speichern, wenn phone fälschlicherweise selbst eine LID ist (>13 Stellen)
  if (cleanLid && cleanPhone && cleanPhone.length <= 13 && autoLidMap[cleanLid] !== cleanPhone) {
    autoLidMap[cleanLid] = cleanPhone;
    saveLidCache();
    console.log(`[LID-Cache] Neu verknüpft: LID (${cleanLid}) -> Phone (${cleanPhone})`);
  }
}

const msgRetryCounterCache = new NodeCache();
let sock;

/**
 * Ermittelt aus JID, LID oder Kontaktbuch die Telefonnummer
 */
async function resolvePhoneNumber(msg, keys) {
  // 1. WhatsApp Alt-JID / Participant JIDs prüfen
  const possibleJids = [
    msg.key.remoteJidAlt,
    msg.key.participantAlt,
    msg.key.participant,
    msg.key.remoteJid,
  ].filter(Boolean);

  for (const jid of possibleJids) {
    if (jid.includes("@s.whatsapp.net")) {
      return jid.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
    }
  }

  // 2. Falls es eine LID ist (@lid)
  const primaryJid = msg.key.remoteJid || "";
  const lidId = primaryJid.split("@")[0].split(":")[0];

  if (autoLidMap[lidId]) {
    return autoLidMap[lidId];
  }

  // 3. Im Baileys Auth-Key-Store nachsehen (Baileys v6 native LID Storage)
  try {
    if (keys && typeof keys.get === "function") {
      const lidMap = await keys.get("lid-mapping", [lidId]);
      if (lidMap && lidMap[lidId]) {
        const foundNum = lidMap[lidId].replace(/[^0-9]/g, "");
        registerLidMapping(lidId, foundNum);
        return foundNum;
      }
    }
  } catch (err) {
    // Ignorieren falls nicht vorhanden
  }

  // 4. Fallback über PushName matching (falls PushName im Mapping definiert ist)
  if (msg.pushName) {
    const pushNameLower = msg.pushName.trim().toLowerCase();
    if (ADDRESS_BOOK[pushNameLower]) {
      const matchedNumber = ADDRESS_BOOK[pushNameLower];
      registerLidMapping(lidId, matchedNumber);
      console.log(`[PushName-Match] LID ${lidId} wurde zu ${msg.pushName} (${matchedNumber}) zugeordnet.`);
      return matchedNumber;
    }
  }

  return lidId; // Rückgabe der rohen ID, falls nicht auflösbar
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info_baileys");

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    msgRetryCounterCache,
    syncFullHistory: true,
  });

  sock.ev.on("creds.update", saveCreds);

  // -------------------------------------------------------------
  // Synchronisation aus Adressbuch & Kontakten
  // -------------------------------------------------------------
  const handleContacts = (contacts) => {
    for (const contact of contacts) {
      if (contact.lid && contact.id) {
        registerLidMapping(contact.lid, contact.id);
      }
    }
  };

  sock.ev.on("contacts.upsert", handleContacts);
  sock.ev.on("contacts.update", handleContacts);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("--- QR CODE SCANNEN ---");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Verbindung getrennt. Reconnect:", shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      if (sock.user?.lid && sock.user?.id) {
        registerLidMapping(sock.user.lid, sock.user.id);
      }
      console.log("WhatsApp Bot ist erfolgreich verbunden!");
      console.log("Erlaubte Nummern:", ALLOWED_USERS);
      console.log("Namens-Mapping:", ADDRESS_BOOK);
    }
  });

  // -------------------------------------------------------------
  // EINGEHENDE NACHRICHTEN (WhatsApp -> Home Assistant)
  // -------------------------------------------------------------
  sock.ev.on("messages.upsert", async (m) => {
    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;

      const senderNumber = await resolvePhoneNumber(msg, state.keys);
      const pushName = msg.pushName || NUMBER_TO_NAME[senderNumber] || "Unbekannt";
      const senderJid = msg.key.remoteJid;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        "";

      if (!text) continue;

      // Zugriffsprüfung
      if (!ALLOWED_USERS.includes(senderNumber)) {
        console.log(`[Zugriff verweigert] Nummer: ${senderNumber} (LID/Name: ${pushName})`);
        continue;
      }

      console.log(`[Nachricht empfangen] Von ${pushName} (${senderNumber}): "${text}"`);

      // An Home Assistant Assist senden
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
          haResponse.data?.response?.speech?.plain?.speech || "Befehl ausgeführt.";

        await sock.sendMessage(senderJid, { text: responseText });
      } catch (error) {
        console.error("Fehler bei Home Assistant:", error.response?.data || error.message);
        await sock.sendMessage(senderJid, {
          text: "Fehler bei der Verarbeitung in Home Assistant.",
        });
      }
    }
  });
}

// -------------------------------------------------------------
// WEBHOOK-SERVER (Home Assistant -> WhatsApp)
// -------------------------------------------------------------
const app = express();
app.use(express.json());

app.post("/send-message", async (req, res) => {
  const { message, recipient } = req.body;

  if (!message) return res.status(400).json({ error: "Keine Nachricht angegeben." });
  if (!sock) return res.status(503).json({ error: "WhatsApp Bot ist noch nicht verbunden." });
  if (!recipient) return res.status(400).json({ error: "Kein Empfänger angegeben." });

  try {
    const cleanRecipient = recipient.toLowerCase().trim();
    let targetNumber = ADDRESS_BOOK[cleanRecipient];

    // Wenn kein Name gematcht wurde, prüfen ob direkt eine Nummer übergeben wurde
    if (!targetNumber) {
      const isNumeric = /^\+?\d+$/.test(cleanRecipient);
      if (isNumeric) {
        targetNumber = cleanRecipient.replace("+", "").trim();
      } else {
        return res.status(404).json({
          error: `Name oder Nummer "${recipient}" wurde in ALLOWED_USERS nicht gefunden.`,
        });
      }
    }

    const targetJid = `${targetNumber}@s.whatsapp.net`;
    await sock.sendMessage(targetJid, { text: message });

    console.log(`Webhook gesendet an ${recipient} (${targetNumber}): "${message}"`);
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