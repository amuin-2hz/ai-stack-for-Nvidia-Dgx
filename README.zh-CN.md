# AMUIN AI STACK

面向 DGX Spark 的 vLLM-first 本地模型工作台 — 模型下载、审计、部署、通过 OpenAI 兼容 API 发布服务。

## 架构

```
前端控制台 (:8888) → 后端控制面 (:8000) → Docker/NVIDIA 运行时
                                              ├── vLLM 服务 (:30000)
                                              ├── TensorRT-LLM 服务 (:31000)
                                              └── 音频服务 (:32000)
```

- **管理控制台**固定发布在 `http://localhost:8888`
- **推理服务**发布在 `30000–60000` 端口段，按服务类型分配入口
- **vLLM** 是 LLM / VLM / Embedding 的默认运行时
- **TensorRT-LLM** 作为 DGX Spark 官方验证模型的高级选项
- **llama.cpp / GGUF** 不纳入本系统发布路线，提示使用 LM Studio 管理

## 快速开始

```bash
cd /home/zhenz/ai-stack

# 全栈（API + 前端 + 基础设施）
docker compose -f deploy/compose/docker-compose.yml up -d --build

# 含 vLLM worker 模板
docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.vllm.yml up -d --build

# 音频专用栈（ASR + TTS）
docker compose -f deploy/compose/docker-compose.audio.yml up -d --build
```

打开 `http://localhost:8888` 进入管理控制台。

## 目录结构

| 目录 | 用途 |
|------|------|
| `apps/api/` | TypeScript/Node.js 控制面 — 模型注册、下载、部署、OpenAI 代理 |
| `apps/frontend/` | Vue 3 管理控制台和聊天界面 |
| `services/audio/` | ASR/TTS 实时音频服务（PyTorch 25.04） |
| `legacy/python-backend/` | 旧 FastAPI 后端，仅保留作迁移参考 |
| `deploy/compose/` | Docker Compose 编排（主栈、vLLM、音频、旧模型） |
| `deploy/dockerfiles/` | 辅助镜像（下载工具、llama.cpp） |
| `models/` | 模型权重和配置文件 |
| `cache/` | HuggingFace / ModelScope 下载缓存 |
| `volumes/` | 持久化数据（PostgreSQL、Milvus、etcd、MinIO） |
| `configs/` | 模型清单、运行时 profile、常驻策略 |
| `ops/scripts/` | 运维脚本（下载、启停、健康检查） |
| `logs/` | 服务和任务日志 |
| `engines/` | TensorRT-LLM engine（规划中） |

## 模型生命周期

每个模型遵循状态机流转：

`未知 → 下载中 → 已下载 → 就绪 → 运行中 → 已停止`

- **导入**：粘贴 HuggingFace 或 ModelScope 模型链接
- **审计**：自动识别文件结构、格式、能力和运行时兼容性
- **下载**：以后台任务方式运行，有进度和日志
- **部署**：将兼容模型加载到 vLLM / TensorRT-LLM / Audio 运行时
- **卸载**：停止部署并释放 GPU 显存

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
| POST | `/deployments/start` | 将模型部署到运行时 |
| POST | `/deployments/:id/stop` | 停止部署 |
| GET | `/containers` | 列出运行时容器及状态 |
| POST | `/containers/:key/pull-image` | 拉取运行时 Docker 镜像 |
| POST | `/containers/:name/start` | 启动容器 |
| POST | `/containers/:name/stop` | 停止容器 |
| GET/POST | `/settings/workbench` | 读取或更新管理端口 |
| GET/POST | `/settings/network` | 读取或切换局域网访问 |

### OpenAI 兼容 API（端口 8888，代理到运行中服务）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | 列出运行中部署的模型 |
| POST | `/v1/chat/completions` | 聊天补全（模型未加载时自动唤醒） |
| POST | `/v1/embeddings` | 嵌入向量 |

## 端口策略

| 端口 | 服务 |
|------|------|
| `8888` | 管理控制台（固定） |
| `8000` | 后端 API（内部） |
| `30000` | vLLM OpenAI 服务 |
| `31000` | TensorRT-LLM OpenAI 服务 |
| `32000` | Audio HTTP/WebSocket 服务 |

推理端口**按服务类型分配**，不按模型分配。模型注册到对应服务，worker 端口仅内部可见。

## 运维操作

```bash
# 从 ModelScope 下载模型
ops/scripts/ms-download.sh Qwen/Qwen3.5-9B qwen35-9b

# 从 HuggingFace 下载
ops/scripts/hf-download.sh Tesslate/OmniCoder-9B omnicoder-9b

# 检查模型下载完整性
python3 ops/scripts/check_models_progress.py

# 查看运行中容器
docker ps --format '{{.Names}}\t{{.Status}}'
docker logs --tail 100 vllm-service
```

## 注意事项

- 当前主机 ModelScope（`modelscope.cn`）为主要下载源，HuggingFace 可能超时
- 所有容器操作需要 Docker socket 权限
- 旧版 `docker-compose-models.yml`（llama.cpp/GGUF）仅供历史参考
- TensorRT-LLM 支持受 DGX Spark 镜像版本和模型架构影响
- vLLM 并非万能运行时，部分架构、多模态模型和特殊量化格式可能需要特定版本
