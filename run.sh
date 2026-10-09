#!/usr/bin/env bash
# Run Pocket Desktop in the foreground (Ctrl+C stops it).
#   ./run.sh                 → http://<this-pc-ip>:8765
#   ./run.sh --tls           → https://… (very small self-signed certificate)
#   ./run.sh --port 9000     → use another port
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (version 18+). Install it with: sudo apt install nodejs" >&2
  exit 1
fi

exec node server.js "$@"
