#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <alias> [port]" >&2
  exit 1
fi

ALIAS="$1"
PORT_OVERRIDE="${2:-}"

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/trtllm-env.sh"

HANDLE_PROFILES="${AI_STACK_BASE}/configs/validated_handles.tsv"

if [[ ! -f "${HANDLE_PROFILES}" ]]; then
  echo "Validated handle profile file not found: ${HANDLE_PROFILES}" >&2
  exit 1
fi

PROFILE_LINE="$(awk -F '\t' -v alias="${ALIAS}" 'NR > 1 && $1 == alias { print; exit }' "${HANDLE_PROFILES}")"

if [[ -z "${PROFILE_LINE}" ]]; then
  echo "Unknown validated alias: ${ALIAS}" >&2
  exit 1
fi

IFS=$'\t' read -r PROFILE_ALIAS MODEL_HANDLE DEFAULT_PORT MAX_BATCH_SIZE RESIDENCY <<< "${PROFILE_LINE}"
PORT="${PORT_OVERRIDE:-${DEFAULT_PORT}}"
CONTAINER_NAME="trtllm-service"

if docker ps -a --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
  echo "Removing existing container ${CONTAINER_NAME}" >&2
  docker rm -f "${CONTAINER_NAME}" >/dev/null
fi

docker run -d \
  --name "${CONTAINER_NAME}" \
  --gpus all \
  --ipc host \
  --network host \
  --ulimit memlock=-1 \
  --ulimit stack=67108864 \
  -e HF_TOKEN="${HF_TOKEN:-}" \
  -e MODEL_HANDLE="${MODEL_HANDLE}" \
  -e HTTP_PROXY="${HTTP_PROXY:-}" \
  -e HTTPS_PROXY="${HTTPS_PROXY:-}" \
  -e ALL_PROXY="${ALL_PROXY:-}" \
  -e http_proxy="${http_proxy:-}" \
  -e https_proxy="${https_proxy:-}" \
  -e all_proxy="${all_proxy:-}" \
  -v "${HF_CACHE_DIR}:/root/.cache/huggingface/" \
  -v "${EXTRA_LLM_API_CONFIG}:/configs/extra-llm-api-config.yml:ro" \
  "${TRTLLM_IMAGE}" \
  bash -lc "hf download \"${MODEL_HANDLE}\" && trtllm-serve \"${MODEL_HANDLE}\" --max_batch_size ${MAX_BATCH_SIZE} --trust_remote_code --port ${PORT} --extra_llm_api_options /configs/extra-llm-api-config.yml"

echo "Started ${CONTAINER_NAME}"
echo "  loaded handle: ${MODEL_HANDLE}"
echo "  residency: ${RESIDENCY}"
echo "  port: ${PORT}"
echo "  health: http://localhost:${PORT}/health"
