# AMUIN AI STACK

AMUIN AI STACK 是面向 DGX Spark 与 NVIDIA GPU 工作站的本地 AI 模型运维工作台。它提供 Electron 桌面控制台和 Vue 3 Web 控制台，用于检查本地模型文件、下载 Hugging Face / ModelScope 仓库、准备运行时容器、启动模型服务，并通过本机 Node.js 控制面暴露 OpenAI 兼容接口。

当前项目以 Linux .deb 桌面应用作为主要分发形态。源码可以发布到 GitHub；package.json 中的 private: true 只是用于避免误发布到 npm registry。

## 当前状态

当前已经实现：

- Electron 桌面壳和打包应用启动流程。
- Vue 3 + Vite 管理控制台，覆盖仪表盘、模型库、运行时服务、模型发布、模型测试、任务和设置。
- 监听 8000 端口的 Node.js / TypeScript 后端 API。
- 本地模型审计：Hugging Face checkpoint、TensorRT-LLM engine、GGUF 文件、音频模型目录。
- Hugging Face / ModelScope 下载计划和可跟踪的后台下载任务。
- vLLM、TensorRT-LLM、通用 PyTorch 三类默认运行时槽位的计划生成和部署任务。
- 容器生命周期控制、镜像拉取/测试任务、日志和修复动作。
- 面向运行中文本/向量模型的 OpenAI 兼容 HTTP 代理接口。
- 通用 PyTorch 环境模板，提供健康检查、运行时信息和模型目录枚举。
- 第三方资源说明文件 THIRD_PARTY_NOTICES.md。

当前还没有作为内置服务落地：

- TTS 语音合成服务。系统会识别和分类 TTS / CosyVoice 模型，但还没有生产可用的 TTS REST 或 WebSocket 合成接口。
- GGUF 内置服务。GGUF 会被识别为本地资产，但 AMUIN 内置运行时不会直接服务 GGUF；请使用 LM Studio、Ollama 或 llama.cpp 等外部工具。
- 生产级多节点/多集群调度、RBAC、配额或 Kubernetes 编排。

## 运行端口与接口

默认端口：

| 组件 | 默认端口 | 说明 |
|---|---:|---|
| 后端 API | 8000 | Node.js 控制面；提供管理 API 和 /v1 OpenAI 兼容代理接口。 |
| Web 开发控制台 | 8888 | 仅 Vite 开发/Web 模式使用。打包后的 Electron 应用从本地静态文件加载前端。 |
| vLLM 运行时 | 30000 | vLLM 模型运行后在 /v1 提供 OpenAI 兼容服务。 |
| TensorRT-LLM 运行时 | 31000 | TensorRT-LLM 模型运行后在 /v1 提供 OpenAI 兼容服务。 |
| PyTorch 运行时 | 32000 | 通用 PyTorch 环境，提供 /healthz、/runtime 和 /models；Audio/FunASR 作为后续自定义业务容器创建。 |

后端 API 包含：

| 路由 | 用途 |
|---|---|
| GET /healthz | API 健康检查。 |
| GET /system/check | 主机、GPU、Docker、网络和工作台状态。 |
| GET /models | 本地模型 registry 与审计结果。 |
| POST /models/import | 将 Hugging Face / ModelScope URL 解析为下载计划。 |
| POST /downloads | 启动可跟踪的模型下载任务。 |
| GET /tasks 和 GET /tasks/:id/logs | 任务列表和任务日志。 |
| GET /containers | 运行时容器列表。 |
| POST /containers/:key/pull-image | 拉取运行时镜像。 |
| POST /containers/:key/start-test | 启动运行时容器测试。 |
| GET /deployments | 已配置和运行中的服务槽位。 |
| POST /deployments/start | 启动模型部署任务。 |
| GET /deployments/:id/logs | 运行时容器日志，Docker 不可用时回退到任务日志。 |
| POST /deployments/:id/stop | 停止并移除运行时容器。 |
| POST /deployments/:id/restart | 重启运行时容器。 |
| GET :8888/models 或 GET :8888/v1/models | 运行中模型目录；每项返回该模型运行时的直连接口、接口类型、路径和发布端口。 |
| 模型推理接口 | 直接调用模型目录返回的 `endpoint`；推理请求仍访问各模型运行时自己的发布端口。 |
| POST /v1/chat/completions | 后端 OpenAI 兼容聊天代理。 |
| POST /v1/embeddings | 后端 OpenAI 兼容向量代理。 |
| GET /audio/models | 历史音频代理入口；后续应指向自定义 Audio/FunASR 服务，不再等同默认 PyTorch 容器。 |

