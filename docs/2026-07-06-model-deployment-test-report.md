# 2026-07-06 Model Deployment Test Report

## Scope

This report covers the 9 models in today's list:

1. `fun-asr-nano-2512`
2. `mineru2.5-pro-2605-1.2b`
3. `omnicoder-9b`
4. `qwen3-embedding-8b`
5. `qwen3-reranker-8b`
6. `qwen36-35b-a3b`
7. `sensevoicesmall`
8. `speech_campplus_sv_zh-cn_16k-common`
9. `unlimited-ocr`

Other directories under `models/` were observed but are not included in this test scope.

## Environment And Safety Notes

- Management API `http://127.0.0.1:8000` is running.
- vLLM public runtime port `30000` was not running at the start.
- TensorRT-LLM public runtime port `31000` was not running at the start.
- PyTorch public runtime port `32000` was not running at the start.
- Docker images are present locally for vLLM, TensorRT-LLM and NVIDIA PyTorch, but the deployment task still tries to pull `vllm/vllm-openai:latest`.
- GPU is reported as `NVIDIA GB10`; `nvidia-smi` returns `N/A` for total/used/free memory, so safe memory gating cannot rely on `nvidia-smi`.
- To avoid OOM, tests were run one model at a time. Large models such as `qwen36-35b-a3b` and `omnicoder-9b` were not weight-loaded.

## Executive Summary

No model should currently be marked as fully production-publishable through the existing one-click deployment path.

Main blockers:

- `qwen3-embedding-8b` is missing `model-00001-of-00004.safetensors`.
- `qwen3-reranker-8b` is missing `model-00003-of-00005.safetensors`.
- `mineru2.5-pro-2605-1.2b` has no weight files in its directory.
- `unlimited-ocr` has complete weights, but the generic vLLM image lacks required Python packages: `addict`, `matplotlib`.
- Audio models require FunASR/ModelScope-style serving as custom business runtimes; the default PyTorch runtime should remain a generic environment, not a bundled Whisper-only service.
- The unified API is feasible, but the current gateway only really handles chat and embeddings; rerank, ASR transcription and speaker verification need explicit routing.

## Actual Tests Performed

### Control Plane

- `GET /v1/models` returned only:

```json
{"object":"list","data":[{"id":"whisper-tiny","object":"model","owned_by":"pytorch"}]}
```

This is misleading because the audio service on `32000` is not running. The model list should be based on live runtime health, not only config presence.

- `GET /audio/models` failed with `connect ECONNREFUSED 127.0.0.1:32000`.
- `GET /runtimes` showed `pytorch` configured, `vllm` not_started, `trtllm` not_started.

### qwen3-embedding-8b

Deployment task through management API:

- `POST /deployments/start` created a deploy task.
- Task failed at `pull` because it tried to pull `vllm/vllm-openai:latest` and was interrupted before container start.

Manual low-risk vLLM test:

- Initial attempt with `--task embed` failed because local vLLM `0.23.0` does not support that flag.
- Corrected attempt used:
  - `--runner pooling`
  - `--convert embed`
  - `--max-model-len 2048`
  - `--gpu-memory-utilization 0.12`
  - `--max-num-seqs 1`
- vLLM recognized pooling config and loaded 3 checkpoint shards.
- Engine failed after loading weights because indexed weights were missing. Integrity check confirmed missing shard:
  - `model-00001-of-00004.safetensors`

Conclusion: not deployable until the missing shard is downloaded.

### unlimited-ocr

Manual low-risk vLLM test:

- Started with generic `vllm/vllm-openai:latest`, `--trust-remote-code`, `--max-model-len 2048`, `--gpu-memory-utilization 0.12`, `--max-num-seqs 1`.
- Failed before model load due missing runtime dependencies:
  - `addict`
  - `matplotlib`

Conclusion: weights are complete, but it requires the Unlimited-OCR vLLM image or a custom image with model requirements installed.

### mineru2.5-pro-2605-1.2b

