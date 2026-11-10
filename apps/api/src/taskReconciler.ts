import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { enrichTaskProgress } from "./taskProgress.js";
import { inspectCompletedModelDownload, inspectModelIntegrity } from "./modelIntegrity.js";
import { isWeightFile, runCommand } from "./utils.js";
import { listTasks, updateTask } from "./store.js";
import type { TaskRecord } from "./types.js";

/**
 * Check whether a `.download-complete` marker file exists at the target path.
 * Download scripts touch this marker AFTER moving files from `.temp` → final
 * location, which is the authoritative signal that download is truly finished.
 */
async function hasDownloadCompleteMarker(targetPath: string): Promise<boolean> {
  return (await inspectCompletedModelDownload(targetPath)).complete;
}

/**
 * If the download target has a `.download-complete` marker, write "succeeded"
 * to the database immediately. This is the definitive signal from the download
 * script that files are fully downloaded and moved to the final directory.
 */
async function tryCommitDownloadSuccess(
  task: TaskRecord,
  workspaceRoot: string
): Promise<TaskRecord | undefined> {
  if (task.type !== "download") return undefined;
  if (!["queued", "running", "paused", "canceling", "failed"].includes(task.status)) return undefined;

  const targetPath = typeof task.metadata?.target_path === "string"
    ? resolve(workspaceRoot, task.metadata.target_path)
    : undefined;
  if (!targetPath) return undefined;

  const markerPresent = await hasDownloadCompleteMarker(targetPath);
  if (!markerPresent) return undefined;

  // Write success to DB — the definitive write triggered by the marker file.
  const updated = await updateTask(task.id, {
    status: "succeeded",
    finished_at: new Date().toISOString(),
    error: undefined
  });
  if (updated) return await enrichTaskProgress(updated, workspaceRoot);
  const enriched2 = await enrichTaskProgress(task, workspaceRoot);
  return { ...enriched2, status: "succeeded" } as TaskRecord;
}

export async function reconcileTask(
  task: TaskRecord | undefined,
  workspaceRoot: string
) {
  if (!task) return task;

  const reconciledDeploy = await reconcileDeployRuntimeTask(task, workspaceRoot);
  if (reconciledDeploy) return reconciledDeploy;

  if (task.status === "failed" && isInterruptedProcessError(task) && await isTaskProcessActive(task)) {
    const updated = await updateTask(task.id, {
      status: "running",
      error: undefined
    });
    return updated ? await enrichTaskProgress(updated, workspaceRoot) : { ...task, status: "running", error: undefined };
  }

  const normalizedFailed = await normalizeFailedRuntimePlan(task);
  if (normalizedFailed) return normalizedFailed;

  // Priority 1: .download-complete marker → definitive DB write
  const committed = await tryCommitDownloadSuccess(task, workspaceRoot);
  if (committed) return committed;

  const enriched = await enrichTaskProgress(task, workspaceRoot);

  if (task.type === "download" && task.status === "failed" && task.error === staleDownloadProcessError() && await isTaskProcessActive(task)) {
    const updated = await updateTask(task.id, { status: "running", error: undefined });
    return updated ? await enrichTaskProgress(updated, workspaceRoot) : { ...enriched, status: "running", error: undefined };
  }

  if (task.type === "download" && task.status === "succeeded") {
    const targetPath = typeof task.metadata?.target_path === "string"
      ? resolve(workspaceRoot, task.metadata.target_path)
      : undefined;
    const inspection = targetPath && isInside(resolve(workspaceRoot), targetPath)
      ? await inspectCompletedModelDownload(targetPath)
      : { complete: false, reason: "download target path is missing or invalid" };
    if (!inspection.complete) {
      const error = "Downloaded model failed completion check: " + inspection.reason;
      const updated = await updateTask(task.id, {
        status: "failed",
        finished_at: task.finished_at ?? new Date().toISOString(),
        error
      });
      return updated ? await enrichTaskProgress(updated, workspaceRoot) : { ...enriched, status: "failed", error };
    }
  }

  const promoted = await tryPromoteCompleteStagedDownload(task, enriched, workspaceRoot);
  if (promoted) return promoted;

  if (task.status === "running" && !(await isTaskProcessActive(task))) {
    if (taskIsWithinStartupGrace(task)) return enriched;
    const error = task.type === "download"
      ? staleDownloadProcessError()
      : staleRuntimeProcessError();
    const updated = await updateTask(task.id, {
      status: "failed",
      metadata: metadataWithFailedRuntimeStage(task),
      finished_at: new Date().toISOString(),
      error
    });
    return updated
      ? await enrichTaskProgress(updated, workspaceRoot)
      : { ...enriched, status: "failed", error };
  }

  // Skip log error scan for download tasks
  if (task.status === "succeeded" && task.log_path && task.type !== "download") {
    const logErrors = await scanLogForErrors(task.log_path);
    if (logErrors) {
      const updated = await updateTask(task.id, {
        status: "failed", error: logErrors,
        metadata: metadataWithFailedRuntimeStage(task),
        finished_at: task.finished_at ?? new Date().toISOString()
      });
      return updated
        ? await enrichTaskProgress(updated, workspaceRoot)
        : { ...enriched, status: "failed", error: logErrors };
    }
  }
  return enriched;
}

