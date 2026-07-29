# AMUIN AI STACK

AMUIN AI STACK is a local AI model operations workbench for DGX Spark and NVIDIA GPU workstations. It provides an Electron desktop console and a Vue 3 web console for inspecting local model files, downloading Hugging Face / ModelScope repositories, preparing runtime containers, launching model services, and exposing OpenAI-compatible endpoints through a local Node.js control plane.

The project is currently packaged as a Linux .deb desktop app. The source repository can be published on GitHub, but the npm package is marked private to avoid accidental npm registry publication.

## Current Status

Implemented today:

- Electron desktop shell for the packaged app.
- Vue 3 + Vite management console for dashboard, model library, runtime services, model publishing, playground, tasks, and settings.
- Node.js / TypeScript backend API on port 8000.
- Local model audit for Hugging Face checkpoints, TensorRT-LLM engines, GGUF files, and audio-model directories.
- Hugging Face / ModelScope download planning and tracked background download tasks.
- Runtime planning and deployment tasks for the default vLLM, TensorRT-LLM, and generic PyTorch slots.
- Container lifecycle controls, image pull/test tasks, logs, and repair actions.
- OpenAI-compatible HTTP proxy routes for running text/embedding runtimes.
- Generic PyTorch environment template with health, runtime info, and model-directory listing endpoints.
- Third-party notices in THIRD_PARTY_NOTICES.md.

Not implemented as a built-in serving path yet:

- TTS synthesis service. TTS/CosyVoice models are detected and categorized, but no production TTS REST or WebSocket synthesis endpoint is implemented yet.
- GGUF serving. GGUF files are recognized as local assets, but built-in AMUIN runtimes do not serve them; use LM Studio, Ollama, or llama.cpp externally.
- Production multi-node / multi-cluster scheduling, RBAC, quotas, or Kubernetes orchestration.

## Runtime Ports And Endpoints

Default ports:

| Component | Default | Notes |
|---|---:|---|
| Backend API | 8000 | Node.js control plane; exposes management APIs and /v1 OpenAI-compatible proxy routes. |
| Web console dev server | 8888 | Vite dev/web mode only. In the packaged Electron app the frontend is loaded from local static files. |
| vLLM runtime | 30000 | OpenAI-compatible model service at /v1 when a vLLM model is running. |
| TensorRT-LLM runtime | 31000 | OpenAI-compatible model service at /v1 when a TensorRT-LLM model is running. |
| PyTorch runtime | 32000 | Generic PyTorch environment with /healthz, /runtime, and /models. Audio/FunASR should be added as custom business runtimes. |

Backend API routes include:

| Route | Purpose |
|---|---|
| GET /healthz | API health check. |
| GET /system/check | Host, GPU, Docker, network, and workbench status. |
| GET /models | Local model registry and audit results. |
| POST /models/import | Parse a Hugging Face / ModelScope URL into a download plan. |
| POST /downloads | Start a tracked model download task. |
| GET /tasks and GET /tasks/:id/logs | Task list and task logs. |
| GET /containers | Runtime container inventory. |
| POST /containers/:key/pull-image | Pull a runtime image. |
| POST /containers/:key/start-test | Start a runtime container test. |
| GET /deployments | Configured and running service slots. |
| POST /deployments/start | Start a model deployment task. |
| GET /deployments/:id/logs | Runtime container logs with task-log fallback. |
| POST /deployments/:id/stop | Stop and remove a runtime container. |
| POST /deployments/:id/restart | Restart a runtime container. |
| GET :8888/models or GET :8888/v1/models | Live model directory. Each item contains the model runtime's direct endpoint, API kind, path, and public port. |
| Model inference endpoints | Call the `endpoint` returned by the model directory directly; inference stays on each model runtime's own published port. |
| POST /v1/chat/completions | Backend OpenAI-compatible chat proxy. |
| POST /v1/embeddings | Backend OpenAI-compatible embeddings proxy. |
| GET /audio/models | Historical audio proxy entry; it should target a custom Audio/FunASR service, not the default PyTorch container. |

Audio WebSocket routes:

| Route | Status |
|---|---|
| ws://127.0.0.1:32000/v1/realtime | No longer implemented by the default PyTorch container; provide it from a custom Audio runtime. |
| ws://127.0.0.1:32000/ws/realtime | Historical compatibility path; not implemented by the default PyTorch container. |
| ws://127.0.0.1:8000/ws/audio/... | Backend audio proxy entry; configure the target to a custom Audio service. |

## Release Package

The release package is a .deb desktop application. It includes:

- Electron desktop shell and built frontend assets.
- Built Node.js backend API and bundled runtime npm dependencies.
- Runtime templates, Docker Compose templates, helper Dockerfiles, and operational scripts.
- Download, deployment, TensorRT-LLM launch, health-check, and diagnostic scripts.

In packaged mode, the app creates and uses a writable workspace under the Electron user-data directory:

~~~text
~/.config/AMUIN AI STACK/workspace/
├── models/     # model files
├── cache/      # Hugging Face / ModelScope cache
├── state/      # task state and temporary compose projects
├── logs/       # download, deployment, and container task logs
├── tmp/        # temporary files
├── configs/    # default configs copied on first launch
├── deploy/     # compose/template resources synced on launch
└── ops/        # operational scripts synced on launch
~~~

The backend database defaults to:

