#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <repo_id> <target_subdir> [extra_hf_download_args...]" >&2
  echo "Example: $0 Qwen/Qwen3-Embedding-8B qwen3-embedding-8b --exclude '*.pt'" >&2
  exit 1
fi

REPO_ID="$1"
TARGET_SUBDIR="$2"
shift 2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${AI_STACK_BASE:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
IMAGE_NAME="hf-tools:latest"
MODEL_DIR="${BASE_DIR}/models/${TARGET_SUBDIR}"
CACHE_DIR="${BASE_DIR}/cache/hf"
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

if [[ -z "${HF_TOKEN:-}" ]]; then
  echo "HF_TOKEN is not set. Public models may still work, but gated or rate-limited downloads will fail." >&2
fi

docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1 || {
  echo "Building ${IMAGE_NAME} from ${BASE_DIR}/deploy/dockerfiles/hf-tools.Dockerfile" >&2
  docker build -t "${IMAGE_NAME}" -f "${BASE_DIR}/deploy/dockerfiles/hf-tools.Dockerfile" "${BASE_DIR}"
}

DEFAULT_EXCLUDES=(
  "--exclude" ".git/*"
  "--exclude" ".cache/*"
  "--exclude" "*.git/*"
  "--exclude" "*.msgpack"
  "--exclude" "*.h5"
  "--exclude" "*.ckpt"
  "--exclude" "*.tflite"
  "--exclude" "*.pb"
  "--exclude" "*.flax"
  "--exclude" "*.ot"
)

if [[ "${AI_STACK_FULL_MODEL_DOWNLOAD:-0}" == "1" ]]; then
  DEFAULT_EXCLUDES=()
fi

echo "Downloading only serving-essential snapshot files by default." >&2
echo "Set AI_STACK_FULL_MODEL_DOWNLOAD=1 to disable default excludes." >&2

# ── Download into .temp staging directory ──
docker run --rm \
  -e HF_TOKEN="${HF_TOKEN:-}" \
  -e HF_HOME=/hf-cache \
  -e HOME=/tmp \
  -e HTTP_PROXY="${HTTP_PROXY:-}" \
  -e HTTPS_PROXY="${HTTPS_PROXY:-}" \
  -e ALL_PROXY="${ALL_PROXY:-}" \
  -e http_proxy="${http_proxy:-}" \
  -e https_proxy="${https_proxy:-}" \
  -e all_proxy="${all_proxy:-}" \
  --network host \
  -u "$(id -u):$(id -g)" \
  -v "${CACHE_DIR}:/hf-cache" \
  -v "${TEMP_DIR}:/models" \
  "${IMAGE_NAME}" download "${REPO_ID}" \
  --local-dir /models \
  --resume-download \
  "${DEFAULT_EXCLUDES[@]}" \
  "$@"

# ── Move from .temp to final location ──
echo "Moving downloaded files from .temp to final location..."
mkdir -p "${MODEL_DIR}"
# Use rsync if available to avoid re-copy if runs overlap; fall back to mv
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