async function tryPromoteCompleteStagedDownload(
  task: TaskRecord,
  enriched: TaskRecord & { downloaded_bytes?: number; total_bytes?: number },
  workspaceRoot: string
): Promise<TaskRecord | undefined> {
  if (task.type !== "download" || task.status !== "failed") return undefined;
  if (await isTaskProcessActive(task)) return undefined;
  const targetPath = typeof task.metadata?.target_path === "string"
    ? resolve(workspaceRoot, task.metadata.target_path)
    : undefined;
  if (!targetPath || !isInside(resolve(workspaceRoot), targetPath)) return undefined;
  const tempPath = join(targetPath, ".temp");
  const tempComplete = await looksCompleteStagedPayload(tempPath);
  const enoughBytes = stagedDownloadHasExpectedBytes(enriched.downloaded_bytes, enriched.total_bytes);
  if (!tempComplete || !enoughBytes) return undefined;

  await promoteTempDirectory(tempPath, targetPath);
  await writeFile(join(targetPath, ".download-complete"), "", "utf-8");
  const updated = await updateTask(task.id, {
    status: "succeeded",
    finished_at: new Date().toISOString(),
    error: undefined
  });
  return updated ? await enrichTaskProgress(updated, workspaceRoot) : { ...enriched, status: "succeeded", error: undefined };
}

function stagedDownloadHasExpectedBytes(downloadedBytes?: number, totalBytes?: number): boolean {
  if (!downloadedBytes || !totalBytes) return false;
  const tolerance = Math.max(1024 * 1024, totalBytes * 0.001);
  return downloadedBytes >= totalBytes - tolerance;
}

async function promoteTempDirectory(tempPath: string, targetPath: string): Promise<void> {
  const entries = await readdir(tempPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const source = join(tempPath, entry.name);
    const destination = join(targetPath, entry.name);
    await rm(destination, { recursive: true, force: true });
    await rename(source, destination);
  }
  await rm(tempPath, { recursive: true, force: true });
}

async function looksCompleteStagedPayload(tempPath: string): Promise<boolean> {
  const files = await listFiles(tempPath);
  if (!files.length) return false;
  if (files.some((file) => file.includes(".incomplete"))) return false;
  const integrity = await inspectModelIntegrity(tempPath);
  if (integrity.missing_indexed_weight_files.length > 0) return false;
  const names = new Set(files.map((file) => file.split("/").pop() ?? file));
  const hasConfig = names.has("config.json") || names.has("configuration.json") || names.has("config.yaml");
  const hasWeight = files.some(isWeightFile);
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

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + "/");
}

