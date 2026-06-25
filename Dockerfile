FROM node:20-alpine

# git is required by @whiskeysockets/baileys during npm install
RUN apk add --no-cache git

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "index.js"]
