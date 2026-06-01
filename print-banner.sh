#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# print-banner.sh <container-name> <subtitle>
# Einheitlicher Init-Log-Banner für alle Junker-der-Provinz-Container
# ─────────────────────────────────────────────────────────────────

CONTAINER="${1:-Container}"
SUBTITLE="${2:-}"
BANNER_FILE="/usr/local/share/banner.txt"
SEP="$(printf '─%.0s' $(seq 1 67))"

echo ""

if [ -f "${BANNER_FILE}" ]; then
    cat "${BANNER_FILE}"
    # The shared banner file has no trailing newline; add blank lines so the
    # banner gets breathing room before the title block (no leading rule above).
    echo ""
    echo ""
else
    echo ""
    echo "  Junker der Provinz"
    echo ""
fi

echo "  ${SEP}"
printf '  %s\n' "${CONTAINER}"
[ -n "${SUBTITLE}" ] && printf '  %s\n' "${SUBTITLE}"
echo "  ${SEP}"
echo ""
