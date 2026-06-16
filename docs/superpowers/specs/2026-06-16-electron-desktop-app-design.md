# AMUIN AI STACK — Electron 桌面应用设计规格

## 1. 概述

将 AMUIN AI STACK 从纯 Docker Compose Web 应用改造为 **Electron 独立窗口桌面应用**，以 `.deb` 包分发，运行在 DGX Spark (Linux, NVIDIA GPU) 上。

## 2. 应用形态

```
┌──────────────────────────────────────────────┐
│  Electron 窗口                                │
│  ┌──────────────────────────────────────────┐│
│  │  Vue 3 前端 (localhost:8888)              ││
│  │  模型管理 / 容器控制 / 部署 / 聊天         ││
│  └──────────────────────────────────────────┘│
│                                              │
│  Electron 主进程 内嵌 Node.js API (:8000)     │
│  - SQLite 持久化                              │
│  - Docker SDK 管理推理容器                     │
│  - 权限控制                                   │
└──────────────────────────────────────────────┘
                     │
          Docker Socket (/var/run/docker.sock)
                     │
     ┌───────────────┼───────────────┐
     ▼               ▼               ▼
┌─────────┐  ┌────────────┐  ┌──────────┐
│ vLLM    │  │TensorRT-LLM│  │ PyTorch  │
│ :30000  │  │ :31000     │  │ :32000   │
└─────────┘  └────────────┘  └──────────┘
```

- Electron 启动时自动拉起内嵌 API 服务，载入前端页面
- 推理容器通过 Docker Compose 模板按需启动，非 Electron 子进程
- 用户关闭 Electron 窗口 → API 服务停止，推理容器不受影响（独立生命周期）

## 3. 权限模型

| 层级 | 访问方式 | 权限 |
|------|----------|------|
| 最高权限 | Electron 本地窗口 | 完整管理权限（所有 API 可调用） |
| 受限访问 | 局域网浏览器（开关开启时） | 可访问管理页面，敏感操作受限 |
| 不可访问 | 局域网浏览器（开关关闭时） | 管理页面完全不可达 |

- **LAN 访问开关**仅控制管理页面是否监听局域网：
  - 关闭（默认）：API/前端仅绑定 `127.0.0.1`，仅本机 Electron 可访问
  - 开启：API/前端绑定 `0.0.0.0`，局域网设备可通过浏览器访问
- Electron 窗口始终是最高权限持有者（通过本地回环检测 + token 标识）
- 敏感 API（如删除模型、修改设置）校验请求来源，非 Electron 端拒绝

## 4. 存储方案

### 4.1 选型：SQLite

- 嵌入式、零依赖、事务安全
- 数据文件位于 `~/.local/share/ai-stack/data.db`
- Electron 主进程通过 `better-sqlite3` 直接操作
- 替代当前 `state/workbench-state.json` 单文件 JSON

### 4.2 数据表设计

```sql
-- 任务记录（下载、部署、容器操作）
CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,       -- 'download' | 'deploy' | 'image_pull' | 'image_test' | 'custom_container'
  status      TEXT NOT NULL,       -- 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  metadata    TEXT,                -- JSON
  log_path    TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 活跃部署（多模型可共容器）
CREATE TABLE deployments (
  deployment_id TEXT PRIMARY KEY,
  model_id      TEXT NOT NULL,
  service_type  TEXT NOT NULL,     -- 'vllm' | 'trtllm' | 'pytorch'
  openai_model  TEXT NOT NULL,
  container_name TEXT,
  status        TEXT NOT NULL,     -- 'configured' | 'starting' | 'running' | 'failed' | 'stopped'
  config        TEXT,              -- JSON: args, ports, etc.
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 聊天记录
CREATE TABLE chats (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 聊天消息
CREATE TABLE messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id   TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  type      TEXT NOT NULL,         -- 'HumanMessage' | 'AIMessage'
  content   TEXT NOT NULL,
  metadata  TEXT,                  -- JSON
  created_at TEXT NOT NULL
);

-- 设置 (key-value)
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,        -- JSON
  updated_at TEXT NOT NULL
);

-- 容器配置
CREATE TABLE container_configs (
  key              TEXT PRIMARY KEY,  -- 'vllm' | 'trtllm' | 'pytorch' | custom
  public_port      INTEGER NOT NULL,
  management_mode  TEXT NOT NULL,     -- 'resident' | 'once'
  restart_policy   TEXT NOT NULL,
  auto_restart     INTEGER NOT NULL DEFAULT 0,
  image            TEXT,
  components       TEXT,              -- JSON array
  is_default       INTEGER NOT NULL DEFAULT 0,  -- 默认容器不可删除
  updated_at       TEXT NOT NULL
);
```

