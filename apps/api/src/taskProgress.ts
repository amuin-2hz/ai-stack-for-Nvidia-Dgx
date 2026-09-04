import { access, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { listModelFilesForTask, upsertModelFile } from "./store.js";
import { fetchHuggingFaceTotalBytes, fetchModelScopeTotalBytes } from "./modelManifest.js";
import { inspectModelIntegrity } from "./modelIntegrity.js";
import { isWeightFile } from "./utils.js";
import type { ModelFileRecord, TaskRecord } from "./types.js";

export interface TaskProgressInfo {
  progress_percent: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  download_speed_bytes_per_sec?: number;
  download_log_speed_bytes_per_sec?: number;
  download_active_file?: string;
  download_active_file_bytes?: number;
  download_active_file_total_bytes?: number;
  download_active_file_percent?: number;
  download_elapsed?: string;
  download_eta?: string;
  download_items_done?: number;
  download_items_total?: number;
  download_retry_attempt?: number;
  download_retry_total?: number;
  download_error_code?: "network_unreachable" | "proxy_unreachable" | "download_failed";
  total_bytes_estimated?: boolean;
  target_path?: string;
  complete_on_disk?: boolean;
}


export async function syncDownloadTaskFiles(task: TaskRecord, workspaceRoot: string): Promise<void> {
  if (task.type !== "download") return;
  const modelId = String(task.metadata?.alias ?? task.metadata?.model_id ?? "");
  const targetPath = typeof task.metadata?.target_path === "string" ? resolve(workspaceRoot, task.metadata.target_path) : undefined;
  if (!modelId || !targetPath || !isInside(resolve(workspaceRoot), targetPath)) return;
  if (!["queued", "running", "paused", "canceling", "failed", "canceled", "succeeded"].includes(task.status)) return;
  const records = await collectDownloadFileRecords(modelId, targetPath, task.id, task.status, task.error);
  for (const record of records) upsertModelFile(record);
}

export async function collectDownloadFileRecords(
  modelId: string,
  targetPath: string,
  taskId: string,
  taskStatus: string,
  error?: string
): Promise<ModelFileRecord[]> {
  const now = new Date().toISOString();
  const finalFiles = await listFileEntries(targetPath, targetPath);
  const tempFiles = [
    ...await listFileEntries(join(targetPath, ".temp"), join(targetPath, ".temp"))
  ];
  const records = new Map<string, ModelFileRecord>();

  for (const file of tempFiles) {
    records.set(file.relative_path, {
      model_id: modelId,
      relative_path: file.relative_path,
      status: taskStatus === "failed" ? "failed" : taskStatus === "canceled" ? "canceled" : "downloading",
      size_bytes: null,
      downloaded_bytes: file.size_bytes,
      task_id: taskId,
      error: taskStatus === "failed" ? error ?? null : null,
      updated_at: now
    });
  }

  const finalStatus = taskStatus === "failed" ? "failed" : taskStatus === "canceled" ? "canceled" : "downloaded";
  for (const file of finalFiles) {
    records.set(file.relative_path, {
      model_id: modelId,
      relative_path: file.relative_path,
      status: finalStatus,
      size_bytes: file.size_bytes,
      downloaded_bytes: file.size_bytes,
      task_id: taskId,
      error: taskStatus === "failed" ? error ?? null : null,
      updated_at: now
    });
  }

  return [...records.values()].filter((record) => !isInternalDownloadFile(record.relative_path));
}

export async function enrichTaskProgress(task: TaskRecord, workspaceRoot: string): Promise<TaskRecord & TaskProgressInfo> {
  const progress = await taskProgress(task, workspaceRoot);
  return { ...task, ...progress };
}

async function taskProgress(task: TaskRecord, workspaceRoot: string): Promise<TaskProgressInfo> {
  const targetPath = typeof task.metadata?.target_path === "string" ? resolve(workspaceRoot, task.metadata.target_path) : undefined;
  const downloadedBytes = targetPath && isInside(resolve(workspaceRoot), targetPath) ? await downloadedBytesForTask(task, workspaceRoot, targetPath) : undefined;
  const localTotalBytes = targetPath && isInside(resolve(workspaceRoot), targetPath) ? await localIndexedWeightTotalBytes(targetPath) : undefined;
  const rawTotalBytes = localTotalBytes ?? await expectedTotalBytes(task);
  const log = await readFile(task.log_path, "utf-8").catch(() => "");
  const totalBytes = trustedExpectedTotalBytes(task, rawTotalBytes, downloadedBytes, log);
  const totalBytesEstimated = Boolean(rawTotalBytes && !totalBytes);
  const speedBytesPerSec = downloadSpeedBytesPerSec(task, downloadedBytes);
  let logProgress = parseDownloadLogProgress(log);
  if (["queued", "running", "paused", "canceling"].includes(task.status) && logProgress.download_error_code && hasDownloadProgressEvidence(downloadedBytes, logProgress)) {
    const { download_error_code: _download_error_code, ...progressWithoutTransientError } = logProgress;
    logProgress = progressWithoutTransientError;
  }
  const targetInsideWorkspace = Boolean(targetPath && isInside(resolve(workspaceRoot), targetPath));
  const integrityOk = targetInsideWorkspace
    ? (await inspectModelIntegrity(targetPath as string)).missing_indexed_weight_files.length === 0
    : true;
  const stagingPresent = targetInsideWorkspace ? await hasDownloadStagingArtifacts(targetPath as string) : false;
  const completeOnDisk = !stagingPresent && integrityOk && (
    Boolean(targetPath && await looksCompleteDownloadedModel(targetPath)) ||
    Boolean(totalBytes && downloadedBytes && downloadedBytes >= totalBytes)
  );
  const parsed = logProgress.progress_percent;
  if (["succeeded", "failed", "canceled"].includes(task.status)) {
    const snapshotBytes = downloadedBytes ?? downloadBytesForFinishedTask(task.id);
    const progressPercent = task.status === "succeeded"
      ? 100
      : totalBytes && snapshotBytes
        ? incompleteProgress((snapshotBytes / totalBytes) * 100)
        : snapshotBytes
          ? parsed
          : 0;
    return {
      ...logProgress,
      progress_percent: progressPercent ?? 0,
      downloaded_bytes: snapshotBytes,
      total_bytes: totalBytes,
      download_speed_bytes_per_sec: 0,
      total_bytes_estimated: totalBytesEstimated,
      target_path: targetPath,
      complete_on_disk: completeOnDisk
    };
  }
  const byteProgress = totalBytes && downloadedBytes ? incompleteProgress((downloadedBytes / totalBytes) * 100) : undefined;
  const fallback = task.status === "running" ? 5 : task.status === "queued" ? 0 : 0;
  return {
    ...logProgress,
    progress_percent: completeOnDisk ? 100 : byteProgress ?? parsed ?? (logProgress.download_error_code ? 0 : fallback),
    downloaded_bytes: downloadedBytes,
    total_bytes: totalBytes,
    download_speed_bytes_per_sec: speedBytesPerSec,
    total_bytes_estimated: totalBytesEstimated,
    target_path: targetPath,
    complete_on_disk: completeOnDisk
  };
}

const downloadSpeedSamples = new Map<string, { bytes: number; at: number; speed: number }>();

function downloadSpeedBytesPerSec(task: TaskRecord, bytes: number | undefined): number | undefined {
  if (task.type !== "download" || typeof bytes !== "number") return undefined;
  const active = ["running", "canceling"].includes(task.status);
  if (!active) {
    downloadSpeedSamples.delete(task.id);
    return 0;
  }
  const now = Date.now();
  const previous = downloadSpeedSamples.get(task.id);
  if (!previous) {
    downloadSpeedSamples.set(task.id, { bytes, at: now, speed: 0 });
    return 0;
  }
  const elapsedSeconds = (now - previous.at) / 1000;
  if (elapsedSeconds < 0.5) return previous.speed;
  const speed = Math.max(0, Math.round((bytes - previous.bytes) / elapsedSeconds));
  downloadSpeedSamples.set(task.id, { bytes, at: now, speed });
  return speed;
}

function downloadBytesForFinishedTask(taskId: string): number {
  return listModelFilesForTask(taskId)
    .map((file) => Number(file.downloaded_bytes ?? file.size_bytes ?? 0))
    .filter((size) => Number.isFinite(size) && size > 0)
    .reduce((sum, size) => sum + size, 0);
}

type ParsedDownloadLogProgress = Partial<Pick<TaskProgressInfo,
  "progress_percent" |
  "download_log_speed_bytes_per_sec" |
  "download_active_file" |
  "download_active_file_bytes" |
  "download_active_file_total_bytes" |
  "download_active_file_percent" |
  "download_elapsed" |
  "download_eta" |
  "download_items_done" |
  "download_items_total" |
  "download_retry_attempt" |
  "download_retry_total" |
  "download_error_code"
>>;

function hasDownloadProgressEvidence(downloadedBytes: number | undefined, progress: ParsedDownloadLogProgress): boolean {
  return Boolean(
    (downloadedBytes && downloadedBytes > 0) ||
    (progress.progress_percent && progress.progress_percent > 0) ||
    progress.download_active_file ||
    (progress.download_active_file_bytes && progress.download_active_file_bytes > 0) ||
    (progress.download_items_done && progress.download_items_done > 0)
  );
}

function parseDownloadLogProgress(log: string): ParsedDownloadLogProgress {
  const clean = log.replace(/\u001b\[[0-9;]*m/g, "").replace(/\r/g, "\n");
  const result: ParsedDownloadLogProgress = {};
  const attempts = [...clean.matchAll(/Hugging Face download attempt\s+(\d+)\/(\d+)/gi)];
  if (attempts.length) {
    const match = attempts[attempts.length - 1];
    result.download_retry_attempt = Number(match[1]);
    result.download_retry_total = Number(match[2]);
  }
  if (/Proxy .*configured but not reachable|Unable to connect to proxy|ProxyError/i.test(clean)) {
    result.download_error_code = "proxy_unreachable";
  } else if (/Network is unreachable|Failed to establish a new connection|NameResolutionError|MaxRetryError/i.test(clean)) {
    result.download_error_code = "network_unreachable";
  } else if (/download failed|LocalEntryNotFoundError|ConnectionError/i.test(clean)) {
    result.download_error_code = "download_failed";
  }
  const downloadLines = [...clean.matchAll(/Downloading \[([^\]]+)\]:[^\n]*/g)].map((match) => match[0]);
  if (downloadLines.length) {
    Object.assign(result, parseDownloadLine(downloadLines[downloadLines.length - 1]));
  }
  const itemMatches = [...clean.matchAll(/Processing\s+(\d+(?:\.\d+)?)\s+items:\s+(\d{1,3})%[^\n]*?\|\s*(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\s+\[([^<\],]+)(?:<([^,\]]+))?/g)];
  if (itemMatches.length) {
    const match = itemMatches[itemMatches.length - 1];
    result.progress_percent = clamp(Number(match[2]));
    result.download_items_done = Number(match[3]);
    result.download_items_total = Number(match[4]);
    result.download_elapsed = match[5]?.trim();
    result.download_eta = match[6]?.trim();
  }
  const fetchingMatches = [...clean.matchAll(/Fetching\s+(\d+)\s+files:\s+(\d{1,3})%[^\n]*?\|\s*(\d+)\/(\d+)/g)];
  if (fetchingMatches.length) {
    const match = fetchingMatches[fetchingMatches.length - 1];
    result.download_items_done = Number(match[3]);
    result.download_items_total = Number(match[4]);
  }
  const byteFractions = [...clean.matchAll(/(\d+(?:\.\d+)?)([kKmMgGtT])\/(\d+(?:\.\d+)?)([kKmMgGtT])/g)];
  if (byteFractions.length) {
    const match = byteFractions[byteFractions.length - 1];
    const downloaded = scaledNumber(match[1], match[2]);
    const total = scaledNumber(match[3], match[4]);
    if (downloaded > 0 && total > 0 && result.progress_percent === undefined) result.progress_percent = clamp((downloaded / total) * 100);
  }
  const generic = [...clean.matchAll(/(?:^|\s)(\d{1,3})%(?:\||\s|$)/g)];
  if (generic.length && result.progress_percent === undefined && result.download_items_done === undefined) result.progress_percent = clamp(Number(generic[generic.length - 1][1]));
  return result;
}

function parseDownloadLine(line: string): ParsedDownloadLogProgress {
  const result: ParsedDownloadLogProgress = {};
  const file = line.match(/Downloading \[([^\]]+)\]:/);
  if (file) result.download_active_file = file[1];
  const fraction = line.match(/(\d+(?:\.\d+)?)([kKmMgGtT]?B?)\/(\d+(?:\.\d+)?)([kKmMgGtT]?B?)/);
  if (fraction) {
    const downloaded = scaledBytes(fraction[1], fraction[2]);
    const total = scaledBytes(fraction[3], fraction[4]);
    if (downloaded > 0) result.download_active_file_bytes = downloaded;
    if (total > 0) {
      result.download_active_file_total_bytes = total;
      result.download_active_file_percent = clamp((downloaded / total) * 100);
    }
  } else {
    const single = line.match(/:\s*(\d+(?:\.\d+)?)([kKmMgGtT]?B?)\s+\[/);
    if (single) result.download_active_file_bytes = scaledBytes(single[1], single[2]);
  }
  const timing = line.match(/\[([^<\],]+)(?:<([^,\]]+))?,\s*([^\]]+\/s)\]/);
  if (timing) {
    result.download_elapsed = timing[1]?.trim();
    result.download_eta = timing[2]?.trim();
    result.download_log_speed_bytes_per_sec = parseSpeedBytesPerSec(timing[3]);
  }
  return result;
}

