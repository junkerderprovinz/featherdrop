#!/usr/bin/env bash
# =============================================================================
# docker-entrypoint.sh — prints the init-log banner, then starts the server.
# =============================================================================
set -e

/usr/local/bin/print-banner.sh \
    "featherdrop" \
    "Self-hosted file sharing — encrypted, auto-expiring"

# exec so the Node process becomes PID 1 and receives container signals.
exec node_modules/.bin/tsx custom-server.ts
