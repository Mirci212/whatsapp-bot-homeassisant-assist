FROM node:20-alpine

# Git und Build-Tools für npm-Abhängigkeiten installieren, plus FFmpeg für Audio
RUN apk add --no-cache ffmpeg git python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

RUN chmod +x /app/run.sh

CMD [ "/app/run.sh" ]