function scaledNumber(value: string, unit: string): number {
  const multipliers: Record<string, number> = { "": 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 };
  return Number(value) * (multipliers[unit.toLowerCase()] ?? 1);
}

function scaledBytes(value: string, unit: string): number {
  const normalized = unit.toLowerCase().replace(/b$/, "");
  return scaledNumber(value, normalized);
}

function parseSpeedBytesPerSec(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([kKmMgGtT]?B?)\/s$/);
  if (!match) return undefined;
  return Math.round(scaledBytes(match[1], match[2]));
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const bounded = Math.max(0, Math.min(100, value));
  return Math.round(bounded * 10) / 10;
}

function incompleteProgress(value: number): number {
  return Math.min(99.9, clamp(value));
}

function trustedExpectedTotalBytes(
  task: TaskRecord,
  totalBytes: number | undefined,
  downloadedBytes: number | undefined,
  log: string
): number | undefined {
  if (!totalBytes) return undefined;
  const active = ["queued", "running", "paused", "canceling"].includes(task.status);
  if (active && downloadedBytes && downloadedBytes >= totalBytes * 0.98) return undefined;
  if (task.metadata?.provider === "huggingface" && totalBytes < 100 * 1024 * 1024 && hasLargeWeightDownloadInLog(log)) {
    return undefined;
  }
  return totalBytes;
}

