# AMUIN AI STACK

A vLLM-first local model workbench for DGX Spark — download, audit, deploy, and serve models through OpenAI-compatible APIs.

## Architecture

```
Frontend Console (:8888) → Backend Control Plane (:8000) → Docker/NVIDIA Runtime
                                                              ├── vLLM Service (:30000)
                                                              ├── TensorRT-LLM Service (:31000)
                                                              └── Audio Service (:32000)
```

- **Management console** fixed at `http://localhost:8888`
- **Inference services** published in the `30000–60000` port range, one entrypoint per service type
- **vLLM** is the default runtime for LLM / VLM / embedding workloads
- **TensorRT-LLM** is available as an advanced option for DGX Spark validated models
- **llama.cpp / GGUF** is not a publishing target — use LM Studio or external tools for GGUF files

## Quick Start

```bash
cd /home/zhenz/ai-stack

# Full stack (API + frontend + infrastructure)
docker compose -f deploy/compose/docker-compose.yml up -d --build

# With vLLM worker template
docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.vllm.yml up -d --build

# Audio-only stack (ASR + TTS)
docker compose -f deploy/compose/docker-compose.audio.yml up -d --build
```

Open `http://localhost:8888` to access the management console.

## Directory Layout

| Directory | Purpose |
|-----------|---------|
| `apps/api/` | TypeScript/Node.js control plane — model registry, downloads, deployments, OpenAI proxy |
| `apps/frontend/` | Vue 3 management console and chat UI |
| `services/audio/` | ASR/TTS realtime audio service (PyTorch 25.04) |
| `legacy/python-backend/` | Previous FastAPI backend — migration reference only |
| `deploy/compose/` | Docker Compose entrypoints (main, vllm, audio, legacy models) |
| `deploy/dockerfiles/` | Helper images (download tools, llama.cpp) |
| `models/` | Local model checkpoints and weights |
| `cache/` | HuggingFace / ModelScope download cache |
| `volumes/` | Persistent data (PostgreSQL, Milvus, etcd, MinIO) |
| `configs/` | Model catalog, runtime profiles, residency policy |
| `ops/scripts/` | Operational scripts (download, start/stop, health checks) |
| `logs/` | Service and task logs |
| `engines/` | Future TensorRT-LLM engines |

## Model Lifecycle

Every model follows a state machine:

`unknown → downloading → downloaded → ready → running → stopped`

- **Import** a model by pasting a HuggingFace or ModelScope URL
- **Audit** inspects file structure, format, capabilities, and runtime compatibility
- **Download** runs as a tracked task with progress and log output
- **Deploy** loads a compatible model into a vLLM / TensorRT-LLM / Audio runtime
- **Unload** stops the deployment and frees GPU memory

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
| POST | `/deployments/start` | Deploy a model to a runtime |
| POST | `/deployments/:id/stop` | Stop a deployment |
| GET | `/containers` | List runtime containers with status |
| POST | `/containers/:key/pull-image` | Pull a runtime Docker image |
| POST | `/containers/:name/start` | Start a container |
| POST | `/containers/:name/stop` | Stop a container |
| GET/POST | `/settings/workbench` | Read or update management port |
| GET/POST | `/settings/network` | Read or toggle LAN access |

### OpenAI-compatible API (port 8888, proxied to running services)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/models` | List models running on active deployments |
| POST | `/v1/chat/completions` | Chat completions (auto-loads model if needed) |
| POST | `/v1/embeddings` | Embeddings |

## Port Policy

| Port | Service |
|------|---------|
| `8888` | Management console (fixed) |
| `8000` | Backend API (internal) |
| `30000` | vLLM OpenAI service |
| `31000` | TensorRT-LLM OpenAI service |
| `32000` | Audio HTTP/WebSocket service |

Inference ports are **per service type**, not per model. Models register into their target service; worker ports are internal only.

## Operations

```bash
# Download a model from ModelScope
ops/scripts/ms-download.sh Qwen/Qwen3.5-9B qwen35-9b

# Download from HuggingFace
ops/scripts/hf-download.sh Tesslate/OmniCoder-9B omnicoder-9b

# Check model download completeness
python3 ops/scripts/check_models_progress.py

# Inspect running containers
docker ps --format '{{.Names}}\t{{.Status}}'
docker logs --tail 100 vllm-service
```

## Notes

- ModelScope (`modelscope.cn`) is the primary download source on this host; HuggingFace may time out
- Docker socket access is required for all container operations
- The legacy `docker-compose-models.yml` (llama.cpp/GGUF) is kept for reference only
- TensorRT-LLM support depends on the DGX Spark image version and model architecture
- vLLM is not universal — some architectures, quantizations, or multimodal models may need specific versions or extra dependencies
