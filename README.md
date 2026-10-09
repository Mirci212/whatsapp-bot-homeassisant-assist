# WhatsApp Home Assistant Integration Bot

Ein leichtgewichtiger Node.js-Service zur bidirektionalen Steuerung von Home Assistant über WhatsApp. Der Bot nutzt die Baileys-Bibliothek für die WhatsApp-Anbindung und kommuniziert direkt mit dem Home Assistant Conversation API Endpoint (`/api/conversation/process`) unter Einsatz von Gemini / Assist.

## Features

- **Sprachsteuerung via Text:** Leitet eingehende WhatsApp-Nachrichten direkt an den Home Assistant Conversation Agenten weiter.
- **Absender-Kontext:** Überträgt den WhatsApp-Namen (`[Absender: Name]`), damit das LLM personalisiert auf den Benutzer eingehen kann.
- **Strenges Rufnummern-Whitelisting:** Zugriffsschutz direkt in der `.env` über zugelassene Telefonnummern.
- **Position basiertes Namens-Mapping:** Dynamisches Zuordnen von Namen zu Telefonnummern für vereinfachte Webhook-Pushs.
- **REST-Webhook für Push-Nachrichten:** Bietet einen Express-Endpunkt (`/send-message`), über den Home Assistant (z. B. via Automatisierung) Nachrichten an Kontakte oder Nummern senden kann.

---

## Voraussetzungen

- **Node.js:** v18 oder neuer
- **Home Assistant:** Lauffähige Instanz mit erstelltem Long-Lived Access Token (Langlebiges Zugangs-Token)
- **LLM Integration:** Konfigurierter Conversation Agent in HA (z. B. Google Generative AI / Gemini Integration)

---

## Installation

1. Repository klonen oder Projektordner erstellen.
2. Erforderliche Abhängigkeiten installieren:
```bash
   npm install @whiskeysockets/baileys axios express node-cache qrcode-terminal dotenv
```

3. Eine Datei namens `.env` im Hauptverzeichnis anlegen (siehe Konfiguration unten).
4. Bot starten:
```bash
node index.js

```


5. Den im Terminal generierten QR-Code mit WhatsApp scannen (*WhatsApp > Verknüpfte Geräte > Gerät verknüpfen*).

---

## Konfiguration (`.env`)

Das System nutzt eine einfache Positions-Zuordnung: Das erste Element in `USER_MAPPING` gehört zur ersten Nummer in `ALLOWED_NUMBERS`, das zweite zum zweiten und so weiter.

Erstelle eine `.env`-Datei im Stammverzeichnis:

```ini
# Zeitzone
TZ=Europe/Vienna

# Server & Home Assistant Netzwerkeinstellungen
PORT=3000
HA_URL=[http://192.168.0.2:8123](http://192.168.0.2:8123)
HA_TOKEN=dein_long_lived_access_token_hier

# Explizite ID des Conversation Agent in HA (z.B. conversation.google_generative_ai)
CONVERSATION_AGENT=conversation.google_generative_ai

# Erlaubte Telefonnummern (mit Landesvorwahl, ohne +, kommagetrennt)
ALLOWED_NUMBERS=436601234567,436649876543

# Namens-Mapping für Webhook Push (Positionen müssen zu ALLOWED_NUMBERS passen!)
USER_MAPPING=marco,brigitte

```

---

## Webhook Endpunkt (`/send-message`)

Home Assistant kann Push-Benachrichtigungen über den Bot an WhatsApp-Nutzer senden.

* **Methode:** `POST`
* **URL:** `http://<bot-ip>:3000/send-message`
* **Header:** `Content-Type: application/json`

### Beispiel 1: Nachricht per Name senden

Sendet die Nachricht an die Nummer, die an der gleichen Position wie `"marco"` in `USER_MAPPING` steht.

```json
{
  "recipient": "marco",
  "message": "Das Garagentor ist noch offen!"
}

```

### Beispiel 2: Nachricht direkt an Telefonnummer senden

Falls ein Name nicht gemappt ist, kann auch direkt eine Nummer übergeben werden.

```json
{
  "recipient": "436601234567",
  "message": "Wichtige Systembenachrichtigung."
}

```

### Fehlerbehandlung

Wird ein Name übergeben, der nicht in `USER_MAPPING` hinterlegt ist, antwortet der Webhook mit HTTP Status `404 Not Found`:

```json
{
  "error": "Name \"peter\" wurde im USER_MAPPING nicht gefunden."
}

```

---

## Home Assistant REST Command Einbindung

Um den Webhook direkt aus Home Assistant-Automatisierungen aufzurufen, füge folgendes in deine `configuration.yaml` ein:

```yaml
rest_command:
  send_whatsapp:
    url: "[http://192.168.0.](http://192.168.0.)x:3000/send-message"
    method: POST
    headers:
      content-type: "application/json"
    payload: '{"recipient": "{{ recipient }}", "message": "{{ message }}"}'

```

Aufruf in einer Automatisierung:

```yaml
action: rest_command.send_whatsapp
data:
  recipient: "marco"
  message: "Die Waschmaschine ist fertig!"

```
