FROM node:18-alpine

# Install git and native build tools required by @whiskeysockets/baileys
RUN apk add --no-cache git python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "index.js"]
