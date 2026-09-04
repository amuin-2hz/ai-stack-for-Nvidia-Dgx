# AMUIN AI STACK

[English](README.md) | 简体中文

AMUIN AI STACK 是一款主要面向 **NVIDIA DGX Spark 及其他 GB10 ARM64 平台**的本地模型图形化部署与运维工具。它把模型下载、兼容性检查、Docker 运行时创建、发布、API 测试、GPU 监控、日志和维护整合为适合个人 AI 工作站的桌面端与 Web 操作流程。

[NVIDIA DGX Spark](https://www.nvidia.com/en-us/products/workstations/dgx-spark/) 采用 GB10 Grace Blackwell Superchip、20 核 ARM64 CPU 和 128 GB CPU/GPU 一致性统一内存。NVIDIA 将其定位为桌面端本地 AI 开发、推理与微调平台，FP4 AI 算力最高可达 1 PFLOP；其 [DGX OS 软件栈](https://docs.nvidia.com/dgx/dgx-spark/system-overview.html) 已集成 CUDA、Docker 和 NVIDIA Container Runtime。AMUIN AI STACK 正是围绕这一环境设计：应用原生运行在 ARM64 上，具体模型推理则隔离在可访问 GPU 的 Docker 容器中。

本项目不是 NVIDIA 官方产品，与 NVIDIA 不存在隶属关系。

## 已支持的部署场景

### 三个基础运行环境

它们是通用模型发布或构建模型专用服务的基础：

| 运行环境 | 主要用途 | 当前边界 |
|---|---|---|
| **vLLM** | LLM/VLM 推理及 OpenAI 兼容 API | 当前主要的通用推理路径。支持上下文、GPU 分配、量化相关运行参数，以及可选的 Tool Call 参数和解析器。 |
| **TensorRT-LLM** | NVIDIA 优化推理 | 已提供运行时与发布计划集成。仍需用户准备兼容 checkpoint 或已构建 engine、匹配的镜像，并完成模型所需的转换。 |
| **PyTorch** | 通用 CUDA/PyTorch 环境 | 用于构建自定义推理服务，或承载无法直接交给 vLLM 的模型；它本身不是万能模型服务器。 |

### 进阶能力 Profile

- **vLLM Embedding**：独立的 OpenAI 兼容向量服务。
- **vLLM Reranker**：独立的相关性评分和重排服务。
- **支持工具调用的 vLLM**：发布时可开启/关闭 Tool Call，并为 Qwen3 等兼容模型选择解析器。
- **OpenAI 兼容 ASR 网关**：使用标准 `/v1/audio/transcriptions` 接口，通过参数选择不同识别管线。

### 套件与模型专用运行时

- **FunASR / SenseVoice**：ASR、VAD、标点、可选说话人处理，以及增强 n-gram 管线。
- **Qwen3-TTS**：CustomVoice、VoiceDesign、Base 声音克隆，并支持多种流式输出格式。
- **VibeVoice**：Hugging Face 适配器专用 Profile；已完成集成，等待新一轮 DGX Spark 端到端验收。
- **Unlimited-OCR**：图片文字识别与坐标输出。
- **MinerU 2.5 Pro**：图片/PDF 内容提取和面向 Markdown 的文档解析。
- **LocateAnything**：图片目标定位、框和点输出。ARM64 Profile 当前仅开放图片能力，使用前还需确认模型许可证适用于目标场景。

## DGX Spark 实机验证矩阵

只有真实模型在 NVIDIA GB10/DGX Spark 主机完成加载，并返回可用推理结果后，才会在这里标记为**已验证**；仅镜像构建成功或健康接口正常不算通过。后续每增加一组针对性模型/运行时验收，都会继续更新此表。

| 场景 | 实测模型/Profile | GB10 实测结果 |
|---|---|---|
| vLLM 通用大模型 | OmniCoder-9B | OpenAI Chat 请求返回 HTTP 200，生成代码通过沙箱断言。 |
| 结构化 Tool Call | Qwen3.8 27B NVFP4 + vLLM | 返回结构化 `tool_calls` 和 `finish_reason: "tool_calls"`；发布页开关 Tool Call 的启动参数已验证。 |
| 文本向量 | Qwen3-Embedding-8B | HTTP 200，返回两组 4096 维向量。 |
| 文本重排 | Qwen3-Reranker-8B | HTTP 200，相关与无关文本的排序结果正确。 |
| 语音识别 | FunASR Gateway | 四个管线均通过 `/v1/audio/transcriptions` 返回 HTTP 200。 |
| 语音合成 | Qwen3-TTS CustomVoice / VoiceDesign / Base | 已生成非流式 WAV，以及流式 PCM/AAC/Opus/MP3 输出。 |
| OCR | Unlimited-OCR | HTTP 200，返回预期文字和检测坐标。 |
| 文档解析 | MinerU 2.5 Pro | HTTP 200，将预期发票字段解析为 Markdown。 |
| 图片目标定位 | LocateAnything-3B | HTTP 200，在图片模式下定位到预期目标区域。 |

TensorRT-LLM 与 VibeVoice 已提供集成，但在最新端到端 DGX Spark 验收完成前，不列入已验证模型场景。

## 当前版本提供的功能

`1.1.2` 面向可信任的个人工作站提供 ARM64 应用和完整部署流程：

- 中英文 Electron 桌面应用，以及可通过局域网访问的 Web 控制台。
- GPU、CPU、内存、存储、Docker 容器、端口、任务、健康状态和日志查看。
- 模型发现、本地存储管理，以及 Hugging Face/ModelScope 下载计划。
- 模型文件审计、未完整下载识别、运行时推荐和发布前检查。
- 运行时创建、启停、重启、健康检查、修复、清理和启动参数持久化。
- OpenAI 兼容的 Chat、Embedding、音频转写接口，以及各类任务专用 API。
- 模型发布前可开启/关闭 vLLM Tool Call，并选择解析器。
- 四个可选 ASR 管线：`pipeline:general`、`pipeline:accurate-zh`、`pipeline:domain-zh`、`pipeline:meeting`。
- 原生 ARM64 DEB 与 aarch64 RPM 安装包。

## 技术栈

| 层级 | 技术 |
|---|---|
| 桌面端 | Electron 33、TypeScript |
| 前端 | Vue 3、Vite、Ant Design Vue |
| 控制面 | Node.js、TypeScript、SQLite（`better-sqlite3`） |
| 运行时编排 | Docker Engine、Docker Compose、NVIDIA Container Toolkit |
| 模型推理 | vLLM、TensorRT-LLM、NVIDIA PyTorch 容器及模型专用 Python/FastAPI 类服务 |
| 安装包 | electron-builder、DEB、RPM |

控制面负责保存本地状态、生成运行计划、调用 Docker、执行健康检查并提供前端/API。模型推理留在独立容器中，避免不同模型的依赖污染桌面应用本身。

## 依赖要求——Docker 是必要条件

AMUIN AI STACK **不会**把所有 CUDA 推理环境打进桌面安装包。模型服务需要拉取或构建 Docker 镜像，因此发布模型前必须具备：

- 官方 `v1.1.2` 安装包要求 ARM64 Linux。
- NVIDIA GPU 驱动及可用的 CUDA 主机环境。
- Docker Engine 和 Docker Compose 插件（`docker compose`）。
- 已为 Docker 配置 NVIDIA Container Toolkit，容器可以访问 GPU。
- 足够的磁盘空间，用于模型权重、镜像层、构建缓存和生成结果。
- 能访问实际使用的镜像仓库和模型源，例如 Docker Hub、NVIDIA NGC、Hugging Face 或 ModelScope。

根据 [NVIDIA 官方容器运行时文档](https://docs.nvidia.com/dgx/dgx-spark/nvidia-container-runtime-for-docker.html)，DGX Spark 默认已经预装并配置 Docker 与 NVIDIA Container Toolkit。安装模型前仍建议先验证：

```bash
docker --version
docker compose version
nvidia-ctk --version
docker run --rm --gpus all nvcr.io/nvidia/cuda:13.0.1-devel-ubuntu24.04 nvidia-smi
```

应用必须有权访问 Docker daemon。可以使用具备相应权限的账户运行，或将用户加入 `docker` 组：

```bash
sudo usermod -aG docker "$USER"
newgrp docker
```

`docker` 组权限在主机上基本等同 root，只应授予可信用户。

## 在 DGX Spark / ARM64 上安装

从仓库的 `v1.1.2` Release 页面下载安装包：

```bash
# DGX OS / Ubuntu / Debian
sudo apt install ./amuin-ai-stack_1.1.2_arm64.deb

# ARM64 RPM 系发行版
sudo dnf install ./amuin-ai-stack-1.1.2-1.aarch64.rpm
```

从系统应用菜单启动，或执行：

```bash
amuin-ai-stack
```

RPM 还会安装 systemd 服务，可作为 Web 服务运行：

```bash
sudo systemctl enable --now amuin-ai-stack
sudo systemctl status amuin-ai-stack
```

Web 控制台默认地址为 `http://<主机IP>:8888`，控制面 API 默认使用 `8000` 端口。RPM 服务环境变量位于 `/etc/sysconfig/amuin-ai-stack`。

## 基本使用方法

1. 使用上面的命令确认 Docker 和容器 GPU 访问正常。
2. 打开 AMUIN AI STACK，设置模型与缓存存储目录。
3. 如果主机需要代理，配置代理和镜像仓库访问方式。
4. 导入 Hugging Face/ModelScope 仓库，或者扫描已有本地模型目录。
5. 查看模型完整性和兼容性评估。
6. 选择基础或专用运行时，配置端口、GPU、上下文及模型专用选项。
7. 发布模型，等待镜像、容器、模型加载和健康检查全部完成。
8. 在模型测试页或 OpenAI 兼容客户端中调用接口。

ASR 调用示例：

```bash
curl --noproxy "*" --http1.1 -H "Expect:" \
  --max-time 300 \
  "http://<主机IP>:8011/v1/audio/transcriptions" \
  -F "file=@/绝对路径/test.wav" \
  -F "model=pipeline:general" \
  -F "language=zh" \
  -F "response_format=json"
```

接口返回普通 JSON，例如 `{"text":"..."}`，不是流式接口。

## x86 NVIDIA 显卡与项目边界

控制面、界面和容器化架构理论上同样适用于使用 NVIDIA 显卡的普通 **x86_64 Linux 工作站**，前提是所选 Docker 镜像、驱动、CUDA、模型和量化方式兼容。但目前官方安装包和场景验收仍以 DGX Spark/GB10 ARM64 为主；在发布专用 x86_64 安装包并逐模型验证前，x86_64 应视为源码部署和兼容性尝试范围，而不是当前正式承诺。

AMUIN AI STACK 主要服务于可信任的**个人单机环境**，不是多租户调度器、分布式推理控制面或企业 GPU 集群管理器。如果需要多节点组网、GPU 池化、分布式调度、配额和组织级治理，建议选择 [GPUStack](https://gpustack.ai/) 或其他面向集群的方案。

将服务开放到可信局域网之外前，请自行检查凭据、防火墙、Docker 权限、模型许可证和模型远程代码要求。

## 源码开发

建议使用 Node.js 20 或更高版本：

```bash
npm install
npm run dev
```

验证命令：

```bash
npm test
npm run build
```

主要组件位于 `apps/frontend`、`apps/api` 和 `apps/main`；运行时定义位于 `deploy` 与 `configs`；打包代码位于 `scripts` 与 `packaging`。

## 致谢

AMUIN AI STACK 的界面布局和大量交互方式借鉴并受到 [LM Studio](https://lmstudio.ai/) 的启发。感谢 LM Studio 团队为易用的本地 AI 软件树立了优秀范例。AMUIN AI STACK 是独立项目，与 LM Studio 不存在隶属、合作或背书关系。

## 许可证

参见 [LICENSE](LICENSE)。
