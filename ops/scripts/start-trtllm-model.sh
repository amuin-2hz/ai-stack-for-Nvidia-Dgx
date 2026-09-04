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

if [[ ! -f "${SERVE_PROFILES}" ]]; then
  echo "Serve profile file not found: ${SERVE_PROFILES}" >&2
  exit 1
fi

PROFILE_LINE="$(awk -F '\t' -v alias="${ALIAS}" 'NR > 1 && $1 == alias { print; exit }' "${SERVE_PROFILES}")"

if [[ -z "${PROFILE_LINE}" ]]; then
  echo "Unknown model alias: ${ALIAS}" >&2
  exit 1
fi

IFS=$'\t' read -r PROFILE_ALIAS SERVE_TYPE MODEL_DIR DEFAULT_PORT MAX_BATCH_SIZE RESIDENCY <<< "${PROFILE_LINE}"

if [[ "${SERVE_TYPE}" != "llm" ]]; then
  echo "Alias ${ALIAS} is serve_type=${SERVE_TYPE}. This script currently supports llm profiles only." >&2
  exit 2
fi

if [[ ! -d "${MODEL_DIR}" ]]; then
  echo "Model directory not found: ${MODEL_DIR}" >&2
  exit 1
fi

if [[ ! -f "${MODEL_DIR}/config.json" ]]; then
  echo "config.json is missing in ${MODEL_DIR}" >&2
  exit 1
fi

PORT="${PORT_OVERRIDE:-${DEFAULT_PORT}}"
MAX_BATCH_SIZE="${TRTLLM_MAX_BATCH_SIZE:-${MAX_BATCH_SIZE}}"
MAX_NUM_TOKENS_ARG=()
if [[ -n "${TRTLLM_MAX_NUM_TOKENS:-}" ]]; then
  MAX_NUM_TOKENS_ARG=(--max_num_tokens "${TRTLLM_MAX_NUM_TOKENS}")
fi
KV_CACHE_ARG=()
if [[ -n "${TRTLLM_KV_CACHE_FREE_GPU_MEMORY_FRACTION:-}" ]]; then
  KV_CACHE_ARG=(--kv_cache_free_gpu_memory_fraction "${TRTLLM_KV_CACHE_FREE_GPU_MEMORY_FRACTION}")
fi
TP_ARG=()
if [[ -n "${TRTLLM_TP_SIZE:-}" ]]; then
  TP_ARG=(--tp_size "${TRTLLM_TP_SIZE}")
fi
PP_ARG=()
if [[ -n "${TRTLLM_PP_SIZE:-}" ]]; then
  PP_ARG=(--pp_size "${TRTLLM_PP_SIZE}")
fi
CONTAINER_NAME="trtllm-service"

if docker ps -a --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
  echo "Removing existing container ${CONTAINER_NAME}" >&2
  docker rm -f "${CONTAINER_NAME}" >/dev/null
fi

docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart "${TRTLLM_RESTART_POLICY:-no}" \
  --gpus "${GPU_DEVICE_REQUEST:-all}" \
  --ipc host \
  -p "${AI_STACK_BIND_ADDR}:${PORT}:${PORT}" \
  --ulimit memlock=-1 \
  --ulimit stack=67108864 \
  -e HF_TOKEN="${HF_TOKEN:-}" \
  -v "${HF_CACHE_DIR}:/root/.cache/huggingface/" \
  -v "${MODEL_DIR}:/models:ro" \
  -v "${EXTRA_LLM_API_CONFIG}:/configs/extra-llm-api-config.yml:ro" \
  "${TRTLLM_IMAGE}" \
  bash -lc "trtllm-serve /models --max_batch_size ${MAX_BATCH_SIZE} ${MAX_NUM_TOKENS_ARG[*]} ${KV_CACHE_ARG[*]} ${TP_ARG[*]} ${PP_ARG[*]} --trust_remote_code --port ${PORT} --extra_llm_api_options /configs/extra-llm-api-config.yml"

echo "Started ${CONTAINER_NAME}"
echo "  loaded model: ${ALIAS}"
echo "  residency: ${RESIDENCY}"
echo "  port: ${PORT}"
echo "  health: http://localhost:${PORT}/health"
