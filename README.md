# AMUIN AI STACK

A local AI model workbench for DGX Spark — download models, launch standardized container templates, and load models into vLLM / TensorRT-LLM / PyTorch runtimes with OpenAI-compatible APIs.

## Architecture

```
Frontend Console (:8888) → Backend API (:8000) → Docker / NVIDIA Runtime
                                                    ├── vLLM Service (:30000)
                                                    ├── TensorRT-LLM Service (:31000)
                                                    └── Audio Service (:32000, PyTorch)
```

- **Management console** at `http://localhost:8888`
- **Inference services** on ports `30000–60000`, one entry per service type
- **3 standardized template containers** — vLLM, TensorRT-LLM, Audio (PyTorch) — pre-configured with Docker images, component dependencies, and restart policies

## Quick Start

```bash
cd /home/zhenz/ai-stack

# Full stack (API + frontend + infrastructure)
docker compose -f deploy/compose/docker-compose.yml up -d --build

# With vLLM worker
docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.vllm.yml up -d --build

# Audio-only stack (ASR + TTS)
docker compose -f deploy/compose/docker-compose.audio.yml up -d --build
```

Open `http://localhost:8888` to access the management console.

## Directory Layout

| Directory | Purpose |
|-----------|---------|
| `apps/api/` | Node.js/TypeScript control plane — model registry, downloads, deployments |
| `apps/frontend/` | Vue 3 + Vite management console and chat UI |
| `services/audio/` | Python ASR/TTS audio service (FunASR + CosyVoice, PyTorch) |
| `deploy/compose/` | Docker Compose entrypoints (main, vllm, audio) |
| `deploy/dockerfiles/` | Helper images (download tools) |
| `models/` | Local model checkpoints and weights (gitignored) |
| `configs/` | Model catalog, runtime profiles, residency policy |
| `scripts/` | Development convenience scripts |
| `ops/` | Operational scripts (download, health checks) |
| `playbooks/` | DGX Spark reference playbooks and examples |

Automatically generated at runtime (gitignored): `volumes/`, `cache/`, `state/`, `logs/`, `tmp/`.

## Container Templates

| Template | Runtime | Port | Stack |
|----------|---------|------|-------|
| vLLM | LLM / VLM / Embedding | 30000 | Python, CUDA, PyTorch, vLLM |
| TensorRT-LLM | High-performance LLM | 31000 | CUDA, TensorRT-LLM |
| Audio Service | ASR / TTS | 32000 | Python, PyTorch, FunASR, CosyVoice |

All three are pre-debugged: Docker images pinned, components verified, restart policies set to `resident`. Launch a container, load a compatible model, and the endpoint is live.

## Workflow

```
Import URL → Audit model → Download → Start container → Load model → Serve
```

1. **Import** — paste a HuggingFace or ModelScope model URL
2. **Audit** — auto-detect file structure, format, capabilities, and runtime compatibility
3. **Download** — runs as a tracked background task with progress and logs
4. **Start container** — pull the runtime image and launch from a standardized template
5. **Load model** — deploy the local model into the target container
6. **Serve** — model registers on the service port with an OpenAI-compatible endpoint

## Runtime Compatibility

| Model Format | vLLM | TensorRT-LLM | Audio | Notes |
|---|---|---|---|---|
| HF safetensors checkpoint | ✓ default | possible | — | Requires config.json + tokenizer + weight shards |
| TensorRT-LLM engine | — | ✓ only | — | Cannot be served by vLLM |
| GGUF single file | — | — | — | External (LM Studio); not deployed by this system |
| FunASR / CosyVoice / Whisper | — | — | ✓ | Audio service only |

## API Endpoints

### Management API (internal, port 8000)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/system/check` | System health, Docker, GPU, ports |
| GET | `/models` | List local models with audit data |
| POST | `/models/import` | Parse a model URL and preview the download plan |
| POST | `/downloads` | Start a model download task |
| GET | `/tasks` | List all tasks (download, deploy, container) |
| GET | `/tasks/:id/logs` | Read task log output |
| GET | `/deployments` | List configured and active deployments |
| POST | `/deployments` | Deploy a model to a runtime |
| GET | `/containers` | List runtime containers with status |
| POST | `/containers/:key/pull-image` | Pull a runtime Docker image |
| POST | `/containers/:key/test-image` | Test a runtime image |
| GET/POST | `/settings/workbench` | Read or update management port |
| GET/POST | `/settings/network` | Read or toggle LAN access |

### OpenAI-compatible API (port 8888, proxied to running services)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/models` | List models on active deployments |
| POST | `/v1/chat/completions` | Chat completions |
| POST | `/v1/embeddings` | Embeddings |

## Port Policy

| Port | Service |
|------|---------|
| `8888` | Management console (fixed) |
| `8000` | Backend API (internal) |
| `30000` | vLLM OpenAI service |
| `31000` | TensorRT-LLM OpenAI service |
| `32000` | Audio HTTP/WebSocket service |

Inference ports are per service type, not per model. Models register into their target service.

## Notes

- ModelScope (`modelscope.cn`) is the primary download source; HuggingFace may time out on this host
- Docker socket access is required for all container operations
- vLLM is not universal — some architectures, quantizations, or multimodal models may need specific versions
- TensorRT-LLM support depends on the DGX Spark image version and model architecture
