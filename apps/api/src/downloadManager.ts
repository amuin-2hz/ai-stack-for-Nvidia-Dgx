import { access, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseModelSource } from "./modelRegistry.js";
import { fetchHuggingFaceManifest } from "./modelManifest.js";
import { createTask, runManagedCommand } from "./taskRunner.js";
import { runCommand, shellQuote } from "./utils.js";
import { createTask as persistTask, listModelFilesForTask, listTasks, markModelFilesForTask, updateTask, upsertModelFile } from "./store.js";
import type { TaskRecord } from "./types.js";
import { inspectCompletedModelDownload } from "./modelIntegrity.js";


export class DownloadConflictError extends Error {
  statusCode = 409;

  constructor(message: string, readonly task: ReturnType<typeof listTasks>[number]) {
    super(message);
    this.name = "DownloadConflictError";
  }
}

export interface ImportRequest {
  url: string;
  alias?: string;
  provider?: string;
  expected_runtime?: string;
  force?: boolean;
}

export function createDownloadPlan(request: ImportRequest, baseDir: string) {
  const model = parseModelSource(request.url, request.alias, request.provider ?? "auto");
  const provider = String(model.provider ?? "unknown");
  const repoId = String(model.repo_id ?? "");
  const alias = String(model.alias ?? "model");
  const repoReady = /^[^/\s]+\/[^/\s]+$/.test(repoId);
  const command = repoReady && provider === "modelscope"
    ? "ops/scripts/ms-download.sh " + shellQuote(repoId) + " " + shellQuote(alias)
    : repoReady && provider === "huggingface"
      ? "ops/scripts/hf-download.sh " + shellQuote(repoId) + " " + shellQuote(alias)
      : null;

  const runtimeHints = runtimeHintsFor(request.url, repoId, alias);

  return {
    status: "parsed",
    download_ready: Boolean(command),
    message: command ? "Download command is ready." : "A valid provider repository in owner/model format is required before downloading.",
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
  const targetPath = String(plannedModel.target_path ?? "models/" + alias);
  const completed = await completedDownloadFor(provider, repoId, targetPath, baseDir);
  if (completed) {
    return { ...plan, status: "already_downloaded", message: "Model is already downloaded.", already_downloaded: true, existing_download: true, task: completed };
  }
  const conflict = await activeDownloadFor(provider, repoId, targetPath);
  if (conflict) {
    if (request.force) throw new DownloadConflictError("A download for this model is already active.", conflict);
    return { ...plan, status: "existing_download", message: "Download task already exists.", existing_download: true, task: conflict };
  }
  const task = createTask("download", plan.download.command, baseDir, join(logsRoot, "tasks", "download-" + alias + ".log"), {
    provider,
    repo_id: repoId,
    alias,
    target_path: targetPath,
    expected_runtime: request.expected_runtime ?? "auto",
    runtime_hints: plan.runtime_hints
  });
  const downloadContainerName = "ai-stack-" + task.id;
  task.metadata.download_container_name = downloadContainerName;
  persistTask(task);
  const plannedFileCount = await writePlannedDownloadFiles(provider, repoId, alias, task.id);
  launchDownloadTask(task, baseDir, plannedFileCount > 0);
  return { ...plan, task };
}

export async function resumeInterruptedDownloads(baseDir: string, _logsRoot: string) {
  const resumed: string[] = [];
  const skipped_active: string[] = [];
  const completed: string[] = [];
  const canceled: string[] = [];
  const failed: string[] = [];

  for (const task of listTasks().reverse()) {
    if (task.type !== "download") continue;
    if (!["queued", "running", "paused", "canceling"].includes(task.status)) continue;

    if (task.status === "canceling") {
      await cleanupDownloadTemp(task.metadata, baseDir);
      await updateTask(task.id, { status: "canceled", finished_at: new Date().toISOString(), error: undefined });
      markDownloadFilesForExistingTask(task, "canceled");
      canceled.push(task.id);
      continue;
    }

    if (await downloadTaskProcessIsActive(task)) {
      skipped_active.push(task.id);
      continue;
    }

    const metadata = task.metadata ?? {};
    const provider = String(metadata.provider ?? "");
    const repoId = String(metadata.repo_id ?? "");
    const alias = String(metadata.alias ?? "");
    const targetPath = String(metadata.target_path ?? (alias ? "models/" + alias : ""));
    if (!isSupportedDownloadProvider(provider) || !repoId || !alias || !targetPath) {
      const error = "Download task could not be resumed because its provider, repo, alias, or target path metadata is incomplete.";
      await updateTask(task.id, { status: "failed", finished_at: new Date().toISOString(), error });
      markDownloadFilesForExistingTask(task, "failed", error);
      failed.push(task.id);
      continue;
    }

    if (await downloadTargetHasCompleteMarker(baseDir, targetPath)) {
      await updateTask(task.id, { status: "succeeded", finished_at: new Date().toISOString(), error: undefined });
      completed.push(task.id);
      continue;
    }

    const downloadContainerName = typeof metadata.download_container_name === "string"
      ? metadata.download_container_name
      : "ai-stack-" + task.id;
    const taskToResume: TaskRecord = {
      ...task,
      log_path: task.log_path || join(baseDir, "logs", "tasks", "download-" + alias + ".log"),
      metadata: { ...metadata, provider, repo_id: repoId, alias, target_path: targetPath, download_container_name: downloadContainerName }
    };
    if (taskToResume.metadata !== task.metadata) await updateTask(task.id, { metadata: taskToResume.metadata, log_path: taskToResume.log_path, error: undefined });
    launchDownloadTask(taskToResume, baseDir, hasPlannedFileRecords(taskToResume.id));
    resumed.push(task.id);
  }

  return { resumed, skipped_active, completed, canceled, failed };
}

export async function cleanupDownloadTemp(metadata: Record<string, unknown>, baseDir: string): Promise<string | undefined> {
  const targetPath = typeof metadata.target_path === "string" ? metadata.target_path : undefined;
  if (!targetPath) return undefined;
  const workspaceRoot = resolve(baseDir);
  const modelPath = resolve(workspaceRoot, targetPath);
  if (modelPath === workspaceRoot || !modelPath.startsWith(workspaceRoot + "/")) return undefined;
  const alias = typeof metadata.alias === "string" && metadata.alias ? metadata.alias : basename(targetPath);
  const tempPaths = [join(modelPath, ".temp")];
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (alias && uid !== undefined) {
    tempPaths.push(join(workspaceRoot, "cache", "modelscope", "uid-" + uid, "local-temp", alias));
  }
  for (const tempPath of tempPaths) await rm(tempPath, { recursive: true, force: true });
  return tempPaths.join(",");
}

export async function cleanupDownloadTarget(metadata: Record<string, unknown>, baseDir: string): Promise<string | undefined> {
  const targetPath = typeof metadata.target_path === "string" ? metadata.target_path : undefined;
  if (!targetPath) return undefined;
  const workspaceRoot = resolve(baseDir);
  const modelPath = resolve(workspaceRoot, targetPath);
  if (modelPath === workspaceRoot || !modelPath.startsWith(workspaceRoot + "/")) return undefined;
  try {
    await access(join(modelPath, ".download-complete"));
    return undefined;
  } catch {
    // No completion marker: a failed/canceled task may leave a partial folder that is safe to remove.
  }
  await rm(modelPath, { recursive: true, force: true });
  return modelPath;
}

async function completedDownloadFor(provider: string, repoId: string, targetPath: string, baseDir: string) {
  const workspaceRoot = resolve(baseDir);
  const modelPath = resolve(workspaceRoot, targetPath);
  if (modelPath === workspaceRoot || !modelPath.startsWith(workspaceRoot + "/")) return undefined;
  const inspection = await inspectCompletedModelDownload(modelPath);
  if (!inspection.complete) {
    // A stale marker must not make the shell skip a resumable, incomplete download.
    await rm(join(modelPath, ".download-complete"), { force: true });
    return undefined;
  }

  const task = listTasks()
    .filter((candidate) => candidate.type === "download")
    .filter((candidate) => sameDownloadTarget(candidate.metadata ?? {}, provider, repoId, targetPath))
    .sort((a, b) => taskTime(b).localeCompare(taskTime(a)))[0];
  if (!task) return undefined;
  if (task.status === "succeeded") return task;
  return updateTask(task.id, {
    status: "succeeded",
    finished_at: new Date().toISOString(),
    error: undefined
  }) ?? { ...task, status: "succeeded", error: undefined };
}

function launchDownloadTask(task: TaskRecord, baseDir: string, hasPlannedFiles: boolean): void {
  const metadata = task.metadata ?? {};
  const provider = String(metadata.provider ?? "");
  const repoId = String(metadata.repo_id ?? "");
  const alias = String(metadata.alias ?? "");
  const script = provider === "modelscope" ? "ops/scripts/ms-download.sh" : "ops/scripts/hf-download.sh";
  const downloadContainerName = String(metadata.download_container_name ?? ("ai-stack-" + task.id));
  const usesFallbackRecord = !hasPlannedFiles || hasFallbackFileRecord(task.id);

  if (usesFallbackRecord) writeDownloadFileStatus(alias, ".", "downloading", task.id);
  void runManagedCommand({
    taskId: task.id,
    command: "bash",
    args: [script, repoId, alias],
    cwd: baseDir,
    env: { AI_STACK_BASE: baseDir, AI_STACK_DOWNLOAD_CONTAINER: downloadContainerName },
    logPath: task.log_path,
    onPause: async () => { await pauseDownloadContainer(downloadContainerName); },
    onResume: async () => { await resumeDownloadContainer(downloadContainerName); },
    onSuccess: async () => {
      const targetPath = String(metadata.target_path ?? (alias ? "models/" + alias : ""));
      const modelPath = resolve(baseDir, targetPath);
      const inspection = await inspectCompletedModelDownload(modelPath);
      if (!inspection.complete) throw new Error("Download completion check failed: " + inspection.reason);
      if (usesFallbackRecord) writeDownloadFileStatus(alias, ".", "downloaded", task.id);
    },
    onCancel: async () => {
      await cleanupDownloadTemp(task.metadata, baseDir);
      if (usesFallbackRecord) writeDownloadFileStatus(alias, ".", "canceled", task.id);
      else markModelFilesForTask(task.id, "canceled");
    },
    onFailure: async (error) => {
      if (usesFallbackRecord) writeDownloadFileStatus(alias, ".", "failed", task.id, error);
      else markModelFilesForTask(task.id, "failed", error);
    }
  });
}

function hasPlannedFileRecords(taskId: string): boolean {
  return listModelFilesForTask(taskId).some((file) => file.relative_path !== ".");
}

function hasFallbackFileRecord(taskId: string): boolean {
  return listModelFilesForTask(taskId).some((file) => file.relative_path === ".");
}

function markDownloadFilesForExistingTask(task: TaskRecord, status: "failed" | "canceled", error?: string): void {
  if (hasFallbackFileRecord(task.id)) {
    const alias = String(task.metadata?.alias ?? task.metadata?.model_id ?? "");
    if (alias) writeDownloadFileStatus(alias, ".", status, task.id, error);
    return;
  }
  markModelFilesForTask(task.id, status, error);
}

async function downloadTargetHasCompleteMarker(baseDir: string, targetPath: string): Promise<boolean> {
  const workspaceRoot = resolve(baseDir);
  const modelPath = resolve(workspaceRoot, targetPath);
  if (modelPath === workspaceRoot || !modelPath.startsWith(workspaceRoot + "/")) return false;
  return (await inspectCompletedModelDownload(modelPath)).complete;
}

export function sameDownloadSource(metadata: Record<string, unknown>, provider: string, repoId: string): boolean {
  return metadata.provider === provider && metadata.repo_id === repoId;
}

function sameDownloadTarget(metadata: Record<string, unknown>, provider: string, repoId: string, targetPath: string): boolean {
  return sameDownloadSource(metadata, provider, repoId) || metadata.target_path === targetPath;
}

function taskTime(task: ReturnType<typeof listTasks>[number]): string {
  return task.updated_at || task.finished_at || task.started_at || task.created_at || "";
}

async function activeDownloadFor(provider: string, repoId: string, targetPath: string) {
  const activeStatuses = new Set(["queued", "running", "paused", "canceling", "failed"]);
  for (const task of listTasks()) {
    if (task.type !== "download" || !activeStatuses.has(task.status)) continue;
    const metadata = task.metadata ?? {};
    const sameTarget = sameDownloadTarget(metadata, provider, repoId, targetPath);
    if (!sameTarget) continue;
    if (task.status === "queued" || await downloadTaskProcessIsActive(task)) return task;
  }
  return undefined;
}

function isSupportedDownloadProvider(provider: string): boolean {
  return provider === "huggingface" || provider === "modelscope";
}

async function downloadTaskProcessIsActive(task: ReturnType<typeof listTasks>[number]): Promise<boolean> {
  const metadata = task.metadata ?? {};
  const containerName = typeof metadata.download_container_name === "string" ? metadata.download_container_name : "";
  if (containerName) {
    const docker = await runCommand("docker", ["ps", "--filter", "name=^" + containerName + "$", "--format", "{{.Names}}"], 3000);
    if (docker.ok) return docker.stdout.split(/\r?\n/).some((name) => name.trim() === containerName);
  }

  const result = await runCommand("ps", ["-eo", "args="], 3000);
  if (!result.ok || !result.stdout) return true;
  const tokens = [
    task.command,
    String(metadata.repo_id ?? ""),
    String(metadata.alias ?? "")
  ].filter((token) => token.length > 4);
  return tokens.some((token) => result.stdout.includes(token));
}



async function pauseDownloadContainer(containerName: string): Promise<void> {
  await controlDownloadContainer(containerName, "pause", "paused");
}

async function resumeDownloadContainer(containerName: string): Promise<void> {
  await controlDownloadContainer(containerName, "unpause", "resumed");
}

async function controlDownloadContainer(containerName: string, action: "pause" | "unpause", label: string): Promise<void> {
  const result = await runCommand("docker", [action, containerName], 15000);
  const detail = result.stderr || result.stdout || "";
  if (result.ok || /No such container/i.test(detail)) return;
  throw new Error("Download container could not be " + label + ": " + detail.trim());
}

async function writePlannedDownloadFiles(provider: string, repoId: string, modelId: string, taskId: string): Promise<number> {
  if (provider !== "huggingface" || !repoId) return 0;
  const files = await fetchHuggingFaceManifest(repoId);
  const now = new Date().toISOString();
  for (const file of files) {
    upsertModelFile({
      model_id: modelId,
      relative_path: file.relative_path,
      status: "planned",
      size_bytes: file.size_bytes,
      downloaded_bytes: 0,
      task_id: taskId,
      error: null,
      updated_at: now
    });
  }
  return files.length;
}

function writeDownloadFileStatus(modelId: string, relativePath: string, status: "downloading" | "downloaded" | "failed" | "canceled", taskId: string, error?: string): void {
  upsertModelFile({
    model_id: modelId,
    relative_path: relativePath,
    status,
    task_id: taskId,
    error: error ?? null,
    updated_at: new Date().toISOString()
  });
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
  if (/qwen3[-_ ]?tts/.test(text)) {
    return [
      { runtime: "qwen3-tts", status: "compatible", label: "Qwen3-TTS", reason: "Use the dedicated Qwen3-TTS gateway for CustomVoice, VoiceDesign, or Base voice cloning." },
      { runtime: "pytorch", status: "unsupported", label: "PyTorch", reason: "The default PyTorch container does not include the pinned qwen-tts package or speech API adapter." },
      { runtime: "vllm", status: "unsupported", label: "vLLM", reason: "Qwen3-TTS online serving is handled by the dedicated gateway." }
    ];
  }
  if (["whisper", "cosyvoice", "funasr", "fun-asr", "asr", "tts", "speech", "speaker", "campplus", "sv"].some((token) => text.includes(token))) {
    return [
      { runtime: "funasr-gateway", status: "external", label: "FunASR Gateway", reason: "ASR models need the custom FunASR Gateway runtime." },
      { runtime: "pytorch", status: "unsupported", label: "PyTorch", reason: "The default PyTorch container is only a generic environment, not the ASR/TTS service." },
      { runtime: "vllm", status: "unsupported", label: "vLLM", reason: "Audio models are not vLLM checkpoints." }
    ];
  }
  return [
    { runtime: "vllm", status: "compatible", label: "vLLM", reason: "HF/ModelScope text checkpoints are expected to be loaded by vLLM after config and weights are present." },
    { runtime: "trtllm", status: "possible", label: "TensorRT-LLM", reason: "May require platform/version validation or conversion before serving." },
    { runtime: "pytorch", status: "unsupported", label: "PyTorch", reason: "No ASR/TTS markers detected from the source name." }
  ];
}
