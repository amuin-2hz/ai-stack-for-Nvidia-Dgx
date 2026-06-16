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
| 受限访问 | 局域网浏览器（开关开启时） | 可访问管理页面，部分操作受限 |
| 不可访问 | 局域网浏览器（开关关闭时） | 管理页面完全不可达 |

- 开关仅控制 **管理页面是否监听局域网**：
  - 关闭（默认）：API/前端仅绑定 `127.0.0.1`，仅本机 Electron 可访问
  - 开启：API/前端绑定 `0.0.0.0`，局域网设备可通过浏览器访问
- Electron 窗口始终是最高权限持有者（通过本地回环检测 + token 标识）
- 敏感 API（如删除模型、修改设置）校验请求来源，非 Electron 端拒绝或降权

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

-- 活跃部署
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
  updated_at       TEXT NOT NULL
);
```

### 4.3 迁移策略

首次启动时检测旧 `state/workbench-state.json`，自动迁移数据到 SQLite，迁移后保留旧文件作为 `.bak`。

## 5. 容器模板

### 5.1 统一管理

所有推理容器以 Docker Compose 模板方式定义（`deploy/templates/`），通过 Docker SDK 启动和管理，不再使用独立 Dockerfile 构建。

### 5.2 三个标准容器模板

| 模板 | 运行时 | 端口 | Docker 镜像 |
|------|--------|------|------------|
| **vLLM** | LLM / VLM / Embedding | 30000 | `vllm/vllm-openai:latest` |
| **TensorRT-LLM** | 高性能 LLM | 31000 | `nvcr.io/nvidia/tritonserver:25.04-trtllm-python-py3` |
| **PyTorch** | 通用推理 (Whisper ASR) | 32000 | `nvcr.io/nvidia/pytorch:25.04-py3` |

### 5.3 容器模板格式 (`deploy/templates/vllm.yml`)

```yaml
# vLLM 容器模板
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
      - ${MODEL_PATH}:/models/${MODEL_ALIAS}:ro
      - ${HF_CACHE_DIR}:/root/.cache/huggingface
    environment:
      - HF_TOKEN=${HF_TOKEN:-}
    command:
      - /models/${MODEL_ALIAS}
      - --served-model-name
      - ${OPENAI_MODEL}
      - --host
      - 0.0.0.0
      - --port
      - "8000"
      - --trust-remote-code
```

### 5.4 容器生命周期

```
创建容器 → 拉取镜像 → 启动容器 → 加载模型 → 健康检查 → 服务就绪
                                                    ↓
                                              停止/重启/删除
```

- 容器独立于 Electron 进程运行
- 启动时注入 `BIND_ADDR` 环境变量，跟随 LAN 开关设置
- PyTorch 容器内置 Whisper ASR（本地），TTS 功能移除（edge-tts 为云端服务）

## 6. 目录结构（优化后）

```
ai-stack/
├── apps/                        # Electron 桌面应用
│   ├── main/                    # Electron 主进程
│   │   ├── index.ts            # 入口：窗口创建、API 启动
│   │   ├── preload.ts          # 预加载脚本
│   │   ├── db.ts               # SQLite 初始化与迁移
│   │   └── permissions.ts      # 权限校验中间件
│   ├── frontend/               # Vue 3 前端（从 apps/frontend 移动）
│   │   ├── src/
│   │   ├── package.json
│   │   └── vite.config.ts
│   └── api/                    # Node.js 后端（从 apps/api 移动）
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
├── configs/                     # 模型目录和配置（清理后）
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

## 7. 删除清单

| 路径 | 原因 |
|------|------|
| 路径 | 原因 |
|------|------|
| `deploy/compose/docker-compose.yml` (修改) | 移除 postgres/etcd/minio/milvus 服务定义及 profiles，保留 api/audio/frontend 服务作为容器化备用方案 |
| `deploy/compose/docker-compose-models.yml` | 旧 GGUF/llama.cpp 方案 |
| `deploy/compose/docker-compose.audio.yml` | 同主 compose 合并，不再需要独立文件 |
| `deploy/compose/docker-compose.vllm.yml` | 迁移到 `deploy/templates/vllm.yml` |
| `deploy/dockerfiles/Dockerfile.llamacpp` | 旧 llama.cpp 构建 |
| `apps/api/Dockerfile` | Electron 内嵌 API，不再需要容器化 API |
| `apps/frontend/Dockerfile` | Electron 接管前端，不再需要容器化 |
| `services/audio/` (整个目录) | 拆解：ASR(Whisper) → PyTorch 容器模板, TTS(edge-tts) → 删除 |
| `volumes/` 中的 etcd/minio/milvus/postgres 数据 | 代码未使用，不再需要 |
| `state/workbench-state.json` | 迁移到 SQLite 后转为 `.bak` 备份 |

## 8. 保留和迁移

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

## 9. .deb 打包

### 9.1 打包工具

使用 `electron-builder` 生成 `.deb` 包。

### 9.2 包信息

```
包名: amuin-ai-stack
版本: 1.1.0
架构: arm64 (DGX Spark)
依赖: docker-ce, nvidia-container-toolkit
安装路径: /opt/amuin-ai-stack/
桌面入口: /usr/share/applications/amuin-ai-stack.desktop
```

### 9.3 .deb 安装后行为

- 首次启动自动初始化 SQLite 数据库
- 从旧 JSON 文件自动迁移数据（如存在）
- 检查 Docker 可用性，不可用时提示安装
- 启动托盘图标，可后台运行

## 10. Audio / PyTorch 容器

### 10.1 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| ASR | OpenAI Whisper (tiny) | 本地 PyTorch 模型，支持中文 |
| HTTP 框架 | FastAPI + Uvicorn | 与前端 WebSocket 通信 |
| 基础镜像 | `nvcr.io/nvidia/pytorch:25.04-py3` | NVIDIA 官方 PyTorch |

### 10.2 移除内容

- `edge-tts`（微软云端 TTS，非本地）
- `CosyVoiceAdapter`（实际调用 edge-tts）
- 所有 TTS 相关 API 端点
- `funasr` 依赖（实际未使用，用的是 whisper）

### 10.3 对外接口

| 端点 | 说明 |
|------|------|
| `GET /healthz` | 健康检查 |
| `GET /v1/models` | 模型列表 |
| `WS /v1/realtime` | OpenAI Realtime ASR（仅转录，无 TTS） |

## 11. 实现阶段

| 阶段 | 内容 |
|------|------|
| **Phase 1**: 清理 | 删除遗留代码（pg/etcd/minio/milvus、edge-tts、llama.cpp、旧 compose） |
| **Phase 2**: 存储 | JSON → SQLite 迁移，替换 StateStore |
| **Phase 3**: Electron | 搭建 Electron 壳、主进程、内嵌 API、打包配置 |
| **Phase 4**: 权限 | 权限中间件、LAN 开关、Electron 最高权限 |
| **Phase 5**: 容器模板 | 统一 vLLM/TensorRT-LLM/PyTorch 三个模板，PyTorch 容器 Dockerfile |
| **Phase 6**: 打包 | electron-builder 配置、.deb 生成、桌面入口 |
| **Phase 7**: 测试验证 | 端到端测试、安装测试 |
