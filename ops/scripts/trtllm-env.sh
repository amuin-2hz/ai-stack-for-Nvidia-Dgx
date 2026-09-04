#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AI_STACK_BASE="${AI_STACK_BASE:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
export TRTLLM_IMAGE="${TRTLLM_IMAGE:-nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6}"
export AI_STACK_BIND_ADDR="${AI_STACK_BIND_ADDR:-${BIND_ADDR:-0.0.0.0}}"
export HF_CACHE_DIR="${HF_CACHE_DIR:-${AI_STACK_BASE}/cache/hf}"
export MODELS_DIR="${MODELS_DIR:-${AI_STACK_BASE}/models}"
export LOGS_DIR="${LOGS_DIR:-${AI_STACK_BASE}/logs}"
export EXTRA_LLM_API_CONFIG="${EXTRA_LLM_API_CONFIG:-${AI_STACK_BASE}/configs/extra-llm-api-config.yml}"
export SERVE_PROFILES="${SERVE_PROFILES:-${AI_STACK_BASE}/configs/serve_profiles.tsv}"
export PROXY_ENV_FILE="${PROXY_ENV_FILE:-${AI_STACK_BASE}/configs/proxy.env}"

mkdir -p "${HF_CACHE_DIR}" "${LOGS_DIR}"

if [[ -f "${PROXY_ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${PROXY_ENV_FILE}"
  set +a
fi
