#!/usr/bin/env bash
# Single entrypoint: n8n + Cloudflare tunnel + WhatsApp webhook URL setup.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec "$ROOT/scripts/start-n8n.sh" "$@"
