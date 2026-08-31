# AMUIN AI STACK

English | [简体中文](README.zh-CN.md)

AMUIN AI STACK is a local AI model operations workbench for DGX Spark and other NVIDIA GPU workstations. It combines an Electron desktop shell, a Vue 3 web console, a Node.js/TypeScript control plane, and Docker-based inference runtimes for downloading, auditing, publishing, testing, and operating local models.

> Project status: **developer preview for a single Linux GPU workstation**. The core management workflow is implemented and covered by automated tests, but the project is not yet a production multi-user or cluster platform.

## Status snapshot

Re-evaluated from the current source tree on **2026-08-24** (root package version `1.1.1`):

| Area | Current state |
|---|---|
| Desktop and web UI | Implemented: dashboard, system status, model library, runtime services, publishing, loaded models, playground, tasks, and settings; Chinese and English UI are available. |
| Control plane | Implemented on port `8000` with SQLite state, model audit, downloads, tasks, deployments, container management, settings, and inference discovery/proxy routes. |
| Model lifecycle | Hugging Face and ModelScope import/download planning, resumable task tracking, file-integrity checks, compatibility recommendations, runtime parameters, health checks, logs, retry, repair, and cleanup are implemented. |
| Standard runtimes | vLLM, TensorRT-LLM, and a generic PyTorch environment are represented. vLLM is the primary general-purpose serving path; TensorRT-LLM requires a compatible built engine; PyTorch is an environment base, not a universal model server. |
| Dedicated runtimes | Compose profiles exist for vLLM Embedding, vLLM Reranker, FunASR, VibeVoice, Qwen3-TTS, Unlimited-OCR, MinerU, and LocateAnything. |
| Verification today | API tests: **55/55 passed**; `npm run build` passes; all Compose profiles pass `docker compose config`; LAN console and authenticated remote configuration smoke tests pass. See [Verification](#verification). |
| Release readiness | **The source is build-clean.** x86_64 DEB and RPM artifacts have been produced on an x86_64 Ubuntu build host. RPM installation/systemd behavior on an RPM-based distribution and NVIDIA GPU inference still require target-host acceptance. |


## What works

- Scans local model directories and distinguishes Hugging Face checkpoints, TensorRT-LLM engines, GGUF assets, audio models, Qwen3-TTS, VibeVoice, embeddings, rerankers, OCR/document models, and incomplete downloads.
- Imports Hugging Face or ModelScope repository URLs and runs downloads as persistent, observable background tasks.
- Prevents obviously incomplete or incompatible models from being published and recommends a suitable standard or dedicated runtime.
- Builds, starts, inspects, stops, restarts, and removes managed runtime containers; exposes task stages, logs, health, and repair actions.
- Publishes general models with configurable vLLM/TensorRT-LLM parameters. Runtime arguments are retained and a running deployment is recreated when launch parameters change.
- Discovers live inference services through `GET /v1/models`; every item includes the real direct endpoint, API kind, path, runtime, and published port.
- Proxies OpenAI-style chat, embeddings, and scoring through the control plane and supports direct capability-specific endpoints for speech, transcription, documents, OCR, and grounding.
- Normalizes proxy settings so localhost and private network ranges remain in `NO_PROXY`.

## Runtime and API matrix

Ports are defaults and can be changed through environment variables or runtime settings.

| Runtime/profile | Default port | Primary API | Assessment |
|---|---:|---|---|
| vLLM | `30000` | `/v1/chat/completions` and model-dependent OpenAI routes | Main serving path for supported HF models. |
| TensorRT-LLM | `31000` | `/v1/chat/completions` | Requires a compatible TensorRT-LLM engine and version-specific validation. |
| Generic PyTorch | `32000` | `/healthz`, `/runtime`, `/models` | Environment/diagnostic service only; it does not serve arbitrary ASR/TTS models. |
| vLLM Embedding | `33010` | `/v1/embeddings` | Dedicated pooling profile; historical GB10 inference validation exists. |
| vLLM Reranker | `33020` | `/v1/score` | Dedicated scoring profile; reranker behavior was historically validated and the current route is `/v1/score`. |
| FunASR Gateway | `8011` | `/transcription/transcribe` | SenseVoice/Paraformer selection, general/accurate/domain/meeting presets, optional speaker diarization, and realtime WebSocket audio. |
| VibeVoice HF | `18000` | `/v1/chat/completions` | Dedicated Hugging Face adapter profile; rerun model-level acceptance for the current revision. |
| Qwen3-TTS | `18020` | `/v1/audio/speech` | Managed three-model service for CustomVoice, VoiceDesign, and Base voice cloning; see the [release note](docs/qwen3-tts-dedicated-release.zh-CN.md). |
| Unlimited-OCR | `33030` | `/v1/chat/completions` | Dedicated custom-model OCR service; historical GB10 inference validation exists. |
| MinerU | `33040` | `/v1/documents/parse` | Dedicated document/PDF parsing service; historical GB10 inference validation exists. |
| LocateAnything | `33060` | `/v1/ground` | Image grounding; historical GB10 validation exists. ARM64 video input is not exposed. |

The model directory is the preferred discovery entry point:

```bash
curl http://127.0.0.1:8000/v1/models
```

The control plane proxies these OpenAI-style routes:

```text
POST /v1/chat/completions
POST /v1/embeddings
POST /v1/score
```

Other capability APIs are normally called at the direct `endpoint` returned by `GET /v1/models`. In web development mode, `GET http://127.0.0.1:8888/models` and `/v1/models` are forwarded to the same discovery route.

FunASR realtime routes:

```text
ws://127.0.0.1:8011/v1/realtime
ws://127.0.0.1:8011/ws/realtime
ws://127.0.0.1:8000/ws/audio/...  # control-plane proxy to FunASR
```

## Known gaps and limits

- This is a single-host workstation manager. Multi-node scheduling, Kubernetes orchestration, RBAC, quotas, tenancy, and production observability are not implemented.
- A successful source build is not packaged-app acceptance. The x86_64 RPM still needs installation, systemd, browser, and GPU inference validation on the target distribution.
- In an RPM installation, the authoritative model-root, bind-address, and management-port settings are currently in `/etc/sysconfig/amuin-ai-stack`. The web Settings page does not yet edit `MODELS_ROOT`, and its saved management-port/LAN preferences do not rewrite the systemd environment file.
- Local model directories are discovered automatically, but discovery is not a validation bypass: the control plane still walks and audits their files, and the normal publishing UI only offers models whose download state is `ready`.
- `deploy/compose/docker-compose.yml` describes API/frontend services but the referenced `apps/api/Dockerfile` and `apps/frontend/Dockerfile` are not present. Do not treat that file as a standalone quick-start stack in the current revision.
- GPU inference was not rerun as part of the 2026-08-03 documentation review. Model/image/driver combinations remain version- and hardware-sensitive.
- The Playground currently exercises chat, vision, embeddings, reranking, file ASR, and a speaker-verification proxy. Qwen3-TTS is available through its published direct Speech API, but its Playground panel is not wired yet.
- The control plane exposes `/audio/speaker-verifications`, but the current FunASR gateway template does not implement the corresponding upstream route. Speaker diarization is available as part of transcription; standalone speaker verification is not currently end-to-end.
- GGUF files are audited as local assets but are not served by a built-in runtime. Use llama.cpp, Ollama, or LM Studio externally.
- Dedicated profiles build large local images and require their exact model directories. Some models or upstream code have separate or restrictive licenses; LocateAnything is non-commercial research use and image-only on the current ARM64 profile.

## Requirements

- Linux workstation with a supported NVIDIA GPU and working `nvidia-smi`
- Node.js 20 or newer and npm
- Docker Engine and Docker Compose v2
- NVIDIA Container Toolkit with Docker GPU access
- Permission to use the Docker socket
- Network access to model registries and container registries, or preloaded models/images

Useful host checks:

```bash
node --version
docker version
docker compose version
nvidia-smi
docker ps
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

## Development quick start

```bash
npm install
npm run dev:web
```

Open `http://127.0.0.1:8888`. The Vite server proxies `/api/*` to the control plane at `http://127.0.0.1:8000`.

Other launch modes:

```bash
npm run dev          # Electron when a display exists, otherwise web mode
npm run dev:electron # force Electron; falls back to Xvfb/web when needed
npm run dev:xvfb     # run Electron in Xvfb
```

A typical workflow is:

1. Import a Hugging Face or ModelScope URL.
2. Review the download plan, integrity result, runtime recommendation, and GPU-memory estimate.
3. Download the model and follow the task until the files are complete.
4. Build/pull the recommended runtime and publish the model with reviewed launch parameters.
5. Wait for runtime health and model discovery to report ready.
6. Copy the direct endpoint from the loaded-model view or `GET /v1/models`, then test it in the Playground or with `curl`/an SDK.
7. Use task/deployment logs and repair actions if a stage fails.

## Build and package

These source build commands pass on the reviewed revision; run the RPM release command on an x86_64 build host.

```bash
npm run build
npm run pack
```

Or run:

```bash
bash scripts/build-deb.sh
```

### x86_64 RPM

Build the RPM on an x86_64 Linux host so the package contains x86_64 Electron and `better-sqlite3` binaries:

```bash
npm ci
npm run release:rpm
sudo dnf install ./dist-electron/amuin-ai-stack-1.1.1-1.x86_64.rpm
```

The RPM installs and starts `amuin-ai-stack.service`. Other computers on the LAN can open `http://<server-ip>:8888`. Before changing configuration remotely, read the generated admin token on the server and save it under Settings → Developer → Remote Admin Token:

```bash
sudo sed -n '1p' /var/lib/amuin-ai-stack/admin-token
```

### RPM service configuration

The model directory, listening address, API port, and web-console port are not restricted to build-time defaults. Edit `/etc/sysconfig/amuin-ai-stack` and restart the service:

```bash
MODELS_ROOT=/data/models
AI_STACK_BIND_ADDR=0.0.0.0
PORT=8000
FRONTEND_PORT=8888

sudo mkdir -p /data/models
sudo systemctl restart amuin-ai-stack
```

`AI_STACK_BIND_ADDR=0.0.0.0` makes the server listen on every host interface; use `127.0.0.1` for local-only access or a specific local interface address when required. `PORT` is the control-plane API port and `FRONTEND_PORT` is the browser console port. The systemd unit reads these values at process start, so a restart is required after every change.

The RPM configuration file is currently the source of truth. The web Settings page has no model-directory field. Its management-port and LAN-access controls save desired values in application state, but do not update `/etc/sysconfig/amuin-ai-stack`; use the file above when the running service must actually change.

### Using an existing local model directory

Place each model as an immediate child of `MODELS_ROOT`, for example `/data/models/Qwen3-8B`, then refresh the model library or call `GET /models`. The directory is discovered automatically; there is no separate manual scan or local-import registration step.

Automatic discovery still performs an internal audit. The control plane walks the model files, checks incomplete/indexed weights, reads known configuration files, infers format and compatibility, and estimates GPU-memory suitability. The normal publishing UI only lists models whose audit produces `status.download = ready`; unsupported or insufficient-memory combinations can also be blocked during deployment. The current `POST /models/import` route is for Hugging Face/ModelScope URLs and is not a local-directory registration or "trust this directory" bypass.

Artifacts are written to `dist-electron/`. In a packaged desktop installation, the writable workspace is:

```text
~/.local/share/ai-stack/
├── models/
├── cache/
├── state/
├── logs/
├── tmp/
├── configs/
├── deploy/
├── ops/
└── data.db
```

In development, `AI_STACK_BASE` defaults to the repository root. Runtime paths can be overridden with `AI_STACK_BASE`, `MODELS_ROOT`, `STATE_ROOT`, `LOGS_ROOT`, and `AI_STACK_DB_PATH`.

## Verification

Run the current automated checks with:

```bash
npm --prefix apps/api test
npm --prefix apps/api run typecheck
npm run build
```

Review result on 2026-08-24: 55/55 API tests, the full Electron/API/frontend build, and all Compose profiles pass. The LAN console returns 200; remote configuration returns 403 without a token and 200 with the correct token. x86_64 DEB and RPM artifacts were produced on an x86_64 Ubuntu host; RPM target-distribution installation and GPU inference remain to be accepted.

Before using a runtime profile, validate and then start it from the UI. For manual profile work:

```bash
docker compose -f deploy/compose/custom/docker-compose.funasr-gateway.yml config
docker compose -f deploy/compose/custom/docker-compose.funasr-gateway.yml up -d --build
```

`docker compose config` only validates configuration rendering. Release acceptance also needs container startup, GPU/model loading, health checks, and a real inference request on the target machine.

## Repository layout

| Path | Purpose |
|---|---|
| `apps/main/` | Electron main process and packaged workspace initialization. |
| `apps/api/` | Node.js/TypeScript control plane and tests. |
| `apps/frontend/` | Vue 3 + Vite bilingual console. |
| `configs/` | Model catalog, runtime profiles, residency, and proxy settings. |
| `deploy/compose/` | Standard and dedicated Docker Compose profiles. |
| `deploy/templates/` | Runtime API servers and configuration templates. |
| `deploy/dockerfiles/` | Helper and dedicated-runtime Dockerfiles. |
| `ops/scripts/` | Download, health, diagnostics, TensorRT-LLM, and smoke-test scripts. |
| `docs/` | Architecture, design, migration, and model-specific notes. |

## License and model terms

AMUIN AI STACK source code is licensed under the [MIT License](LICENSE). Model weights, container images, and upstream model code retain their own licenses and acceptable-use terms. Review [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before redistribution.