- Disk audit found no weight files.
- `POST /v1/chat/completions` through unified API triggered lazy-load and timed out. Background task failed at `pull`.

Conclusion: not deployable until weights are present. Also should not be lazy-loaded by default without a readiness check.

## Per-Model Result Matrix

| Model | Type | Disk Status | Runtime Target | Test Result | Basic Use |
|---|---|---:|---|---|---|
| `fun-asr-nano-2512` | ASR | Ready | Custom FunASR audio | Not started; default PyTorch environment is not a FunASR server | `POST /v1/audio/transcriptions` via `funasr-server --model fun-asr-nano` |
| `mineru2.5-pro-2605-1.2b` | document VLM | Missing weights | vLLM or transformers + MinerU client | Not deployable | document/image parsing through MinerU client or vLLM engine |
| `omnicoder-9b` | code/chat LLM | Complete single safetensors | vLLM | Not loaded to avoid OOM risk | `POST /v1/chat/completions` |
| `qwen3-embedding-8b` | embedding | Missing 1 shard | vLLM pooling | Failed after weight load | `POST /v1/embeddings` after re-download |
| `qwen3-reranker-8b` | rerank | Missing 1 shard | vLLM rerank | Not loaded; integrity failed | `POST /v1/rerank` with `--hf-overrides` |
| `qwen36-35b-a3b` | MoE chat LLM | Complete 26 shards | vLLM or TensorRT-LLM | Not loaded to avoid OOM risk | `POST /v1/chat/completions` |
| `sensevoicesmall` | ASR/audio understanding | Ready | Custom FunASR audio | Not started; default PyTorch environment is not a SenseVoice server | `POST /v1/audio/transcriptions` via `funasr-server --model sensevoice` |
| `speech_campplus_sv_zh-cn_16k-common` | speaker verification | Ready | ModelScope audio pipeline | Not started; not an ASR transcription model | speaker verification endpoint taking two audio files and `thr` |
| `unlimited-ocr` | OCR VLM | Complete | dedicated vLLM/SGLang/custom image | Failed due missing deps in generic vLLM image | OpenAI-compatible vision request after custom runtime |

## Required Runtime Parameters

### Common vLLM Parameters

These should be shared across LLM/VLM/Embedding/Reranker panels:

- `image`: runtime image tag
- `served_model_name`
- `max_model_len`
- `gpu_memory_utilization`
- `max_num_seqs`
- `tensor_parallel_size`
- `kv_cache_dtype`
- `swap_space`
- `trust_remote_code`
- `enable_prefix_caching`
- `safetensors_load_strategy`
- `cpu_offload_gb`
- `max_num_batched_tokens`

### Chat / Code LLM

Applies to `omnicoder-9b`, `qwen36-35b-a3b`.

User-facing inference parameters:

- `temperature`
- `top_p`
- `top_k`
- `max_tokens`
- `stop`
- `presence_penalty`
- `frequency_penalty`
- `stream`

Deployment parameters:

- `max_model_len`
- `max_num_seqs`
- `gpu_memory_utilization`
- `tensor_parallel_size`
- `kv_cache_dtype`

### Embedding

Applies to `qwen3-embedding-8b` after re-download.

Deployment parameters for current vLLM image:

- `--runner pooling`
- `--convert embed`
- `--max-model-len`
- `--gpu-memory-utilization`
- `--max-num-seqs`

Inference parameters:

- `input`
- `dimensions` if supported by the serving backend
- query instruction / prompt prefix
- normalize embeddings

### Reranker

Applies to `qwen3-reranker-8b` after re-download.

Required deployment details:

- Model path should be nested path `models/qwen3-reranker-8b/models/Qwen3-Reranker-8B`, not the outer wrapper directory.
- Use `--hf-overrides`:

```json
{"architectures":["Qwen3ForSequenceClassification"],"classifier_from_token":["no","yes"],"is_original_qwen3_reranker":true}
```

Expected API:

- `POST /v1/rerank`
- request shape: `model`, `query`, `documents`, optional `top_n`, `return_documents`

