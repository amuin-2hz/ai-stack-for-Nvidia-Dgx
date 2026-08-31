# AMUIN AI STACK

简体中文 | [English](README.md)

AMUIN AI STACK 是面向 DGX Spark 及其他 NVIDIA GPU 工作站的本地 AI 模型运维工作台。项目由 Electron 桌面壳、Vue 3 Web 控制台、Node.js/TypeScript 控制面和基于 Docker 的推理运行时组成，用于下载、审计、发布、测试和管理本地模型。

> 项目定位：**Linux 单机 GPU 工作站开发预览版**。核心管理流程已经实现并有自动化测试覆盖，但目前还不是生产级多用户或集群平台。

## 状态概览

以下结论基于 **2026-08-24** 对当前源码树的重新评估（根包版本 `1.1.1`）：

| 范围 | 当前状态 |
|---|---|
| 桌面与 Web 界面 | 已实现仪表盘、系统状态、模型库、运行时服务、模型发布、已加载模型、模型测试、任务和设置；界面支持中英文。 |
| 控制面 | 已实现，默认监听 `8000`；使用 SQLite 保存状态，提供模型审计、下载、任务、部署、容器管理、设置以及推理发现/代理接口。 |
| 模型生命周期 | 已实现 Hugging Face / ModelScope 导入与下载计划、可恢复任务跟踪、文件完整性检查、兼容性建议、运行参数、健康检查、日志、重试、修复和清理。 |
| 标准运行时 | 已包含 vLLM、TensorRT-LLM 和通用 PyTorch 环境。vLLM 是通用模型的主要发布路径；TensorRT-LLM 需要兼容的已构建 engine；PyTorch 是环境基座，不是万能模型服务。 |
| 专用运行时 | 已提供 vLLM Embedding、vLLM Reranker、FunASR、VibeVoice、Qwen3-TTS、Unlimited-OCR、MinerU 和 LocateAnything 的 Compose Profile。 |
| 本次验证 | 后端测试 **55/55 通过**；`npm run build` 全量通过；全部 Compose Profile 均通过 `docker compose config`；控制台经局域网 IP 访问及远程令牌配置冒烟通过。详见[验证](#验证)。 |
| 发布就绪度 | **源码当前 build-clean。** x86_64 DEB 和 RPM 已在 x86_64 Ubuntu 构建机产出；RPM 仍需在 RPM 系发行版完成安装/systemd 验收，并在 NVIDIA GPU 目标机完成推理验收。 |


## 已实现能力

- 扫描本地模型目录，区分 Hugging Face checkpoint、TensorRT-LLM engine、GGUF 资产、音频模型、Qwen3-TTS、VibeVoice、Embedding、Reranker、OCR/文档模型和未完成下载。
- 解析 Hugging Face 或 ModelScope 仓库 URL，以可持久化、可观察的后台任务下载模型。
- 阻止明显不完整或不兼容的模型发布，并推荐合适的标准或专用运行时。
- 构建、启动、检查、停止、重启和删除受管运行时容器；展示任务阶段、日志、健康状态和修复动作。
- 使用可配置的 vLLM / TensorRT-LLM 参数发布通用模型。系统会保存运行参数；参数改变时会重建已运行的部署。
- 通过 `GET /v1/models` 发现在线推理服务；每项都包含真实直连接口、API 类型、路径、运行时和发布端口。
- 通过控制面代理 OpenAI 风格的聊天、向量和评分接口，并为语音、转写、文档、OCR 和视觉定位提供能力专用直连接口。
- 自动规范代理设置，确保本机和私有网络地址保留在 `NO_PROXY` 中。

## 运行时与 API 矩阵

以下均为默认端口，可通过环境变量或运行时设置调整。

| 运行时 / Profile | 默认端口 | 主要 API | 评估 |
|---|---:|---|---|
| vLLM | `30000` | `/v1/chat/completions` 及模型相关 OpenAI 路由 | 受支持 HF 模型的主要发布路径。 |
| TensorRT-LLM | `31000` | `/v1/chat/completions` | 需要兼容的 TensorRT-LLM engine，并按具体版本验证。 |
| 通用 PyTorch | `32000` | `/healthz`、`/runtime`、`/models` | 仅提供环境和诊断，不直接服务任意 ASR/TTS 模型。 |
| vLLM Embedding | `33010` | `/v1/embeddings` | 专用 pooling Profile；有历史 GB10 真模型验证记录。 |
| vLLM Reranker | `33020` | `/v1/score` | 专用评分 Profile；排序能力曾完成历史验证，当前路由为 `/v1/score`。 |
| FunASR Gateway | `8011` | `/transcription/transcribe` | 文件转写、可选说话人分离及实时 WebSocket 音频。 |
| VibeVoice HF | `18000` | `/v1/chat/completions` | 专用 Hugging Face 适配器；当前版本应重新进行模型级验收。 |
| Qwen3-TTS | `18020` | `/v1/audio/speech` | 托管的三模型服务，支持 CustomVoice、VoiceDesign 和 Base 音色克隆；详见[发布说明](docs/qwen3-tts-dedicated-release.zh-CN.md)。 |
| Unlimited-OCR | `33030` | `/v1/chat/completions` | 专用自定义模型 OCR 服务；有历史 GB10 真模型验证记录。 |
| MinerU | `33040` | `/v1/documents/parse` | 专用文档/PDF 解析服务；有历史 GB10 真模型验证记录。 |
| LocateAnything | `33060` | `/v1/ground` | 图像定位；有历史 GB10 验证记录。当前 ARM64 Profile 不提供视频输入。 |

推荐先从模型目录发现接口开始：

```bash
curl http://127.0.0.1:8000/v1/models
```

控制面代理以下 OpenAI 风格路由：

```text
POST /v1/chat/completions
POST /v1/embeddings
POST /v1/score
```

其他能力通常直接调用 `GET /v1/models` 返回的 `endpoint`。Web 开发模式下，`GET http://127.0.0.1:8888/models` 和 `/v1/models` 会转发到同一发现接口。

FunASR 实时路由：

```text
ws://127.0.0.1:8011/v1/realtime
ws://127.0.0.1:8011/ws/realtime
ws://127.0.0.1:8000/ws/audio/...  # 控制面转发到 FunASR
```

## 已知缺口与限制

- 当前是单机工作站管理器，尚未实现多节点调度、Kubernetes 编排、RBAC、配额、多租户和生产级可观测性。
- 源码构建成功不等于安装包验收完成；x86_64 DEB/RPM 仍需在目标发行版验证安装、systemd、浏览器访问和 GPU 推理。
- RPM 安装后的模型根目录、监听地址和管理端口目前以 `/etc/sysconfig/amuin-ai-stack` 为准。网页设置页尚不能修改 `MODELS_ROOT`，其中保存的管理端口和局域网访问偏好也不会回写 systemd 环境文件。
- 本地模型目录可以自动发现，但自动发现不等于跳过校验：控制面仍会遍历并审计模型文件，常规发布界面只提供下载状态为 `ready` 的模型。
- `deploy/compose/docker-compose.yml` 描述了 API/前端服务，但它引用的 `apps/api/Dockerfile` 和 `apps/frontend/Dockerfile` 当前不存在，因此不能把该文件当作现版本的独立快速启动栈。
- 2026-08-24 的源码复核没有重新运行 GPU 推理。模型、镜像、驱动和硬件组合仍然具有版本敏感性。
- 模型测试页当前可测试聊天、视觉、Embedding、Reranker、文件 ASR，并提供说话人验证代理。Qwen3-TTS 可以通过发布后的 Speech API 直连调用，但测试页尚未接通其 TTS 面板。
- 控制面暴露了 `/audio/speaker-verifications`，但当前 FunASR Gateway 模板没有实现对应上游路由。说话人分离可作为转写的一部分使用；独立说话人验证目前没有端到端闭环。
- GGUF 文件会作为本地资产被审计，但内置运行时不提供 GGUF 服务；请外接 llama.cpp、Ollama 或 LM Studio。
- 专用 Profile 会构建较大的本地镜像，并要求准确的模型目录。部分模型或上游代码采用独立或限制性许可证；LocateAnything 仅限非商业研究用途，当前 ARM64 Profile 仅支持图像。

## 环境要求

- 带受支持 NVIDIA GPU 且 `nvidia-smi` 正常的 Linux 工作站
- Node.js 20 或更高版本及 npm
- Docker Engine 与 Docker Compose v2
- 能让 Docker 使用 GPU 的 NVIDIA Container Toolkit
- 当前用户具备 Docker socket 权限
- 可访问模型/容器仓库的网络，或预先准备好模型与镜像

建议先检查宿主机：

```bash
node --version
docker version
docker compose version
nvidia-smi
docker ps
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

## 开发环境快速启动

```bash
npm install
npm run dev:web
```

打开 `http://127.0.0.1:8888`。Vite 会把 `/api/*` 代理到 `http://127.0.0.1:8000` 控制面。

其他启动模式：

```bash
npm run dev          # 有显示环境时启动 Electron，否则使用 Web 模式
npm run dev:electron # 强制 Electron；需要时回退到 Xvfb/Web
npm run dev:xvfb     # 在 Xvfb 中运行 Electron
```

典型工作流：

1. 导入 Hugging Face 或 ModelScope URL。
2. 查看下载计划、完整性结果、运行时建议和显存估算。
3. 下载模型，并跟踪任务直至文件完整。
4. 构建/拉取推荐运行时，确认启动参数后发布模型。
5. 等待运行时健康检查和模型发现均报告就绪。
6. 从“已加载模型”或 `GET /v1/models` 复制直连接口，在模型测试页或通过 `curl` / SDK 调用。
7. 某阶段失败时查看任务/部署日志并使用修复动作。

## 构建与打包

以下命令已通过源码构建验证；正式 RPM 仍需在 x86_64 构建机执行。

```bash
npm run build
npm run pack
```

也可以运行：

```bash
bash scripts/build-deb.sh
```

### x86_64 RPM

RPM 必须在 x86_64 Linux 构建机上生成，避免把 ARM 版 Electron 或 `better-sqlite3` 原生模块装进 RPM：

```bash
npm ci
npm run release:rpm
sudo dnf install ./dist-electron/amuin-ai-stack-1.1.1-1.x86_64.rpm
```

RPM 会安装并启动 `amuin-ai-stack.service`。同一局域网的电脑可访问 `http://<服务器IP>:8888`。首次远程修改配置前，在服务器读取自动生成的管理令牌，并在“设置 → 开发者 → 远程管理令牌”中保存：

```bash
sudo sed -n '1p' /var/lib/amuin-ai-stack/admin-token
```

### RPM 服务配置

模型目录、监听地址、控制面 API 端口和 Web 控制台端口不受构建时默认值限制。编辑 `/etc/sysconfig/amuin-ai-stack`，然后重启服务：

```bash
MODELS_ROOT=/data/models
AI_STACK_BIND_ADDR=0.0.0.0
PORT=8000
FRONTEND_PORT=8888

sudo mkdir -p /data/models
sudo systemctl restart amuin-ai-stack
```

`AI_STACK_BIND_ADDR=0.0.0.0` 表示监听服务器全部网卡；仅允许本机访问时使用 `127.0.0.1`，有需要时也可以填写服务器的某个本地网卡地址。`PORT` 是控制面 API 端口，`FRONTEND_PORT` 是浏览器控制台端口。systemd 在进程启动时读取这些值，因此每次修改后都需要重启服务。

目前 RPM 配置文件才是实际运行配置的权威来源。网页设置页没有模型目录输入项；页面中的管理端口和局域网访问开关只会把期望值保存到应用状态，不会修改 `/etc/sysconfig/amuin-ai-stack`。如需让运行中的服务真正改变，请修改上述文件。

### 使用已有的本地模型目录

将每个模型作为 `MODELS_ROOT` 的一级子目录放入，例如 `/data/models/Qwen3-8B`，随后刷新模型库或请求 `GET /models`。系统会自动发现该目录，不需要额外点击扫描，也不需要执行本地模型注册/导入步骤。

自动发现仍会执行内部审计，并不是免校验直载。控制面会遍历模型文件、检查未完成文件及索引权重、读取已知配置、推断格式与兼容性，并估算 GPU 显存适配情况。常规发布界面只列出审计结果为 `status.download = ready` 的模型；不兼容或显存不足的组合也可能在部署时被拦截。当前 `POST /models/import` 只用于 Hugging Face/ModelScope URL，不是本地目录登记或“信任此目录并跳过检查”的接口。

产物输出到 `dist-electron/`。桌面版打包安装后，可写工作区实际位于：

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

开发模式下，`AI_STACK_BASE` 默认是仓库根目录。可通过 `AI_STACK_BASE`、`MODELS_ROOT`、`STATE_ROOT`、`LOGS_ROOT` 和 `AI_STACK_DB_PATH` 覆盖运行路径。

## 验证

执行当前自动化检查：

```bash
npm --prefix apps/api test
npm --prefix apps/api run typecheck
npm run build
```

2026-08-24 复核结果：后端测试 55/55、Electron 主进程、API、前端全量构建和全部 Compose Profile 渲染均通过；局域网控制台返回 200，远程配置无令牌返回 403、正确令牌返回 200。x86_64 DEB 和 RPM 已在 x86_64 Ubuntu 主机产出；RPM 仍需完成目标发行版安装及 GPU 推理验收。

使用运行时 Profile 前，建议先在界面中验证再启动。手工操作示例：

```bash
docker compose -f deploy/compose/custom/docker-compose.funasr-gateway.yml config
docker compose -f deploy/compose/custom/docker-compose.funasr-gateway.yml up -d --build
```

`docker compose config` 只验证配置渲染；发布验收还需要在目标机器上完成容器启动、GPU/模型加载、健康检查和真实推理请求。

## 仓库结构

| 路径 | 用途 |
|---|---|
| `apps/main/` | Electron 主进程与打包工作区初始化。 |
| `apps/api/` | Node.js/TypeScript 控制面和测试。 |
| `apps/frontend/` | Vue 3 + Vite 双语控制台。 |
| `configs/` | 模型清单、运行时 Profile、驻留和代理设置。 |
| `deploy/compose/` | 标准及专用 Docker Compose Profile。 |
| `deploy/templates/` | 运行时 API 服务和配置模板。 |
| `deploy/dockerfiles/` | 辅助及专用运行时 Dockerfile。 |
| `ops/scripts/` | 下载、健康检查、诊断、TensorRT-LLM 和冒烟脚本。 |
| `docs/` | 架构、设计、迁移和模型专项说明。 |

## 许可证与模型条款

AMUIN AI STACK 源代码采用 [MIT License](LICENSE)。模型权重、容器镜像及上游模型代码仍遵循各自许可证和使用条款；重新分发前请检查 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