function hasLargeWeightDownloadInLog(log: string): boolean {
  return /Downloading ['"][^'"]*\.(?:safetensors|bin|pt|pth|gguf|engine|fst)['"]/i.test(log);
}

async function hasDownloadStagingArtifacts(path: string): Promise<boolean> {
  for (const name of [".temp"]) {
    try {
      const info = await stat(join(path, name));
      if (info.isDirectory() || info.isFile()) return true;
    } catch {
      // absent
    }
  }
  return false;
}

async function localIndexedWeightTotalBytes(targetPath: string): Promise<number | undefined> {
  const candidates = [
    join(targetPath, ".temp", "model.safetensors.index.json"),
    join(targetPath, "model.safetensors.index.json")
  ];
  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(await readFile(candidate, "utf-8"));
      const total = Number(payload?.metadata?.total_size);
      if (Number.isFinite(total) && total > 0) return total;
    } catch {
      // The index appears after the first metadata files finish downloading.
    }
  }
  return undefined;
}

async function downloadedBytesForTask(task: TaskRecord, workspaceRoot: string, targetPath: string): Promise<number> {
  const entries = [
    ...await listFileEntries(targetPath, targetPath),
    ...await listFileEntries(join(targetPath, ".temp"), join(targetPath, ".temp")),
    ...await externalStagingFileEntries(task, workspaceRoot)
  ];
  const unique = new Map<string, number>();
  for (const entry of entries) {
    if (isInternalDownloadFile(entry.relative_path)) continue;
    const current = unique.get(entry.relative_path) ?? 0;
    unique.set(entry.relative_path, Math.max(current, entry.size_bytes));
  }
  return [...unique.values()].reduce((sum, size) => sum + size, 0);
}

