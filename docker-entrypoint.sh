#!/usr/bin/env bash
# =============================================================================
# docker-entrypoint.sh — prints the init-log banner, then starts the server.
# =============================================================================
set -e

/usr/local/bin/print-banner.sh \
    "featherdrop" \
    "Encrypted at rest, auto-deleted when the link expires"

# exec so the Node process becomes PID 1 and receives container signals.
exec node_modules/.bin/tsx custom-server.ts
