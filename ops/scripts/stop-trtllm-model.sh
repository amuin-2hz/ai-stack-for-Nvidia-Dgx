#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <alias>" >&2
  exit 1
fi

ALIAS="$1"
CONTAINER_NAME="trtllm-service"

if docker ps -a --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
  docker rm -f "${CONTAINER_NAME}"
else
  echo "Container already absent: ${CONTAINER_NAME}"
fi