async function externalStagingFileEntries(task: TaskRecord, workspaceRoot: string): Promise<Array<{ relative_path: string; size_bytes: number }>> {
  if (task.type !== "download" || task.metadata?.provider !== "modelscope") return [];
  const alias = typeof task.metadata?.alias === "string" ? task.metadata.alias : undefined;
  if (!alias) return [];
  const safeAlias = alias.replace(/\//g, "_");
  const modelscopeCacheRoot = join(workspaceRoot, "cache", "modelscope");
  const candidates = new Set<string>();

  if (typeof process.getuid === "function") {
    candidates.add(join(modelscopeCacheRoot, "uid-" + process.getuid(), "local-temp", safeAlias));
  }

  try {
    const entries = await readdir(modelscopeCacheRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("uid-")) {
        candidates.add(join(modelscopeCacheRoot, entry.name, "local-temp", safeAlias));
      }
    }
  } catch {
    // Cache directory may not exist until the first ModelScope download starts.
  }

  const entries = await Promise.all([...candidates].map((candidate) => listFileEntries(candidate, candidate)));
  return entries.flat();
}

async function directorySize(path: string): Promise<number> {
  try {
    const info = await stat(path);
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
    const entries = await readdir(path, { withFileTypes: true });
    const sizes = await Promise.all(entries.map((entry) => directorySize(join(path, entry.name))));
    return sizes.reduce((sum, size) => sum + size, 0);
  } catch {
    return 0;
  }
}


