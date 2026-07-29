#!/usr/bin/env bash
set -euo pipefail
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${API_PORT:-8000}"

api_ready() {
  curl -fsS "http://127.0.0.1:${API_PORT}/healthz" >/dev/null 2>&1
}

wait_for_api() {
  local url="http://127.0.0.1:${API_PORT}/healthz"
  local timeout="${API_START_TIMEOUT:-30}"
  local waited=0

  echo "[web] Waiting for API at ${url} ..."
  while [[ $waited -lt $timeout ]]; do
    if [[ -n "${api_pid:-}" ]] && ! kill -0 "$api_pid" 2>/dev/null; then
      echo "[web] API process exited before becoming ready"
      wait "$api_pid" || true
      return 1
    fi
    if api_ready; then
      echo "[web] API is ready"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "[web] Timed out waiting for API after ${timeout}s"
  return 1
}

if api_ready; then
  api_pid=""
  echo "[web] API already running on ${API_PORT}; reusing existing service"
else
  "${BASE_DIR}/scripts/dev-api.sh" &
  api_pid=$!
  wait_for_api
fi
"${BASE_DIR}/scripts/dev-frontend.sh" &
frontend_pid=$!
cleanup() {
  if [[ -n "${api_pid:-}" ]]; then
    kill "${api_pid}" 2>/dev/null || true
  fi
  kill "${frontend_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
if [[ -n "${api_pid:-}" ]]; then
  wait -n "${api_pid}" "${frontend_pid}"
else
  wait "${frontend_pid}"
fi
cleanup
wait || true