### 4.3 迁移策略

首次启动时检测旧 `state/workbench-state.json`，自动迁移数据到 SQLite，迁移后保留旧文件作为 `.bak`。

## 5. 容器模板

### 5.1 统一管理

所有推理容器以 Docker Compose 模板方式定义（`deploy/templates/`），通过 Docker SDK 启动和管理。

### 5.2 容器分类

三个默认容器是系统内置的，**不可删除**，但用户可以修改其发布端口（端口不可重叠）。

| 模板 | 运行时 | 默认端口 | 可删除 | 可改端口 |
|------|--------|----------|--------|----------|
| **vLLM** | LLM / VLM / Embedding | 30000 | 否 | 是 |
| **TensorRT-LLM** | 高性能 LLM | 31000 | 否 | 是 |
| **PyTorch** | 通用推理 (Whisper ASR) | 32000 | 否 | 是 |
| **Custom** (用户创建) | 用户自定义 | 动态分配 | 是 | 是 |

端口冲突检测：修改端口时校验不与任何已配置容器的端口重叠。

### 5.3 多模型共容器加载（核心设计）

加载模型到已运行的容器时，**不额外启动新容器**，而是将模型添加到现有容器实例中：

```
容器 vLLM (30000) 已运行，已加载 Qwen3.5-9B
         ↓ 加载新模型（增加，不是额外开启）
容器 vLLM (30000) 运行中，已加载 Qwen3.5-9B + Qwen3-Embedding-8B
         ↓ OpenAI API
GET /v1/models → { data: [{id: "Qwen3.5-9B"}, {id: "Qwen3-Embedding-8B"}] }
```

- vLLM 原生支持多模型，通过 `--served-model-name` 多值或 `--lora-modules` 加载额外模型
- TensorRT-LLM 通过 Triton 多模型仓库支持
- 模型只在**兼容的**容器类型中加载（LLM → vLLM/TensorRT-LLM, ASR → PyTorch）
- 用户部署时选择目标容器，系统自动检测兼容性并给出推荐

### 5.4 容器模板格式 (`deploy/templates/vllm.yml`)

```yaml
# vLLM 容器模板 (多模型共容器)
services:
  vllm-worker:
    image: ${VLLM_IMAGE:-vllm/vllm-openai:latest}
    container_name: vllm-service
    gpus: all
    ipc: host
    ports:
      - "${BIND_ADDR:-127.0.0.1}:${VLLM_PORT:-30000}:8000"
    restart: ${RESTART_POLICY:-no}
    volumes:
      - ${MODELS_ROOT:-../../models}:/models:ro
      - ${HF_CACHE_DIR}:/root/.cache/huggingface
    environment:
      - HF_TOKEN=${HF_TOKEN:-}
    # 多模型由部署管理器动态拼接 command
```

### 5.5 容器生命周期

```
创建容器 → 拉取镜像 → 启动容器 → 加载模型 → 健康检查 → 服务就绪
                               ↓ 加载更多模型（不重启容器）
                          模型注册到 OpenAI API → GET /v1/models 可发现
                               ↓
                          停止/重启/删除容器
```

- 容器独立于 Electron 进程运行
- 启动时注入 `BIND_ADDR` 环境变量，跟随 LAN 开关设置
- PyTorch 容器内置 Whisper ASR（本地），TTS 已移除

## 6. OpenAI API 标准合规

整个系统的模型发布、对话、数据对接 **全部遵循 OpenAI API 标准**。

### 6.1 标准端点

| 端点 | 说明 | 标准 |
|------|------|------|
| `GET /v1/models` | 列出所有已加载模型 | OpenAI Models API |
| `POST /v1/chat/completions` | 对话补全（流式 + 非流式） | OpenAI Chat Completions API |
| `POST /v1/embeddings` | 文本向量化 | OpenAI Embeddings API |
| `WS /v1/realtime` | 实时音频流（ASR） | OpenAI Realtime API (WebSocket) |

### 6.2 请求路由

```
外部客户端请求
      │
      ▼
Electron API (:8000)
      │
      ├── /v1/models ──────────► 聚合所有运行中容器的模型列表
      ├── /v1/chat/completions ─► 按模型名路由到对应容器 (vLLM / TensorRT-LLM)
      ├── /v1/embeddings ───────► 路由到支持 embedding 的容器
      └── /v1/realtime (WS) ───► 代理到 PyTorch 容器的 WebSocket
```

