FROM node:18-alpine AS builder

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache python3 make g++ tzdata ffmpeg

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

RUN npm prune --omit=dev

# ─────────────────────────────────────────────────────────────────────────────

FROM node:18-alpine

# ffmpeg (with ffprobe) is required at runtime for HEVC live transcode and VOD transcode
RUN apk add --no-cache tzdata ffmpeg

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public ./public
COPY package.json ./

ENTRYPOINT []
CMD ["node", "dist/server.js"]
