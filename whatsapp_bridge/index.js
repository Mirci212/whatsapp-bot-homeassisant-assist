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
const WEBHOOK_PORT = process.env.PORT || 3000;

// Admin-Nummer bereinigen (nur Ziffern)
const ADMIN_NUMBER = process.env.ADMIN_NUMBER ? process.env.ADMIN_NUMBER.replace(/[^0-9]/g, "") : "";

// Dynamische Laufzeit-Variablen
let currentAgent = process.env.CONVERSATION_AGENT || null;
let currentStt = process.env.STT_ENGINE || null;
let currentTts = process.env.TTS_ENGINE || null;

// -------------------------------------------------------------
// Persistenter Chat-Cache (überlebt Container-Neustarts)
// -------------------------------------------------------------
const CHAT_CACHE_FILE = path.join(__dirname, "auth_info_baileys", "known_chats.json");
const knownChats = new Set();

if (fs.existsSync(CHAT_CACHE_FILE)) {
  try {
    const savedChats = JSON.parse(fs.readFileSync(CHAT_CACHE_FILE, "utf-8"));
    savedChats.forEach(jid => knownChats.add(jid));
  } catch (e) {
    console.error("[Chat-Cache] Fehler beim Laden:", e.message);
  }
}

function saveChatCache() {
  try {
    const dir = path.dirname(CHAT_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CHAT_CACHE_FILE, JSON.stringify([...knownChats], null, 2));
  } catch (e) {
    console.error("[Chat-Cache] Fehler beim Speichern:", e.message);
  }
}

// Parsing der ALLOWED_USERS
const ALLOWED_USERS = []; 
const ADDRESS_BOOK = {};  
const NUMBER_TO_NAME = {};

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

if (ADMIN_NUMBER && !ALLOWED_USERS.includes(ADMIN_NUMBER)) {
  ALLOWED_USERS.push(ADMIN_NUMBER);
}

// Persistent LID-Cache System
const LID_CACHE_FILE = path.join(__dirname, "auth_info_baileys", "lid_cache.json");
const autoLidMap = {};

if (fs.existsSync(LID_CACHE_FILE)) {
  try {
    const savedLids = JSON.parse(fs.readFileSync(LID_CACHE_FILE, "utf-8"));
    Object.assign(autoLidMap, savedLids);
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
  }
}

const userConversations = {}; 
const msgRetryCounterCache = new NodeCache();
let sock;
let authState = null;

// Letzte bekannte Nachricht pro Chat (für chatModify delete nötig).
// Baileys verlangt echte key.id + messageTimestamp, kein ""-Platzhalter.
const lastMessageCache = new Map();

function trackChatMessage(jid, msg) {
  if (!jid || !msg?.key?.id) return;
  if (jid === "status@broadcast") return;
  // messageTimestamp kann bei eigenen gesendeten Nachrichten fehlen -> jetzt setzen
  const ts = msg.messageTimestamp || Math.floor(Date.now() / 1000);
  lastMessageCache.set(jid, {
    key: {
      remoteJid: msg.key.remoteJid || jid,
      id: msg.key.id,
      fromMe: Boolean(msg.key.fromMe),
      ...(msg.key.participant ? { participant: msg.key.participant } : {}),
    },
    messageTimestamp: ts,
  });
  // Merke zusätzlich die letzten Keys pro Chat für Fallback-Einzellöschung
  if (!trackChatMessage.recent) trackChatMessage.recent = new Map();
  const arr = trackChatMessage.recent.get(jid) || [];
  arr.push({ key: { remoteJid: msg.key.remoteJid || jid, id: msg.key.id, fromMe: Boolean(msg.key.fromMe) } });
  if (arr.length > 20) arr.splice(0, arr.length - 20);
  trackChatMessage.recent.set(jid, arr);
  if (!knownChats.has(jid)) {
    knownChats.add(jid);
    saveChatCache();
  }
}

