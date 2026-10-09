const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const axios = require("axios");
const qrcode = require("qrcode-terminal");
const express = require("express");
const NodeCache = require("node-cache");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

try {
  require("dotenv").config({ override: false });
} catch (e) {
  // In Docker / Portainer werden ENV-Variablen direkt geladen
}

const HA_URL = process.env.HA_URL || "http://192.168.0.2:8123";
const HA_TOKEN = process.env.HA_TOKEN;
const CONVERSATION_AGENT = process.env.CONVERSATION_AGENT || null;
const STT_ENGINE = process.env.STT_ENGINE || null; // z.B. stt.faster_whisper oder stt.whisper
const TTS_ENGINE = process.env.TTS_ENGINE || null; // z.B. tts.piper oder tts.google_translate
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

  if (cleanLid && cleanPhone && cleanPhone.length <= 13 && autoLidMap[cleanLid] !== cleanPhone) {
    autoLidMap[cleanLid] = cleanPhone;
    saveLidCache();
    console.log(`[LID-Cache] Neu verknüpft: LID (${cleanLid}) -> Phone (${cleanPhone})`);
  }
}

// -------------------------------------------------------------
// Conversation Memory (In-Memory Variable)
// -------------------------------------------------------------
const userConversations = {}; // Nummer -> conversation_id

const msgRetryCounterCache = new NodeCache();
let sock;

/**
 * Wandelt Text via Home Assistant TTS in eine Sprachnachricht um
 */
