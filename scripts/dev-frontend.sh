#!/usr/bin/env bash
set -euo pipefail
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export API_PORT="${API_PORT:-8000}"
export API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:${API_PORT}}"
export FRONTEND_PORT="${FRONTEND_PORT:-8888}"
cd "${BASE_DIR}/apps/frontend"
exec npm run dev
