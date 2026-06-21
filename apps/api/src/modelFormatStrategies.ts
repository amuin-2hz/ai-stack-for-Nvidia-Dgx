/**
 * Data-driven model format detection and compatibility strategies.
 * Replaces deeply nested if/else chains in modelRegistry.ts.
 */

import type { CompatibilityInfo, ServiceType } from "./types.js";

/* ── format detector interface ─────────────────── */
export interface FormatStrategy {
  name: string;
  /** Returns true if this strategy matches the files/path/config */
  matches(params: FormatMatchParams): boolean;
  /** Runtime preference */
  runtime: { preferred: string; supported: string[] };
  /** Compatibility map for all service types */
  compatibility: Record<string, CompatibilityInfo>;
}

export interface FormatMatchParams {
  path: string;
  isFile: boolean;
  files: string[];
  names: Set<string>;
  configs: string[];
  config: Record<string, unknown>;
}

/* ── audio detection helper ────────────────────── */
function looksLikeAudio(path: string, names: Set<string>): boolean {
  const lower = path.toLowerCase().replace(/[/\\]/g, "").split("/").pop() ?? "";
  return ["whisper", "fun-asr", "funasr", "cosyvoice"].some((token) => lower.includes(token)) ||
    ["cosyvoice.yaml", "vocabulary.txt", "spk2info.pt", "flow.pt", "hift.pt", "multilingual.tiktoken"].some((name) => names.has(name));
}

/* ── capability detection helper ───────────────── */
function audioCapabilities(path: string, names: Set<string>, config: Record<string, unknown>): string[] {
  if (!looksLikeAudio(path, names)) return [];
  const lower = path.toLowerCase();
  const architectures = Array.isArray(config.architectures) ? config.architectures.map(String).join(" ").toLowerCase() : "";
  const modelType = String(config.model_type ?? "").toLowerCase();
  if (lower.includes("cosyvoice") || lower.includes("tts") || lower.includes("vits") ||
      architectures.includes("cosyvoice") || modelType.includes("cosyvoice")) return ["tts"];
  return ["asr"];
}

/* ── strategy implementations ──────────────────── */
export const formatStrategies: FormatStrategy[] = [
  {
    name: "gguf",
    matches: ({ isFile, files }) => isFile && files.length === 1 && files[0]?.endsWith?.(".gguf") || files.some((f) => f.endsWith(".gguf")),
    runtime: { preferred: "lmstudio", supported: ["lmstudio"] },
    compatibility: {
      vllm: { status: "unsupported", reason: "GGUF is a llama.cpp/LM Studio format and is not published by this workbench." },
      trtllm: { status: "unsupported", reason: "TensorRT-LLM needs a checkpoint or converted engine, not GGUF." },
      pytorch: { status: "unsupported", reason: "GGUF is not an ASR/TTS model directory." },
      lmstudio: { status: "compatible", reason: "GGUF is best managed by LM Studio or llama.cpp." }
    }
  },
  {
    name: "trtllm_engine",
    matches: ({ files }) => files.some((f) => f.endsWith(".engine")),
    runtime: { preferred: "trtllm", supported: ["trtllm"] },
    compatibility: {
      vllm: { status: "unsupported", reason: "TensorRT-LLM engines cannot be loaded by vLLM." },
      trtllm: { status: "compatible", reason: "Converted engine layout is intended for TensorRT-LLM." },
      pytorch: { status: "unsupported", reason: "Engine is not an ASR/TTS model directory." },
      lmstudio: { status: "unsupported", reason: "Engine is not a GGUF file." }
    }
  },
  {
    name: "audio",
    matches: ({ path, names }) => looksLikeAudio(path, names),
    runtime: { preferred: "pytorch", supported: ["pytorch"] },
    compatibility: {
      vllm: { status: "unsupported", reason: "Audio models use ASR/TTS-specific files and are not vLLM checkpoints." },
      trtllm: { status: "unsupported", reason: "Audio models use the PyTorch runtime, not TensorRT-LLM." },
      pytorch: { status: "compatible", reason: "Directory matches the local ASR/TTS service model layout." },
      lmstudio: { status: "unsupported", reason: "Audio service directories are not GGUF files." }
    }
  },
  {
    name: "hf_safetensors",
    matches: ({ files }) => files.some((f) => f.endsWith(".safetensors")),
    runtime: { preferred: "vllm", supported: ["vllm", "trtllm"] },
    compatibility: {
      vllm: { status: "compatible", reason: "HF snapshot with safetensors weights; config/tokenizer files are present." },
      trtllm: { status: "possible", reason: "May work after TensorRT-LLM version validation or engine conversion on the current NVIDIA platform." },
      pytorch: { status: "unsupported", reason: "Text or multimodal checkpoint is not an ASR/TTS model directory." },
      lmstudio: { status: "unsupported", reason: "HF checkpoints are not GGUF files." }
    }
  },
  {
    name: "hf_bin",
    matches: ({ files, configs }) => files.some((f) => f.endsWith(".bin")) && configs.length > 0,
    runtime: { preferred: "vllm", supported: ["vllm", "trtllm"] },
    compatibility: {
      vllm: { status: "compatible", reason: "HF snapshot with bin weights; config/tokenizer files are present." },
      trtllm: { status: "possible", reason: "May work after TensorRT-LLM version validation or engine conversion on the current NVIDIA platform." },
      pytorch: { status: "unsupported", reason: "Text or multimodal checkpoint is not an ASR/TTS model directory." },
      lmstudio: { status: "unsupported", reason: "HF checkpoints are not GGUF files." }
    }
  },
  {
    name: "hf_partial",
    matches: ({ configs }) => configs.includes("config.json"),
    runtime: { preferred: "vllm", supported: ["vllm", "trtllm"] },
    compatibility: {
      vllm: { status: "compatible", reason: "HF snapshot with partial weights; config/tokenizer files are present." },
      trtllm: { status: "possible", reason: "May work after TensorRT-LLM version validation or engine conversion on the current NVIDIA platform." },
      pytorch: { status: "unsupported", reason: "Text or multimodal checkpoint is not an ASR/TTS model directory." },
      lmstudio: { status: "unsupported", reason: "HF checkpoints are not GGUF files." }
    }
  }
];