async function textToSpeech(text) {
  if (!TTS_ENGINE) return null;

  try {
    // 1. HA-Dienst aufrufen, um TTS zu erzeugen
    const response = await axios.post(
      `${HA_URL}/api/services/tts/speak`,
      {
        engine_id: TTS_ENGINE,
        media_player_entity_id: "media_player.dummy", // Wird für die Dateigenerierung benötigt
        message: text,
        language: "de"
      },
      {
        headers: {
          Authorization: `Bearer ${HA_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Alternative: Direkter Fallback auf tts_get_url mit Fehler-Logging
    const urlResponse = await axios.post(
      `${HA_URL}/api/tts_get_url`,
      {
        engine_id: TTS_ENGINE,
        message: text,
        language: "de",
      },
      {
        headers: {
          Authorization: `Bearer ${HA_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (urlResponse.data?.url) {
      return `${HA_URL}${urlResponse.data.url}`;
    }
  } catch (error) {
    console.error("[HA TTS] Fehler bei TTS-Generierung:", error.response?.data || error.message);
  }
  return null;
}

/**
 * Sendet Sprachnachrichten an den Home Assistant STT Endpoint (Whisper)
 */
async function transcribeAudio(msg) {
  if (!STT_ENGINE) {
    console.error("[HA STT] Keine STT_ENGINE in .env konfiguriert.");
    return null;
  }

  const tmpOggPath = path.join(__dirname, `tmp_${Date.now()}.ogg`);
  const tmpWavPath = path.join(__dirname, `tmp_${Date.now()}.wav`);

  try {
    // 1. OGG-Audio aus WhatsApp herunterladen und temporär speichern
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { reconnect: async () => true }
    );
    fs.writeFileSync(tmpOggPath, buffer);

    // 2. Mit ffmpeg nach WAV konvertieren (16kHz, Mono, 16-bit PCM)
    execSync(`ffmpeg -y -i "${tmpOggPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${tmpWavPath}"`, {
      stdio: "ignore",
    });

    const wavBuffer = fs.readFileSync(tmpWavPath);

    // 3. Konvertiertes WAV an Home Assistant senden
    const response = await axios.post(
      `${HA_URL}/api/stt/${STT_ENGINE}`,
      wavBuffer,
      {
        headers: {
          Authorization: `Bearer ${HA_TOKEN}`,
          "Content-Type": "audio/wav",
          "X-Speech-Content": "language=de; format=wav; codec=pcm; sample_rate=16000; bit_rate=16; channel=1",
        },
      }
    );

    if (response.data && response.data.result === "success") {
      return response.data.text;
    } else {
      console.error("[HA STT] Unerwartetes Antwortformat:", response.data);
      return null;
    }
  } catch (error) {
    console.error(
      "[HA STT] Fehler bei der Transkription:",
      error.response?.data || error.message
    );
    return null;
  } finally {
    // Temporäre Dateien aufräumen
    if (fs.existsSync(tmpOggPath)) fs.unlinkSync(tmpOggPath);
    if (fs.existsSync(tmpWavPath)) fs.unlinkSync(tmpWavPath);
  }
}

/**
 * Ermittelt aus JID, LID oder Kontaktbuch die Telefonnummer
 */
async function resolvePhoneNumber(msg, keys) {
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

  const primaryJid = msg.key.remoteJid || "";
  const lidId = primaryJid.split("@")[0].split(":")[0];

  if (autoLidMap[lidId]) {
    return autoLidMap[lidId];
  }

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

  if (msg.pushName) {
    const pushNameLower = msg.pushName.trim().toLowerCase();
    if (ADDRESS_BOOK[pushNameLower]) {
      const matchedNumber = ADDRESS_BOOK[pushNameLower];
      registerLidMapping(lidId, matchedNumber);
      console.log(`[PushName-Match] LID ${lidId} wurde zu ${msg.pushName} (${matchedNumber}) zugeordnet.`);
      return matchedNumber;
    }
  }

  return lidId;
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

      // 1. Textnachrichten extrahieren (alle Typen & Interaktive Elemente)
      let text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        msg.message?.buttonsResponseMessage?.selectedButtonId ||
        msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
        "";

      // 2. Sprachnachricht verarbeiten, falls kein Text vorhanden ist
      const isAudio = Boolean(msg.message?.audioMessage);
      if (!text && isAudio) {
        console.log(`[Audio empfangen] Verarbeite Sprachnachricht von ${pushName}...`);
        text = await transcribeAudio(msg);

        if (text) {
          console.log(`[HA Whisper STT] Transkribiert: "${text}"`);
        } else {
          await sock.sendMessage(senderJid, {
            text: "Fehler: Sprachnachricht konnte nicht transkribiert werden.",
          });
          continue;
        }
      }

      if (!text) continue;

      // Zugriffsprüfung
      if (!ALLOWED_USERS.includes(senderNumber)) {
        console.log(`[Zugriff verweigert] Nummer: ${senderNumber} (LID/Name: ${pushName})`);
        continue;
      }

      const cleanCmd = text.trim().toLowerCase();

      // ---------------------------------------------------------
      // STEUERBEFEHLE & MENÜS
      // ---------------------------------------------------------
      if (cleanCmd === "!reset" || cleanCmd === "/reset" || cleanCmd === "cmd_reset") {
        delete userConversations[senderNumber];
        await sock.sendMessage(senderJid, {
          text: "🔄 Dein Gesprächsverlauf wurde zurückgesetzt.",
        });
        continue;
      }

      if (cleanCmd === "/help" || cleanCmd === "!help" || cleanCmd === "hilfe") {
        const helpMsg =
          "🤖 *Home Assistant WhatsApp-Bot*\n\n" +
          "• *Steuerung:* Schreibe oder sprich einfache Sprachbefehle.\n" +
          "• `/menu` - Öffnet das interaktive Auswahlmenü.\n" +
          "• `!reset` - Setzt den aktuellen Gesprächsverlauf zurück.\n" +
          "• `/status` - Zeigt System-Informationen an.\n" +
          "• `/help` - Zeigt diese Hilfe an.";
        await sock.sendMessage(senderJid, { text: helpMsg });
        continue;
      }

      if (cleanCmd === "/status") {
        const statusMsg =
          "🟢 *System Status*\n\n" +
          `• Home Assistant: ${HA_URL}\n` +
          `• STT Engine: ${STT_ENGINE || "Nicht aktiv"}\n` +
          `• TTS Engine: ${TTS_ENGINE || "Nicht aktiv"}\n` +
          `• Aktiver Agent: ${CONVERSATION_AGENT || "Default"}\n` +
          `• Aktive Session: ${userConversations[senderNumber] ? "Ja" : "Nein"}`;
        await sock.sendMessage(senderJid, { text: statusMsg });
        continue;
      }

      if (cleanCmd === "/menu") {
        const listMessage = {
          text: "Wähle eine Aktion aus oder starte ein Kommando:",
          footer: "Home Assistant WhatsApp Bot",
          title: "🤖 Hauptmenü",
          buttonText: "Optionen anzeigen",
          sections: [
            {
              title: "Schnellbefehle",
              rows: [
                { title: "🔄 Verlauf zurücksetzen", rowId: "cmd_reset", description: "Löscht den Sprach-Kontext" },
                { title: "ℹ️ System Status", rowId: "/status", description: "Verbindungsdetails anzeigen" },
                { title: "❓ Hilfe", rowId: "/help", description: "Anleitung und Befehle" },
              ],
            },
          ],
        };
        await sock.sendMessage(senderJid, listMessage);
        continue;
      }

      console.log(`[Nachricht empfangen] Von ${pushName} (${senderNumber}): "${text}"`);

      // ---------------------------------------------------------
      // AN HOME ASSISTANT ASSIST SENDEN
      // ---------------------------------------------------------
      try {
        const payload = {
          text: `[Absender: ${pushName}] ${text}`,
          language: "de",
        };

        if (CONVERSATION_AGENT) {
          payload.agent_id = CONVERSATION_AGENT;
        }

        if (userConversations[senderNumber]) {
          payload.conversation_id = userConversations[senderNumber];
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

        if (haResponse.data?.conversation_id) {
          userConversations[senderNumber] = haResponse.data.conversation_id;
        }

        const responseText =
          haResponse.data?.response?.speech?.plain?.speech || "Befehl ausgeführt.";

        // Wenn der Absender eine Sprachnachricht geschickt hat UND TTS konfiguriert ist -> Antworte per Sprachnachricht
        let sentAudio = false;
        if (isAudio && TTS_ENGINE) {
          const audioUrl = await textToSpeech(responseText);
          if (audioUrl) {
            await sock.sendMessage(senderJid, {
              audio: { url: audioUrl },
              mimetype: "audio/ogg; codecs=opus",
              ptt: true, // ptt: true macht daraus eine echte Sprachnachricht
            });
            sentAudio = true;
          }
        }

        // Falls keine Sprachnachricht gesendet werden konnte/sollte -> Sende Text
        if (!sentAudio) {
          await sock.sendMessage(senderJid, { text: responseText });
        }
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