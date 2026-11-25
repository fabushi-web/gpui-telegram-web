# syntax=docker/dockerfile:1
# ==============================================================================
# Stage 1: Build @gpui-telegram/protocol, @gpui-telegram/server & @gpui-telegram/web
# ==============================================================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

ARG VITE_BASE_PATH=/
ARG VITE_DEFAULT_SERVER_URL=
ENV VITE_BASE_PATH=${VITE_BASE_PATH} \
    VITE_DEFAULT_SERVER_URL=${VITE_DEFAULT_SERVER_URL}

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

RUN npm ci

COPY packages ./packages
COPY apps ./apps

RUN npm run build && npm prune --omit=dev

# ==============================================================================
# Stage 2: Production Full-Stack Runtime (Node.js 22 LTS + SQLite WAL + Chromium CDP)
# ==============================================================================
FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Fabushi Web" \
      org.opencontainers.image.version="1.6.11" \
      org.opencontainers.image.source="https://github.com/fabushiweb/fabushi-web"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Runtime defaults for FABUSHI_CLOUD_GATEWAY_URL (https://api.ombhrum.com),
# FABUSHI_AI_GATEWAY_URL (https://ai.ombhrum.com), GPUI_MASTER_SECRET, and TURN_SECRET
# are resolved in apps/server/src/config.ts so canonical or legacy alias env vars never shadow.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    DATA_DIR=/data \
    CHROMIUM_PATH=/usr/bin/chromium \
    SEED_DEMO_DATA=0 \
    ALLOW_DEMO_AUTH=0 \
    EXPOSE_DEV_OTP_CODE=0 \
    ENABLE_TEST_RESET=0

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
