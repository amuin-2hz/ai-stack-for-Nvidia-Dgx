# AMUIN AI STACK

English | [简体中文](README.zh-CN.md)

AMUIN AI STACK is a local model operations platform for NVIDIA GPU workstations and DGX Spark. It brings model acquisition, compatibility checks, publishing, API testing, runtime monitoring, and maintenance into one desktop and web console.

Version `1.1.1` focuses on practical single-machine deployment: OpenAI-compatible inference endpoints, dedicated audio and document runtimes, configurable vLLM tool calling, and native ARM64 installation packages.

## Highlights

- Import and download models from Hugging Face or ModelScope.
- Audit model files and recommend compatible runtimes before publishing.
- Publish with vLLM, TensorRT-LLM, PyTorch, or dedicated Compose runtimes.
- Monitor GPUs, containers, tasks, health checks, ports, and logs.
- Test chat, embeddings, reranking, speech, OCR, and document models from the UI.
- Use OpenAI-compatible chat, embeddings, and audio transcription APIs.
- Enable or disable vLLM tool calling during model publishing and select a parser.
- Operate through the Electron desktop application or the LAN-accessible bilingual web console.

## Runtime coverage

General model runtimes include vLLM, TensorRT-LLM, and PyTorch. Dedicated profiles are provided for:

- FunASR with four selectable ASR pipelines
- Qwen3-TTS and VibeVoice
- vLLM Embedding and Reranker
- Unlimited-OCR, MinerU, and LocateAnything

## Verified in v1.1.1

The current release was validated on an NVIDIA GB10 ARM64 host:

- API test suite: **80/80 passed**
- Frontend, API, and desktop builds passed
- Web console available on the LAN through port `8888`
- Qwen3.8 returned structured `tool_calls` with `finish_reason: "tool_calls"`
- The model publishing form correctly enables/disables vLLM tool-call launch flags
- All four ASR pipelines returned HTTP 200 through the OpenAI transcription endpoint
- ARM64 DEB and aarch64 RPM packages passed checksum and package-integrity verification

## Install on ARM64 Linux

Download the DEB or RPM from the repository release page.

```bash
# Debian / Ubuntu
sudo apt install ./amuin-ai-stack_1.1.1_arm64.deb

# Fedora / RHEL compatible distributions
sudo dnf install ./amuin-ai-stack-1.1.1-1.aarch64.rpm
```

The RPM installs a systemd service. Its environment can be adjusted in `/etc/sysconfig/amuin-ai-stack`. The default web port is `8888`; the control-plane API uses port `8000`.

## OpenAI-compatible ASR

FunASR exposes the standard transcription route:

```text
POST http://<server-ip>:8011/v1/audio/transcriptions
```

Select one of four pipelines through the `model` form field:

| Model value | Intended use |
|---|---|
| `pipeline:general` | General speech recognition |
| `pipeline:accurate-zh` | Higher-accuracy Chinese recognition |
| `pipeline:domain-zh` | Chinese domain vocabulary with n-gram support |
| `pipeline:meeting` | Meeting and multi-speaker audio |

```bash
curl --noproxy "*" --http1.1 -H "Expect:" \
  --max-time 300 \
  "http://<server-ip>:8011/v1/audio/transcriptions" \
  -F "file=@/absolute/path/test.wav" \
  -F "model=pipeline:general" \
  -F "language=zh" \
  -F "response_format=json"
```

The response is a normal JSON object such as `{"text":"..."}`; this endpoint is not a streaming endpoint.

## vLLM tool calling

When publishing a compatible Qwen model, enable **Tool Call**, choose the parser (for example `qwen3_coder`), and publish the model. AMUIN AI STACK adds the matching vLLM launch arguments and exposes structured tool calls through `/v1/chat/completions`. Disable the switch to launch the model without tool-call flags.

## Typical workflow

1. Configure model storage and network settings.
2. Import or download a model.
3. Review the compatibility audit and runtime recommendation.
4. Publish the model with the required runtime options.
5. Test the API in the playground or with an OpenAI-compatible client.
6. Monitor health, GPU usage, logs, and background tasks.

## Requirements

- Linux on ARM64 for the packaged `v1.1.1` release
- NVIDIA GPU and a working NVIDIA Container Toolkit for GPU runtimes
- Docker with Compose support
- Node.js 20 or newer for source development

## Development

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm test
npm run build
```

The main components are under `apps/frontend`, `apps/api`, and `apps/main`; runtime definitions are under `deploy` and `configs`; packaging scripts are under `scripts` and `packaging`.

## Project scope

AMUIN AI STACK currently targets a trusted, single-host Linux environment. It is not yet a multi-tenant cluster scheduler. Review network exposure, credentials, model licenses, and runtime security before production use.

## License

See [LICENSE](LICENSE).
