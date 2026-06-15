#!/usr/bin/env bash
set -euo pipefail
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"${BASE_DIR}/scripts/dev-api.sh" &
api_pid=$!
"${BASE_DIR}/scripts/dev-frontend.sh" &
frontend_pid=$!
cleanup() {
  kill "${api_pid}" "${frontend_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
wait -n "${api_pid}" "${frontend_pid}"
cleanup
wait || true