### MinerU Document Parsing

Applies to `mineru2.5-pro-2605-1.2b` after weights are present.

Important parameters:

- `image_analysis`
- backend: `transformers`, `vllm-engine`, `vllm-async-engine`
- logits processor for vLLM >= 0.10.1
- output post-processing: JSON to Markdown

### Unlimited-OCR

Requires dedicated runtime. Generic vLLM image is insufficient.

Important parameters:

- runtime image: `vllm/vllm-openai:unlimited-ocr` or equivalent custom image
- `base_size`
- `image_size`
- `crop_mode`
- `max_length`
- `no_repeat_ngram_size`
- `ngram_window`
- `save_results`
- for SGLang: `--enable-custom-logit-processor`, `--mem-fraction-static`, `--context-length`

### FunASR / SenseVoice

Applies to `fun-asr-nano-2512`, `sensevoicesmall`.

Expected API:

- `POST /v1/audio/transcriptions`

Important parameters:

- `language`
- `itn` / `use_itn`
- `batch_size`
- `batch_size_s`
- `hotwords`
- `vad_model`
- `vad_kwargs.max_single_segment_time`
- `merge_vad`
- `merge_length_s`
- `device`

### CAM++ Speaker Verification

Applies to `speech_campplus_sv_zh-cn_16k-common`.

This is not an ASR model. It needs a dedicated verification endpoint.

Expected request:

- audio file A
- audio file B
- optional `thr`

Important parameters:

- `thr`: verification threshold; higher means stricter same-speaker decision
- sample rate: 16 kHz

## Unified API Feasibility

Yes, a unified user-facing API is feasible, and users should not need to access separate model ports.

