# syntax=docker/dockerfile:1
# =============================================================================
# featherdrop — self-hosted file sharer (Next.js + Mantine, single container)
#
# GitHub:  https://github.com/junkerderprovinz/featherdrop
# Image:   ghcr.io/junkerderprovinz/featherdrop
# License: MIT
#
# Debian-slim base (not alpine) so better-sqlite3's native addon builds and runs
# without musl friction. Multi-stage:
#   deps    — install all deps + compile better-sqlite3's native addon
#   build   — next build (output:standalone) + esbuild-bundle the custom server
#   runtime — ship only the trace-pruned standalone output (~24MB node_modules
#             vs ~498MB), the static assets, and the better-sqlite3 binary
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
# Stage 2 — build: Next standalone output + esbuild-bundled custom server
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS build
ARG NODE_VERSION
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next build emits .next/standalone (server + a trace-pruned node_modules). Then
# esbuild bundles the custom Node server into that tree, keeping `next` and
# `better-sqlite3` external so they resolve from the traced node_modules at
# runtime (@tus/* etc. are inlined). Finally copy better-sqlite3's compiled
# .node binary, which Next's file tracer can't follow through bindings(). No
# webpack backfill is needed: custom-server.ts hands Next the pre-resolved
# config, so it never loads the (pruned) webpack/config machinery.
RUN npm run build \
    && node_modules/.bin/esbuild custom-server.ts \
        --bundle --platform=node --format=cjs --target=node${NODE_VERSION} \
        --external:next --external:better-sqlite3 \
        --outfile=.next/standalone/custom-server.cjs \
    && cp -r node_modules/better-sqlite3/build \
        .next/standalone/node_modules/better-sqlite3/build

# -----------------------------------------------------------------------------
# Stage 3 — lean runtime
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

LABEL org.opencontainers.image.title="featherdrop" \
      org.opencontainers.image.description="Self-hosted file sharer — drop a file, set an expiry, share a link." \
      org.opencontainers.image.source="https://github.com/junkerderprovinz/featherdrop" \
      org.opencontainers.image.licenses="MIT" \
      maintainer="junkerderprovinz"

# The standalone output carries the server, a trace-pruned node_modules, and
# .next/required-server-files.json (custom-server.cjs reads its Next config from
# there). Static assets aren't traced into standalone, so copy them separately.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static

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