### 6.3 流式对话 (SSE)

`/v1/chat/completions` 支持 `stream: true`，Server-Sent Events 格式对齐 OpenAI：

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"}}]}

data: [DONE]
```

### 6.4 模型数据对接

- 部署时注册 `openai_model` 名称 → 对外暴露为 `/v1/models` 中的模型 ID
- 多个模型共容器时，`/v1/models` 返回该容器上所有模型
- 第三方客户端（如 Open WebUI、ChatBox、Continue.dev）可直接 `OPENAI_BASE_URL=http://<host>:8000/v1` 接入，无需适配

## 7. Audio / PyTorch 容器（WebSocket 流模式）

### 7.1 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| ASR | OpenAI Whisper (tiny) | 本地 PyTorch 模型，支持中文 |
| HTTP 框架 | FastAPI + Uvicorn | HTTP + WebSocket 双协议 |
| 基础镜像 | `nvcr.io/nvidia/pytorch:25.04-py3` | NVIDIA 官方 PyTorch |

### 7.2 WebSocket 流模式 — OpenAI Realtime API 兼容

音频服务通过 **WebSocket 长连接** 实现实时流式语音识别，对齐 OpenAI Realtime API 协议：

```
客户端 ──WS connect──► /v1/realtime
         ◄── session.created (session_id, modalities, audio_format)
         ── input_audio_buffer.append (base64 PCM16 音频块) × N
         ── input_audio_buffer.commit
         ◄── conversation.item.input_audio_transcription.completed (转录文本)
         ── ... 更多音频 ...
         ◄── ... 更多转录 ...
```

### 7.3 事件协议

**客户端 → 服务端：**

| 事件 | 说明 |
|------|------|
| `session.update` | 更新会话配置（采样率、语言等） |
| `input_audio_buffer.append` | 推送 PCM16 音频数据 (base64) |
| `input_audio_buffer.commit` | 提交音频缓冲区，触发转录 |
| `input_audio_buffer.clear` | 清空音频缓冲区 |

**服务端 → 客户端：**

| 事件 | 说明 |
|------|------|
| `session.created` / `session.updated` | 会话状态变更 |
| `conversation.item.created` | 新建对话项 |
| `input_audio_buffer.status` | 缓冲区状态 |
| `conversation.item.input_audio_transcription.completed` | 转录完成（含文本） |
| `error` | 错误事件 |

### 7.4 API 网关 WebSocket 代理

Electron 内嵌 API 负责将 `/v1/realtime` 的 WebSocket 连接代理到 PyTorch 容器：

```
客户端 ←─WS─→ Electron API (:8000) ←─WS─→ PyTorch 容器 (:32000)
                    │
           权限校验（可选：仅 Electron 端可用）
```

### 7.5 移除内容

- `edge-tts`（微软云端 TTS，非本地）
- `CosyVoiceAdapter`（实际调用 edge-tts）
- 所有 TTS 相关事件（`response.audio.delta`、`response.audio.done`）
- `funasr` 依赖包（实际未使用，用的是 openai-whisper）
- `services/audio/` 整个目录

## 8. 目录结构（优化后）

```
ai-stack/
├── apps/                        # Electron 桌面应用
│   ├── main/                    # Electron 主进程
│   │   ├── index.ts            # 入口：窗口创建、API 启动
│   │   ├── preload.ts          # 预加载脚本
│   │   ├── db.ts               # SQLite 初始化与迁移
│   │   └── permissions.ts      # 权限校验中间件
│   ├── frontend/               # Vue 3 前端
│   │   ├── src/
│   │   ├── package.json
│   │   └── vite.config.ts
│   └── api/                    # Node.js 后端
│       ├── src/
│       ├── package.json
│       └── tsconfig.json
├── deploy/                      # 容器模板
│   ├── templates/              # Docker Compose 模板
│   │   ├── vllm.yml
│   │   ├── tensorrt-llm.yml
│   │   └── pytorch.yml
│   └── dockerfiles/            # 辅助 Dockerfiles
│       ├── hf-tools.Dockerfile       # HuggingFace 下载工具
│       └── ms-tools.Dockerfile       # ModelScope 下载工具
├── configs/                     # 模型目录和配置
│   ├── model_catalog.csv       # 模型注册表
│   ├── serve_profiles.tsv      # 服务运行配置
│   ├── validated_handles.tsv   # TRT-LLM 验证模型
│   ├── residency_plan.yaml     # 常驻/按需策略
│   ├── extra-llm-api-config.yml
│   └── proxy.env               # HTTP 代理
├── models/                      # 本地模型文件
├── scripts/                     # 构建和开发脚本
│   ├── build-deb.sh            # .deb 打包脚本
│   └── dev.sh                  # 开发启动脚本
└── playbooks/                   # NVIDIA DGX Spark 参考手册（不打包进 deb）
    └── dgx-spark-playbooks/
```