async function listFileEntries(root: string, base: string): Promise<Array<{ relative_path: string; size_bytes: number }>> {
  try {
    const info = await stat(root);
    if (info.isFile()) return [{ relative_path: normalizeRelativePath(relative(base, root) || root.split("/").pop() || root), size_bytes: info.size }];
    if (!info.isDirectory()) return [];
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => listFileEntries(join(root, entry.name), base)));
    return nested.flat();
  } catch {
    return [];
  }
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isInternalDownloadFile(name: string): boolean {
  return name === "" || name === ".download-complete" || name.endsWith("/.download-complete") || name.split("/").some((part) => part === ".temp");
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + "/");
}

const totalSizeCache = new Map<string, Promise<number | undefined>>();

async function expectedTotalBytes(task: TaskRecord): Promise<number | undefined> {
  if (task.type !== "download") return undefined;
  const repoId = typeof task.metadata?.repo_id === "string" ? task.metadata.repo_id : undefined;
  const provider = String(task.metadata?.provider ?? "");
  if (!repoId) return undefined;
  const cacheKey = provider + ":" + repoId;
  if (!totalSizeCache.has(cacheKey)) {
    const promise = provider === "huggingface"
      ? fetchHuggingFaceTotalBytes(repoId)
      : provider === "modelscope"
        ? fetchModelScopeTotalBytes(repoId)
        : Promise.resolve(undefined);
    totalSizeCache.set(cacheKey, promise);
  }
  return totalSizeCache.get(cacheKey);
}

async function looksCompleteDownloadedModel(path: string): Promise<boolean> {
  const files = await listFiles(path);
  if (!files.length) return false;
  if (files.some((file) => file.includes(".incomplete"))) return false;
  if (files.some((file) => file.split("/").some((seg) => seg === ".temp"))) return false;
  const integrity = await inspectModelIntegrity(path);
  if (integrity.missing_indexed_weight_files.length > 0) return false;

  const names = new Set(files.map((file) => file.split("/").pop() ?? file));
  const hasConfig = names.has("config.json") || names.has("configuration.json") || names.has("cosyvoice.yaml") || names.has("config.yaml");
  const hasWeight = files.some(isWeightFile);
  if (!hasConfig || !hasWeight) return false;

  const hasMarker = await (async () => {
    try { await access(join(path, ".download-complete")); return true; } catch { return false; }
  })();
  if (hasMarker) return true;

  return true;
}

async function listFiles(path: string, prefix = ""): Promise<string[]> {
  try {
    const info = await stat(path);
    if (info.isFile()) return [prefix || path];
    if (!info.isDirectory()) return [];
    const entries = await readdir(path, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => listFiles(join(path, entry.name), prefix ? join(prefix, entry.name) : entry.name)));
    return nested.flat();
  } catch {
    return [];
  }
}
