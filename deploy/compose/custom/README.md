# Custom Runtime Compose Profiles

This directory keeps business-specific runtime profiles separate from the three
system default containers:

- `deploy/compose/docker-compose.vllm.yml`: default vLLM slot.
- `deploy/templates/tensorrt-llm.yml`: default TensorRT-LLM slot.
- `deploy/compose/docker-compose.pytorch.yml`: default PyTorch environment slot.

The profiles here provide model-specific dependencies and API routes for model
families called out in `docs/2026-07-06-model-deployment-test-report.zh-CN.md`.
They remain separate from the default stack so each runtime can be built and
started independently.

## Profiles

- `docker-compose.vllm-embedding.yml`: Qwen3 embedding through vLLM pooling.
- `docker-compose.vllm-reranker.yml`: Qwen3 reranker through a dedicated rerank profile.
- `docker-compose.funasr-gateway.yml`: FunASR/SenseVoice ASR, VAD, punctuation, and speaker diarization service.
- `docker-compose.vibevoice-hf.yml`: VibeVoice Hugging Face adapter service.
- `docker-compose.qwen3-tts.yml`: dedicated Qwen3-TTS family gateway for CustomVoice, VoiceDesign, and Base voice cloning.
- `docker-compose.ocr-unlimited.yml`: Unlimited-OCR built locally from `deploy/dockerfiles/custom/ocr-unlimited.Dockerfile` and tagged as `local/ai-stack-unlimited-ocr:latest` by default.
- `docker-compose.mineru.yml`: MinerU2.5-Pro image and PDF parsing service.
- `docker-compose.locate-anything.yml`: LocateAnything image grounding and object-location service.

Run `docker compose config` first. Every profile here uses a dedicated Dockerfile under `deploy/dockerfiles/custom/`; the `image:` value is the local tag produced by the build, not a hidden prebuilt requirement.

## Network policy

All bundled profiles publish using `AI_STACK_BIND_ADDR`: `0.0.0.0` for LAN
access (the system default), or `127.0.0.1` for local-only access. The service
inside a bridge-network container still listens on `0.0.0.0`; Docker controls
which host interfaces expose it. Internal-only dependencies such as the FunASR
n-gram runtime remain unpublished.

The system's publish/start actions read the saved LAN switch. For manual
operation, run the following from the workspace root so the same setting is
read from the local API:

```bash
node scripts/runtime-compose.mjs -f deploy/compose/custom/docker-compose.mineru.yml config
node scripts/runtime-compose.mjs -f deploy/compose/custom/docker-compose.mineru.yml up -d --no-build
```

Set `AI_STACK_API_URL` if the API is not at `http://127.0.0.1:8000`. If the API
is unavailable, the launcher refuses to start instead of guessing the exposure
policy. An explicit environment override is available for offline operation:

```bash
AI_STACK_BIND_ADDR=127.0.0.1 node scripts/runtime-compose.mjs -f deploy/compose/custom/docker-compose.mineru.yml up -d --no-build
```

The legacy `BIND_ADDR` alias is supported by the launcher and old templates;
`AI_STACK_BIND_ADDR` takes precedence. Raw `docker compose` does not read the
application database: without an override it uses the template's LAN default.
Handwritten fixed `ports` or `network_mode: host` in imported profiles are not
rewritten by the system; use the canonical variable to opt into this policy.

Saving the switch affects newly created/republished services, not existing
containers. Republish them to recreate Docker port mappings; `docker restart`
alone cannot change those mappings. Restart the API/web service separately to
apply its saved listener policy. No running model containers are automatically
restarted. These model APIs are intended for a trusted LAN, not direct Internet
exposure.

The ARM64 `locate-anything` profile supports image grounding only. Video input is not exposed because `decord==0.6.0` has no Python 3.12 ARM64 wheel. The model is subject to NVIDIA's non-commercial research license.