### 运行时目录（自动生成，不纳入源码管理）

```
~/.local/share/ai-stack/        # XDG 数据目录
├── data.db                     # SQLite 数据库
├── logs/                       # 运行日志
├── cache/                      # 下载缓存
│   ├── modelscope/
│   └── huggingface/
└── state/                      # 遗留迁移备份
    └── workbench-state.json.bak
```

## 9. 删除清单

| 路径 | 原因 |
|------|------|
| `deploy/compose/docker-compose.yml` (修改) | 移除 postgres/etcd/minio/milvus 服务定义及 profiles |
| `deploy/compose/docker-compose-models.yml` | 旧 GGUF/llama.cpp 方案 |
| `deploy/compose/docker-compose.audio.yml` | 合并到主 compose |
| `deploy/compose/docker-compose.vllm.yml` | 迁移到 `deploy/templates/vllm.yml` |
| `deploy/dockerfiles/Dockerfile.llamacpp` | 旧 llama.cpp 构建 |
| `apps/api/Dockerfile` | Electron 内嵌 API，不再需要容器化 |
| `apps/frontend/Dockerfile` | Electron 接管前端，不再需要容器化 |
| `services/audio/` (整个目录) | ASR(Whisper) → PyTorch 容器模板, TTS(edge-tts) → 删除 |
| `volumes/` 中的 etcd/minio/milvus/postgres 数据 | 代码未使用 |
| `state/workbench-state.json` | 迁移到 SQLite 后转为 `.bak` 备份 |

## 10. 保留和迁移

| 路径 | 处理 |
|------|------|
| `apps/api/src/` | 保持不变，`StateStore` 替换为 SQLite |
| `apps/frontend/src/` | 保持不变，无大改 |
| `configs/` (6 个文件) | 全部保留，清理过时条目 |
| `deploy/dockerfiles/hf-tools.Dockerfile` | 保留 |
| `deploy/dockerfiles/ms-tools.Dockerfile` | 保留 |
| `scripts/` | 重写为 Electron 构建和 .deb 打包脚本 |
| `playbooks/` | 保留，不打包进 .deb |
| `models/` | 保持不变 |

## 11. .deb 打包

### 11.1 打包工具

使用 `electron-builder` 生成 `.deb` 包。

### 11.2 包信息

```
包名: amuin-ai-stack
版本: 1.1.0
架构: arm64 (DGX Spark)
依赖: docker-ce, nvidia-container-toolkit
安装路径: /opt/amuin-ai-stack/
桌面入口: /usr/share/applications/amuin-ai-stack.desktop
```

### 11.3 .deb 安装后行为

- 首次启动自动初始化 SQLite 数据库
- 从旧 JSON 文件自动迁移数据（如存在）
- 检查 Docker 可用性，不可用时提示安装
- 启动托盘图标，可后台运行

## 12. 实现阶段

| 阶段 | 内容 |
|------|------|
| **Phase 1**: 清理 | 删除遗留代码（pg/etcd/minio/milvus、edge-tts、llama.cpp、旧 compose） |
| **Phase 2**: 存储 | JSON → SQLite 迁移，替换 StateStore |
| **Phase 3**: Electron | 搭建 Electron 壳、主进程、内嵌 API、打包配置 |
| **Phase 4**: 权限 | 权限中间件、LAN 开关、Electron 最高权限 |
| **Phase 5**: 容器模板 | 统一 vLLM/TensorRT-LLM/PyTorch 三个模板 + 端口可配 + 多模型共容器 |
| **Phase 6**: OpenAI API | `/v1/models`、`/v1/chat/completions`(流式)、`/v1/embeddings`、`/v1/realtime`(WS) |
| **Phase 7**: Audio WS | PyTorch 容器 Whisper ASR + OpenAI Realtime WebSocket 流协议 |
| **Phase 8**: 打包 | electron-builder 配置、.deb 生成、桌面入口 |
| **Phase 9**: 测试验证 | 端到端测试、安装测试 |
