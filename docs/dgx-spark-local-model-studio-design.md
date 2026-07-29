# DGX Spark 本地模型工作台设计与优化方案

日期：2026-06-12  
范围：基于当前 `/home/zhenz/ai-stack` 项目现状，设计一个面向 DGX Spark 的 vLLM-first 本地模型下载、环境准备、部署、服务发布和 OpenAI 标准 API 管理系统。管理页面固定发布在本机 `8888` 端口，推理服务按类型发布在 `30000-60000` 端口段。

## 1. 目标

本项目可以演进为一个面向 DGX Spark 的本地模型工作台：

- 输入 Hugging Face 或 ModelScope 模型链接后，自动下载到 `models/`。
- 自动识别模型类型、模型文件结构、推荐运行时与部署镜像。
- 在关键位置提示模型格式与运行环境的兼容关系，避免把 GGUF、Hugging Face checkpoint、TensorRT-LLM engine、ASR/TTS 专用目录混为一谈。
- 自动准备本地运行环境，优先使用 NVIDIA 官方或 DGX Spark playbook 中验证过的镜像。
- 自动部署模型，LLM、多模态和 embedding 以 vLLM 为主线；对 DGX Spark 官方验证路线可保留 TensorRT-LLM 作为高级/兜底运行时；不建设 llama.cpp 发布路线。
- 支持按服务类型发布，并通过 OpenAI 兼容 API 暴露 `/v1/models`、`/v1/chat/completions`、`/v1/embeddings` 等接口。
- 提供美观、直观的本地页面，覆盖模型库、下载任务、运行中服务、端口、日志、测试请求、聊天和多模态工作流。
- 前端管理页面固定为 `http://localhost:8888`；公开推理端口按服务类型划分，例如 vLLM、TensorRT-LLM、Audio 分别拥有自己的服务入口，避免“一模型一端口”。

## 2. 当前项目现状评估

### 已具备能力

当前项目不是空壳，已经有几块可复用的基础：

- `backend/`：FastAPI 后端，已有聊天、RAG、图片上传、音频网关、模型进度查看接口。
- `audio-service/`：独立 ASR/TTS 实时音频服务，使用 `nvcr.io/nvidia/pytorch:25.04-py3` 作为基础镜像，符合“音频栈专用服务”的方向。
- `frontend/`：Next.js 前端，已有聊天页面、侧边栏、文件上传和模型选择基础 UI。
- `docker-compose.yml`：编排后端、前端、PostgreSQL、Milvus、MinIO、etcd、audio-service。
- `docker-compose-models.yml`：当前编排 llama.cpp server，服务 Qwen3、Qwen coder、Qwen embedding、Qwen VL 等 GGUF 模型；该能力可视为历史兼容，不作为本工作台后续发布路线。
- `scripts/hf-download.sh` 与 `scripts/ms-download.sh`：已经具备容器化下载 Hugging Face / ModelScope 模型的能力，目标目录为 `models/<alias>`。
- `scripts/start-trtllm-model.sh`、`scripts/start-trtllm-handle.sh`、`scripts/stop-trtllm-model.sh`：已经能按 alias 启停 TensorRT-LLM 容器，并支持端口覆盖。
- `configs/model_catalog.csv`、`configs/serve_profiles.tsv`、`configs/validated_handles.tsv`、`configs/residency_plan.yaml`：已有模型清单、常驻策略、启动 profile 和官方验证 handle 的雏形。
- `playbooks/dgx-spark-playbooks/`：本地存在 DGX Spark playbook，可作为官方部署路线参考。

### 当前模型与存储状态

当前 `models/` 约 25G，`cache/` 约 27G。`models/` 根目录下可见：

- `Qwen3-8B-Q4_K_M.gguf`
- `Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf`
- `Qwen3-Embedding-4B-Q4_K_M.gguf`
- `Qwen3-VL-8B-Instruct-Q4_K_M.gguf`
- `Qwen3-VL-8B-Instruct-mmproj-Q8_0.gguf`
- `fun-asr-mlt-nano-2512/`
- `cosyvoice-300m-sft/`
- `whisper-small/`
- `whisper-large-v3/`

这说明项目已经有本地多模型运行的真实素材，适合直接向“模型工作台”方向扩展。

### 主要问题

