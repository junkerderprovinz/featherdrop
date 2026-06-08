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
#   deps    – full install incl. toolchain → compiles the better-sqlite3 binary
#   build   – next build (output: standalone) + esbuild-bundled custom server
#   runtime – ONLY Next's standalone output (its traced node_modules is ~24 MB,
#             vs ~500 MB for the full one) + static assets. No tsx, no dev deps.
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
# Stage 2 — build the standalone Next.js app + bundle the custom server
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 1) next build (output:standalone) → .next/standalone: server.js + a minimal traced
#    node_modules (next, react, better-sqlite3's JS, ...) + the build output.
# 2) Bundle our custom server; next + better-sqlite3 stay external (resolved from the
#    traced node_modules at runtime); @tus/* is inlined. (age-encryption and nanoid are
#    used only by Next route handlers, which live in .next/server — not in this bundle.)
# 3) Next's trace can't follow better-sqlite3's dynamic bindings() lookup, so the native
#    *.node binary is NOT traced into standalone — copy its build/ dir in explicitly,
#    else new Database() throws "Could not locate the bindings file" at runtime.
# 4) next() loads the config machinery (webpack) at runtime; the production trace can
#    omit it — copy the compiled webpack in so app.prepare() doesn't fail on './bundle5'.
RUN npm run build \
    && node_modules/.bin/esbuild custom-server.ts --bundle --platform=node --format=cjs \
        --target=node${NODE_VERSION} --external:next --external:better-sqlite3 \
        --outfile=.next/standalone/custom-server.cjs \
    && cp -r node_modules/better-sqlite3/build \
        .next/standalone/node_modules/better-sqlite3/build \
    && cp -rn node_modules/next/dist/compiled/webpack/. \
        .next/standalone/node_modules/next/dist/compiled/webpack/

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

# Self-contained standalone bundle: the traced node_modules (with the compiled
# better-sqlite3 binary, next, react + the compiled webpack added in build), the
# esbuild-bundled custom server, and the build output. ~24 MB instead of ~500 MB.
COPY --from=build /app/.next/standalone ./
# Next does not place static assets inside standalone — add them.
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
