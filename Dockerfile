# syntax=docker/dockerfile:1
# =============================================================================
# featherdrop — self-hosted file sharer (Next.js + Mantine, single container)
#
# GitHub:  https://github.com/junkerderprovinz/featherdrop
# Image:   ghcr.io/junkerderprovinz/featherdrop
# License: MIT
#
# Debian-slim base (not alpine) so better-sqlite3's native addon builds and runs
# without musl friction. Multi-stage: deps (with toolchain) -> build -> a lean
# runtime that reuses the deps node_modules (which already has the compiled
# better-sqlite3 binary).
# =============================================================================
ARG NODE_VERSION=22

# -----------------------------------------------------------------------------
# Stage 1 — install dependencies + compile native addons (better-sqlite3)
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# -----------------------------------------------------------------------------
# Stage 2 — build the Next.js app (reuses deps' node_modules with the binary)
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 3 — lean runtime
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOSTNAME=0.0.0.0

LABEL org.opencontainers.image.title="featherdrop" \
      org.opencontainers.image.description="Self-hosted file sharer — drop a file, set an expiry, share a link." \
      org.opencontainers.image.source="https://github.com/junkerderprovinz/featherdrop" \
      org.opencontainers.image.licenses="MIT" \
      maintainer="junkerderprovinz"

# Carry the deps node_modules (with the compiled better-sqlite3 binary), the
# compiled .next, and the sources tsx executes at runtime (custom-server +
# server/ + lib/). The app/ and components/ sources are compiled into .next and
# are not needed at runtime; Next serves them from the build output.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY package.json package-lock.json next.config.mjs tsconfig.json custom-server.ts ./
COPY server ./server
COPY lib ./lib

# Init-log banner (brand art is a shared asset; container name passed at runtime).
COPY .github/assets/banner-raw.txt /usr/local/share/banner-raw.txt
COPY print-banner.sh /usr/local/bin/print-banner.sh
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN tr -d '\r' < /usr/local/share/banner-raw.txt > /usr/local/share/banner.txt \
    && tr -d '\r' < /usr/local/bin/print-banner.sh > /usr/local/bin/print-banner.sh.tmp \
    && mv /usr/local/bin/print-banner.sh.tmp /usr/local/bin/print-banner.sh \
    && tr -d '\r' < ./docker-entrypoint.sh > ./docker-entrypoint.sh.tmp \
    && mv ./docker-entrypoint.sh.tmp ./docker-entrypoint.sh \
    && chmod +x /usr/local/bin/print-banner.sh ./docker-entrypoint.sh

VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