1. 模型管理还停留在脚本层。

   用户需要手动运行 shell 脚本；后端没有统一的模型下载、注册、部署、停止、日志、健康检查 API。前端自然也无法像 LM Studio 一样点选模型并发布端口。

2. `/models/progress` 的模型识别能力偏早期。

   `backend/model_audit.py` 只扫描 `models/` 下的目录，对 vLLM 需要的 Hugging Face checkpoint、分片 safetensors、tokenizer、config、下载残片、磁盘占用等还没有形成完整审计模型。GGUF 单文件可以显示为本地资产，但不进入本系统部署路线。

3. 运行时路线分裂。

   当前有三条路线：

   - llama.cpp：由 `docker-compose-models.yml` 启动 GGUF 模型，适合轻量、快速、低复杂度，但用户已有 LM Studio，本系统不再重复建设该发布路线。
   - TensorRT-LLM：由脚本启动官方或本地 checkpoint，适合 DGX Spark 官方验证路线。
   - audio-service：独立 ASR/TTS 服务，已经接近目标服务化形态。
   - vLLM：用户期望的主路线，但当前尚未落地为可管理服务。

   这些能力没有统一 registry、统一状态模型、统一端口策略和统一 OpenAI API 网关。

4. vLLM 尚未成为默认部署路径。

   用户目标是“模型自动部署优先 vLLM”。当前项目没有 vLLM compose、Dockerfile、启动 profile 或 API 管理封装。

5. OpenAI API 暴露方式不统一。

   vLLM、TensorRT-LLM 都可以暴露 OpenAI 兼容接口，但目前后端聊天代码使用 `http://<model-service>:8000/v1`，TRT-LLM 使用 host network 和指定端口，尚无统一 `/v1` 网关或模型路由层。

6. 配置数据格式需要升级。

   `configs/model_catalog.csv` 和 `configs/serve_profiles.tsv` 适合早期手工维护，但不适合作为长期状态中心。下载任务、运行中服务、端口占用、运行时选择、启动参数、失败原因、模型文件校验等需要结构化持久化。

7. 音频 WebSocket 路径存在配置不一致。

   `audio-service/README.md` 写的是 `/ws/realtime`，`backend/main.py` 默认也是 `ws://audio-service:9000/ws/realtime`，但 `docker-compose.yml` 和 `docker-compose.audio.yml` 中配置为 `ws://audio-service:9000/v1/realtime`。这会导致音频网关在 compose 环境下连接失败。

8. `frontend` 仍是聊天 UI，不是模型控制台。

   现在页面适合对话和文档上传，不适合模型下载、部署、端口管理、日志观察、运行时选择、API 测试。

9. Docker 权限是运行前置条件。

   当前环境中执行 `docker ps` 返回 Docker socket permission denied。模型工作台需要能调用 Docker API 或安全地执行容器命令，所以必须在安装检查中暴露这个问题。

10. 部分路径硬编码。

   多个脚本硬编码 `/home/zhenz/ai-stack`。短期可接受，长期应通过 `AI_STACK_BASE` 或 `.env` 管理，便于迁移和备份。

11. 端口规划需要统一。

   当前前端默认 `3000`，后端 `8000`，音频服务 `9000`，TRT-LLM profile 使用 `8355` 等端口。目标系统应固定管理页面为 `8888`，推理服务公开端口限定为 `30000-60000`。端口不按模型分配，而按服务类型分配，例如 vLLM 服务、TensorRT-LLM 服务、Audio 服务分别有自己的公开入口。

12. 模型格式与运行环境的兼容提示不足。

   不同运行环境支持的模型格式不同。vLLM 通常面向 Hugging Face checkpoint、safetensors、部分量化格式和特定架构；TensorRT-LLM 更依赖官方验证模型、兼容 checkpoint、转换后的 engine 或特定版本支持；audio-service 面向 FunASR、CosyVoice、Whisper 等专用目录结构；GGUF 属于 LM Studio / llama.cpp 路线。本系统必须在下载、审计、部署前明确告诉用户“该模型适合哪个服务，为什么不适合另一个服务”。

## 3. 设计原则

