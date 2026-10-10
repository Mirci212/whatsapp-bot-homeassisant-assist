FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

# Hier nur gezielt die package.json kopieren
COPY package.json ./
RUN npm install

# Rest des Codes kopieren
COPY . .

RUN chmod +x /app/run.sh

CMD [ "/app/run.sh" ]