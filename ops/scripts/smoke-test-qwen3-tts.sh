#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:18020}"
OUTPUT_PATH="${2:-/tmp/ai-stack-qwen3-tts-smoke.wav}"
STREAM_OUTPUT_PATH="${3:-/tmp/ai-stack-qwen3-tts-stream.pcm}"
STREAM_HEADERS_PATH="${STREAM_OUTPUT_PATH}.headers"
MODEL_ID="qwen3-tts-12hz-1.7b-customvoice"

curl -fsS "${BASE_URL}/healthz" >/dev/null
curl -fsS "${BASE_URL}/v1/models" >/dev/null
curl -fsS "${BASE_URL}/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3-tts-12hz-1.7b-customvoice","input":"Qwen3语音合成服务验收通过。","voice":"Vivian","language":"Chinese","response_format":"wav","seed":20260722}' \
  --output "${OUTPUT_PATH}"

test -s "${OUTPUT_PATH}"

curl -fsS --no-buffer -D "${STREAM_HEADERS_PATH}" "${BASE_URL}/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3-tts-12hz-1.7b-customvoice","input":"第一段流式音频验收。第二段会继续传输。","voice":"Vivian","language":"Chinese","response_format":"pcm","stream":true,"stream_chunk_chars":20,"seed":20260722}' \
  --output "${STREAM_OUTPUT_PATH}"

test -s "${STREAM_OUTPUT_PATH}"
grep -qi '^x-ai-stack-stream-mode: segmented' "${STREAM_HEADERS_PATH}"
grep -qi '^transfer-encoding: chunked' "${STREAM_HEADERS_PATH}"

printf 'Qwen3-TTS smoke test passed: model=%s output=%s stream=%s\n' \
  "${MODEL_ID}" "${OUTPUT_PATH}" "${STREAM_OUTPUT_PATH}"
