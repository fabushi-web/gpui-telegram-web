# syntax=docker/dockerfile:1
# ==============================================================================
# Stage 1: Build @gpui-telegram/protocol, @gpui-telegram/server & @gpui-telegram/web
# ==============================================================================
FROM node:24-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

RUN npm ci

COPY packages ./packages
COPY apps ./apps

RUN npm run build && npm prune --omit=dev

# ==============================================================================
# Stage 2: Production Full-Stack Runtime (Node.js 24 + SQLite WAL + Chromium CDP)
# ==============================================================================
FROM node:24-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    DATA_DIR=/data \
    CHROMIUM_PATH=/usr/bin/chromium

RUN mkdir -p /data && chown -R node:node /data /app

COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=builder --chown=node:node /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=builder --chown=node:node /app/apps/web/dist ./apps/web/dist

USER node

VOLUME ["/data"]
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/v1/health" || exit 1

CMD ["node", "apps/server/dist/index.js"]