- 音频、LLM、多模态、embedding 都采用“独立模型服务 + 后端控制面 + OpenAI 网关”的模式。
- 下载、部署、发布都应是可观察任务，有状态、有日志、有失败原因。
- 不把模型运行逻辑塞进聊天 Agent；聊天 Agent 只消费统一模型路由。
- 以 vLLM 为主运行时；TensorRT-LLM 仅作为 DGX Spark 官方验证模型或高级性能路线；不提供 llama.cpp 发布路线，GGUF 交由 LM Studio 或外部工具管理。
- 模型格式与运行环境必须显式匹配。系统应展示兼容、可能兼容、需要转换、不支持四种状态，并给出原因。
- UI 第一屏应该是可操作工作台，不是介绍页。
- 每个模型有清晰状态：未下载、下载中、已下载、环境待准备、可部署、运行中、失败、已停止。
- 每个运行中服务有清晰信息：服务类型、运行时、容器名、公开端口、OpenAI base URL、健康状态、显存/内存、日志入口。
- 管理页面固定监听 `8888`；后端 API 可继续内部使用 `8000`，由前端或反向代理统一暴露到 `8888`。
- 推理服务公开端口只允许 `30000-60000`。模型部署到对应服务，不为每个模型额外暴露用户可见端口。
- 如果底层运行时必须一模型一进程，其 worker 端口应只在 Docker 网络或本机 loopback 内部使用，由服务网关统一转发。

## 4. 推荐总体架构

```text
Frontend Console
  |
  | HTTP / WebSocket
  v
Backend Control Plane
  |-- Model Registry
  |-- Download Manager
  |-- Runtime Planner
  |-- Deployment Manager
  |-- OpenAI Route Registry
  |-- Health / Logs / Metrics
  |
  +--> Docker / Compose / NVIDIA Container Runtime
  |      |-- vLLM services
  |      |-- TensorRT-LLM services
  |      |-- audio-service
  |
  +--> models/
  +--> cache/
  +--> configs/
  +--> logs/
  +--> PostgreSQL or SQLite state store
```

### 控制面

建议在 `backend/` 新增 `model_ops/` 模块，负责模型生命周期：

```text
backend/model_ops/
  registry.py        # 模型元数据、文件状态、运行状态
  downloader.py      # HF / ModelScope 下载任务
  planner.py         # 自动选择 vLLM / TRT-LLM / audio
  deployer.py        # 启停容器，生成 compose 或 docker run 参数
  router.py          # OpenAI base_url 路由注册
  health.py          # 健康检查、端口探测
  logs.py            # 日志读取和任务事件流
  schemas.py         # Pydantic 请求/响应模型
```

### 模型服务层

运行时建议分层：

- `vllm`：默认 LLM/VLM/embedding 推理路线。适合 Hugging Face safetensors checkpoint，是本系统的主要发布能力。
- `trtllm`：DGX Spark 官方验证模型或需要极致性能的模型。复用现有 `start-trtllm-*` 逻辑，但由后端管理，默认隐藏在高级选项中。
- `audio`：ASR/TTS 专用服务，保留当前 `audio-service` 模式。
- `llama.cpp`：不纳入本系统发布路线。已有 LM Studio 负责 GGUF/llama.cpp 场景，本系统只可在模型库中识别 GGUF 为“外部管理资产”。

### OpenAI 网关

建议新增统一网关，不让前端或 Agent 直接关心容器名和端口：

- 管理页面公开：`http://localhost:8888`
- 后端内部 API：`http://localhost:8000`
- 推理服务端口：`30000-60000`
- OpenAI 网关可公开为：`http://localhost:8888/v1`
- 后端内部按服务类型 registry 转发到：
  - vLLM 服务：`http://127.0.0.1:30000/v1`
  - TensorRT-LLM 服务：`http://127.0.0.1:31000/v1`
  - Audio 服务：`http://127.0.0.1:32000`

公开端口属于服务类型，不属于单个模型。模型通过 registry 注册到对应服务，用户调用时仍然通过 `model` 字段选择模型。

短期可以先由后端提供模型路由，长期可引入 LiteLLM、Nginx、Traefik 或自研轻量反向代理。

## 5. 模型生命周期设计

### 状态模型

每个模型至少包含：