~~~text
~/.local/share/ai-stack/data.db
~~~

In development mode, the repository root is used as AI_STACK_BASE by default.

## Target Machine Requirements

DGX Spark machines and similar NVIDIA GPU workstations usually provide the GPU driver stack, but verify these before testing model serving:

| Requirement | Purpose | Check |
|---|---|---|
| Docker Engine | Pull, build, and run model containers | docker version |
| Docker Compose v2 | Render and launch compose templates | docker compose version |
| NVIDIA Driver | GPU visibility and nvidia-smi | nvidia-smi |
| NVIDIA Container Toolkit | GPU access from Docker containers | docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi |
| Docker socket permission | Allow AMUIN to manage containers | docker ps |
| Network or preloaded images | Runtime image pulls and model downloads | docker pull vllm/vllm-openai:latest |

The generated deb declares Docker, Compose, NVIDIA Container Toolkit, and Electron GUI library dependencies. If the target machine has no Docker/NVIDIA apt repositories configured, install the low-level runtime stack first using the machine vendor, NVIDIA, or Docker instructions.

## Build And Run

Install dependencies and build everything:

~~~bash
npm install
npm run build
~~~

Package a .deb:

~~~bash
npm run pack
~~~

Or use the release helper:

~~~bash
bash scripts/build-deb.sh
~~~

The .deb is written to dist-electron/.

Development launchers:

~~~bash
npm run dev          # auto-select Electron or web mode
npm run dev:web      # API + Vite only, useful over SSH
npm run dev:electron # force Electron
npm run dev:xvfb     # Electron inside Xvfb
~~~

Web dev mode opens the console at http://127.0.0.1:8888 and proxies /api/* to the backend API at http://127.0.0.1:8000.

## Runtime Architecture

~~~text
Electron desktop app or Vite web console
        -> Backend API (:8000)
        -> Docker / NVIDIA runtime
          ├── vLLM service (:30000)
          ├── TensorRT-LLM service (:31000)
          └── PyTorch environment (:32000)
~~~

The backend control plane owns model audit, download tasks, runtime planning, deployment tasks, logs, health checks, and OpenAI-compatible proxy routing.

## Typical Workflow

1. Import a Hugging Face or ModelScope model URL.
2. Review the generated download plan and expected runtime compatibility.
3. Download model files as a tracked task.
4. Audit local model files, format, capabilities, and GPU-memory fit.
5. Pull or test the target runtime image.
6. Start a deployment into the selected runtime slot.
7. Call the running model through the backend /v1 proxy or the runtime service port.
8. Inspect task logs, deployment logs, health checks, and repair actions if something fails.

## Runtime Compatibility

| Model / Format | vLLM | TensorRT-LLM | PyTorch | Notes |
|---|---|---|---|---|
| Hugging Face safetensors / bin checkpoint | Supported when model architecture is supported by vLLM | Possible, architecture/version dependent | No | Requires config, tokenizer, and complete weight shards. |
| TensorRT-LLM engine | No | Supported route | No | Use the TensorRT-LLM service slot. |
| GGUF single file | No | No | No | Recognized as a local asset only; serve externally with LM Studio/Ollama/llama.cpp. |
| Whisper / FunASR-style ASR directory | No | No | Needs a custom Audio/FunASR container | The default PyTorch runtime is a generic environment and does not directly serve ASR. |
| CosyVoice / TTS-style directory | No | No | Needs a custom Audio/TTS container | TTS serving is not implemented yet. |

## Repository Layout

| Path | Purpose |
|---|---|
| apps/main/ | Electron main process and packaged-app workspace bootstrap. |
| apps/api/ | Node.js / TypeScript backend control plane. |
| apps/frontend/ | Vue 3 + Vite management console. |
| configs/ | Model catalog, runtime profiles, residency/proxy config. |
| deploy/compose/ | Docker Compose definitions and runtime compose overlays. |
| deploy/templates/ | Runtime templates, including the generic PyTorch environment template. |
| deploy/dockerfiles/ | Helper Dockerfiles for download/runtime images. |
| ops/scripts/ | Download, TensorRT-LLM, health-check, and diagnostic scripts. |
| scripts/ | Development and packaging helpers. |
| docs/ | Design notes, migration notes, and prototypes. |
| THIRD_PARTY_NOTICES.md | Third-party dependency and upstream notice summary. |

## Publication Notes

Before pushing a public GitHub repository:

- Do not commit model weights, caches, logs, runtime state, or packaged Electron output.
- Keep models/, cache/, logs/, state/, volumes/, dist-electron/, .cache/, and .npm-cache/ out of git.
- Keep upstream SPDX notices in files that already contain them.
- Review THIRD_PARTY_NOTICES.md when adding dependencies, vendor snippets, runtime images, or model templates.
- Remember that model licenses are separate from the AMUIN source license; users must comply with each downloaded model license.

## Troubleshooting

- docker ps fails: add the user to the docker group and log in again.
- Containers cannot see the GPU: check the NVIDIA driver, nvidia-smi, and nvidia-container-toolkit.
- Runtime image pulls are slow or unavailable: preload images with docker pull, docker save, and docker load.
- Downloads fail: check proxy, DNS, Hugging Face / ModelScope reachability, and configs/proxy.env.
- Port conflicts: default ports are 8000, 8888, 30000, 31000, and 32000; free those ports or update runtime settings.
