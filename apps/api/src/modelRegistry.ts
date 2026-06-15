import { access, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { isWeightFile, safeSize, slugify } from "./utils.js";
import type { CompatibilityInfo, DeploymentRecord, ModelRecord, ServiceType } from "./types.js";

const configNames = new Set(["config.json", "tokenizer.json", "tokenizer_config.json", "configuration.json", "config.yaml", "cosyvoice.yaml"]);

export const servicePorts = {
  vllm: Number(process.env.VLLM_PUBLIC_PORT ?? "30000"),
  trtllm: Number(process.env.TRTLLM_PUBLIC_PORT ?? "31000"),
  audio: Number(process.env.AUDIO_PUBLIC_PORT ?? "32000")
};

export async function listModels(modelsRoot: string): Promise<ModelRecord[]> {
  try {
    await access(modelsRoot);
  } catch {
    return [];
  }
  const entries = await readdir(modelsRoot, { withFileTypes: true });
  const records: ModelRecord[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const path = join(modelsRoot, entry.name);
    if (entry.isDirectory() || (entry.isFile() && isWeightFile(path))) {
      records.push(await auditModelPath(path));
    }
  }
  return records;
}

export async function getModel(modelsRoot: string, modelId: string): Promise<ModelRecord | undefined> {
  return (await listModels(modelsRoot)).find((model) => model.id === modelId);
}

export async function deleteModel(modelsRoot: string, modelId: string): Promise<{ model_id: string; deleted_path: string }> {
  const model = await getModel(modelsRoot, modelId);
  if (!model) throw new Error("Unknown model: " + modelId);
  const root = resolve(modelsRoot);
  const target = resolve(model.local.path);
  if (target !== root && !target.startsWith(root + "/")) {
    throw new Error("Refusing to delete a path outside models root.");
  }
  await rm(target, { recursive: true, force: true });
  return { model_id: modelId, deleted_path: target };
}

export async function listDeployments(modelsRoot: string): Promise<DeploymentRecord[]> {
  const audioModels = (await listModels(modelsRoot))
    .filter((model) => model.capabilities.includes("asr") || model.capabilities.includes("tts"))
    .map((model) => model.id);
  return [
    {
      deployment_id: "svc_audio",
      model_id: null,
      status: "configured",
      service_type: "audio",
      runtime: "audio-service",
      container_name: "audio-service",
      public_port: servicePorts.audio,
      base_url: `http://localhost:${servicePorts.audio}`,
      health_url: `http://localhost:${servicePorts.audio}/healthz`,
      worker_endpoint: null,
      openai_models: audioModels,
      warnings: []
    },
    {
      deployment_id: "svc_vllm",
      model_id: null,
      status: "not_started",
      service_type: "vllm",
      runtime: "vllm",
      container_name: "vllm-service",
      public_port: servicePorts.vllm,
      base_url: `http://localhost:${servicePorts.vllm}/v1`,
      health_url: `http://localhost:${servicePorts.vllm}/health`,
      worker_endpoint: null,
      openai_models: [],
      warnings: ["vLLM runtime is idle by default; AMUIN /v1 requests can load a compatible local model on demand."]
    },
    {
      deployment_id: "svc_trtllm",
      model_id: null,
      status: "not_started",
      service_type: "trtllm",
      runtime: "TensorRT-LLM",
      container_name: "trtllm-service",
      public_port: servicePorts.trtllm,
      base_url: `http://localhost:${servicePorts.trtllm}/v1`,
      health_url: `http://localhost:${servicePorts.trtllm}/health`,
      worker_endpoint: null,
      openai_models: [],
      warnings: ["TensorRT-LLM remains an advanced route until a validated profile is selected."]
    }
  ];
}

export function compatibilityFor(model: ModelRecord, serviceType: ServiceType): CompatibilityInfo {
  return model.compatibility[serviceType] ?? { status: "unsupported", reason: `Unknown service type: ${serviceType}.` };
}

export function parseModelSource(url: string, alias?: string, provider = "auto"): Record<string, string | null> {
  const parsed = parseUrl(url);
  let inferredProvider = provider;
  let repoId: string | null = null;

  if (provider === "auto") {
    if (parsed.hostname === "modelscope.cn") inferredProvider = "modelscope";
    else if (parsed.hostname === "huggingface.co" || parsed.protocol === "hf:") inferredProvider = "huggingface";
    else inferredProvider = url.includes("/") ? "huggingface" : "unknown";
  }

  if (inferredProvider === "modelscope") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    const cleaned = parts[0] === "models" ? parts.slice(1) : parts;
    repoId = cleaned.slice(0, 2).join("/") || null;
  } else if (inferredProvider === "huggingface") {
    const parts = parsed.protocol === "hf:" ? `${parsed.hostname}${parsed.pathname}`.split("/").filter(Boolean) : parsed.pathname.split("/").filter(Boolean);
    repoId = parts.slice(0, 2).join("/") || (url.includes("/") ? url.replace(/^https?:\/\/huggingface\.co\//, "") : null);
  }

  const suggestedAlias = alias || slugify((repoId || url).split("/").pop() || "model");
  return {
    provider: inferredProvider,
    repo_id: repoId,
    alias: suggestedAlias,
    target_path: `models/${suggestedAlias}`,
    original_url: url
  };
}

async function auditModelPath(path: string): Promise<ModelRecord> {
  const rootStat = await stat(path);
  const files = rootStat.isFile() ? [path] : await walkFiles(path);
  const names = new Set(files.map((file) => basename(file)));
  const weightFiles = files.filter(isWeightFile);
  const incompleteFiles = files.filter((file) => basename(file).includes(".incomplete"));
  const configs = [...names].filter((name) => configNames.has(name)).sort();
  const config = rootStat.isDirectory() ? await readJson(join(path, "config.json")) : {};
  const tokenizerConfig = rootStat.isDirectory() ? await readJson(join(path, "tokenizer_config.json")) : {};
  const inference = inferInferenceLimits(config, tokenizerConfig);
  const [layout, format] = detectLayoutFormat(path, rootStat.isFile(), files, configs);
  const capabilities = detectCapabilities(path, config, names);
  const runtime = runtimeFor(format, capabilities);
  const compatibility = compatibilityMap(format, layout, capabilities, configs);

  const download = downloadStatusFor(format, weightFiles.length, configs, incompleteFiles.length);

  const sizeBytes = (await Promise.all(files.map(safeSize))).reduce((sum, size) => sum + size, 0);
  const basePath = rootStat.isDirectory() ? path : join(path, "..");

  return {
    id: slugify(rootStat.isFile() ? basename(path, extname(path)) : basename(path)),
    display_name: rootStat.isFile() ? basename(path, extname(path)) : basename(path),
    source: { provider: "local", repo_id: null, original_url: null },
    local: {
      path,
      layout,
      format,
      size_bytes: sizeBytes,
      file_count: files.length,
      weight_files: weightFiles.length,
      config_files: configs,
      incomplete_files: incompleteFiles.slice(0, 20).map((file) => relative(basePath, file))
    },
    capabilities,
    runtime,
    inference,
    compatibility,
    status: { download, deploy: "stopped", health: "unknown" },
    serving: { service_type: null, public_base_url: null, worker_endpoint: null, openai_model: null }
  };
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function detectLayoutFormat(path: string, isFile: boolean, files: string[], configs: string[]): [string, string] {
  if (isFile && extname(path) === ".gguf") return ["single_file", "gguf"];
  if (files.some((file) => extname(file) === ".gguf")) return ["gguf_bundle", "gguf"];
  if (files.some((file) => extname(file) === ".engine")) return ["trtllm_engine", "trtllm_engine"];
  if (looksLikeAudio(path, new Set(files.map((file) => basename(file))))) return ["audio_model_directory", "audio_directory"];
  if (files.some((file) => extname(file) === ".safetensors")) return ["hf_snapshot", "hf_safetensors"];
  if (configs.includes("config.json") && files.some((file) => extname(file) === ".bin")) return ["hf_snapshot", "hf_bin"];
  return [isFile ? "single_file" : "directory", "unknown"];
}

function detectCapabilities(path: string, config: Record<string, unknown>, names: Set<string>): string[] {
  const lower = basename(path).toLowerCase();
  const architectures = Array.isArray(config.architectures) ? config.architectures.map(String).join(" ").toLowerCase() : "";
  const modelType = String(config.model_type ?? "").toLowerCase();
  if (looksLikeAudio(path, names)) return lower.includes("cosyvoice") || lower.includes("tts") ? ["tts"] : ["asr"];
  if (lower.includes("embed") || architectures.includes("embedding")) return ["embeddings"];
  if (["vl", "vision", "multimodal", "qwen2_5_vl"].some((token) => lower.includes(token) || modelType.includes(token) || architectures.includes(token))) return ["chat", "vision"];
  if (architectures.includes("causallm") || modelType) return ["chat"];
  return ["unknown"];
}

function downloadStatusFor(format: string, weightFileCount: number, configs: string[], incompleteFileCount: number): string {
  if (incompleteFileCount > 0) return "incomplete";
  if (format === "gguf") return "unsupported";
  if (format === "trtllm_engine") return weightFileCount > 0 ? "ready" : "needs_review";
  if (format === "audio_directory") return weightFileCount > 0 ? "ready" : "needs_review";
  if (["hf_safetensors", "hf_bin"].includes(format)) return weightFileCount > 0 && configs.includes("config.json") ? "ready" : "needs_review";
  return "needs_review";
}

function inferInferenceLimits(config: Record<string, unknown>, tokenizerConfig: Record<string, unknown>) {
  const candidates: Array<[string, unknown]> = [
    ["config.max_position_embeddings", config.max_position_embeddings],
    ["config.model_max_length", config.model_max_length],
    ["config.seq_length", config.seq_length],
    ["config.n_positions", config.n_positions],
    ["config.n_ctx", config.n_ctx],
    ["config.max_sequence_length", config.max_sequence_length],
    ["config.max_seq_len", config.max_seq_len],
    ["tokenizer_config.model_max_length", tokenizerConfig.model_max_length],
    ["tokenizer_config.max_len", tokenizerConfig.max_len]
  ];
  const found = candidates
    .map(([source, value]) => ({ source, value: Number(value) }))
    .find((item) => Number.isFinite(item.value) && item.value > 0 && item.value < 10_000_000);
  const max = Math.max(512, Math.floor(found?.value ?? 4096));
  const step = max >= 8192 ? 1024 : 512;
  return {
    context_length: {
      min: 512,
      max,
      default: Math.min(max, 4096),
      step,
      source: found?.source ?? "default"
    }
  };
}

function runtimeFor(format: string, capabilities: string[]): { preferred: string; supported: string[] } {
  if (format === "gguf") return { preferred: "lmstudio", supported: ["lmstudio"] };
  if (format === "trtllm_engine") return { preferred: "trtllm", supported: ["trtllm"] };
  if (format === "audio_directory" || capabilities.some((cap) => ["asr", "tts"].includes(cap))) return { preferred: "audio", supported: ["audio"] };
  if (["hf_safetensors", "hf_bin"].includes(format)) return { preferred: "vllm", supported: ["vllm", "trtllm"] };
  return { preferred: "manual_review", supported: [] };
}

function compatibilityMap(format: string, layout: string, capabilities: string[], configs: string[]): Record<string, CompatibilityInfo> {
  if (format === "gguf") {
    return {
      vllm: { status: "unsupported", reason: "GGUF is a llama.cpp/LM Studio format and is not published by this workbench." },
      trtllm: { status: "unsupported", reason: "TensorRT-LLM needs a checkpoint or converted engine, not GGUF." },
      audio: { status: "unsupported", reason: "GGUF is not an ASR/TTS model directory." },
      lmstudio: { status: "compatible", reason: "GGUF is best managed by LM Studio or llama.cpp." }
    };
  }
  if (format === "audio_directory" || capabilities.some((cap) => ["asr", "tts"].includes(cap))) {
    return {
      vllm: { status: "unsupported", reason: "Audio models use ASR/TTS-specific files and are not vLLM checkpoints." },
      trtllm: { status: "unsupported", reason: "Audio models are served by the dedicated audio service." },
      audio: { status: "compatible", reason: "Directory matches the local ASR/TTS service model layout." },
      lmstudio: { status: "unsupported", reason: "Audio service directories are not GGUF files." }
    };
  }
  if (format === "trtllm_engine") {
    return {
      vllm: { status: "unsupported", reason: "TensorRT-LLM engines cannot be loaded by vLLM." },
      trtllm: { status: "compatible", reason: "Converted engine layout is intended for TensorRT-LLM." },
      audio: { status: "unsupported", reason: "Engine is not an ASR/TTS model directory." },
      lmstudio: { status: "unsupported", reason: "Engine is not a GGUF file." }
    };
  }
  if (["hf_safetensors", "hf_bin"].includes(format)) {
    const configHint = configs.length ? "config/tokenizer files are present" : "config/tokenizer files need review";
    return {
      vllm: { status: "compatible", reason: `HF snapshot with ${format.replace("_", " ")} weights; ${configHint}.` },
      trtllm: { status: "possible", reason: "May work after TensorRT-LLM version validation or engine conversion on the current NVIDIA platform." },
      audio: { status: "unsupported", reason: "Text or multimodal checkpoint is not an ASR/TTS model directory." },
      lmstudio: { status: "unsupported", reason: "HF checkpoints are not GGUF files." }
    };
  }
  return {
    vllm: { status: "possible", reason: `Unrecognized ${layout} layout; inspect config and weights before deployment.` },
    trtllm: { status: "possible", reason: "Manual validation is required before TensorRT-LLM deployment." },
    audio: { status: "unsupported", reason: "No ASR/TTS model markers were found." },
    lmstudio: { status: "unsupported", reason: "No GGUF file was found." }
  };
}

function looksLikeAudio(path: string, names: Set<string>): boolean {
  const lower = basename(path).toLowerCase();
  return ["whisper", "fun-asr", "funasr", "cosyvoice"].some((token) => lower.includes(token)) ||
    ["cosyvoice.yaml", "vocabulary.txt", "spk2info.pt", "flow.pt", "hift.pt", "multilingual.tiktoken"].some((name) => names.has(name));
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseUrl(value: string): URL {
  try {
    return new URL(value.includes("://") ? value : `hf://${value}`);
  } catch {
    return new URL(`hf://${value}`);
  }
}

