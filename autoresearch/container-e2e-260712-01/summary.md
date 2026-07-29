# Custom Container End-to-End Validation

Date: 2026-07-12
Host: NVIDIA GB10, LAN 192.168.31.55

## Acceptance criteria

- Docker Compose parses successfully.
- Dockerfile builds a local image.
- Container starts with GPU and local model mounts.
- A real model inference request returns a valid result.
- The request succeeds through the host LAN address with AI_STACK_BIND_ADDR=0.0.0.0.

## Result

All five custom runtime profiles passed. See results.tsv for the exact endpoints and evidence.

## Fixes made during validation

- Aligned PyTorch-image Pydantic/Pillow/Matplotlib/psutil/protobuf/einops versions with NGC 25.04 constraints.
- Added torchaudio and a real OpenAI-compatible FunASR transcription endpoint.
- Replaced the MinerU placeholder with MinerUClient-based image/PDF parsing.
- Replaced Unlimited-OCR AutoProcessor/generate usage with the model's AutoTokenizer/model.infer API.
- Updated vLLM images to use python3, removed redundant package mutation, added explicit --model, and enabled offline local model loading.
- Corrected the nested Qwen3-Reranker model path and added the official query/document scoring template.

## Cleanup

All test containers were stopped and removed after validation. Built images remain available for publishing.
