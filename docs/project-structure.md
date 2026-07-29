# Project Structure

This workspace is organized around AMUIN AI STACK, a local desktop workbench for model operations.

## Source Code

- `apps/api/`: TypeScript/Node.js control plane, chat compatibility API, model registry APIs.
- `apps/frontend/`: Vue 3 + Vite management console, served by the Electron shell or web dev launcher on `localhost:8888`.

## Deployment

- `deploy/compose/`: Docker Compose entrypoints.
  - `docker-compose.yml`: main workbench stack.
  - `docker-compose.vllm.yml`: vLLM worker template.
  - `docker-compose.pytorch.yml`: default PyTorch environment template.
  - `custom/`: business-specific custom runtime profile templates, kept separate from the three system default containers.
- `deploy/dockerfiles/`: Helper Dockerfiles for downloads and legacy model serving.

## Operations

- `ops/scripts/`: Manual operational scripts for downloading, checking, and starting models.
- `configs/`: Catalogs, runtime profiles, residency policy, proxy settings.
- `logs/`: Runtime logs.
- `tmp/`: Scratch space.

## Data Roots

These stay at the repository root because they are large, persistent, and used by compose mounts:

- `models/`: Local model assets.
- `cache/`: Hugging Face, ModelScope, and Whisper caches.
- `volumes/`: Docker service data for PostgreSQL, Milvus, etcd, and MinIO.
- `engines/`: Future TensorRT-LLM engines.

## Standard Commands

Run compose from the repository root:

```bash
docker compose -f deploy/compose/docker-compose.yml up -d --build
docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.vllm.yml config
docker compose -f deploy/compose/custom/docker-compose.funasr-gateway.yml config
```

Run scripts from the repository root:

```bash
ops/scripts/check_models_progress.py
ops/scripts/ms-download.sh Qwen/Qwen3.5-9B qwen35-9b
ops/scripts/hf-download.sh Tesslate/OmniCoder-9B omnicoder-9b
```