```yaml
id: qwen35-9b
display_name: Qwen3.5 9B
source:
  provider: modelscope
  repo_id: Qwen/Qwen3.5-9B
  original_url: https://modelscope.cn/models/...
local:
  path: /home/zhenz/ai-stack/models/qwen35-9b
  layout: hf_snapshot
  format: hf_safetensors
  size_bytes: 0
  checksum: null
capabilities:
  - chat
  - tool_call
runtime:
  preferred: vllm
  supported:
    - vllm
    - trtllm
compatibility:
  vllm:
    status: compatible
    reason: "HF snapshot with config.json, tokenizer, and safetensors weights."
  trtllm:
    status: possible
    reason: "Requires DGX Spark TensorRT-LLM version validation or engine conversion."
  audio:
    status: unsupported
    reason: "Text model, not ASR/TTS."
  lmstudio:
    status: unsupported
    reason: "Not a GGUF file."
status:
  download: ready
  deploy: stopped
  health: unknown
serving:
  service_type: vllm
  public_base_url: http://localhost:30000/v1
  worker_endpoint: null
  openai_model: qwen35-9b
```

### 下载流程

用户输入模型链接后：

1. 解析 URL：
   - Hugging Face：`https://huggingface.co/<namespace>/<repo>`
   - ModelScope：`https://modelscope.cn/models/<namespace>/<repo>`
   - 也支持直接输入 `Qwen/Qwen3-Embedding-8B`
2. 生成 alias：
   - 默认使用 repo 名小写化。
   - 允许用户编辑 alias。
3. 选择目标目录：
   - snapshot checkpoint：`models/<alias>/`
   - GGUF 单文件：只登记为外部管理资产，不进入部署流程。
4. 创建下载任务：
   - task id
   - provider
   - repo id
   - target path
   - status
   - progress
   - log file
5. 后台执行：
   - Hugging Face 使用现有 `scripts/hf-download.sh` 的容器化能力。
   - ModelScope 使用现有 `scripts/ms-download.sh` 的容器化能力。
6. 完成后进行模型审计：
   - 文件数量、权重文件、config/tokenizer、safetensors 分片、总大小。
   - 识别模型格式、模型能力、推荐 runtime 和不兼容原因。
7. 写入 registry。

### 运行时自动规划

推荐规则：

| 模型形态 / 格式 | 默认运行时 | 备选 | UI 提示 |
|---|---|---|
| Hugging Face CausalLM checkpoint，常见为 `.safetensors` / `.bin` + `config.json` | vLLM | TensorRT-LLM | 适合 vLLM；TensorRT-LLM 需版本或转换验证 |
| 官方 DGX Spark 验证 handle | vLLM | TensorRT-LLM | 可优先 vLLM，追求性能时走 TensorRT-LLM |
| TensorRT-LLM engine / 已转换目录 | TensorRT-LLM | 无 | 只适合 TensorRT-LLM，不应交给 vLLM |
| GGUF 单文件 | 外部 LM Studio 管理 | 不部署 | 本系统不发布，提示使用 LM Studio |
| Embedding checkpoint | vLLM embedding server | 无 | 只开放 embeddings 能力，不应作为 chat 模型 |
| VLM checkpoint | vLLM multimodal | TensorRT-LLM | 需要检查图像处理器、vision config、依赖版本 |
| ASR/TTS 专用目录，如 FunASR、CosyVoice、Whisper | audio-service | 专用服务 | 不进入 vLLM/TensorRT-LLM |

如果模型包含 `config.json`，可读取 `model_type`、`architectures`、`quantization_config`、`tokenizer_class` 等字段，结合文件后缀推断 runtime。对无法确认的模型，UI 应显示“需要人工确认”而不是直接部署。

### 格式兼容提示

在 Models 页面、模型详情页、下载完成弹窗、Deploy 弹窗中都要显示兼容性提示：

- `compatible`：可以部署到该服务。
- `possible`：可能可以部署，但需要转换、版本验证或额外参数。
- `needs_conversion`：必须转换格式后才能部署。
- `unsupported`：该服务不支持此格式。

示例提示：

```text
Qwen/Qwen3.5-9B
格式：HF safetensors checkpoint
推荐：vLLM
TensorRT-LLM：可能支持，但需要 DGX Spark 镜像版本验证
LM Studio：不支持，因为不是 GGUF
```

### 部署流程

1. 用户在 UI 中点击“部署”。
2. 选择服务类型/runtime、上下文长度、GPU 占用策略、是否常驻。
3. 后端检查：
   - Docker 权限
   - NVIDIA runtime
   - 对应服务入口是否健康，服务公开端口是否在 `30000-60000`
   - 模型文件是否完整
   - runtime 镜像是否存在
