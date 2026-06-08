#!/usr/bin/env bash
# =============================================================================
# docker-entrypoint.sh — prints the init-log banner, then starts the server.
# =============================================================================
set -e

/usr/local/bin/print-banner.sh \
    "featherdrop" \
    "Encrypted at rest, auto-deleted when the link expires"

# exec so the Node process becomes PID 1 and receives container signals.
# custom-server.cjs is the esbuild-bundled custom server inside Next's standalone
# output; it reuses standalone's traced node_modules (next, better-sqlite3, ...).
exec node custom-server.cjs