function isLatestCustomProfileTask(task: TaskRecord): boolean {
  const profileId = String(task.metadata?.profile_id ?? "");
  if (!profileId) return false;
  const latest = listTasks().find((candidate) =>
    candidate.type === "container" && candidate.metadata?.action === "start_custom_profile" && candidate.metadata?.profile_id === profileId
  );
  return latest?.id === task.id;
}
async function reconcileDeployRuntimeTask(task: TaskRecord, workspaceRoot: string): Promise<TaskRecord | undefined> {
  const isCustomProfile = task.type === "container" && task.metadata?.action === "start_custom_profile";
  if (isCustomProfile && !isLatestCustomProfileTask(task)) return undefined;
  const isRuntimeDeployment = task.type === "deploy" || isCustomProfile;
  if (!isRuntimeDeployment || !["running", "failed"].includes(task.status)) return undefined;
  const runtimePlan = task.metadata?.runtime_plan as { current_stage?: unknown; stage_statuses?: Record<string, string> } | undefined;
  const runtimeStage = typeof runtimePlan?.current_stage === "string" ? runtimePlan.current_stage : "";
  // A deployment removes an older container before starting its replacement. During
  // prepare/pull/start the running task can therefore legitimately have no container.
  // Keep it loading so polling clients do not render a transient failure.
  const taskProcessActive = await isTaskProcessActive(task);
  const runtimeStillLaunching = runtimeLaunchShouldRemainRunning(task, runtimeStage, taskProcessActive);
  if (runtimeStillLaunching) {
    if (task.status === "failed") {
      const launchProgress = { prepare: 10, pull: 30, start: 55 }[runtimeStage] ?? 10;
      const updated = await updateTask(task.id, {
        status: "running",
        metadata: {
          ...task.metadata,
          runtime_plan: {
            ...runtimePlan,
            current_stage: runtimeStage,
            progress_percent: launchProgress,
            stage_statuses: { ...(runtimePlan?.stage_statuses ?? {}), [runtimeStage]: "running" }
          }
        },
        error: undefined,
        finished_at: undefined
      });
      return updated ? await enrichTaskProgress(updated, workspaceRoot) : { ...task, status: "running", error: undefined };
    }
    return await enrichTaskProgress(task, workspaceRoot);
  }
  const containerName = typeof task.metadata?.container_name === "string" ? task.metadata.container_name : "";
  if (!containerName) return undefined;
  const containerRunning = await deployContainerIsRunning(containerName);
  if (!containerRunning) {
    const exitSummary = await dockerContainerExitSummary(containerName);
    const currentError = String(task.error ?? "").trim();
    const currentLooksUseful = Boolean(currentError) && currentError !== staleRuntimeProcessError() && /(?:error|exception|traceback|out of memory|oom|memory reserve|timeout|unable to|stopped before)/i.test(currentError);
    const error = currentLooksUseful ? currentError : exitSummary || "Custom runtime stopped before becoming ready.";
    const updated = await updateTask(task.id, {
      status: "failed",
      metadata: metadataWithFailedRuntimeStage(task),
      finished_at: task.finished_at ?? new Date().toISOString(),
      error
    });
    return updated ? await enrichTaskProgress(updated, workspaceRoot) : { ...task, status: "failed", error };
  }

  if (await deployRuntimeIsReady(task)) {
    const updated = await updateTask(task.id, {
      status: "succeeded",
      metadata: metadataWithRuntimeStage(task, "health", "succeeded", 100),
      finished_at: new Date().toISOString(),
      error: undefined
    });
    return updated ? await enrichTaskProgress(updated, workspaceRoot) : { ...task, status: "succeeded", error: undefined };
  }

  if (isCustomProfile) {
    const created = Date.parse(task.created_at ?? "");
    if (Number.isFinite(created) && Date.now() - created >= 15 * 60 * 1000) {
      const error = "Custom runtime readiness timeout after 15 minutes; the container was stopped.";
      await runCommand("docker", ["stop", containerName], 60000);
      const updated = await updateTask(task.id, {
        status: "failed",
        metadata: metadataWithFailedRuntimeStage(task),
        finished_at: new Date().toISOString(),
        error
      });
      return updated ? await enrichTaskProgress(updated, workspaceRoot) : { ...task, status: "failed", error };
    }
  }
  const plan = task.metadata?.runtime_plan as { current_stage?: unknown; stage_statuses?: Record<string, string> } | undefined;
  const currentStage = typeof plan?.current_stage === "string" ? plan.current_stage : "";
  const loadingLooksFailed = currentStage === "load" && plan?.stage_statuses?.load === "failed";
  if (task.status === "failed" || task.error === staleRuntimeProcessError() || loadingLooksFailed) {
    const updated = await updateTask(task.id, {
      status: "running",
      metadata: metadataWithRuntimeStage(task, "load", "running", isCustomProfile ? 45 : 82),
      error: undefined
    });
    return updated ? await enrichTaskProgress(updated, workspaceRoot) : { ...task, status: "running", error: undefined };
  }
  return await enrichTaskProgress(task, workspaceRoot);
}

