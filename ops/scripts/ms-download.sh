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
CACHE_DIR="${MODELSCOPE_CACHE_DIR:-${BASE_DIR}/cache/modelscope/uid-$(id -u)}"
PROXY_ENV_FILE="${BASE_DIR}/configs/proxy.env"

# ── Stage into .temp first so programs can monitor in-progress downloads ──
TEMP_DIR="${MODEL_DIR}/.temp"
COMPLETE_MARKER="${MODEL_DIR}/.download-complete"

# Skip if already marked complete
if [[ -f "${COMPLETE_MARKER}" ]]; then
  rm -rf "${TEMP_DIR}"
  echo "Model already downloaded (${COMPLETE_MARKER} exists)."
  exit 0
fi

# Keep staged files by default so retries can resume partial downloads.
# Set AI_STACK_CLEAN_DOWNLOAD_TEMP=1 when a fresh download is required.
if [[ "${AI_STACK_CLEAN_DOWNLOAD_TEMP:-0}" == "1" ]]; then
  rm -rf "${TEMP_DIR}"
fi
mkdir -p "${TEMP_DIR}" "${CACHE_DIR}"


apply_proxy_scope() {
  local provider="$1"
  local scope="${AI_STACK_PROXY_SCOPE:-all}"
  scope="${scope,,}"
  case "${scope}" in
    ""|"all")
      return 0
      ;;
    "huggingface")
      [[ "${provider}" == "huggingface" ]] && return 0
      ;;
    "modelscope")
      [[ "${provider}" == "modelscope" ]] && return 0
      ;;
    *)
      echo "Unknown AI_STACK_PROXY_SCOPE=${scope}; treating proxy as global." >&2
      return 0
      ;;
  esac
  echo "Proxy scope ${scope} does not include ${provider}; continuing without proxy." >&2
  unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy
}

use_proxy_env_if_reachable() {
  local proxy_url="${HTTPS_PROXY:-${HTTP_PROXY:-}}"
  if [[ -z "${proxy_url}" ]]; then
    return 0
  fi
  local without_scheme="${proxy_url#*://}"
  local hostport="${without_scheme%%/*}"
  local host="${hostport%%:*}"
  local port="${hostport##*:}"
  if [[ "${host}" != "localhost" && "${host}" != "127."* && "${host}" != "::1" ]]; then
    return 0
  fi
  if [[ -z "${port}" || "${port}" == "${host}" ]]; then
    return 0
  fi
  if ! (echo >"/dev/tcp/${host}/${port}") >/dev/null 2>&1; then
    echo "Proxy ${proxy_url} is configured but not reachable; continuing without proxy." >&2
    unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy
  fi
}

if [[ -f "${PROXY_ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${PROXY_ENV_FILE}"
  set +a
fi
apply_proxy_scope "modelscope"
use_proxy_env_if_reachable

DOCKER_NAME_ARGS=()
if [[ -n "${AI_STACK_DOWNLOAD_CONTAINER:-}" ]]; then
  docker rm -f "${AI_STACK_DOWNLOAD_CONTAINER}" >/dev/null 2>&1 || true
  DOCKER_NAME_ARGS=(--name "${AI_STACK_DOWNLOAD_CONTAINER}")
fi


docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1 || {
  echo "Building ${IMAGE_NAME} from ${BASE_DIR}/deploy/dockerfiles/ms-tools.Dockerfile" >&2
  docker build -t "${IMAGE_NAME}" -f "${BASE_DIR}/deploy/dockerfiles/ms-tools.Dockerfile" "${BASE_DIR}"
}

run_modelscope_download() {
  docker run --rm \
    "${DOCKER_NAME_ARGS[@]}" \
    --network host \
    -u "$(id -u):$(id -g)" \
    -e HTTP_PROXY="${HTTP_PROXY:-}" \
    -e HTTPS_PROXY="${HTTPS_PROXY:-}" \
    -e ALL_PROXY="${ALL_PROXY:-}" \
    -e http_proxy="${http_proxy:-}" \
    -e https_proxy="${https_proxy:-}" \
    -e all_proxy="${all_proxy:-}" \
    -e NO_PROXY="${NO_PROXY:-}" \
    -e no_proxy="${no_proxy:-}" \
    -e MODELSCOPE_CACHE=/ms-cache \
    -e MODELSCOPE_MODEL_ID="${MODEL_ID}" \
    -e MODELSCOPE_LOCAL_DIR=/models \
    -e HOME=/tmp \
    -v "${CACHE_DIR}:/ms-cache" \
    -v "${TEMP_DIR}:/models" \
    -v "${BASE_DIR}/ops/scripts/modelscope-direct-download.py:/modelscope-direct-download.py:ro" \
    --entrypoint python \
    "${IMAGE_NAME}" \
    /modelscope-direct-download.py
}

DOWNLOAD_ATTEMPTS="${AI_STACK_DOWNLOAD_ATTEMPTS:-4}"
DOWNLOAD_RETRY_DELAY="${AI_STACK_DOWNLOAD_RETRY_DELAY:-20}"
for ((attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++)); do
  echo "ModelScope download attempt ${attempt}/${DOWNLOAD_ATTEMPTS}" >&2
  if run_modelscope_download; then
    break
  else
    status=$?
  fi
  if (( attempt == DOWNLOAD_ATTEMPTS )); then
    echo "ModelScope download failed after ${DOWNLOAD_ATTEMPTS} attempts." >&2
    exit "${status}"
  fi
  echo "ModelScope download failed with exit ${status}; retrying in ${DOWNLOAD_RETRY_DELAY}s with staged files preserved." >&2
  sleep "${DOWNLOAD_RETRY_DELAY}"
done

# ── Move from .temp to final location ──
echo "Moving downloaded files from .temp to final location..."
rm -rf "${TEMP_DIR}/.temp"
mkdir -p "${MODEL_DIR}"
if command -v rsync &>/dev/null; then
  rsync -a --exclude ".temp/" --remove-source-files "${TEMP_DIR}/" "${MODEL_DIR}/"
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
