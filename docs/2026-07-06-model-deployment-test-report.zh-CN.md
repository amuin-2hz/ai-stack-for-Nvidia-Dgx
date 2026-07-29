# 2026-07-06 模型部署测试报告（中文）

## 一句话结论

目前不能认为“所有模型都能启动并服务”。模型文件有些已经可见或 ready，但真正要稳定发布，需要在默认运行时之外增加若干“专用运行时/自定义容器配置”。

建议保留三个默认槽位：

- vLLM：通用文本、代码、部分视觉模型。
- TensorRT-LLM：高级优化路线，适合后续经过验证或转换的模型。
- PyTorch：通用 PyTorch 环境，用于健康检查、基础依赖验证和后续自定义运行时的基础镜像参考；不内置 ASR/TTS 业务服务。

音频不能作为默认 PyTorch 容器里的 Whisper 占位服务继续存在；FunASR / ModelScope 音频能力应该作为后续自定义业务容器创建。除此之外，OCR、Reranker、Embedding 也需要各自的运行时 profile。

## 为什么三个默认容器不够

这 11 个模型实际分成了多种任务类型：

- 聊天/代码生成：`omnicoder-9b`、`qwen36-35b-a3b`
- 向量：`qwen3-embedding-8b`
- 重排：`qwen3-reranker-8b`
- 文档/OCR/VLM：`mineru2.5-pro-2605-1.2b`、`unlimited-ocr`
- ASR：`fun-asr-nano-2512`、`sensevoicesmall`、`whisper-large-v3`
- 说话人验证：`speech_campplus_sv_zh-cn_16k-common`
- 说话人分离：`speech_campplus_speaker-diarization_common`

这些模型的服务方式不同，不能都用 `/v1/chat/completions` 或同一个 vLLM 启动参数解决。

## 推荐容器/运行时设计

### 1. vLLM 标准容器

用途：

- `omnicoder-9b`
- `qwen36-35b-a3b`
- 部分普通 VLM/LLM

统一 API：

- `POST /v1/chat/completions`

需要参数面板：

- `max_model_len`
- `gpu_memory_utilization`
- `max_num_seqs`
- `tensor_parallel_size`
- `kv_cache_dtype`
- `temperature`
- `top_p`
- `top_k`
- `max_tokens`
- `stream`

### 2. vLLM Embedding Profile

用途：

- `qwen3-embedding-8b`

它不是普通 chat 模型。当前 vLLM 镜像需要类似：

```bash
--runner pooling --convert embed
```

统一 API：

- `POST /v1/embeddings`

注意：

- 这个模型当前磁盘检查仍显示缺少一个分片：`model-00001-of-00004.safetensors`。
- 下载补齐前不应该允许一键发布。

### 3. vLLM Reranker Profile

用途：

- `qwen3-reranker-8b`

它需要专门的 rerank 路由和特殊 `hf_overrides`，不是 chat/embedding。

统一 API：

- `POST /v1/rerank`

关键启动参数：

```json
{"architectures":["Qwen3ForSequenceClassification"],"classifier_from_token":["no","yes"],"is_original_qwen3_reranker":true}
```

注意：

- 当前磁盘检查仍显示缺少一个分片：`model-00003-of-00005.safetensors`。
- 需要补齐后再测试。

### 4. 自定义 Audio-FunASR / ModelScope 容器

这是最应该新增的业务级自定义容器，不属于三个默认容器之一。

建议名字可以是：

- `audio-funasr-service`
- 或 `funasr-gateway-service`
- 或简单叫 `audio-service`

用途：

- `fun-asr-nano-2512`
- `sensevoicesmall`
- `whisper-large-v3`
- `speech_campplus_sv_zh-cn_16k-common`
- `speech_campplus_speaker-diarization_common`

统一 API：

- `POST /v1/audio/transcriptions`：ASR
- `POST /v1/audio/speaker-verifications`：说话人验证
- `POST /v1/audio/diarizations`：说话人分离

为什么必须做：

- 现在 `/audio/models` 连不上 `127.0.0.1:32000`。
- 修正前生成的 PyTorch plan 会调用 `docker compose ... pytorch-service`，但主 compose 里没有这个 service。
- 修正前的模板偏 Whisper WebSocket，不支持 FunASR/SenseVoice/CAM++ 这些模型的真实调用方式。

### 5. OCR / Unlimited-OCR 专用容器