音频 WebSocket 路由：

| 路由 | 状态 |
|---|---|
| ws://127.0.0.1:32000/v1/realtime | 默认 PyTorch 容器不再提供该 ASR WebSocket；需要由自定义 Audio 容器实现。 |
| ws://127.0.0.1:32000/ws/realtime | 历史兼容路径；默认 PyTorch 容器不再实现。 |
| ws://127.0.0.1:8000/ws/audio/... | 后端音频代理入口；目标应配置为自定义 Audio 服务。 |

## 发布包

发布包是 .deb 桌面应用。包内包含：

- Electron 桌面壳和前端构建产物。
- Node.js 后端 API 构建产物及其 npm 运行依赖。
- 运行时模板、Docker Compose 模板、辅助 Dockerfile 和运维脚本。
- 下载、部署、TensorRT-LLM 启动、健康检查和诊断脚本。

打包模式下，应用会在 Electron user-data 目录下创建并使用可写工作区：

~~~text
~/.config/AMUIN AI STACK/workspace/
├── models/     # 模型文件
├── cache/      # Hugging Face / ModelScope 缓存
├── state/      # 任务状态和临时 compose 项目
├── logs/       # 下载、部署、容器任务日志
├── tmp/        # 临时文件
├── configs/    # 首次启动复制的默认配置
├── deploy/     # 启动时同步的 compose/template 资源
└── ops/        # 启动时同步的运维脚本
~~~

后端数据库默认位于：

~~~text
~/.local/share/ai-stack/data.db
~~~

开发模式下，默认使用仓库根目录作为 AI_STACK_BASE。

## 目标机器依赖

DGX Spark 和类似 NVIDIA GPU 工作站通常已经具备 GPU 驱动栈，但正式测试模型服务前仍建议确认：

| 依赖 | 用途 | 检查命令 |
|---|---|---|
| Docker Engine | 拉取、构建、运行模型容器 | docker version |
| Docker Compose v2 | 渲染和启动 compose 模板 | docker compose version |
| NVIDIA Driver | GPU 可见性和 nvidia-smi | nvidia-smi |
| NVIDIA Container Toolkit | 让 Docker 容器使用 GPU | docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi |
| Docker socket 权限 | 允许 AMUIN 管理容器 | docker ps |
| 网络或预置镜像 | 运行时镜像拉取和模型下载 | docker pull vllm/vllm-openai:latest |

生成的 deb 会声明 Docker、Compose、NVIDIA Container Toolkit 和 Electron GUI 运行库依赖。如果目标机没有 Docker/NVIDIA apt 源，请先按机器厂商、NVIDIA 或 Docker 官方说明完成底层运行环境安装。

## 构建与运行

安装依赖并构建全部模块：

~~~bash
npm install
npm run build
~~~

打包 .deb：

~~~bash
npm run pack
~~~

也可以使用发布脚本：

~~~bash
bash scripts/build-deb.sh
~~~

生成的 .deb 会输出到 dist-electron/。

开发启动命令：

~~~bash
npm run dev          # 自动选择 Electron 或 Web 模式
npm run dev:web      # 仅启动 API + Vite，适合 SSH 环境
npm run dev:electron # 强制 Electron
npm run dev:xvfb     # 在 Xvfb 中运行 Electron
~~~

Web 开发模式下，控制台地址是 http://127.0.0.1:8888，并将 /api/* 代理到 http://127.0.0.1:8000 后端 API。

## 运行架构

