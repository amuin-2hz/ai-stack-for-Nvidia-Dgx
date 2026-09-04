#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

const extensions = [
  {
    id: "funasr-gateway",
    category: "shared",
    title: "FunASR Gateway",
    title_zh: "FunASR 语音网关",
    description: "Single runtime profile for FunASR ASR, VAD, punctuation, and speaker diarization.",
    description_zh: "一个运行时包含 FunASR 语音识别、VAD、标点和说话人分离。",
    suitable_models: [
      "sensevoicesmall",
      "speech_fsmn_vad_zh-cn-16k-common-pytorch",
      "speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
      "punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
      "speech_campplus_sv_zh-cn_16k-common",
      "speech_campplus_speaker-diarization_common"
    ],
    files: [
      "deploy/dockerfiles/custom/funasr-gateway.Dockerfile",
      "deploy/templates/ai_stack_funasr_gateway.py"
    ]
  },
  {
    id: "vibevoice-hf",
    category: "shared",
    title: "VibeVoice HF",
    title_zh: "VibeVoice HF",
    description: "Single runtime profile for the local VibeVoice Hugging Face adapter.",
    description_zh: "本地 VibeVoice Hugging Face 适配服务运行时。",
    suitable_models: ["vibevoice", "vibevoice-asr-hf"],
    files: [
      "deploy/dockerfiles/custom/vibevoice-hf.Dockerfile",
      "deploy/templates/ai_stack_vibevoice_hf_server.py"
    ]
  },
  {
    id: "qwen3-tts",
    category: "shared",
    title: "Qwen3-TTS",
    title_zh: "Qwen3-TTS 专用语音合成",
    description: "AI Stack-managed Qwen3-TTS service for preset voices, voice design, and voice cloning.",
    description_zh: "由 AI Stack 统一托管 Qwen3-TTS 预置音色、音色设计和参考音频克隆能力。",
    suitable_models: [
      "qwen3-tts-12hz-1.7b-customvoice",
      "qwen3-tts-12hz-1.7b-voicedesign",
      "qwen3-tts-12hz-1.7b-base"
    ],
    files: [
      "deploy/dockerfiles/custom/qwen3-tts.Dockerfile",
      "deploy/templates/ai_stack_qwen3_tts_server.py",
      "ops/scripts/smoke-test-qwen3-tts.sh"
    ]
  },
  {
    id: "vllm-embedding",
    category: "dedicated",
    title: "vLLM Embedding",
    title_zh: "vLLM 向量",
    description: "Qwen3 embedding service with vLLM pooling runner.",
    description_zh: "使用 vLLM pooling runner 发布 Qwen3 向量模型。",
    suitable_models: ["qwen3-embedding-8b"],
    files: ["deploy/dockerfiles/custom/vllm-embedding.Dockerfile"]
  },
  {
    id: "vllm-reranker",
    category: "dedicated",
    title: "vLLM Reranker",
    title_zh: "vLLM 重排",
    description: "Qwen3 reranker service with sequence-classification overrides.",
    description_zh: "使用 sequence-classification overrides 发布 Qwen3 重排模型。",
    suitable_models: ["qwen3-reranker-8b"],
    files: [
      "deploy/dockerfiles/custom/vllm-reranker.Dockerfile",
      "deploy/templates/qwen3_reranker_score.jinja"
    ]
  },
  {
    id: "ocr-unlimited",
    category: "dedicated",
    title: "Unlimited-OCR",
    title_zh: "Unlimited-OCR",
    description: "OCR service profile for a purpose-built image with OCR dependencies.",
    description_zh: "面向专用 OCR 镜像和依赖的文档识别服务。",
    suitable_models: ["unlimited-ocr"],
    files: [
      "deploy/dockerfiles/custom/ocr-unlimited.Dockerfile",
      "deploy/templates/ai_stack_ocr_server.py"
    ]
  },
  {
    id: "mineru",
    category: "dedicated",
    title: "MinerU Document Parse",
    title_zh: "MinerU 文档解析",
    description: "Validated MinerU2.5-Pro image and PDF parsing service.",
    description_zh: "已验证的 MinerU2.5-Pro 图片和 PDF 文档解析服务。",
    suitable_models: ["mineru2.5-pro-2605-1.2b"],
    files: [
      "deploy/dockerfiles/custom/mineru.Dockerfile",
      "deploy/templates/ai_stack_document_server.py"
    ]
  },
  {
    id: "locate-anything",
    category: "dedicated",
    title: "LocateAnything Visual Grounding",
    title_zh: "LocateAnything 视觉定位",
    description: "NVIDIA LocateAnything image grounding and object-location service.",
    description_zh: "NVIDIA LocateAnything 图片目标检测与视觉定位服务。",
    suitable_models: ["locateanything-3b"],
    files: [
      "deploy/dockerfiles/custom/locate-anything.Dockerfile",
      "deploy/templates/decord.py",
      "deploy/templates/ai_stack_locate_server.py"
    ]
  }
];

function readSource(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error("Missing runtime extension source: " + relativePath);
  return fs.readFileSync(absolutePath, "utf8");
}

function writeRuntimeExtensions(outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const written = [];
  for (const extension of extensions) {
    const composePath = "deploy/compose/custom/docker-compose." + extension.id + ".yml";
    const document = {
      format: "ai-stack-runtime/v1",
      manifest: {
        id: extension.id,
        category: extension.category,
        title: extension.title,
        title_zh: extension.title_zh,
        description: extension.description,
        description_zh: extension.description_zh,
        suitable_models: extension.suitable_models
      },
      compose: readSource(composePath),
      files: extension.files.map((file) => ({ path: file, content: readSource(file) }))
    };
    const filename = extension.id + ".aistack-runtime.json";
    const outputPath = path.join(outputDir, filename);
    fs.writeFileSync(outputPath, JSON.stringify(document, null, 2) + "\n");
    written.push({
      id: extension.id,
      category: extension.category,
      filename,
      title_zh: extension.title_zh,
      files: 1 + extension.files.length
    });
  }
  return written;
}

if (require.main === module) {
  const outputDir = path.resolve(process.argv[2] || path.join(repoRoot, "dist-runtime-extensions"));
  fs.rmSync(outputDir, { recursive: true, force: true });
  const written = writeRuntimeExtensions(outputDir);
  console.log("Created " + written.length + " runtime extension packages in " + outputDir);
}

module.exports = { extensions, writeRuntimeExtensions };
