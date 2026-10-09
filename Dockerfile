FROM node:20-alpine

# ffmpeg für die Audio-Konvertierung installieren
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000
CMD ["node", "index.js"]