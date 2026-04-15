# Simple Dockerfile for the HA ↔ OpenClaw bridge
FROM node:22-alpine

WORKDIR /app

# Install dependencies first (better cache behavior)
COPY package*.json ./
RUN npm install --omit=dev

# Copy application code
COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "index.js"]
