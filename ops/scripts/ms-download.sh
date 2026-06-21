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

# ── Stage into .temp first so programs can monitor in-progress downloads ──
TEMP_DIR="${MODEL_DIR}/.temp"
COMPLETE_MARKER="${MODEL_DIR}/.download-complete"

# Skip if already marked complete
if [[ -f "${COMPLETE_MARKER}" ]]; then
  echo "Model already downloaded (${COMPLETE_MARKER} exists)."
  exit 0
fi

# Clean stale temp from previous failed attempt
rm -rf "${TEMP_DIR}"
mkdir -p "${TEMP_DIR}" "${CACHE_DIR}"

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

# ── Download into .temp staging directory ──
docker run --rm \
  --network host \
  -u "$(id -u):$(id -g)" \
  -e HTTP_PROXY="${HTTP_PROXY:-}" \
  -e HTTPS_PROXY="${HTTPS_PROXY:-}" \
  -e ALL_PROXY="${ALL_PROXY:-}" \
  -e http_proxy="${http_proxy:-}" \
  -e https_proxy="${https_proxy:-}" \
  -e all_proxy="${all_proxy:-}" \
  -e MODELSCOPE_CACHE=/ms-cache \
  -e HOME=/tmp \
  -v "${CACHE_DIR}:/ms-cache" \
  -v "${TEMP_DIR}:/models" \
  --entrypoint python \
  "${IMAGE_NAME}" \
  -c "from modelscope.hub.snapshot_download import snapshot_download; snapshot_download('${MODEL_ID}', cache_dir='/ms-cache', local_dir='/models')"

# ── Move from .temp to final location ──
echo "Moving downloaded files from .temp to final location..."
mkdir -p "${MODEL_DIR}"
if command -v rsync &>/dev/null; then
  rsync -a --remove-source-files "${TEMP_DIR}/" "${MODEL_DIR}/"
else
  shopt -s dotglob nullglob
  for f in "${TEMP_DIR}"/*; do
    mv -f "$f" "${MODEL_DIR}/"
  done
fi
rm -rf "${TEMP_DIR}"

# ── Write completion marker → DB reconciler picks this up ──
touch "${COMPLETE_MARKER}"
echo "Download complete: ${MODEL_DIR}"
