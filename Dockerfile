# Simple Dockerfile for the HA ↔ OpenClaw bridge
FROM node:22-alpine

WORKDIR /app

# Install dependencies first (better cache behavior)
COPY package*.json ./
RUN npm install --omit=dev

# Copy application code
COPY . .

# Add SSH client so the bridge can perform read-only diagnostics against
# other hosts (for example checking Plex patch status) when configured
# to do so, and curl for UniFi controller queries.
RUN apk add --no-cache openssh-client curl

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "index.js"]
