# AMUIN AI STACK

[English](README.md) | 简体中文

AMUIN AI STACK 是面向 NVIDIA GPU 工作站和 DGX Spark 的本地模型运维平台，将模型获取、兼容性检查、发布、API 测试、运行监控和维护集中到一个桌面端与 Web 控制台中。

`1.1.1` 版本聚焦可落地的单机部署：提供 OpenAI 兼容推理接口、音频与文档专用运行时、可配置的 vLLM Tool Call，以及原生 ARM64 安装包。

## 核心能力

- 从 Hugging Face 或 ModelScope 导入、下载模型。
- 发布前检查模型文件，并推荐兼容运行时。
- 使用 vLLM、TensorRT-LLM、PyTorch 或专用 Compose 运行时发布模型。
- 统一查看 GPU、容器、任务、健康状态、端口和日志。
- 在界面中测试对话、Embedding、Reranker、语音、OCR 和文档模型。
- 提供 OpenAI 兼容的对话、Embedding 和音频转写 API。
- 发布 vLLM 模型时可开启或关闭 Tool Call，并选择解析器。
- 支持 Electron 桌面端，以及可通过局域网访问的中英文 Web 控制台。

## 运行时覆盖

通用模型运行时包括 vLLM、TensorRT-LLM 和 PyTorch，同时提供以下专用 Profile：

- FunASR：支持四个可选 ASR 管线
- Qwen3-TTS 和 VibeVoice
- vLLM Embedding 和 Reranker
- Unlimited-OCR、MinerU 和 LocateAnything

## v1.1.1 验证结果

当前版本已在 NVIDIA GB10 ARM64 主机完成验收：

- API 测试：**80/80 通过**
- 前端、API 和桌面端构建通过
- Web 控制台可通过局域网 `8888` 端口访问
- Qwen3.8 实际返回结构化 `tool_calls`，且 `finish_reason` 为 `tool_calls`
- 模型发布页可正确开启/关闭 vLLM Tool Call 启动参数
- 四个 ASR 管线均通过 OpenAI 转写接口返回 HTTP 200
- ARM64 DEB 与 aarch64 RPM 均通过校验和及安装包完整性检查

## ARM64 Linux 安装

请从仓库的 Release 页面下载 DEB 或 RPM。

```bash
# Debian / Ubuntu
sudo apt install ./amuin-ai-stack_1.1.1_arm64.deb

# Fedora / RHEL 兼容发行版
sudo dnf install ./amuin-ai-stack-1.1.1-1.aarch64.rpm
```

RPM 会安装 systemd 服务，可通过 `/etc/sysconfig/amuin-ai-stack` 调整环境变量。Web 默认端口为 `8888`，控制面 API 默认端口为 `8000`。

## OpenAI 兼容 ASR

FunASR 提供标准音频转写路由：

```text
POST http://<服务器IP>:8011/v1/audio/transcriptions
```

通过 `model` 表单字段选择四个管线之一：

| model 值 | 适用场景 |
|---|---|
| `pipeline:general` | 通用语音识别 |
| `pipeline:accurate-zh` | 更高精度的中文识别 |
| `pipeline:domain-zh` | 支持 n-gram 的中文领域词汇 |
| `pipeline:meeting` | 会议及多说话人音频 |

```bash
curl --noproxy "*" --http1.1 -H "Expect:" \
  --max-time 300 \
  "http://<服务器IP>:8011/v1/audio/transcriptions" \
  -F "file=@/绝对路径/test.wav" \
  -F "model=pipeline:general" \
  -F "language=zh" \
  -F "response_format=json"
```

接口返回普通 JSON，例如 `{"text":"..."}`；该接口不是流式接口。

## vLLM Tool Call

发布兼容的 Qwen 模型时，开启 **Tool Call**，选择解析器（例如 `qwen3_coder`），然后发布模型。系统会加入对应的 vLLM 启动参数，并通过 `/v1/chat/completions` 返回结构化工具调用。关闭开关后，发布计划不会包含 Tool Call 参数。

## 典型使用流程

1. 配置模型存储和网络设置。
2. 导入或下载模型。
3. 查看兼容性检查和运行时建议。
4. 使用所需参数发布模型。
5. 在模型测试页或 OpenAI 兼容客户端中测试接口。
6. 持续查看健康状态、GPU 使用、日志和后台任务。

## 环境要求

- `v1.1.1` 安装包面向 ARM64 Linux
- GPU 运行时需要 NVIDIA GPU 和可用的 NVIDIA Container Toolkit
- Docker 与 Docker Compose
- 源码开发需要 Node.js 20 或更高版本

## 源码开发

```bash
npm install
npm run dev
```

常用检查命令：

```bash
npm test
npm run build
```

主要组件位于 `apps/frontend`、`apps/api` 和 `apps/main`；运行时定义位于 `deploy` 与 `configs`；打包脚本位于 `scripts` 与 `packaging`。

## 项目边界

AMUIN AI STACK 当前面向可信任的 Linux 单机环境，暂不是多租户集群调度平台。用于生产环境前，请评估网络暴露、凭据、模型许可证和运行时安全。

## 许可证

参见 [LICENSE](LICENSE)。
