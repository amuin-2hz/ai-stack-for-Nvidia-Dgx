# Qwen3-TTS 三模型 AI Stack 托管发布方案

更新日期：2026-07-22

## 1. 发布目标

Qwen3-TTS 通过 AI Stack 的“模型库 → 加载/发布”功能统一管理。用户不需要执行 Docker、Compose 或启动命令，也不需要维护独立容器。

| 模型 | 能力 | 模型 ID | 状态 |
| --- | --- | --- | --- |
| CustomVoice | 预置音色与指令控制 | `qwen3-tts-12hz-1.7b-customvoice` | 已下载、可发布 |
| VoiceDesign | 自然语言设计音色 | `qwen3-tts-12hz-1.7b-voicedesign` | 已下载、可发布 |
| Base | 参考音频音色克隆 | `qwen3-tts-12hz-1.7b-base` | 已下载、可发布 |

AI Stack 仅在模型目录完整、无下载暂存目录、配置与权重存在且下载任务完成时允许发布。当前三个模型均已通过准入检查。

## 2. AI Stack 托管架构

```text
AI Stack 模型库
  │ 选择任一 Qwen3-TTS 模型
  ▼
加载/发布：Qwen3-TTS 托管语音服务
  ├─ 平台准备运行环境
  ├─ 平台挂载三个已完成模型
  ├─ 平台执行模型与接口健康检查
  └─ 平台登记 Speech API 与三个模型 ID
       ├─ CustomVoice：预置音色
       ├─ VoiceDesign：音色设计
       └─ Base：参考音频克隆
```

Qwen3-TTS 在产品中表现为一个 AI Stack 托管语音服务，而不是需要用户单独管理的容器。底层编排、GPU、端口、模型挂载和恢复均由 AI Stack 控制面负责。

首次发布时平台准备运行环境；服务运行后，再选择同族模型会复用现有服务，不会重复创建或重启运行环境。一次成功发布后，三个已就绪模型统一出现在“已加载模型”区域。

## 3. 界面发布流程

1. 打开 AI Stack“模型库”。
2. 确认三个 Qwen3-TTS 模型状态均为“已下载”。
3. 选择任意一个模型，进入“加载/发布”。
4. 发布方式应自动显示“Qwen3-TTS 专用语音合成”和“AI Stack 托管”。
5. 点击“AI Stack 加载并发布”。
6. 查看“准备运行环境 → 加载模型 → 健康检查”的任务进度。
7. 状态变为 `READY` 后，在“已加载模型”复制调用地址。

如果服务已运行，按钮显示“发布到托管服务”。该操作复用现有服务，不要求用户进入“服务”页面手工启动任何内容。

## 4. 平台运行策略

- 三个模型共用一个 AI Stack 托管语音服务。
- 首选模型作为启动预热模型。
- 默认 GPU 缓存一个模型；跨能力调用时按需切换。
- 默认单并发，额外请求排队，优先保证统一内存环境稳定。
- 默认 BF16；FlashAttention 2 不可用时自动回退 SDPA。
- 模型文件只读使用，服务不会修改下载目录。
- 参考音频只接受 base64 data URL，不接受远程 URL 或服务器路径。
- 输入默认最多 4000 字符，参考音频默认最多 15 MiB。

## 5. Speech API

AI Stack 会在“已加载模型”卡片中显示真实地址，接口为 `POST /v1/audio/speech`。

公共字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `model` | 是 | 三个规范模型 ID 之一 |
| `input` | 是 | 待合成文本 |
| `language` | 否 | `Auto` 或指定语言 |
| `response_format` | 否 | `mp3`、`wav`、`flac`、`opus`、`aac`、`pcm` |
| `speed` | 否 | 0.25–4.0 |
| `seed` | 否 | 随机种子 |
| `stream` | 否 | `true` 时启用分段增量音频响应 |
| `stream_chunk_chars` | 否 | 每段最大字符数，默认 120，范围 20–1000 |

### CustomVoice

```json
{
  "model": "qwen3-tts-12hz-1.7b-customvoice",
  "input": "欢迎使用 AI Stack 本地语音服务。",
  "voice": "Vivian",
  "language": "Chinese",
  "instructions": "清晰、自然、热情",
  "response_format": "wav"
}
```

### VoiceDesign

```json
{
  "model": "qwen3-tts-12hz-1.7b-voicedesign",
  "input": "系统已经准备就绪。",
  "language": "Chinese",
  "instructions": "沉稳可信的成年男声，语速适中，播报风格",
  "response_format": "wav"
}
```

### Base 音色克隆

```json
{
  "model": "qwen3-tts-12hz-1.7b-base",
  "input": "这是克隆音色生成的新内容。",
  "language": "Chinese",
  "reference_audio": "data:audio/wav;base64,<参考音频>",
  "reference_text": "参考音频中逐字对应的准确文本",
  "response_format": "wav"
}
```

### 流式输出

请求中设置：

```json
{
  "model": "qwen3-tts-12hz-1.7b-customvoice",
  "input": "第一段会优先生成并返回。第二段生成后继续传输。第三段不会等待全文完成。",
  "voice": "Vivian",
  "language": "Chinese",
  "response_format": "pcm",
  "stream": true,
  "stream_chunk_chars": 40
}
```

流式响应是原始音频字节的 HTTP chunked 传输，不是 SSE。推荐使用 `pcm` 获得最稳定、
最低额外开销的连续音频块；也支持 `mp3`、`aac` 和 `opus`。由于 WAV 和 FLAC
文件头需要最终长度，`stream=true` 时使用这两种格式会返回 400。

AI Stack 会按自然标点和 `stream_chunk_chars` 将长文本分段，第一段生成后立即发送，
后续段落边生成边传输。响应头包括：

- `X-AI-Stack-Stream-Mode: segmented`
- `X-AI-Stack-Stream-Chunks: <分段数>`
- `X-AI-Stack-Sample-Rate: 24000`
- `Transfer-Encoding: chunked`

当前 `qwen-tts 0.1.1` 不提供原生逐帧生成；这里实现的是可实际降低长文本首包等待的
分段增量生成，而不是把整段生成完成后再切片。

## 6. AI Stack 验收

发布任务应完成模型完整性、运行环境、模型加载和健康检查，并满足：

- `/v1/models` 返回三个 `ready=true` 模型；
- “已加载模型”显示 Qwen3-TTS、AI Stack 托管和 Speech API；
- 三种能力分别完成功能抽检；
- 流式响应首包早于完整响应结束，且 PCM/MP3 可完整解码；
- 连续请求无 5xx、无在线下载、无 OOM；
- 日志中不记录参考音频正文。

内部冒烟脚本只用于 AI Stack 自动化验收，不属于用户启动步骤。

## 7. 日常管理

- 状态与调用地址：AI Stack“加载/发布”。
- 发布任务：AI Stack“任务”。
- 服务健康与日志：AI Stack“服务”中的 Qwen3-TTS 托管语音服务。
- 停止：在“已加载模型”点击“退出加载”，由平台完成停止与清理。
- 重新发布：回到模型库选择模型并点击“AI Stack 加载并发布”。

三个模型共享托管服务，停止服务会使三个模型同时退出加载，但不会删除模型文件或下载记录。

底层 Compose 模板、镜像定义和 FastAPI 网关仅是 AI Stack 内部运行时模块，由控制面调用，不属于用户发布步骤。

模型能力依据 Qwen 官方仓库：<https://github.com/QwenLM/Qwen3-TTS>。