4. 后端生成容器配置并启动。
5. 写入服务 registry。
6. 健康检查通过后，在 OpenAI 路由表注册。
7. UI 展示：
   - 服务入口，例如 `http://localhost:30000/v1`
   - `curl` 示例
   - 健康状态
   - 日志入口

## 6. 后端 API 草案

建议新增以下 API：

```http
GET  /system/check
GET  /models
POST /models/import
POST /models/download
GET  /models/downloads
GET  /models/downloads/{task_id}
POST /models/audit
GET  /models/{model_id}
PATCH /models/{model_id}
DELETE /models/{model_id}

GET  /runtimes
POST /runtimes/compatibility
GET  /deployments
POST /deployments
GET  /deployments/{deployment_id}
POST /deployments/{deployment_id}/stop
POST /deployments/{deployment_id}/restart
GET  /deployments/{deployment_id}/logs
GET  /deployments/{deployment_id}/health

GET  /v1/models
POST /v1/chat/completions
POST /v1/completions
POST /v1/embeddings
```

### `POST /models/import`

用于从链接创建模型记录。

```json
{
  "url": "https://modelscope.cn/models/Qwen/Qwen3-Embedding-8B",
  "alias": "qwen3-embedding-8b",
  "provider": "auto"
}
```

### `POST /deployments`

用于将模型部署到指定服务类型。默认不传公开端口；端口由服务类型决定。

```json
{
  "model_id": "qwen35-9b",
  "service_type": "vllm",
  "openai_model": "qwen35-9b",
  "args": {
    "max_model_len": 8192,
    "gpu_memory_utilization": 0.85,
    "trust_remote_code": true
  }
}
```

### `POST /runtimes/compatibility`

用于在部署前检查模型格式与服务类型是否匹配。

```json
{
  "model_id": "qwen35-9b",
  "service_type": "vllm"
}
```

返回：

```json
{
  "status": "compatible",
  "model_format": "hf_safetensors",
  "service_type": "vllm",
  "reason": "HF snapshot includes config.json, tokenizer, and safetensors weights.",
  "warnings": []
}
```

返回：

```json
{
  "deployment_id": "dep_qwen35_9b_vllm",
  "status": "starting",
  "service_type": "vllm",
  "base_url": "http://localhost:30000/v1",
  "health_url": "http://localhost:30000/health",
  "worker_endpoint": "internal"
}
```

## 7. 前端页面设计

当前前端是聊天页面。建议升级为三栏工作台，并将管理页面固定发布为 `http://localhost:8888`。

### 左侧导航

- Chat
- Models
- Running
- Downloads
- Audio
- Settings

### Models 页面

核心视图是模型库：

- 顶部输入框：粘贴 Hugging Face / ModelScope 链接。
- 模型卡片或表格：
  - 名称
  - 类型：LLM / VLM / Embedding / ASR / TTS
  - 来源：HF / ModelScope / Local
  - 状态：未下载 / 下载中 / 已下载 / 运行中 / 失败
  - 大小
  - 模型格式：HF safetensors / TensorRT engine / GGUF / ASR-TTS directory
  - 推荐 runtime
  - 兼容性：可部署 / 可能可部署 / 需要转换 / 不支持
  - 操作：下载、审计、部署、删除、打开目录

### Running 页面

展示所有运行中服务：

- 服务类型：vLLM / TensorRT-LLM / Audio
- 已加载模型列表
- runtime
- 容器名
- 公开端口，必须位于 `30000-60000`
- OpenAI base URL
- 健康状态
- GPU/内存占用
- 日志 tail
- 操作：停止服务、重启服务、卸载模型、复制 curl、在 Chat 中使用

### Deploy 弹窗

部署时弹窗应包含：

- runtime 选择：vLLM / TensorRT-LLM / audio。默认选 vLLM，TensorRT-LLM 放入高级选项。
- 服务入口展示，例如 vLLM 使用 `http://localhost:30000/v1`。
- 格式兼容提示，必须解释为什么推荐或禁止某个服务。
- OpenAI model name。
- 常用参数：
  - context length
  - max batch size
  - GPU memory utilization
  - tensor parallel size
  - quantization
  - trust remote code
- 预览启动命令。

端口不在模型部署弹窗中逐个填写。服务端口应在 Settings / Services 中统一配置，例如 vLLM 服务、TensorRT-LLM 服务、Audio 服务各自一个公开入口。

