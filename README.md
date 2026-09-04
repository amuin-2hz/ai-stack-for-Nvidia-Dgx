# AMUIN AI STACK

English | [简体中文](README.zh-CN.md)

AMUIN AI STACK is a graphical local-model deployment and operations tool built primarily for **NVIDIA DGX Spark and other GB10 ARM64 systems**. It turns model download, compatibility checks, Docker runtime creation, publishing, API testing, GPU monitoring, logs, and maintenance into a desktop and web workflow for a personal AI workstation.

[NVIDIA DGX Spark](https://www.nvidia.com/en-us/products/workstations/dgx-spark/) combines a GB10 Grace Blackwell Superchip, a 20-core ARM64 CPU, and 128 GB of coherent unified system memory in a compact desktop system. NVIDIA positions it for local AI development, inference, and fine-tuning, with up to 1 PFLOP of FP4 AI performance. Its [DGX OS software stack](https://docs.nvidia.com/dgx/dgx-spark/system-overview.html) includes CUDA, Docker, and the NVIDIA Container Runtime. AMUIN AI STACK is designed around that environment: the application runs natively on ARM64, while inference workloads remain isolated in GPU-enabled containers.

This project is not an NVIDIA product and is not affiliated with NVIDIA.

## Supported deployment scenarios

### Three core runtime environments

These are the general foundations used to publish models or build a model-specific service:

| Runtime | Intended use | Current scope |
|---|---|---|
| **vLLM** | LLM/VLM serving and OpenAI-compatible APIs | Primary general inference path. Supports configurable context, GPU allocation, quantization-related runtime options, and optional Tool Call flags/parsers. |
| **TensorRT-LLM** | NVIDIA-optimized inference | Runtime and launch-plan integration is available. A compatible checkpoint or prebuilt engine, matching image, and model-specific conversion remain the user's responsibility. |
| **PyTorch** | General CUDA/PyTorch environment | Base environment for custom inference services and models that cannot be served directly by vLLM. It is not a universal model server by itself. |

### Advanced profiles

- **vLLM Embedding** — dedicated OpenAI-compatible embedding service.
- **vLLM Reranker** — dedicated relevance-scoring and reranking service.
- **Tool-enabled vLLM** — publishing-time Tool Call switch and parser selection for compatible models, including the Qwen3 family.
- **OpenAI-compatible ASR gateway** — standard `/v1/audio/transcriptions` API with multiple selectable pipelines.

### Suite-specific runtimes

- **FunASR / SenseVoice** — ASR, VAD, punctuation, optional speaker processing, and an n-gram-enhanced pipeline.
- **Qwen3-TTS** — CustomVoice, VoiceDesign, and Base voice-cloning workflows, including streaming output formats.
- **VibeVoice** — dedicated Hugging Face adapter profile; integrated but awaiting an updated DGX Spark acceptance run.
- **Unlimited-OCR** — image text recognition and coordinates.
- **MinerU 2.5 Pro** — image/PDF content extraction and Markdown-oriented document parsing.
- **LocateAnything** — image grounding, boxes, and points. The ARM64 profile currently supports images only; the model's license must be reviewed for the intended use.

## DGX Spark validation matrix

An entry is described as **verified** only after the real model has loaded and returned a usable inference result on an NVIDIA GB10/DGX Spark host. Merely building an image or passing a health endpoint is not enough. As more model/runtime combinations pass scenario-specific acceptance, this table will be updated.

| Scenario | Model/profile exercised | Result on GB10 |
|---|---|---|
| General LLM through vLLM | OmniCoder-9B | OpenAI chat request returned HTTP 200 and generated code passed sandboxed assertions. |
| Structured Tool Call | Qwen3.8 27B NVFP4 through vLLM | Returned structured `tool_calls` and `finish_reason: "tool_calls"`; publishing with Tool Call on/off was verified. |
| Text embedding | Qwen3-Embedding-8B | HTTP 200, two 4096-dimensional vectors returned. |
| Reranking | Qwen3-Reranker-8B | HTTP 200 and relevant/irrelevant ordering verified. |
| Speech recognition | FunASR gateway | All four pipelines returned HTTP 200 through `/v1/audio/transcriptions`. |
| Speech synthesis | Qwen3-TTS CustomVoice / VoiceDesign / Base | Non-streaming WAV and streaming PCM/AAC/Opus/MP3 outputs were generated. |
| OCR | Unlimited-OCR | HTTP 200 with the expected text and detection coordinates. |
| Document parsing | MinerU 2.5 Pro | HTTP 200 and expected invoice fields parsed to Markdown. |
| Image grounding | LocateAnything-3B | HTTP 200 and the expected target region was located in image mode. |

TensorRT-LLM and VibeVoice are available integrations, but they are intentionally not listed as verified model scenarios until a current end-to-end DGX Spark acceptance run is recorded.

## What the current release provides

Version `1.1.2` provides an ARM64 application and deployment workflow for a trusted personal workstation:

- Chinese/English Electron desktop application and LAN-accessible web console.
- GPU, CPU, memory, storage, Docker container, port, task, health, and log views.
- Model discovery, local storage management, and Hugging Face/ModelScope download planning.
- Model file audit, incomplete-download detection, runtime recommendations, and publication checks.
- Runtime creation, start/stop/restart, health checks, repair, cleanup, and persisted launch parameters.
- OpenAI-compatible chat, embeddings, and audio transcription paths, plus task-specific APIs.
- vLLM Tool Call enable/disable control and parser selection before model publication.
- Four selectable ASR pipelines: `pipeline:general`, `pipeline:accurate-zh`, `pipeline:domain-zh`, and `pipeline:meeting`.
- Native ARM64 DEB and aarch64 RPM release packages.

## Technology stack

| Layer | Technology |
|---|---|
| Desktop | Electron 33, TypeScript |
| Frontend | Vue 3, Vite, Ant Design Vue |
| Control plane | Node.js, TypeScript, SQLite (`better-sqlite3`) |
| Runtime orchestration | Docker Engine, Docker Compose, NVIDIA Container Toolkit |
| Inference | vLLM, TensorRT-LLM, NVIDIA PyTorch containers, and dedicated Python/FastAPI-style model services |
| Packaging | electron-builder, DEB, RPM |

The control plane stores local state, produces runtime plans, invokes Docker, performs health checks, and exposes the frontend/API. Model inference remains in independent containers so runtime dependencies do not pollute the desktop application.

## Requirements — Docker matters

AMUIN AI STACK does **not** bundle the CUDA inference environments inside the desktop package. Model services are pulled or built as Docker images, so the following are required before publishing a model:

- Linux ARM64 for the official `v1.1.2` packages.
- NVIDIA GPU driver and a working CUDA-capable host.
- Docker Engine with the Docker Compose plugin (`docker compose`).
- NVIDIA Container Toolkit configured for Docker GPU access.
- Enough free storage for model weights, image layers, build cache, and generated outputs.
- Network access to the registries/model sources you use, such as Docker Hub, NVIDIA NGC, Hugging Face, or ModelScope.

DGX Spark ships with Docker and NVIDIA Container Toolkit preinstalled and configured according to the [official container-runtime guide](https://docs.nvidia.com/dgx/dgx-spark/nvidia-container-runtime-for-docker.html). Verify the host before installing models:

```bash
docker --version
docker compose version
nvidia-ctk --version
docker run --rm --gpus all nvcr.io/nvidia/cuda:13.0.1-devel-ubuntu24.04 nvidia-smi
```

The application must be able to access the Docker daemon. You may run it with appropriate privileges or add your user to the `docker` group:

```bash
sudo usermod -aG docker "$USER"
newgrp docker
```

Membership in the `docker` group is effectively root-equivalent on the host. Only grant it to trusted users.

## Install on DGX Spark / ARM64

Download the packages from the repository's `v1.1.2` Release page.

```bash
# DGX OS / Ubuntu / Debian
sudo apt install ./amuin-ai-stack_1.1.2_arm64.deb

# ARM64 RPM-based distributions
sudo dnf install ./amuin-ai-stack-1.1.2-1.aarch64.rpm
```

Launch the desktop application from the system menu or terminal:

```bash
amuin-ai-stack
```

The RPM also installs a system service and a web-oriented launch path:

```bash
sudo systemctl enable --now amuin-ai-stack
sudo systemctl status amuin-ai-stack
```

The default web console is `http://<host-ip>:8888`; the control-plane API defaults to port `8000`. RPM service environment overrides live in `/etc/sysconfig/amuin-ai-stack`.

## First use

1. Confirm Docker and container GPU access with the commands above.
2. Open AMUIN AI STACK and set the model/cache storage paths.
3. Configure proxy and registry access if the host requires them.
4. Import a Hugging Face or ModelScope repository, or scan an existing local model directory.
5. Review the integrity and compatibility assessment.
6. Choose a core or dedicated runtime and configure port, GPU, context, and model-specific options.
7. Publish the model; wait for the image, container, model load, and health stages to complete.
8. Test the endpoint in the model playground or from an OpenAI-compatible client.

Example ASR request:

```bash
curl --noproxy "*" --http1.1 -H "Expect:" \
  --max-time 300 \
  "http://<host-ip>:8011/v1/audio/transcriptions" \
  -F "file=@/absolute/path/test.wav" \
  -F "model=pipeline:general" \
  -F "language=zh" \
  -F "response_format=json"
```

This endpoint returns a normal JSON response such as `{"text":"..."}`; it is not a streaming endpoint.

## x86 NVIDIA GPU systems and project boundaries

The control plane, UI, and container-oriented design should also be applicable to ordinary **x86_64 Linux workstations with NVIDIA GPUs**, provided the selected Docker images, drivers, CUDA stack, model, and quantization are compatible. However, the current official binaries and scenario acceptance focus on DGX Spark/GB10 ARM64. x86_64 should be treated as source-deployment/compatibility territory until dedicated packages and model-by-model validation are published.

AMUIN AI STACK is primarily for a trusted **personal, single-host environment**. It is not a multi-tenant scheduler, distributed inference control plane, or enterprise GPU cluster manager. For multi-node networking, pooled GPUs, distributed scheduling, quotas, and organizational governance, consider [GPUStack](https://gpustack.ai/) or another cluster-oriented platform.

Before exposing the service beyond a trusted LAN, review credentials, firewall rules, Docker privileges, model licenses, and each model's remote-code requirements.

## Development

Node.js 20 or newer is recommended:

```bash
npm install
npm run dev
```

Validation commands:

```bash
npm test
npm run build
```

The main components are under `apps/frontend`, `apps/api`, and `apps/main`; runtime definitions are under `deploy` and `configs`; packaging code is under `scripts` and `packaging`.

## Acknowledgements

AMUIN AI STACK's interface layout and many interaction patterns were extensively inspired by [LM Studio](https://lmstudio.ai/). We thank the LM Studio team for setting a high bar for approachable local-AI software. AMUIN AI STACK is an independent project and is not affiliated with or endorsed by LM Studio.

## License

See [LICENSE](LICENSE).
