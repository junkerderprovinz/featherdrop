# syntax=docker/dockerfile:1
# =============================================================================
# featherdrop — the published image (Go backend) — built + pushed by build.yml
#
# A single static Go binary that serves the existing React/TS client as embedded
# static assets plus the JSON/file API. The browser zero-knowledge crypto + UI
# stay in TypeScript; only the SERVER is Go. Drop-in on the same /config + /data
# volumes as the previous Next.js image (same db.sqlite schema, same blob layout).
#
# As of v6.0.0 this REPLACED the Next.js/Node server (the legacy Next image and
# its server source have since been removed). The Vite SPA reuses components/,
# lib/, theme.ts and the shared app/ pages.
#
# Multi-stage:
#   client  — node builds the Vite SPA into server-go/webroot (build:spa)
#   gobuild — CGO-free `go build` embedding that webroot via //go:embed
#   runtime — distroless static: just the ~15 MB binary, no Node, no shell
# =============================================================================
ARG NODE_VERSION=22
ARG GO_VERSION=1.26

# -----------------------------------------------------------------------------
# Stage 1 — build the static SPA client (Vite) into server-go/webroot
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS client
WORKDIR /app
# Install deps first for layer caching. postinstall copies the libsodium ESM
# wrapper the browser bundle needs (see package.json), so it must run.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# vite build -> client-dist, then scripts/build-client.mjs copies it into
# server-go/webroot/ (built index.html with %%TOKENS%% + hashed assets +
# sw-download.js) and ships app/opengraph-image.png there too.
RUN npm run build:spa

# -----------------------------------------------------------------------------
# Stage 2 — build the static Go binary embedding the populated webroot
# -----------------------------------------------------------------------------
FROM golang:${GO_VERSION} AS gobuild
WORKDIR /src/server-go
# Module graph first (cached until go.mod/go.sum change).
COPY server-go/go.mod server-go/go.sum ./
RUN go mod download
# Go source, then overlay the SPA-populated webroot from the client stage so the
# //go:embed all:webroot picks up the real built client (not the placeholder).
COPY server-go/ ./
COPY --from=client /app/server-go/webroot ./webroot
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/featherdrop .

# -----------------------------------------------------------------------------
# Stage 3 — minimal runtime (distroless static: tiny, no shell, ca-certs + tmp)
# -----------------------------------------------------------------------------
FROM gcr.io/distroless/static-debian12 AS runtime
LABEL org.opencontainers.image.source="https://github.com/junkerderprovinz/featherdrop"
LABEL org.opencontainers.image.description="featherdrop — self-hosted zero-knowledge file sharer (Go backend)"
LABEL org.opencontainers.image.licenses="MIT"
COPY --from=gobuild /out/featherdrop /featherdrop
# DATA_DIR holds the bulk blobs + in-progress tus uploads; CONFIG_DIR holds the
# SQLite metadata DB. Defaults match lib/config.ts / the Unraid template mounts.
ENV DATA_DIR=/data \
    CONFIG_DIR=/config \
    PORT=3000
EXPOSE 3000
VOLUME ["/data", "/config"]
# Distroless ships no shell/wget/curl, so the binary probes itself: -healthcheck
# GETs /api/healthcheck on $PORT and exits 0/1 (exec form — no shell needed).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/featherdrop", "-healthcheck"]
ENTRYPOINT ["/featherdrop"]