如果用户选择了不兼容服务，Deploy 按钮应禁用，并给出直接原因。例如：“GGUF 文件不支持 vLLM，本系统不发布 GGUF，请使用 LM Studio。”

### Chat 页面

保留当前聊天能力，但模型选择应来自运行中模型 registry，而不是只来自 `MODELS` 环境变量。

## 8. Compose 与运行时优化

### 短期

- 修复音频 WS 环境变量为 `ws://audio-service:9000/ws/realtime`。
- 修复 `frontend` volume：
  - 当前为 `/frontend:/app/frontend`，像是误用了绝对路径。
  - 建议改为 `./frontend:/app` 或生产模式不挂载源码。
- 前端管理页面对外端口改为 `8888:3000`，或增加反向代理将 `8888` 统一转发到前端与后端 API。
- `docker-compose-models.yml` 不再作为目标发布路线；保留文件仅用于历史兼容或迁移参考。
- 新增 `docker-compose.vllm.yml` 模板，用于默认 vLLM 发布。

### vLLM 服务模板

建议拆成公开服务入口和内部 worker。公开入口固定在服务类型端口，例如 vLLM 使用 `30000`；具体模型 worker 不直接对用户暴露端口。

```yaml
services:
  vllm-service:
    image: local/model-router:latest
    container_name: vllm-service
    ports:
      - "30000:30000"
    environment:
      - SERVICE_TYPE=vllm
      - LISTEN_PORT=30000
    depends_on:
      - vllm-${MODEL_ALIAS}

  vllm-${MODEL_ALIAS}:
    image: ${VLLM_IMAGE}
    container_name: vllm_${MODEL_ALIAS}
    gpus: all
    ipc: host
    networks:
      - chatbot-net
    volumes:
      - ./models/${MODEL_ALIAS}:/models/${MODEL_ALIAS}:ro
      - ./cache/hf:/root/.cache/huggingface
    command:
      - --model
      - /models/${MODEL_ALIAS}
      - --served-model-name
      - ${OPENAI_MODEL}
      - --host
      - 0.0.0.0
      - --port
      - "8000"
      - --trust-remote-code
```

实际镜像 tag 应从 NVIDIA 官方 DGX Spark 文档或 NGC 页面确认，不建议在代码里长期写死未经验证的 tag。

### 端口策略

- 管理页面：固定 `8888`。
- 后端内部：可继续使用 `8000`，但不要求用户直接访问。
- 推理服务公开端口：只允许 `30000-60000`。
- 推荐服务端口：
  - vLLM OpenAI 服务：`30000`
  - TensorRT-LLM OpenAI 服务：`31000`
  - Audio HTTP/WebSocket 服务：`32000`
  - 预留 embedding/rerank/image 专用服务：`33000-33999`
- 模型 worker 端口：内部使用，不作为用户可见端口；可固定为容器内 `8000` 或由编排器分配。
- API 层必须拒绝将单个模型直接绑定到新的公开端口，除非是在 Settings / Services 中新增一种服务类型或服务实例。

### TensorRT-LLM

当前脚本可继续保留：

- 本地 checkpoint：`scripts/start-trtllm-model.sh <alias> [port]`
- 官方 handle：`scripts/start-trtllm-handle.sh <alias> [port]`

优化方向：

- 后端不要直接拼超长 shell 字符串。
- 将 profile 读取、服务端口检查、容器名生成、日志路径写成 Python 模块；TensorRT-LLM 公开入口建议固定为 `31000`，内部模型 worker 不直接暴露给用户。
- 保留 shell 脚本作为人工救援入口。

## 9. 数据持久化建议

短期可以用 SQLite，后续接入现有 PostgreSQL。

建议表：

- `model_registry`
- `download_tasks`
- `deployments`
- `runtime_profiles`
- `route_registry`
- `event_logs`

`configs/*.csv` 和 `configs/*.tsv` 可以继续作为 seed 数据，但运行态不要再依赖手工编辑表格。

## 10. 近期优先级

### P0：先让“模型工作台”跑起来

1. 修复音频 WS 路径配置。
2. 将前端管理页面固定发布到 `8888`。
3. 新增服务端口配置，固定 vLLM / TensorRT-LLM / Audio 等服务入口，公开端口限制为 `30000-60000`。
4. 新增模型 registry API：`GET /models`。
5. 新增格式审计字段：`format`、`layout`、`capabilities`、`compatibility`。
6. 新增部署 registry API：`GET /deployments`。
7. 新增 vLLM runtime profile，并能启动一个本地 Hugging Face checkpoint。
8. 前端新增 Models / Running 页面，先显示状态、服务入口和格式兼容提示，不追求复杂参数。