Recommended public gateway:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/embeddings`
- `POST /v1/rerank`
- `POST /v1/audio/transcriptions`
- `POST /v1/audio/speaker-verifications` as a local extension

The gateway should route by model capability:

| Capability | Public Endpoint | Backend Runtime |
|---|---|---|
| chat/code | `/v1/chat/completions` | vLLM / TensorRT-LLM |
| vision/document OCR | `/v1/chat/completions` with image content, or app-level document endpoint | vLLM / SGLang / custom OCR |
| embedding | `/v1/embeddings` | vLLM pooling or TEI |
| rerank | `/v1/rerank` | vLLM rerank |
| ASR | `/v1/audio/transcriptions` | FunASR audio service |
| speaker verification | `/v1/audio/speaker-verifications` | ModelScope/FunASR audio service |

Current gaps:

- `/v1/models` currently exposes `whisper-tiny` even when audio runtime is not running.
- `/v1/chat/completions` lazy-load can trigger a deployment task without preflight integrity checks.
- No `/v1/rerank` route exists.
- No `/v1/audio/transcriptions` route exists in the unified OpenAI route set.
- Audio proxy exists as `/audio/models`, but the target service is down and the PyTorch deployment template is incomplete.

## Can Parameter整理 Be Automated?

Yes. This should be automated by a local model capability scanner that emits a per-model runtime manifest.

Recommended manifest fields:

- `model_id`
- `model_path`
- `capability`: `chat`, `vision`, `embedding`, `rerank`, `asr`, `speaker_verification`, `ocr_document`
- `download_integrity`: indexed shard check, temp/staging check, missing weights check
- `runtime`: preferred runtime and fallback runtimes
- `deployment_schema`: JSON schema for runtime parameters
- `inference_schema`: JSON schema for user-facing request parameters
- `api_routes`: public gateway routes
- `health_check`: runtime health endpoint
- `risk`: estimated size, memory visibility, OOM caution

The UI should generate parameter panels from this manifest:

- Basic tab: model name, route, start/stop, health, test request
- Runtime tab: image, port, GPU/memory, context, concurrency
- Inference tab: task-specific parameters
- Advanced tab: `hf_overrides`, custom dependencies, custom image, extra CLI args

Specialized panels are necessary. A single generic parameter panel will hide important differences between chat, embedding, rerank, ASR and speaker verification.

## Recommended Fixes

1. Add preflight integrity checks before marking a model ready:
   - validate `model.safetensors.index.json`
   - validate no temp/staging directories
   - validate required weight files are present

2. Stop automatic `docker compose pull` in normal deploy:
   - use local image if present
   - expose "refresh image" as an explicit action
   - otherwise deploy tasks can fail before model testing begins

3. Add runtime-specific vLLM arguments:
   - embedding: `--runner pooling --convert embed`
   - reranker: nested model path plus `--hf-overrides`
   - OCR: custom image/dependencies

4. Fix PyTorch/default-audio separation:
   - keep the default PyTorch service generic and add custom audio compose/profile services
   - replace Whisper-only template with FunASR/SenseVoice/CAM++ capable service
   - add `/v1/audio/transcriptions` and speaker verification route

5. Make lazy-load safe:
   - no lazy-load when integrity is failed
   - no lazy-load for large models unless user explicitly confirms
   - one runtime lock per GPU/runtime slot
   - low-risk defaults when memory is unknown

6. Improve model library status:
   - separate "download task succeeded" from "disk integrity passed"
   - show exact missing shards
   - show "not tested", "started", "health passed", "inference passed"

## Next Safe Test Order

After re-downloading missing shards and adding audio service support:

1. `speech_campplus_sv_zh-cn_16k-common` through a CPU/GPU audio verification service.
2. `sensevoicesmall` through FunASR server.
3. `fun-asr-nano-2512` through FunASR server.
4. `unlimited-ocr` with its dedicated image.
5. `qwen3-embedding-8b` after missing shard is fixed.
6. `qwen3-reranker-8b` after missing shard is fixed.
7. `omnicoder-9b` with low context and one request.
8. `qwen36-35b-a3b` only after reliable memory telemetry or explicit confirmation.
9. `mineru2.5-pro-2605-1.2b` only after weights are present.


## Supplemental Test: Newly Visible Audio Models

Added after the second system scan. The system now lists two additional disk-ready models:

- `speech_campplus_speaker-diarization_common`
- `whisper-large-v3`

Observed status:

- `speech_campplus_speaker-diarization_common`: ready, audio_onnx, 4 weight files, no incomplete files.
- `whisper-large-v3`: ready, audio_pt, 1 weight file, no incomplete files.

Deployment plan checks:

- Both models currently map to the generic `pytorch` runtime in compatibility data, but should ultimately use custom audio profiles.
- The default `pytorch-service` uses port `32000` only as a generic PyTorch environment.
- Current generated command still uses `docker compose -f deploy/compose/docker-compose.yml pull pytorch-service` and `up -d pytorch-service`.
- The main compose file does not define `pytorch-service`, so these plans are not runnable as-is.

Runtime probe:

- `GET /audio/models` returns `connect ECONNREFUSED 127.0.0.1:32000`.
- `GET /v1/models` still returns a synthetic `whisper-tiny` entry even though the audio runtime is unavailable.

Basic usage and parameters:

- `whisper-large-v3`: ASR model. Expected unified route: `POST /v1/audio/transcriptions`. Useful parameters: `language`, `fs` for PCM sample rate, `output_dir`, `vad_model`, `punc_model`, `spk_model`, `batch_size_s`, `hotword`, `beam_size`, `lm_model`, `lm_weight`.
- `speech_campplus_speaker-diarization_common`: speaker diarization model. Expected local extension route: `POST /v1/audio/diarizations`. Useful parameters: input audio file or URL, optional `oracle_num` for known speaker count, and JSON speaker time-segment output.

Conclusion:

- These two models are now correctly visible and disk-ready.
- They should not be treated as deployable through the default generic PyTorch route.
- They should be handled by a real custom audio service adapter, not by vLLM/TensorRT-LLM or the default PyTorch environment.
- The unified API remains feasible if the gateway adds `/v1/audio/transcriptions` for Whisper ASR and `/v1/audio/diarizations` for diarization.
