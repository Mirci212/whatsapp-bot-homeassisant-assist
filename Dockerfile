FROM node:20-alpine

# Git und Build-Tools installieren, da Baileys Git benötigt
RUN apk add --no-cache git

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]