~~~text
Electron 桌面应用或 Vite Web 控制台
        -> 后端 API (:8000)
        -> Docker / NVIDIA runtime
          ├── vLLM service (:30000)
          ├── TensorRT-LLM service (:31000)
          └── PyTorch environment (:32000)
~~~

后端控制面负责模型审计、下载任务、运行时计划、部署任务、日志、健康检查和 OpenAI 兼容代理路由。

## 典型工作流

1. 导入 Hugging Face 或 ModelScope 模型 URL。
2. 查看下载计划和预计运行时兼容性。
3. 以后台任务下载模型文件。
4. 审计本地模型文件、格式、能力和显存适配情况。
5. 拉取或测试目标运行时镜像。
6. 将模型部署到选定运行时槽位。
7. 通过后端 /v1 代理或运行时服务端口调用模型。
8. 失败时查看任务日志、部署日志、健康检查和修复动作。

## 运行时兼容性

| 模型 / 格式 | vLLM | TensorRT-LLM | PyTorch | 说明 |
|---|---|---|---|---|
| Hugging Face safetensors / bin checkpoint | 支持，取决于 vLLM 是否支持该架构 | 可能支持，取决于架构和版本 | 不支持 | 需要 config、tokenizer 和完整权重分片。 |
| TensorRT-LLM engine | 不支持 | 支持 | 不支持 | 使用 TensorRT-LLM 服务槽位。 |
| GGUF 单文件 | 不支持 | 不支持 | 不支持 | 只识别为本地资产；请使用 LM Studio/Ollama/llama.cpp 外部服务。 |
| Whisper / FunASR 风格 ASR 目录 | 不支持 | 不支持 | 需要自定义 Audio/FunASR 容器 | 默认 PyTorch 只是通用环境，不直接提供 ASR。 |
| CosyVoice / TTS 风格目录 | 不支持 | 不支持 | 需要自定义 Audio/TTS 容器 | TTS 服务尚未实现。 |

## 仓库结构

| 路径 | 用途 |
|---|---|
| apps/main/ | Electron main process 和打包应用工作区初始化。 |
| apps/api/ | Node.js / TypeScript 后端控制面。 |
| apps/frontend/ | Vue 3 + Vite 管理控制台。 |
| configs/ | 模型清单、运行时 profile、驻留/代理配置。 |
| deploy/compose/ | Docker Compose 定义和运行时 overlay。 |
| deploy/templates/ | 运行时模板，包括通用 PyTorch 环境模板。 |
| deploy/dockerfiles/ | 下载/运行时辅助 Dockerfile。 |
| ops/scripts/ | 下载、TensorRT-LLM、健康检查和诊断脚本。 |
| scripts/ | 开发和打包辅助脚本。 |
| docs/ | 设计说明、迁移说明和原型。 |
| THIRD_PARTY_NOTICES.md | 第三方依赖和上游 notices 摘要。 |

## 开源发布注意事项

发布公开 GitHub 仓库前：

- 不要提交模型权重、缓存、日志、运行状态或 Electron 打包产物。
- models/、cache/、logs/、state/、volumes/、dist-electron/、.cache/、.npm-cache/ 应保持在 git 之外。
- 已带上游 SPDX notices 的文件应保留 notices。
- 增加依赖、vendor 代码片段、运行时镜像或模型模板时，同步检查 THIRD_PARTY_NOTICES.md。
- 模型许可证独立于 AMUIN 源码许可证；用户需要遵守每个下载模型自己的许可证。

## 常见问题

- docker ps 权限失败：把当前用户加入 docker 组后重新登录。
- 容器看不到 GPU：检查 NVIDIA 驱动、nvidia-smi 和 nvidia-container-toolkit。
- 运行时镜像拉取慢或不可用：可预先 docker pull、docker save、docker load。
- 下载失败：检查代理、DNS、Hugging Face / ModelScope 可达性，以及 configs/proxy.env。
- 端口冲突：默认端口是 8000、8888、30000、31000、32000；释放冲突端口或调整运行时设置。