### P1：实现链接下载和自动审计

1. 新增 `POST /models/import` 解析 Hugging Face / ModelScope 链接。
2. 新增 `POST /models/download` 后台任务。
3. 下载日志写入 `logs/downloads/<task_id>.log`。
4. 前端显示下载进度、失败原因、重新下载按钮。
5. 下载完成后自动判断模型格式、模型类型、推荐 runtime 和不兼容原因。
6. 新增 `POST /runtimes/compatibility`，部署前强制检查格式与服务类型是否匹配。

### P2：引入 vLLM 默认部署

1. 支持 LLM checkpoint 用 vLLM 启动。
2. 支持模型注册到 vLLM 服务，并通过 vLLM 服务入口访问。
3. 支持 `/v1/models` 聚合运行中模型。
4. Chat 页面模型选择改为运行中 OpenAI 模型。

### P3：优化 UI 和体验

1. 运行中服务提供实时日志。
2. 模型详情页提供 curl / Python SDK 示例。
3. 支持一键设为默认模型。
4. 支持常驻策略：开机启动、按需唤醒、空闲释放。
5. 支持系统资源页：GPU、内存、磁盘、端口。

## 11. 风险与注意事项

- DGX Spark 官方镜像、vLLM 镜像和 TensorRT-LLM tag 需要以 NVIDIA 官方文档或 NGC 当前页面为准。不要把未经验证的镜像 tag 当作长期默认值。
- 部署模型需要 Docker 权限。当前用户访问 Docker socket 被拒绝，应在 `/system/check` 中明确显示。
- Hugging Face 在当前机器上可能有网络超时，README 也提到 ModelScope 更稳定。因此下载 provider 应支持自动 fallback，并允许用户配置代理。
- 大模型、多模态模型、MoE 模型不能默认全部常驻。应采用“一个主 LLM 常驻，其余按需唤醒”的策略。
- 本系统不承担 llama.cpp/GGUF 发布；如果用户导入 GGUF，只显示为外部资产，并提示使用 LM Studio 管理。
- 不同环境支持的模型格式不同，不能只按模型名称判断。部署前必须基于文件结构、config、权重后缀和目标服务做兼容性检查。
- TensorRT-LLM 支持情况受镜像版本、模型架构、转换流程影响很大，不能把所有 Hugging Face checkpoint 都标成可直接运行。
- vLLM 也不是万能运行时。部分新架构、多模态模型、特殊量化格式、远程代码模型可能需要特定版本、参数或额外依赖。
- 公开推理服务端口必须强制限制在 `30000-60000`，避免误占用 `3000`、`8000`、`8888`、`9000`、数据库和 Milvus 等端口。
- 不做“一模型一公开端口”。如果底层运行时需要多个模型 worker，应由服务网关转发，worker 端口仅内部可见。
- 后端执行容器启动属于高权限操作，必须限制命令参数来源，避免把用户输入直接拼进 shell。
- 删除模型是破坏性操作，应要求二次确认，并优先移动到 trash，而不是直接删除。

## 12. 建议的最终体验

用户打开 `http://localhost:8888` 后：

1. 进入 Models 页面。
2. 粘贴模型链接。
3. 系统自动识别来源、alias、模型格式、模型类型、推荐 runtime 和不兼容服务。
4. 点击下载。
5. 下载完成后点击部署。
6. 选择服务类型，例如 vLLM。页面显示该服务入口 `http://localhost:30000/v1`，并提示该模型格式是否兼容。
7. 系统启动 vLLM 容器；高级场景可选择 TensorRT-LLM；GGUF 不在此发布。
8. 页面显示：

```text
Status: healthy
Runtime: vLLM
OpenAI Base URL: http://localhost:30000/v1
Model: qwen35-9b
```

9. 用户可以直接复制：

```bash
curl http://localhost:30000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen35-9b","messages":[{"role":"user","content":"你好"}]}'
```

10. Chat 页面可以直接选择这个运行中模型进行对话。

这就是当前项目从“脚本 + demo 栈”进化为“DGX Spark 本地模型工作台”的最短路径。
