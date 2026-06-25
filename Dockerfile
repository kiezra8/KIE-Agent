FROM node:18-alpine

# git is required by @whiskeysockets/baileys during npm install
RUN apk add --no-cache git

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# auth_info will be mounted as a Fly volume (persistent storage)
VOLUME ["/app/auth_info"]

CMD ["node", "index.js"]
