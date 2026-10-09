FROM node:20-alpine

# Arbeitsverzeichnis im Container
WORKDIR /app

# 1. Nur Package-Dateien kopieren (nutzt Docker Layer Cache optimal)
COPY package*.json ./

# 2. Nur Production-Abhängigkeiten installieren
RUN npm ci --only=production

# 3. Den eigentlichen Anwendungs-Code kopieren
COPY . .

# Port freigeben
EXPOSE 3000

# Start-Befehl
CMD ["node", "index.js"]