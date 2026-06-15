# AMUIN AI STACK

面向 DGX Spark 的本地 AI 模型工作台 — 模型下载、启动标准化容器模板、将模型加载到 vLLM / TensorRT-LLM / PyTorch 运行时，通过 OpenAI 兼容 API 提供服务。

## 架构

```
前端控制台 (:8888) → 后端 API (:8000) → Docker / NVIDIA 运行时
                                            ├── vLLM 服务 (:30000)
                                            ├── TensorRT-LLM 服务 (:31000)
                                            └── 音频服务 (:32000, PyTorch)
```

- **管理控制台**位于 `http://localhost:8888`
- **推理服务**发布在 `30000–60000` 端口段，按服务类型分配入口
- **内置 3 个标准化模板容器** —— vLLM、TensorRT-LLM、Audio (PyTorch)，均已调试好 Docker 镜像、组件依赖和重启策略

## 快速开始

```bash
cd /home/zhenz/ai-stack

# 全栈（API + 前端 + 基础设施）
docker compose -f deploy/compose/docker-compose.yml up -d --build

# 含 vLLM worker
docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.vllm.yml up -d --build

# 音频专用栈（ASR + TTS）
docker compose -f deploy/compose/docker-compose.audio.yml up -d --build
```

打开 `http://localhost:8888` 进入管理控制台。

## 目录结构

| 目录 | 用途 |
|------|------|
| `apps/api/` | Node.js/TypeScript 控制面 — 模型注册、下载、部署 |
| `apps/frontend/` | Vue 3 + Vite 管理控制台和聊天界面 |
| `services/audio/` | Python ASR/TTS 音频服务（FunASR + CosyVoice，PyTorch） |
| `deploy/compose/` | Docker Compose 编排（主栈、vLLM、音频） |
| `deploy/dockerfiles/` | 辅助镜像（下载工具） |
| `models/` | 本地模型权重和配置（gitignored） |
| `configs/` | 模型清单、运行时 profile、常驻策略 |
| `scripts/` | 开发便捷脚本 |
| `ops/` | 运维脚本（下载、健康检查） |
| `playbooks/` | DGX Spark 参考 playbook 和示例 |

运行时自动生成（gitignored）：`volumes/`、`cache/`、`state/`、`logs/`、`tmp/`。

## 标准化容器模板

| 模板 | 运行时 | 端口 | 技术栈 |
|------|--------|------|--------|
| vLLM | LLM / VLM / Embedding | 30000 | Python, CUDA, PyTorch, vLLM |
| TensorRT-LLM | 高性能 LLM | 31000 | CUDA, TensorRT-LLM |
| Audio Service | ASR / TTS | 32000 | Python, PyTorch, FunASR, CosyVoice |

三个容器均已完成调试：Docker 镜像已固定、组件已验证、重启策略设为 `resident`（常驻）。启动容器 → 加载兼容模型 → 接口即刻上线。

## 工作流

```
导入链接 → 审计模型 → 下载 → 启动容器 → 加载模型 → 提供服务
```

1. **导入** — 粘贴 HuggingFace 或 ModelScope 模型链接
2. **审计** — 自动识别文件结构、格式、能力和运行时兼容性
3. **下载** — 以后台任务方式运行，有进度和日志
4. **启动容器** — 从标准化模板拉取镜像并启动
5. **加载模型** — 将本地模型部署到目标推理容器
6. **服务** — 模型注册到对应服务端口，提供 OpenAI 兼容接口

## 运行时兼容性

| 模型格式 | vLLM | TensorRT-LLM | Audio | 说明 |
|---|---|---|---|---|
| HF safetensors checkpoint | ✓ 默认 | 可能 | — | 需 config.json + tokenizer + 权重分片 |
| TensorRT-LLM engine | — | ✓ 仅支持 | — | 不能交给 vLLM |
| GGUF 单文件 | — | — | — | 外部工具（LM Studio），本系统不部署 |
| FunASR / CosyVoice / Whisper | — | — | ✓ | 仅音频服务 |

## API 端点

### 管理 API（内部，端口 8000）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/system/check` | 系统健康检查（Docker、GPU、端口） |
| GET | `/models` | 列出本地模型及审计信息 |
| POST | `/models/import` | 解析模型链接并预览下载计划 |
| POST | `/downloads` | 启动模型下载任务 |
| GET | `/tasks` | 列出所有任务（下载、部署、容器） |
| GET | `/tasks/:id/logs` | 读取任务日志 |
| GET | `/deployments` | 列出已配置和活跃部署 |
| POST | `/deployments` | 将模型部署到运行时 |
| GET | `/containers` | 列出运行时容器及状态 |
| POST | `/containers/:key/pull-image` | 拉取运行时 Docker 镜像 |
| POST | `/containers/:key/test-image` | 测试运行时镜像 |
| GET/POST | `/settings/workbench` | 读取或更新管理端口 |
| GET/POST | `/settings/network` | 读取或切换局域网访问 |

### OpenAI 兼容 API（端口 8888，代理到运行中服务）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | 列出运行中部署的模型 |
| POST | `/v1/chat/completions` | 聊天补全 |
| POST | `/v1/embeddings` | 嵌入向量 |

## 端口策略

| 端口 | 服务 |
|------|------|
| `8888` | 管理控制台（固定） |
| `8000` | 后端 API（内部） |
| `30000` | vLLM OpenAI 服务 |
| `31000` | TensorRT-LLM OpenAI 服务 |
| `32000` | Audio HTTP/WebSocket 服务 |

推理端口按服务类型分配，不按模型分配。模型注册到对应服务即可。

## 注意事项

- 当前主机 ModelScope（`modelscope.cn`）为主要下载源，HuggingFace 可能超时
- 所有容器操作需要 Docker socket 权限
- vLLM 并非万能运行时，部分架构、多模态模型和特殊量化格式可能需要特定版本
- TensorRT-LLM 支持受 DGX Spark 镜像版本和模型架构影响
