import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TaskRecord } from "./types.js";

export interface TaskProgressInfo {
  progress_percent: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  target_path?: string;
  complete_on_disk?: boolean;
}

export async function enrichTaskProgress(task: TaskRecord, workspaceRoot: string): Promise<TaskRecord & TaskProgressInfo> {
  const progress = await taskProgress(task, workspaceRoot);
  return { ...task, ...progress };
}

async function taskProgress(task: TaskRecord, workspaceRoot: string): Promise<TaskProgressInfo> {
  const targetPath = typeof task.metadata?.target_path === "string" ? resolve(workspaceRoot, task.metadata.target_path) : undefined;
  const downloadedBytes = targetPath && isInside(resolve(workspaceRoot), targetPath) ? await directorySize(targetPath) : undefined;
  const totalBytes = await expectedTotalBytes(task);
  const completeOnDisk = Boolean(targetPath && await looksCompleteDownloadedModel(targetPath)) || Boolean(totalBytes && downloadedBytes && downloadedBytes >= totalBytes);
  if (task.status === "succeeded") return { progress_percent: 100, downloaded_bytes: downloadedBytes, total_bytes: totalBytes, target_path: targetPath, complete_on_disk: true };
  if (task.status === "failed") return { progress_percent: 100, downloaded_bytes: downloadedBytes, total_bytes: totalBytes, target_path: targetPath, complete_on_disk: completeOnDisk };
  const log = await readFile(task.log_path, "utf-8").catch(() => "");
  const parsed = parseProgress(log);
  const byteProgress = totalBytes && downloadedBytes ? clamp((downloadedBytes / totalBytes) * 100) : undefined;
  const fallback = task.status === "running" ? 5 : task.status === "queued" ? 0 : 0;
  return { progress_percent: completeOnDisk ? 100 : byteProgress ?? parsed ?? fallback, downloaded_bytes: downloadedBytes, total_bytes: totalBytes, target_path: targetPath, complete_on_disk: completeOnDisk };
}

function parseProgress(log: string): number | undefined {
  const clean = log.replace(/\u001b\[[0-9;]*m/g, "").replace(/\r/g, "\n");
  const matches = [...clean.matchAll(/Fetching\s+\d+\s+files:\s+(\d{1,3})%/g)];
  if (matches.length) return clamp(Number(matches[matches.length - 1][1]));
  const generic = [...clean.matchAll(/(?:^|\s)(\d{1,3})%(?:\||\s|$)/g)];
  if (generic.length) return clamp(Number(generic[generic.length - 1][1]));
  return undefined;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
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

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + "/");
}

const totalSizeCache = new Map<string, Promise<number | undefined>>();

async function expectedTotalBytes(task: TaskRecord): Promise<number | undefined> {
  if (task.type !== "download") return undefined;
  const repoId = typeof task.metadata?.repo_id === "string" ? task.metadata.repo_id : undefined;
  const provider = String(task.metadata?.provider ?? "");
  if (!repoId || provider !== "huggingface") return undefined;
  if (!totalSizeCache.has(repoId)) totalSizeCache.set(repoId, fetchHuggingFaceTotalBytes(repoId));
  return totalSizeCache.get(repoId);
}

async function fetchHuggingFaceTotalBytes(repoId: string): Promise<number | undefined> {
  try {
    const response = await fetch("https://huggingface.co/api/models/" + encodeURIComponent(repoId).replace(/%2F/g, "/") + "?blobs=true");
    if (!response.ok) return undefined;
    const payload = await response.json() as { siblings?: Array<{ rfilename?: string; size?: number }> };
    const files = payload.siblings ?? [];
    const total = files.filter((file) => file.rfilename && !isExcludedSnapshotFile(file.rfilename)).reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    return total || undefined;
  } catch {
    return undefined;
  }
}

function isExcludedSnapshotFile(name: string): boolean {
  return name.startsWith(".git/") || name.startsWith(".cache/") || name.includes("/.git/") || /\.(msgpack|h5|ckpt|tflite|pb|flax|ot)$/.test(name);
}

async function looksCompleteDownloadedModel(path: string): Promise<boolean> {
  const files = await listFiles(path);
  if (!files.length) return false;
  if (files.some((file) => file.includes(".incomplete"))) return false;
  const names = new Set(files.map((file) => file.split("/").pop() ?? file));
  const hasConfig = names.has("config.json") || names.has("cosyvoice.yaml") || names.has("config.yaml");
  const hasWeight = files.some((file) => /\.(safetensors|bin|gguf|pt|pth|onnx|engine)$/.test(file));
  return hasConfig && hasWeight;
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