export function runtimeLaunchShouldRemainRunning(
  task: Pick<TaskRecord, "status" | "created_at">,
  runtimeStage: string,
  taskProcessActive: boolean,
  now = Date.now()
): boolean {
  if (!["prepare", "pull", "start"].includes(runtimeStage)) return false;
  if (task.status === "failed") return taskProcessActive;
  if (task.status !== "running") return false;
  const created = Date.parse(task.created_at ?? "");
  const withinStartupGrace = Number.isFinite(created) && now - created < 90_000;
  return withinStartupGrace || taskProcessActive;
}

async function deployContainerIsRunning(containerName: string): Promise<boolean> {
  const docker = await runCommand("docker", ["ps", "--filter", "name=^" + containerName + "$", "--format", "{{.Names}}"], 3000);
  if (!docker.ok) return true;
  return docker.stdout.split(/\r?\n/).some((name) => name.trim() === containerName);
}


async function dockerContainerExitSummary(containerName: string): Promise<string> {
  const inspected = await runCommand("docker", ["inspect", "-f", "{{json .State}}", containerName], 5000);
  if (!inspected.ok || !inspected.stdout.trim()) return "";
  try {
    const state = JSON.parse(inspected.stdout) as { Status?: unknown; ExitCode?: unknown; OOMKilled?: unknown };
    const status = String(state.Status ?? "unknown");
    const exitCode = Number(state.ExitCode ?? 0);
    if (state.OOMKilled === true) return "Custom runtime was killed by the out-of-memory controller (status=" + status + ", exit_code=" + exitCode + ").";
    if (exitCode === 137) return "Custom runtime received SIGKILL (status=" + status + ", exit_code=137). It was stopped by resource protection or an external process.";
    return "Custom runtime stopped before becoming ready (status=" + status + ", exit_code=" + exitCode + ").";
  } catch {
    return "Custom runtime stopped before becoming ready.";
  }
}
async function deployRuntimeIsReady(task: TaskRecord): Promise<boolean> {
  const plan = task.metadata?.runtime_plan as { health_url?: unknown; base_url?: unknown } | undefined;
  const healthUrl = typeof plan?.health_url === "string" ? plan.health_url : "";
  const baseUrl = typeof plan?.base_url === "string" ? plan.base_url : "";
  if (!healthUrl || !(await urlOk(healthUrl))) return false;
  const openaiModel = typeof task.metadata?.openai_model === "string" ? task.metadata.openai_model : "";
  if (!openaiModel || !baseUrl) return true;
  const modelPath = task.metadata?.action === "start_custom_profile" ? "/v1/models" : "/models";
  const models = await fetchRuntimeModels(baseUrl.replace(/\/$/, "") + modelPath);
  return models.includes(openaiModel);
}

