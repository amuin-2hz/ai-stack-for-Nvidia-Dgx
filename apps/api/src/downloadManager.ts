import { join } from "node:path";
import { parseModelSource } from "./modelRegistry.js";
import { createTask, runManagedCommand } from "./taskRunner.js";
import { shellQuote } from "./utils.js";
import { createTask as persistTask } from "./store.js";

export interface ImportRequest {
  url: string;
  alias?: string;
  provider?: string;
  expected_runtime?: string;
}

export function createDownloadPlan(request: ImportRequest, baseDir: string) {
  const model = parseModelSource(request.url, request.alias, request.provider ?? "auto");
  const provider = String(model.provider ?? "unknown");
  const repoId = String(model.repo_id ?? "");
  const alias = String(model.alias ?? "model");
  const command = provider === "modelscope"
    ? "ops/scripts/ms-download.sh " + shellQuote(repoId) + " " + shellQuote(alias)
    : provider === "huggingface"
      ? "ops/scripts/hf-download.sh " + shellQuote(repoId) + " " + shellQuote(alias)
      : null;

  const runtimeHints = runtimeHintsFor(request.url, repoId, alias);

  return {
    status: "parsed",
    download_ready: Boolean(command && repoId),
    message: command ? "Download command is ready." : "Model source parsed, but provider/repo could not be turned into a download command.",
    model: { ...model, runtime_hints: runtimeHints },
    runtime_hints: runtimeHints,
    download: command ? {
      mode: "managed_task",
      command,
      working_directory: baseDir,
      target_path: model.target_path
    } : null
  };
}

export async function startDownload(request: ImportRequest, baseDir: string, logsRoot: string) {
  const plan = createDownloadPlan(request, baseDir);
  if (!plan.download) throw new Error(plan.message);
  const plannedModel = plan.model as Record<string, unknown>;
  const provider = String(plannedModel.provider ?? "");
  const repoId = String(plannedModel.repo_id ?? "");
  const alias = String(plannedModel.alias ?? "model");
  const script = provider === "modelscope" ? "ops/scripts/ms-download.sh" : "ops/scripts/hf-download.sh";
  const task = createTask("download", plan.download.command, baseDir, join(logsRoot, "tasks", "download-" + alias + ".log"), {
    provider,
    repo_id: repoId,
    alias,
    target_path: String(plannedModel.target_path ?? "models/" + alias),
    expected_runtime: request.expected_runtime ?? "auto",
    runtime_hints: plan.runtime_hints
  });
  persistTask(task);
  void runManagedCommand({
    taskId: task.id,
    command: "bash",
    args: [script, repoId, alias],
    cwd: baseDir,
    env: { AI_STACK_BASE: baseDir },
    logPath: task.log_path
  });
  return { ...plan, task };
}

function runtimeHintsFor(url: string, repoId: string, alias: string) {
  const text = (url + " " + repoId + " " + alias).toLowerCase();
  if (text.includes("gguf")) {
    return [
      { runtime: "lmstudio", status: "external", label: "LM Studio / llama.cpp", reason: "GGUF is not served by the current AMUIN container runtimes." },
      { runtime: "vllm", status: "unsupported", label: "vLLM", reason: "vLLM expects HF checkpoint layouts, not GGUF." },
      { runtime: "trtllm", status: "unsupported", label: "TensorRT-LLM", reason: "TensorRT-LLM needs a checkpoint or converted engine." }
    ];
  }
  if (["whisper", "cosyvoice", "funasr", "fun-asr", "asr", "tts"].some((token) => text.includes(token))) {
    return [
      { runtime: "audio", status: "compatible", label: "Audio Service", reason: "Repository name looks like an ASR/TTS model." },
      { runtime: "vllm", status: "unsupported", label: "vLLM", reason: "Audio models are served by the dedicated audio runtime." }
    ];
  }
  return [
    { runtime: "vllm", status: "compatible", label: "vLLM", reason: "HF/ModelScope text checkpoints are expected to be loaded by vLLM after config and weights are present." },
    { runtime: "trtllm", status: "possible", label: "TensorRT-LLM", reason: "May require platform/version validation or conversion before serving." },
    { runtime: "audio", status: "unsupported", label: "Audio Service", reason: "No ASR/TTS markers detected from the source name." }
  ];
}
