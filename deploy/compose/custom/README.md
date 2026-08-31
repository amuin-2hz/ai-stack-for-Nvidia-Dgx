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

The ARM64 `locate-anything` profile supports image grounding only. Video input is not exposed because `decord==0.6.0` has no Python 3.12 ARM64 wheel. The model is subject to NVIDIA's non-commercial research license.
