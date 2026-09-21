# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# featherdrop: one static Go binary that serves the React client as embedded
# assets plus the JSON/file API. Encryption happens in the browser. The /config
# and /data volumes, database schema and blob layout stay those of earlier
# releases, so an existing install keeps working.
#
# Stages:
#   client:  node builds the Vite SPA into server-go/webroot
#   gobuild: a CGO-free go build that embeds the webroot
#   runtime: distroless static with only the binary
ARG NODE_VERSION=24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG GO_VERSION=1.27@sha256:3680233e3204827fbdc66088528ae6d4b3d034f51d03a99d454f6de034888244

FROM node:${NODE_VERSION} AS client
WORKDIR /app
# Dependencies first for layer caching. postinstall copies the libsodium ESM
# wrapper the browser bundle needs (see package.json), so it has to run.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# scripts/build-client.mjs copies the build into server-go/webroot, with the
# %%TOKEN%% index.html, the hashed assets, sw-download.js and the Open Graph
# image.
RUN npm run build:spa

FROM golang:${GO_VERSION} AS gobuild
WORKDIR /src/server-go
COPY server-go/go.mod server-go/go.sum ./
RUN go mod download
# The client stage's webroot replaces the committed placeholder, so
# //go:embed all:webroot picks up the real build.
COPY server-go/ ./
COPY --from=client /app/server-go/webroot ./webroot
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/featherdrop .

FROM gcr.io/distroless/static-debian12:latest@sha256:d75cdd72874d4790092fcb1b058493ecf6bb5bf2b2b897045b00ff01d91843f2 AS runtime
LABEL org.opencontainers.image.source="https://github.com/junkerderprovinz/featherdrop"
LABEL org.opencontainers.image.description="featherdrop: self-hosted zero-knowledge file sharer (Go backend)"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=gobuild /out/featherdrop /featherdrop
# DATA_DIR holds the blobs and the tus uploads in progress, CONFIG_DIR the
# SQLite database; the defaults match the Unraid template mounts.
ENV DATA_DIR=/data \
    CONFIG_DIR=/config \
    PORT=3000
EXPOSE 3000
VOLUME ["/data", "/config"]
# Distroless has no shell, wget or curl, so the binary probes itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/featherdrop", "-healthcheck"]
ENTRYPOINT ["/featherdrop"]