// Prüft, ob der App-State-Key für chatModify (clear/delete) vorhanden ist.
async function getAppStateDiag() {
  try {
    const keyId = authState?.creds?.myAppStateKeyId;
    if (!keyId) return { ok: false, reason: "myAppStateKeyId fehlt (Sync noch nicht fertig oder Session unvollständig)" };
    let stored = null;
    try {
      const res = await authState.keys.get("app-state-sync-key", [keyId]);
      stored = res?.[keyId];
    } catch (e) {
      return { ok: false, reason: `Key-Store Fehler: ${e.message}` };
    }
    if (!stored) return { ok: false, reason: `app-state-sync-key "${keyId}" nicht im Store (Volume/Session prüfen)` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// PN-Fallback für @lid-Chats: falls Mapping bekannt, zusätzlich PN-JID versuchen
function getPnFallbackJid(jid) {
  if (!jid?.endsWith("@lid")) return null;
  const lid = jid.split("@")[0].split(":")[0];
  const pn = autoLidMap[lid];
  if (pn) return `${pn}@s.whatsapp.net`;
  return null;
}

function isTrackableChatJid(jid) {
  if (!jid || typeof jid !== "string") return false;
  return (
    jid.endsWith("@s.whatsapp.net") ||
    jid.endsWith("@lid") ||
    jid.endsWith("@g.us")
  );
}

/**
 * Löscht alle bekannten Bot-Chats vollständig (nur auf Bot-Seite!
 * "Für alle löschen" geht via Baileys nicht für ganze Chats).
 */
async function cleanupOldChats() {
  if (!sock) return { cleared: 0, failed: 0, details: [] };
  console.log("[Reinigung] Starte das Aufräumen und Löschen aller Chats...");
  let cleared = 0;
  let failed = 0;
  const details = [];
  const done = [];

  const diag = await getAppStateDiag();
  if (!diag.ok) {
    console.warn(`[Reinigung] App-State-Key fehlt: ${diag.reason} -> versuche Einzelnachrichten-Fallback.`);
  }

  // Baileys App-State neu syncen, falls Methode vorhanden (hilft nach Reconnect)
  if (!diag.ok && typeof sock?.resyncAppState === "function") {
    try {
      await sock.resyncAppState(["critical_unblock_low", "regular_high", "regular_low", "critical_block"]);
      console.log("[Reinigung] App-State Resync angestoßen.");
    } catch (e) {
      console.warn("[Reinigung] Resync fehlgeschlagen:", e.message);
    }
  }

  for (const jid of [...knownChats]) {
    // Kandidaten: erst Original-JID, dann PN-Fallback bei @lid
    const candidates = [jid];
    const pnFallback = getPnFallbackJid(jid);
    if (pnFallback && pnFallback !== jid) candidates.push(pnFallback);

    let ok = false;
    let lastErr = null;

    for (const target of candidates) {
      try {
        // 1. Verlauf auf Bot-Seite leeren
        try {
          await sock.chatModify({ clear: true }, target);
        } catch (clearErr) {
          console.warn(`[Reinigung] Clear für ${target} fehlgeschlagen:`, clearErr.message);
          // Clear-Fehler ist fatal für diesen Kandidaten -> nächsten versuchen
          lastErr = clearErr;
          continue;
        }

        // 2. Chat aus der Chatliste entfernen (braucht ECHTE letzte Nachricht)
        const lastMsg = lastMessageCache.get(jid) || lastMessageCache.get(target);
        if (lastMsg?.key?.id && lastMsg.messageTimestamp) {
          const fixedLast = {
            key: { ...lastMsg.key, remoteJid: target },
            messageTimestamp: lastMsg.messageTimestamp,
          };
          await sock.chatModify({ delete: true, lastMessages: [fixedLast] }, target);
        } else {
          console.warn(`[Reinigung] Keine letzte Nachricht für ${jid} bekannt, nur Verlauf geleert.`);
        }
        ok = true;
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`[Reinigung] Kandidat ${target} fehlgeschlagen:`, err.message);
      }
    }

    // Fallback: einzelne eigene Nachrichten zurückrufen, wenn chatModify am App-State-Key scheitert
    if (!ok && lastErr?.message?.includes("App state key")) {
      const recent = trackChatMessage.recent?.get(jid) || [];
      // Nur eigene Nachrichten können per "delete for everyone" zurückgerufen werden
      const ownKeys = recent.filter(r => r.key.fromMe).slice(-10);
      // Falls keine eigenen Keys bekannt: zumindest letzte bekannte eigene Nachricht aus lastMessageCache
      if (!ownKeys.length) {
        const lm = lastMessageCache.get(jid);
        if (lm?.key?.fromMe) ownKeys.push({ key: lm.key });
      }
      if (ownKeys.length) {
        let deleted = 0;
        for (const r of ownKeys) {
          try {
            await sock.sendMessage(jid, { delete: r.key });
            deleted++;
          } catch (e) {
            console.warn(`[Reinigung] Einzellöschung fehlgeschlagen:`, e.message);
          }
        }
        if (deleted > 0) {
          ok = true;
          details.push(`⚠️ ${jid}: Chat-Delete ohne App-State-Key nicht möglich, aber ${deleted} eigene Nachrichten zurückgerufen.`);
          done.push(jid);
          lastMessageCache.delete(jid);
          cleared++;
          continue;
        }
      }
    }

    if (ok) {
      done.push(jid);
      lastMessageCache.delete(jid);
      cleared++;
      console.log(`[Reinigung] Chat bereinigt: ${jid}`);
      details.push(`✅ ${jid}`);
    } else {
      failed++;
      const msg = lastErr?.message || "unbekannt";
      console.error(`[Reinigung] Konnte Chat ${jid} nicht löschen:`, msg);
      if (msg.includes("App state key")) {
        details.push(`❌ ${jid}: App-State-Key fehlt (${diag.reason || msg}). Fix: Bot einmal neu koppeln (QR), Volume auth_info_baileys prüfen, nach Connect 1-2 Min Sync abwarten, dann /clean erneut.`);
      } else {
        details.push(`❌ ${jid}: ${msg}`);
      }
    }
  }

  // Erfolgreich bereinigte Chats aus dem Cache entfernen, damit die Liste nicht ewig wächst
  for (const jid of done) knownChats.delete(jid);
  if (done.length) saveChatCache();

  console.log(`[Reinigung] ${cleared} Chats bereinigt, ${failed} Fehler.`);
  return { cleared, failed, details, appState: diag };
}

/**
 * Hilfsfunktion zum Abrufen von verfügbaren Conversation Agents aus Home Assistant
 */
async function fetchAvailableAgents() {
  try {
    const res = await axios.get(`${HA_URL}/api/states`, {
      headers: { Authorization: `Bearer ${HA_TOKEN}` }
    });
    return res.data
      .filter(e => e.entity_id.startsWith("conversation."))
      .map(e => `• \`${e.entity_id}\` (${e.attributes.friendly_name || e.entity_id})`);
  } catch (e) {
    return ["Fehler beim Abrufen der Agenten aus Home Assistant."];
  }
}

function resolveTargetJid(recipient) {
  const cleanRecipient = recipient.toLowerCase().trim();
  let targetNumber = ADDRESS_BOOK[cleanRecipient];

  if (!targetNumber) {
    const isNumeric = /^\+?\d+$/.test(cleanRecipient);
    if (isNumeric) {
      targetNumber = cleanRecipient.replace("+", "").trim();
    } else {
      return null;
    }
  }
  return `${targetNumber}@s.whatsapp.net`;
}

async function textToSpeech(text) {
  if (!currentTts) return null;

  try {
    const urlResponse = await axios.post(
      `${HA_URL}/api/tts_get_url`,
      {
        engine_id: currentTts,
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

async function transcribeAudio(msg) {
  if (!currentStt) {
    console.error("[HA STT] Keine STT_ENGINE aktiv.");
    return null;
  }

  const uniqueId = Date.now();
  const tmpOggPath = path.join(__dirname, `tmp_${uniqueId}.ogg`);
  const tmpWavPath = path.join(__dirname, `tmp_${uniqueId}.wav`);

  try {
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { reconnect: async () => true }
    );
    fs.writeFileSync(tmpOggPath, buffer);

    execSync(`ffmpeg -y -i "${tmpOggPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${tmpWavPath}"`, {
      stdio: "ignore",
    });

    const wavBuffer = fs.readFileSync(tmpWavPath);

    const response = await axios.post(
      `${HA_URL}/api/stt/${currentStt}`,
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
    console.error("[HA STT] Fehler bei der Transkription:", error.response?.data || error.message);
    return null;
  } finally {
    try {
      if (fs.existsSync(tmpOggPath)) fs.unlinkSync(tmpOggPath);
      if (fs.existsSync(tmpWavPath)) fs.unlinkSync(tmpWavPath);
    } catch (e) {}
  }
}

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
  } catch (err) {}

  if (msg.pushName) {
    const pushNameLower = msg.pushName.trim().toLowerCase();
    if (ADDRESS_BOOK[pushNameLower]) {
      const matchedNumber = ADDRESS_BOOK[pushNameLower];
      registerLidMapping(lidId, matchedNumber);
      return matchedNumber;
    }
  }

  return lidId;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info_baileys");
  authState = state;

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

      // Timer nur einmal anlegen (sonst bei jedem Reconnect ein weiterer Interval)
      if (!global.__waCleanupTimer) {
        global.__waCleanupTimer = setInterval(cleanupOldChats, 24 * 60 * 60 * 1000);
        setTimeout(cleanupOldChats, 60_000);
      }
    }
  });

  // Eigene gesendete Nachrichten mittracken (für späteren Delete nötig)
  const origSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content, options) => {
    const sent = await origSendMessage(jid, content, options);
    if (sent?.key?.id && isTrackableChatJid(jid)) {
      trackChatMessage(jid, sent);
    }
    return sent;
  };

  // Historie beim Connect mitnehmen, damit /clean auch alte Chats kennt
  sock.ev.on("messaging-history.set", ({ chats, messages }) => {
    for (const c of chats || []) {
      if (isTrackableChatJid(c.id) && !knownChats.has(c.id)) {
        knownChats.add(c.id);
      }
    }
    for (const m of messages || []) {
      const jid = m.key?.remoteJid;
      if (isTrackableChatJid(jid)) trackChatMessage(jid, m);
    }
    saveChatCache();
  });

  sock.ev.on("messages.upsert", async (m) => {
    for (const msg of m.messages) {
      const senderJid = msg.key.remoteJid;
      if (isTrackableChatJid(senderJid)) {
        trackChatMessage(senderJid, msg);
      }

      if (msg.key.fromMe) continue;

      const senderNumber = await resolvePhoneNumber(msg, state.keys);
      const pushName = msg.pushName || NUMBER_TO_NAME[senderNumber] || "Unbekannt";
      const isAdmin = ADMIN_NUMBER && senderNumber === ADMIN_NUMBER;

      let text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        "";

      const isAudio = Boolean(msg.message?.audioMessage);
      if (!text && isAudio) {
        console.log(`[Audio empfangen] Verarbeite Sprachnachricht von ${pushName}...`);
        text = await transcribeAudio(msg);

        if (!text) {
          await sock.sendMessage(senderJid, {
            text: "Fehler: Sprachnachricht konnte nicht transkribiert werden.",
          });
          continue;
        }
      }

      if (!text) continue;

      if (!ALLOWED_USERS.includes(senderNumber)) {
        console.log(`[Zugriff verweigert] Nummer: ${senderNumber} (Name:${pushName})`);
        continue;
      }

      let cleanCmd = text.trim().toLowerCase();

      // Schnell-Zahlen aus dem Menü
      if (cleanCmd === "1") cleanCmd = "!reset";
      if (cleanCmd === "2") cleanCmd = "/status";
      if (cleanCmd === "3") cleanCmd = "/help";

      // ---------------------------------------------------------
      // STEUERBEFEHLE & ADMIN-BEFEHLE
      // ---------------------------------------------------------
      if (cleanCmd === "!reset" || cleanCmd === "/reset" || cleanCmd === "cmd_reset" || cleanCmd.includes("verlauf zurücksetzen")) {
        delete userConversations[senderNumber];
        await sock.sendMessage(senderJid, {
          text: "🔄 Dein Gesprächsverlauf wurde zurückgesetzt.",
        });
        continue;
      }

      if (cleanCmd === "/help" || cleanCmd === "!help" || cleanCmd === "hilfe" || cleanCmd.includes("hilfe")) {
        let helpMsg =
          "🤖 *Home Assistant WhatsApp-Bot*\n\n" +
          "• *Steuerung:* Schreibe oder sprich einfache Sprachbefehle.\n" +
          "• `1` oder `!reset` - Setzt den Gesprächsverlauf zurück.\n" +
          "• `2` oder `/status` - Zeigt System-Informationen an.\n" +
          "• `/ping` - Bot-Erreichbarkeit & Laufzeit.\n" +
          "• `/whoami` - Zeigt deine Benutzerinfo.";

        if (isAdmin) {
          helpMsg += 
            "\n\n👑 *Admin-Befehle:*\n" +
            "• `/setagent [id]` - Agent setzen oder alle anzeigen\n" +
            "• `/settts [id]` - TTS-Engine setzen oder anzeigen\n" +
            "• `/setstt [id]` - STT-Engine setzen oder anzeigen\n" +
            "• `/clean` - Löscht alle Chats vollständig\n" +
            "• `/restart` - Startet den Bot neu";
        }

        await sock.sendMessage(senderJid, { text: helpMsg });
        continue;
      }

      if (cleanCmd === "/status") {
        const statusMsg =
          "🟢 *System Status*\n\n" +
          `• Home Assistant: ${HA_URL}\n` +
          `• STT Engine: ${currentStt || "Nicht aktiv"}\n` +
          `• TTS Engine: ${currentTts || "Nicht aktiv"}\n` +
          `• Aktiver Agent: ${currentAgent || "Default"}\n` +
          `• Admin-Modus: ${isAdmin ? "Aktiv (" + senderNumber + ")" : "Nein"}\n` +
          `• Aktive Session: ${userConversations[senderNumber] ? "Ja" : "Nein"}`;
        await sock.sendMessage(senderJid, { text: statusMsg });
        continue;
      }

      if (cleanCmd === "/ping") {
        const uptimeSeconds = Math.floor(process.uptime());
        await sock.sendMessage(senderJid, { text: `🏓 Pong! Bot läuft stabil.\n⏱️ Laufzeit: ${uptimeSeconds} Sekunden` });
        continue;
      }

      if (cleanCmd === "/whoami") {
        await sock.sendMessage(senderJid, { text: `👤 *Dein Profil*\n\n• Name: ${pushName}\n• Nummer: ${senderNumber}\n• Admin: ${isAdmin ? "Ja 👑" : "Nein"}` });
        continue;
      }

      // --- ADMIN: CHATS BEREINIGEN ---
      if (cleanCmd === "/clean" || cleanCmd === "/deletechats") {
        if (!isAdmin) {
          await sock.sendMessage(senderJid, { text: "❌ Dieser Befehl ist nur dem Administrator vorbehalten." });
          continue;
        }
        await sock.sendMessage(senderJid, { text: "🧹 Lösche alle Chats und Verläufe (nur auf Bot-Seite, nicht bei den Kontakten)..." });
        const result = await cleanupOldChats();
        let reply = `✅ Fertig! ${result.cleared} Chats bereinigt`;
        if (result.failed) reply += `, ${result.failed} Fehler`;
        reply += ".";
        if (result.appState && !result.appState.ok) {
          reply += `\n\n⚠️ App-State-Key fehlt: ${result.appState.reason}`;
          reply += "\nFix: 1) Volume auth_info_baileys prüfen (muss persistent sein), 2) nach Connect 1-2 Min Sync abwarten, 3) sonst Bot einmal neu koppeln (Session löschen + QR scannen).";
        }
        if (result.details?.length) {
          const short = result.details.slice(0, 20).join("\n");
          reply += `\n\n${short}`;
          if (result.details.length > 20) reply += `\n… +${result.details.length - 20} weitere`;
        }
        reply += "\n\nℹ️ Hinweis: WhatsApp erlaubt kein Löschen beim Kontakt – dort bleibt der Verlauf sichtbar.";
        await sock.sendMessage(senderJid, { text: reply });
        continue;
      }

      // --- ADMIN: AGENT SETZEN ODER AUFLISTEN ---
      if (cleanCmd.startsWith("/setagent")) {
        if (!isAdmin) {
          await sock.sendMessage(senderJid, { text: "❌ Dieser Befehl ist nur dem Administrator vorbehalten." });
          continue;
        }
        const newAgent = text.replace("/setagent", "").trim();
        if (!newAgent) {
          const agents = await fetchAvailableAgents();
          await sock.sendMessage(senderJid, {
            text: `🤖 *Verfügbare Conversation Agents in HA:*\nAktuell aktiv: \`${currentAgent || "Default"}\`\n\n` + agents.join("\n") + `\n\nNutze: \`/setagent <entity_id>\``
          });
        } else {
          currentAgent = newAgent;
          await sock.sendMessage(senderJid, { text: `✅ Konversations-Agent geändert zu:\n\`${currentAgent}\`` });
        }
        continue;
      }

      // --- ADMIN: TTS ENGINE SETZEN ODER AUFLISTEN ---
      if (cleanCmd.startsWith("/settts")) {
        if (!isAdmin) {
          await sock.sendMessage(senderJid, { text: "❌ Dieser Befehl ist nur dem Administrator vorbehalten." });
          continue;
        }
        const newTts = text.replace("/settts", "").trim();
        if (!newTts) {
          await sock.sendMessage(senderJid, {
            text: `🗣️ *TTS Engine*\nAktuell aktiv: \`${currentTts || "Nicht aktiv"}\`\n\nGib den Namen der Engine ein (z. B. \`/settts tts.piper\` oder \`/settts google_translate_say\`).`
          });
        } else {
          currentTts = newTts;
          await sock.sendMessage(senderJid, { text: `✅ TTS-Engine geändert zu:\n\`${currentTts}\`` });
        }
        continue;
      }

      // --- ADMIN: STT ENGINE SETZEN ODER AUFLISTEN ---
      if (cleanCmd.startsWith("/setstt")) {
        if (!isAdmin) {
          await sock.sendMessage(senderJid, { text: "❌ Dieser Befehl ist nur dem Administrator vorbehalten." });
          continue;
        }
        const newStt = text.replace("/setstt", "").trim();
        if (!newStt) {
          await sock.sendMessage(senderJid, {
            text: `🎙️ *STT Engine*\nAktuell aktiv: \`${currentStt || "Nicht aktiv"}\`\n\nGib den Namen der Engine ein (z. B. \`/setstt stt.faster_whisper\`).`
          });
        } else {
          currentStt = newStt;
          await sock.sendMessage(senderJid, { text: `✅ STT-Engine geändert zu:\n\`${currentStt}\`` });
        }
        continue;
      }

      if (cleanCmd === "/restart") {
        if (!isAdmin) {
          await sock.sendMessage(senderJid, { text: "❌ Dieser Befehl ist nur dem Administrator vorbehalten." });
          continue;
        }
        await sock.sendMessage(senderJid, { text: "🔄 Bot wird im Admin-Auftrag neu gestartet..." });
        setTimeout(() => process.exit(0), 1000);
        continue;
      }

      if (cleanCmd === "/menu") {
        const menuMsg =
          "🤖 *Hauptmenü*\n\n" +
          "Wähle eine Option (einfach Zahl senden):\n\n" +
          "1️⃣ *Verlauf zurücksetzen*\n" +
          "2️⃣ *System Status*\n" +
          "3️⃣ *Hilfe anzeigen*";
        await sock.sendMessage(senderJid, { text: menuMsg });
        continue;
      }

      console.log(`[Nachricht empfangen] Von ${pushName} (${senderNumber}): "${text}"`);

      try {
        const payload = {
          text: `[Absender: ${pushName}] ${text}`,
          language: "de",
        };

        if (currentAgent) {
          payload.agent_id = currentAgent;
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

        let sentAudio = false;
        if (isAudio && currentTts) {
          const audioUrl = await textToSpeech(responseText);
          if (audioUrl) {
            await sock.sendMessage(senderJid, {
              audio: { url: audioUrl },
              mimetype: "audio/ogg; codecs=opus",
              ptt: true,
            });
            sentAudio = true;
          }
        }

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
    const targetJid = resolveTargetJid(recipient);
    if (!targetJid) {
      return res.status(404).json({ error: `Empfänger "${recipient}" nicht gefunden.` });
    }

    if (!knownChats.has(targetJid)) {
      knownChats.add(targetJid);
      saveChatCache();
    }
    await sock.sendMessage(targetJid, { text: message });
    res.json({ success: true });
  } catch (err) {
    console.error("Fehler beim Senden via Webhook:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/send-poll", async (req, res) => {
  const { title, options, recipient } = req.body;

  if (!title || !options || !Array.isArray(options)) {
    return res.status(400).json({ error: "Titel und ein Array von 'options' sind erforderlich." });
  }
  if (!sock) return res.status(503).json({ error: "WhatsApp Bot ist noch nicht verbunden." });
  if (!recipient) return res.status(400).json({ error: "Kein Empfänger angegeben." });

  try {
    const targetJid = resolveTargetJid(recipient);
    if (!targetJid) {
      return res.status(404).json({ error: `Empfänger "${recipient}" nicht gefunden.` });
    }

    if (!knownChats.has(targetJid)) {
      knownChats.add(targetJid);
      saveChatCache();
    }
    await sock.sendMessage(targetJid, {
      poll: {
        name: title,
        values: options,
        selectableCount: 1
      }
    });

    res.json({ success: true, message: "Umfrage erfolgreich gesendet." });
  } catch (err) {
    console.error("Fehler beim Senden der Umfrage via API:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(WEBHOOK_PORT, () => {
  console.log(`Webhook-Server läuft auf Port ${WEBHOOK_PORT}`);
});

startBot();