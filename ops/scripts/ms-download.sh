#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <modelscope_model_id> <target_subdir>" >&2
  echo "Example: $0 Qwen/Qwen3-Embedding-8B qwen3-embedding-8b" >&2
  exit 1
fi

MODEL_ID="$1"
TARGET_SUBDIR="$2"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${AI_STACK_BASE:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
IMAGE_NAME="ms-tools:latest"
MODEL_DIR="${BASE_DIR}/models/${TARGET_SUBDIR}"
CACHE_DIR="${BASE_DIR}/cache/modelscope"
PROXY_ENV_FILE="${BASE_DIR}/configs/proxy.env"

mkdir -p "${MODEL_DIR}" "${CACHE_DIR}"

if [[ -f "${PROXY_ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${PROXY_ENV_FILE}"
  set +a
fi

docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1 || {
  echo "Building ${IMAGE_NAME} from ${BASE_DIR}/deploy/dockerfiles/ms-tools.Dockerfile" >&2
  docker build -t "${IMAGE_NAME}" -f "${BASE_DIR}/deploy/dockerfiles/ms-tools.Dockerfile" "${BASE_DIR}"
}

docker run --rm \
  --network host \
  -e HTTP_PROXY="${HTTP_PROXY:-}" \
  -e HTTPS_PROXY="${HTTPS_PROXY:-}" \
  -e ALL_PROXY="${ALL_PROXY:-}" \
  -e http_proxy="${http_proxy:-}" \
  -e https_proxy="${https_proxy:-}" \
  -e all_proxy="${all_proxy:-}" \
  -e MODELSCOPE_CACHE=/ms-cache \
  -v "${CACHE_DIR}:/ms-cache" \
  -v "${MODEL_DIR}:/models" \
  --entrypoint python \
  "${IMAGE_NAME}" \
  -c "from modelscope.hub.snapshot_download import snapshot_download; snapshot_download('${MODEL_ID}', cache_dir='/ms-cache', local_dir='/models')"
