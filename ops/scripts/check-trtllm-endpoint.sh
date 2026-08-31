#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <port>" >&2
  exit 1
fi

PORT="$1"

echo "== /health =="
curl -fsS "http://localhost:${PORT}/health"
echo
echo "== /version =="
curl -fsS "http://localhost:${PORT}/version"
echo