/* ── default/fallback strategy ─────────────────── */
export const defaultStrategy: FormatStrategy = {
  name: "unknown",
  matches: () => true,
  runtime: { preferred: "manual_review", supported: [] },
  compatibility: {
    vllm: { status: "possible", reason: "Unrecognized layout; inspect config and weights before deployment." },
    trtllm: { status: "possible", reason: "Manual validation is required before TensorRT-LLM deployment." },
    pytorch: { status: "unsupported", reason: "No ASR/TTS model markers were found." },
    lmstudio: { status: "unsupported", reason: "No GGUF file was found." }
  }
};

/* ── match-first dispatch ──────────────────────── */
export function resolveStrategy(params: FormatMatchParams): FormatStrategy {
  return formatStrategies.find((s) => s.matches(params)) ?? defaultStrategy;
}

/* ── capability detection ──────────────────────── */
export function detectCapabilities(params: FormatMatchParams): string[] {
  const { path, config, names } = params;

  // Audio first (most specific)
  const audioCaps = audioCapabilities(path, names, config);
  if (audioCaps.length) return audioCaps;

  const lower = path.toLowerCase();
  const architectures = Array.isArray(config.architectures) ? config.architectures.map(String).join(" ").toLowerCase() : "";
  const modelType = String(config.model_type ?? "").toLowerCase();

  // Embedding models
  if (lower.includes("embed") || architectures.includes("embedding") ||
      (modelType.includes("bert") && !architectures.includes("causallm"))) return ["embeddings"];

  // Vision/multimodal
  if (["vl", "vision", "multimodal", "qwen2_5_vl", "llava"].some(
    (t) => lower.includes(t) || modelType.includes(t) || architectures.includes(t)
  )) return ["chat", "vision"];

  // Text generation
  if (architectures.includes("causallm") || modelType ||
      architectures.includes("llama") || architectures.includes("gpt") ||
      architectures.includes("qwen") || architectures.includes("mistral") ||
      architectures.includes("chatglm") || architectures.includes("baichuan")) return ["chat"];

  return ["unknown"];
}

/* ── map capabilities to compatibility ─────────── */
export function compatibilityForModel(format: string, capabilities: string[], configs: string[]): Record<string, CompatibilityInfo> {
  // For audio models detected via capabilities
  if (capabilities.some((cap) => ["asr", "tts"].includes(cap))) {
    return {
      vllm: { status: "unsupported", reason: "Audio models use ASR/TTS-specific files and are not vLLM checkpoints." },
      trtllm: { status: "unsupported", reason: "Audio models use the PyTorch runtime, not TensorRT-LLM." },
      pytorch: { status: "compatible", reason: "Directory matches the local ASR/TTS service model layout." },
      lmstudio: { status: "unsupported", reason: "Audio service directories are not GGUF files." }
    };
  }

  // HF checkpoints
  if (["hf_safetensors", "hf_bin", "hf_partial"].includes(format)) {
    const configHint = configs.length ? "config/tokenizer files are present" : "config/tokenizer files need review";
    return {
      vllm: { status: "compatible", reason: `HF snapshot with ${format.replace("_", " ")} weights; ${configHint}.` },
      trtllm: { status: "possible", reason: "May work after TensorRT-LLM version validation or engine conversion on the current NVIDIA platform." },
      pytorch: { status: "unsupported", reason: "Text or multimodal checkpoint is not an ASR/TTS model directory." },
      lmstudio: { status: "unsupported", reason: "HF checkpoints are not GGUF files." }
    };
  }

  // Unknown
  return {
    vllm: { status: "possible", reason: "Unrecognized layout; inspect config and weights before deployment." },
    trtllm: { status: "possible", reason: "Manual validation is required before TensorRT-LLM deployment." },
    pytorch: { status: "unsupported", reason: "No ASR/TTS model markers were found." },
    lmstudio: { status: "unsupported", reason: "No GGUF file was found." }
  };
}
