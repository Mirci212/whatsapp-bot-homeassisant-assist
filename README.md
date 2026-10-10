# WhatsApp Home Assistant Integration Bot

[![Open your Home Assistant instance and show the add add-on repository dialog with a specific URL](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https://github.com/Mirci212/whatsapp-bridge-homeassisant)

Ein robuster und funktionsreicher Node.js-Service zur bidirektionalen Steuerung von Home Assistant über WhatsApp. Der Bot nutzt die Baileys-Library für die WhatsApp-Anbindung und kommuniziert nahtlos mit Home Assistant (Conversation API, STT, TTS und Webhooks).

---

## Features

- **Sprach- & Textsteuerung:** Leitet eingehende Nachrichten (sowie transkribierte Sprachnachrichten via Whisper) direkt an den Home Assistant Conversation Agenten weiter.
- **Interaktive Umfragen & Nachrichten:** Webhook-APIs zum Senden von Textnachrichten (`/send-message`) und Umfragen/Polls (`/send-poll`) – perfekt für UI-Skripte in Home Assistant.
- **Admin-Steuerung per Chat:** Der definierte Administrator kann im laufenden Betrieb Agenten, TTS- und STT-Engines wechseln, den Bot neu starten oder Chats bereinigen.
- **Tägliche Bot-Chat-Bereinigung:** Löscht alte Chats automatisch auf der Bot-Seite, damit der WhatsApp-Speicher nicht überläuft (plus manueller `/clean`-Befehl).
- **Zahlen-Fallback-Menü:** Einfache Zifferneingaben (`1`, `2`, `3`) als stabile Alternative zu interaktiven Buttons.
- **Dual-Deployment:** Kann sowohl als offizielles **Home Assistant Add-on** (aus dem Repository im Unterordner `whatsapp_bridge`)[cite: 3, 4] als auch als **Standalone Docker Container** (über GHCR) betrieben werden.

---

## 🚀 Installation & Deployment

Du hast zwei Möglichkeiten, diesen Bot zu betreiben:

### Option A: Als Home Assistant Add-on (Empfohlen)

1. Klicke auf den Button oben oder füge dein Repository manuell in Home Assistant unter **Einstellungen -> Add-ons -> Add-on Store -> 3 Punkte -> Repositories** hinzu.
2. Installiere das **WhatsApp Home Assistant Bridge** Add-on aus der Liste.
3. Trage im Tab **Konfiguration** deine Admin-Nummer, erlaubten Nutzer und API-Daten ein.
4. Starte das Add-on.

### Option B: Als Docker Container / Portainer (GHCR)

Verwende folgendes `docker-compose.yml`-Beispiel:

```yaml
services:
  whatsapp-ha-bridge:
    image: ghcr.io/DeinGitHubBenutzer/whatsapp-bridge-homeassistant:latest
    container_name: whatsapp_ha_bridge
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - TZ=Europe/Vienna
      - HA_URL=http://192.168.0.X:8123
      - HA_TOKEN=dein_long_lived_access_token_hier
      - ADMIN_NUMBER=436****
      - ALLOWED_USERS=436****:Marco,436***:Brigitte
      - CONVERSATION_AGENT=conversation.google_generative_ai
      - STT_ENGINE=stt.whisper
      - TTS_ENGINE=tts.piper
    volumes:
      - ha_bridge_auth:/app/auth_info_baileys

volumes:
  ha_bridge_auth:

```

---

## 🕹️ Bot-Befehle im Chat

Eingehende Nachrichten von erlaubten Nummern werden verarbeitet. Zusätzlich stehen folgende Befehle zur Verfügung:

### Allgemeine Befehle (für alle erlaubten Nutzer)

* `1` oder `!reset` — Setzt den KI-Gesprächsverlauf zurück.
* `2` oder `/status` — Zeigt den aktuellen Systemstatus an.
* `3` oder `/help` — Zeigt die Hilfe an.
* `/ping` — Prüft die Erreichbarkeit und Laufzeit.
* `/whoami` — Zeigt das eigene Benutzerprofil an.

### 👑 Admin-Befehle (nur für `ADMIN_NUMBER`)

* `/setagent [id]` — Setzt den Agenten oder listet alle verfügbaren HA-Agenten auf.
* `/settts [id]` — Setzt die TTS-Engine oder zeigt Optionen.
* `/setstt [id]` — Setzt die STT-Engine oder zeigt Optionen.
* `/clean` — Räumt sofort alle Chats auf der Bot-Seite auf.
* `/restart` — Startet den Bot-Dienst neu.

---

## 🔌 API Endpunkte & Home Assistant Integration

Der integrierte Webhook-Server stellt zwei Endpunkte zur Verfügung:

### 1. Nachricht senden (`/send-message`)

* **Methode:** `POST`
* **URL:** `http://<bot-ip>:3000/send-message`
* **Payload:**
```json
{
  "recipient": "Marco",
  "message": "Das Garagentor ist noch offen!"
}

```



### 2. Umfrage senden (`/send-poll`) — Neu!

* **Methode:** `POST`
* **URL:** `http://<bot-ip>:3000/send-poll`
* **Payload:**
```json
{
  "recipient": "Marco",
  "title": "Soll das Licht ausgeschaltet werden?",
  "options": ["Ja, bitte", "Nein, angelassen"]
}

```



---

## 🏠 Home Assistant REST Commands & Skripte

Füge dies in deine `configuration.yaml` ein, um die Endpunkte anzusprechen:

```yaml
rest_command:
  whatsapp_send_message:
    url: "[http://192.168.0.2:3000/send-message](http://192.168.0.2:3000/send-message)"
    method: POST
    headers:
      Content-Type: "application/json"
    payload: >
      {
        "recipient": "{{ recipient }}",
        "message": "{{ message }}"
      }

  whatsapp_send_poll:
    url: "[http://192.168.0.2:3000/send-poll](http://192.168.0.2:3000/send-poll)"
    method: POST
    headers:
      Content-Type: "application/json"
    payload: >
      {
        "recipient": "{{ recipient }}",
        "title": "{{ title }}",
        "options": {{ options | to_json }}
      }

```