async function urlOk(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function fetchRuntimeModels(url: string): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return [];
    const payload = await response.json() as { data?: Array<{ id?: unknown }> };
    return (payload.data ?? []).map((item) => String(item.id ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

function metadataWithRuntimeStage(
  task: TaskRecord,
  currentStage: "load" | "health",
  status: "running" | "succeeded",
  progressPercent: number
): Record<string, unknown> {
  const plan = task.metadata?.runtime_plan;
  if (!plan || typeof plan !== "object") return task.metadata;
  const existingPlan = plan as { stage_statuses?: Record<string, string> };
  const stage_statuses = { ...(existingPlan.stage_statuses ?? {}) };
  stage_statuses.prepare = "succeeded";
  stage_statuses.pull = "succeeded";
  stage_statuses.start = "succeeded";
  if (currentStage === "load") {
    stage_statuses.load = status;
    stage_statuses.health = stage_statuses.health === "succeeded" ? "succeeded" : "pending";
  } else {
    stage_statuses.load = "succeeded";
    stage_statuses.health = status;
  }
  return {
    ...task.metadata,
    runtime_plan: {
      ...existingPlan,
      current_stage: currentStage,
      progress_percent: progressPercent,
      stage_statuses
    }
  };
}

async function normalizeFailedRuntimePlan(task: TaskRecord): Promise<TaskRecord | undefined> {
  if (task.status !== "failed") return undefined;
  const plan = task.metadata?.runtime_plan;
  if (!plan || typeof plan !== "object") return undefined;
  const existingPlan = plan as { current_stage?: unknown; stage_statuses?: Record<string, string> };
  const currentStage = typeof existingPlan.current_stage === "string" ? existingPlan.current_stage : undefined;
  if (!currentStage || existingPlan.stage_statuses?.[currentStage] === "failed") return undefined;
  const updated = await updateTask(task.id, { metadata: metadataWithFailedRuntimeStage(task) });
  return updated;
}

function staleDownloadProcessError(): string {
  return "Download task process is no longer active.";
}

function staleRuntimeProcessError(): string {
  return "Task process was interrupted or the management service restarted before completion.";
}

function isInterruptedProcessError(task: TaskRecord): boolean {
  return task.type === "download"
    ? task.error === staleDownloadProcessError()
    : task.error === staleRuntimeProcessError();
}

function taskIsWithinStartupGrace(task: TaskRecord): boolean {
  const created = Date.parse(task.created_at ?? "");
  return Number.isFinite(created) && Date.now() - created < 90_000;
}

function metadataWithFailedRuntimeStage(task: TaskRecord): Record<string, unknown> {
  const plan = task.metadata?.runtime_plan;
  if (!plan || typeof plan !== "object") return task.metadata;
  const existingPlan = plan as { current_stage?: unknown; stage_statuses?: Record<string, string> };
  const currentStage = typeof existingPlan.current_stage === "string" ? existingPlan.current_stage : undefined;
  if (!currentStage) return task.metadata;
  return {
    ...task.metadata,
    runtime_plan: {
      ...existingPlan,
      stage_statuses: { ...(existingPlan.stage_statuses ?? {}), [currentStage]: "failed" }
    }
  };
}

async function scanLogForErrors(logPath: string): Promise<string | null> {
  try {
    const content = await readFile(logPath, "utf-8");
    const errorLines: string[] = [];
    for (const line of content.split("\n")) {
      if (
        /\b(ERROR|FATAL|Error:|error:|Traceback|exception|failed|Failed)\b/.test(line) &&
        !/\b(exit 0|succeeded|download completed|Download finished|100%|model ready)\b/i.test(line)
      ) {
        errorLines.push(line.trim());
      }
    }
    if (errorLines.length > 0) {
      return "Log contains error indicators: " + errorLines.slice(0, 3).join(" | ") + (errorLines.length > 3 ? " ..." : "");
    }
  } catch { /* log file not readable */ }
  return null;
}

async function isTaskProcessActive(task: {
  command: string; metadata: Record<string, unknown>; type: string;
}): Promise<boolean> {
  if (task.type === "download") {
    const containerName = typeof task.metadata?.download_container_name === "string" ? task.metadata.download_container_name : "";
    if (containerName) {
      const docker = await runCommand("docker", ["ps", "--filter", "name=^" + containerName + "$", "--format", "{{.Names}}"], 3000);
      if (docker.ok) return docker.stdout.split(/\r?\n/).some((name) => name.trim() === containerName);
    }

    const result = await runCommand("ps", ["-eo", "args="], 3000);
    if (!result.ok || !result.stdout) return true;
    const haystack = result.stdout;
    const tokens = [task.command, String(task.metadata?.repo_id ?? ""), String(task.metadata?.alias ?? "")].filter((token) => token.length > 4);
    return tokens.some((token) => haystack.includes(token));
  }

  if (task.type === "deploy") {
    const plan = task.metadata?.runtime_plan as { deployment_id?: unknown } | undefined;
    const deploymentId = typeof plan?.deployment_id === "string" ? plan.deployment_id : "";
    const containerName = typeof task.metadata?.container_name === "string" ? task.metadata.container_name : "";
    if (containerName && await deployContainerIsRunning(containerName)) return true;
    const result = await runCommand("ps", ["-eo", "args="], 3000);
    if (!result.ok || !result.stdout) return true;
    return [deploymentId, containerName].some((token) => token.length > 4 && result.stdout.includes(token));
  }

  const result = await runCommand("ps", ["-eo", "args="], 3000);
  if (!result.ok || !result.stdout) return true;
  const tokens = [
    String(task.metadata?.name ?? ""),
    String(task.metadata?.profile_id ?? ""),
    String(task.metadata?.compose_yaml_path ?? "")
  ].filter((token) => token.length > 4);
  return tokens.some((token) => result.stdout.includes(token));
}
