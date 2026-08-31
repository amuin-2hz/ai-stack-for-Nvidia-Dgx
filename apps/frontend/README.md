# Frontend

Vue 3 + Vite management console for AMUIN AI STACK.

## Overview

The frontend is a desktop-style control surface for local model operations:

- Dashboard for host readiness, GPU, Docker, containers, and recent tasks
- Model library for local model audit, compatibility hints, downloads, and deletion guards
- Runtime/service pages for vLLM, TensorRT-LLM, and PyTorch audio containers
- Deployment and load flows for publishing local models through OpenAI-compatible endpoints
- Playground for chat, vision-style requests, and embeddings against running local services
- Task views for download, deployment, repair actions, and logs

## Stack

- Vue 3
- Vite
- TypeScript
- Ant Design Vue

## Development

From the repository root:

```bash
npm run dev:web
```

Or from this package:

```bash
npm --prefix apps/frontend run dev
```

The production frontend build is created by the root build command:

```bash
npm run build
```