用途：

- `unlimited-ocr`

当前测试结果：

- 权重完整。
- 通用 vLLM 镜像启动失败，缺 Python 包：`addict`、`matplotlib`。

推荐：

- 使用专用镜像，例如 `vllm/vllm-openai:unlimited-ocr`
- 或做一个自定义 OCR 镜像，把依赖和启动参数固定进去。

统一 API：

- 如果走 OpenAI Vision 形式：`POST /v1/chat/completions`
- 如果做产品化文档解析：建议另加 `/v1/document/parse`

### 6. MinerU 专用 Profile

用途：

- `mineru2.5-pro-2605-1.2b`

当前状态：

- 目录里没有权重文件，不能部署。

后续如果权重补齐，它更像“文档解析服务”，不是普通聊天模型。

统一 API：

- 可临时走 Vision chat。
- 产品上更建议 `/v1/document/parse`，输出 Markdown/JSON。

## 是否需要“自定义容器”

需要，但建议不要做成“每个模型一个完全独立容器模板”，而是做成“运行时 Profile”。

推荐层次：

1. 默认 runtime slot：`vllm`、`trtllm`、`pytorch`
2. runtime profile：`chat`、`embedding`、`rerank`、`funasr-asr`、`speaker-verification`、`diarization`、`ocr`
3. model-specific override：例如 `qwen3-reranker-8b` 的 `hf_overrides`，`unlimited-ocr` 的专用镜像

这样用户看到的还是统一入口，不会被一堆端口和容器名吓到。

## 统一 API 能不能搞定

可以，但后端网关要补能力路由。

建议统一入口：

| 能力 | 统一 API | 后端运行时 |
|---|---|---|
| 文本/代码聊天 | `/v1/chat/completions` | vLLM / TRT-LLM |
| 图片/VLM | `/v1/chat/completions` | vLLM / 专用 VLM |
| 向量 | `/v1/embeddings` | vLLM pooling / TEI |
| 重排 | `/v1/rerank` | vLLM reranker |
| 语音转写 | `/v1/audio/transcriptions` | 自定义 Audio-FunASR |
| 说话人验证 | `/v1/audio/speaker-verifications` | 自定义 FunASR Gateway |
| 说话人分离 | `/v1/audio/diarizations` | 自定义 FunASR Gateway |
| 文档解析 | `/v1/document/parse` | MinerU / Unlimited-OCR |

用户端只访问管理 API，比如 `http://127.0.0.1:8000`，不用知道 30000、31000、32000 或其它内部端口。

## 参数整理是否能程序化

可以，而且应该程序化。

建议写一个本地扫描器，生成每个模型的 manifest：

```json
{
  "model_id": "qwen3-reranker-8b",
  "capability": "rerank",
  "runtime": "vllm",
  "download_integrity": "failed",
  "missing_files": ["model-00003-of-00005.safetensors"],
  "api_routes": ["/v1/rerank"],
  "deployment_schema": {},
  "inference_schema": {}
}
```

前端参数面板根据 manifest 自动生成：

- Chat 面板
- Embedding 面板
- Rerank 面板
- Audio ASR 面板
- Speaker Verification 面板
- Diarization 面板
- OCR/Document Parse 面板

这样以后不是人工整理参数，而是模型目录扫描后自动归类、自动提示缺文件、自动推荐运行时。

## 当前最重要的修复顺序

1. 修复模型完整性检查，把缺分片的模型直接标红，禁止发布。
2. 保留默认 PyTorch 为通用环境；后续新增真正的 `audio-funasr-service` 等自定义业务容器。
3. 补统一 API：`/v1/audio/transcriptions`、`/v1/rerank`、`/v1/audio/diarizations`。
4. 给 vLLM 增加 profile 参数：chat / embedding / rerank。
5. 给 Unlimited-OCR 增加专用镜像或自定义容器方案。
6. 只有在显存监控可靠后，再实测 `omnicoder-9b` 和 `qwen36-35b-a3b`。

## 当前真实状态

- 不是所有模型都能启动服务。
- 两个新增可见模型 `speech_campplus_speaker-diarization_common`、`whisper-large-v3` 已经磁盘 ready。
- 它们仍需要后续自定义 Audio 服务才能真正发布。
- 目前最值得新增的自定义容器就是 `audio-funasr-service` / `funasr-gateway-service`。
