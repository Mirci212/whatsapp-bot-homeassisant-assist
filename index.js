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
const fs = require("fs");
const path = require("path");

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

// Dynamisches Adressbuch aufbauen (z.B. marco -> 436505803032)
const ADDRESS_BOOK = {};
USER_NAMES.forEach((name, index) => {
  if (ALLOWED_USERS[index]) {
    ADDRESS_BOOK[name] = ALLOWED_USERS[index];
  }
});

// Statisches LID-Mapping aus ENV (Format: LID1:NUMMER1,LID2:NUMMER2)
const LID_MAPPING = {};
if (process.env.LID_MAPPING) {
  process.env.LID_MAPPING.split(",").forEach((pair) => {
    const [lid, num] = pair.split(":");
    if (lid && num) LID_MAPPING[lid.trim()] = num.trim();
  });
}

// -------------------------------------------------------------
// Persistent LID-Cache System (im Auth-Volume speichern)
// -------------------------------------------------------------
const LID_CACHE_FILE = path.join(__dirname, "auth_info_baileys", "lid_cache.json");
const autoLidMap = {};

// Cache beim Start aus der Datei laden
if (fs.existsSync(LID_CACHE_FILE)) {
  try {
    const savedLids = JSON.parse(fs.readFileSync(LID_CACHE_FILE, "utf-8"));
    Object.assign(autoLidMap, savedLids);
    console.log("[LID-Cache] Erfolgreich aus Volume geladen:", autoLidMap);
  } catch (e) {
    console.error("[LID-Cache] Fehler beim Laden der Cache-Datei:", e.message);
  }
}

// Speichert den aktuellen Stand von autoLidMap in das Volume
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

// Hilfsfunktion zum Hinzufügen einer LID ins Cache-System
function registerLidMapping(lid, phone) {
  if (!lid || !phone) return;
  const cleanLid = lid.split("@")[0].split(":")[0];
  const cleanPhone = phone.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");

  if (cleanLid && cleanPhone && autoLidMap[cleanLid] !== cleanPhone) {
    autoLidMap[cleanLid] = cleanPhone;
    saveLidCache();
    console.log(`[LID-Cache] Neue Verknüpfung gespeichert: LID (${cleanLid}) -> Nummer (${cleanPhone})`);
  }
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

    // a) Im persistenten Auto-LID-Map nachsehen
    if (autoLidMap[lidId]) {
      return autoLidMap[lidId];
    }

    // b) Im manuellen ENV-Mapping nachsehen
    if (LID_MAPPING[lidId]) {
      return LID_MAPPING[lidId];
    }

    // c) Versuchen, das Mapping aus dem Baileys Session-Store zu lesen
    try {
      if (keys && typeof keys.get === "function") {
        const lidMap = await keys.get("lid-mapping", [lidId]);
        if (lidMap && lidMap[lidId]) {
          return lidMap[lidId];
        }
      }
    } catch (err) {
      // Ignorieren falls nicht gefunden
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
    syncFullHistory: true, // Für den Kontakt-Sync auf true belassen
  });

  sock.ev.on("creds.update", saveCreds);

  // Automatische Kontakt- & LID-Synchronisierung abfangen und im Volume speichern
  sock.ev.on("contacts.upsert", (contacts) => {
    for (const contact of contacts) {
      if (contact.lid && contact.id) {
        registerLidMapping(contact.lid, contact.id);
      }
    }
  });

  sock.ev.on("contacts.update", (updates) => {
    for (const update of updates) {
      if (update.lid && update.id) {
        registerLidMapping(update.lid, update.id);
      }
    }
  });

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
      // Eigene LID und Nummer aus der aktiven WhatsApp-Session registrieren & im Volume speichern
      if (sock.user) {
        const myNum = sock.user.id;
        const myLid = sock.user.lid;
        if (myLid && myNum) {
          registerLidMapping(myLid, myNum);
        }
      }

      console.log("WhatsApp Bot ist erfolgreich verbunden!");
      console.log("Erlaubte Nummern:", ALLOWED_USERS);
      console.log("Namens-Mapping:", ADDRESS_BOOK);
    }
  });

  // 1. EINGEHENDE NACHRICHTEN (WhatsApp -> Home Assistant Assist)
  sock.ev.on("messages.upsert", async (m) => {
    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;

      // 1. Alt-JIDs bevorzugen
      let rawJid =
        msg.key.remoteJidAlt ||
        msg.key.participantAlt ||
        msg.key.participant ||
        msg.key.remoteJid ||
        "";

      // 2. Nummer/LID auflösen
      let senderNumber = await getPhoneNumberFromJid(state.keys, rawJid);

      // Falls immer noch eine Alt-JID mit Mobilnummer existiert
      const altJid = msg.key.remoteJidAlt || msg.key.participantAlt;
      if (altJid && altJid.includes("@s.whatsapp.net")) {
        senderNumber = altJid.split("@")[0].split(":")[0];
      }

      // Suffixe und Sonderzeichen entfernen
      senderNumber = senderNumber.replace(/[^0-9]/g, "");

      const pushName = msg.pushName || "Unbekannt";

      // 3. PushName Fallback (falls die LID neu & noch nicht im Volume gespeichert war)
      if (senderNumber.length > 13 && pushName !== "Unbekannt") {
        const cleanPushName = pushName.toLowerCase().trim();
        if (ADDRESS_BOOK[cleanPushName]) {
          const matchedNumber = ADDRESS_BOOK[cleanPushName];
          // Verknüpfung direkt im Volume speichern, damit es ab jetzt dauerhaft bekannt ist
          registerLidMapping(rawJid, matchedNumber);
          senderNumber = matchedNumber;
          console.log(`[PushName-Fallback] LID für ${pushName} als ${senderNumber} aufgelöst und im Volume gespeichert.`);
        }
      }

      // 4. Empfänger-JID für die Antwort bestimmen
      const senderJid = msg.key.remoteJid;

      // 5. Nachrichtentext extrahieren
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        "";

      if (!text) continue; // Keine Textnachricht -> überspringen

      console.log(`Empfangen von Nummer: ${senderNumber}`);

      // 6. Zugriffsprüfung
      if (!ALLOWED_USERS.includes(senderNumber)) {
        console.log(`Zugriff verweigert für: ${senderNumber} (Name: ${pushName})`);
        continue;
      }

      console.log(
        `Nachricht von ${pushName} (Tel: ${senderNumber}): "${text}"`
      );

      // 7. An Home Assistant senden
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