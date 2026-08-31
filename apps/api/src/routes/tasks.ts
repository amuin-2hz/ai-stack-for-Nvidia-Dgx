import { readFile } from "node:fs/promises";
import { readBody, sendJson } from "../serverUtils.js";
import { deleteTask, getContainerConfig, getTask, listModelFilesForTask, listTasks, setContainerConfig, updateTask } from "../store.js";
import { cleanupDownloadTarget, cleanupDownloadTemp, DownloadConflictError, startDownload } from "../downloadManager.js";
import { syncDownloadTaskFiles } from "../taskProgress.js";
import { diagnoseTask } from "../taskDiagnostics.js";
import { reconcileTask } from "../taskReconciler.js";
import { cancelManagedTask, pauseManagedTask, resumeManagedTask } from "../taskRunner.js";
import { applyContainerRuntimeConfig, containerAction, createImagePullTask, listContainers } from "../containerManager.js";

import { runCommand } from "../utils.js";
export function register(
  route: (method: string, path: string, handler: (...args: any[]) => Promise<void>) => void,
  workspaceRoot: string,
  logsRoot: string
) {
  route("GET", "/tasks", async (_req: any, res: any) => {
    const tasks = await Promise.all(listTasks().map((t: any) => taskWithFiles(t, workspaceRoot)));
    sendJson(res, 200, { tasks });
  });

  route("GET", "/tasks/:task_id", async (_req: any, res: any, params: any) => {
    const task = getTask(params.task_id);
    if (!task) return sendJson(res, 404, { detail: "Unknown task: " + params.task_id });
    sendJson(res, 200, await taskWithFiles(task, workspaceRoot));
  });

  route("GET", "/tasks/:task_id/logs", async (_req: any, res: any, params: any) => {
    const task = getTask(params.task_id);
    if (!task) return sendJson(res, 404, { detail: "Unknown task: " + params.task_id });
    let logs = await readFile(task.log_path, "utf-8").catch(() => "");
    if (task.type === "container" && task.metadata?.action === "start_custom_profile" && ["queued", "running"].includes(task.status)) {
      const containerName = String(task.metadata?.container_name ?? task.metadata?.name ?? "");
      if (containerName) {
        const runtimeLog = await runCommand("docker", ["logs", "--tail", "240", containerName], 10000);
        const live = [runtimeLog.stdout, runtimeLog.stderr].filter(Boolean).join("\n").trim();
        if (live) logs += (logs ? "\n\n" : "") + "--- live runtime log: " + containerName + " ---\n" + live;
      }
    }
    if (!logs) {
      logs = ["queued", "running"].includes(task.status)
        ? "Task log is being prepared. Runtime output will appear here shortly."
        : "No task log output is available.";
    }
    sendJson(res, 200, { task_id: task.id, log_path: task.log_path, logs });
  });

  route("POST", "/tasks/:task_id/pause", async (_req: any, res: any, params: any) => {
    const task = getTask(params.task_id);
    if (!task) return sendJson(res, 404, { detail: "Unknown task: " + params.task_id });
    if (task.type !== "download") return sendJson(res, 400, { detail: "Only download tasks can be paused." });
    const result = await pauseManagedTask(task.id);
    sendJson(res, result.ok ? 200 : 409, result);
  });

  route("POST", "/tasks/:task_id/resume", async (_req: any, res: any, params: any) => {
    const task = getTask(params.task_id);
    if (!task) return sendJson(res, 404, { detail: "Unknown task: " + params.task_id });
    if (task.type !== "download") return sendJson(res, 400, { detail: "Only download tasks can be resumed." });
    const result = await resumeManagedTask(task.id);
    sendJson(res, result.ok ? 200 : 409, result);
  });

  route("POST", "/tasks/:task_id/repair", async (req: any, res: any, params: any) => {
    const task = getTask(params.task_id);
    if (!task) return sendJson(res, 404, { detail: "Unknown task: " + params.task_id });
    const body = await readBody<{ action?: string; runtime?: string; public_port?: number; image?: string }>(req);
    if (!body.action) return sendJson(res, 400, { detail: "action is required" });
    try {
      const enriched = await taskWithFiles(task, workspaceRoot);
      if (!repairActionAllowed(enriched, body.action)) {
        return sendJson(res, 400, { detail: "Repair action is not available for this task diagnostic." });
      }
      sendJson(res, 200, await runRepairAction(task, body.action, workspaceRoot, logsRoot, body.runtime, body.public_port, body.image));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  route("POST", "/tasks/:task_id/cancel", async (_req: any, res: any, params: any) => {
    const task = getTask(params.task_id);
    if (!task) return sendJson(res, 404, { detail: "Unknown task: " + params.task_id });
    if (task.type !== "download") return sendJson(res, 400, { detail: "Only download tasks can be canceled." });
    const result = await cancelManagedTask(task.id);
    if (!result.ok && /not active/i.test(result.detail)) {
      const cleaned_temp_path = await cleanupDownloadTemp(task.metadata, workspaceRoot);
      await updateTask(task.id, { status: "canceled", finished_at: new Date().toISOString(), error: undefined });
      return sendJson(res, 200, { ok: true, detail: "Task process is not active; cleaned any staged download files.", cleaned_temp_path });
    }
    sendJson(res, result.ok ? 200 : 409, result);
  });

  route("POST", "/tasks/:task_id/retry", async (_req: any, res: any, params: any) => {
    const task = getTask(params.task_id);
    if (!task) return sendJson(res, 404, { detail: "Unknown task: " + params.task_id });
    const current = await reconcileTask(task, workspaceRoot) ?? task;
    if (current.type !== "download") return sendJson(res, 400, { detail: "Only download tasks can be retried." });
    if (["queued", "running", "paused", "canceling"].includes(current.status)) {
      return sendJson(res, 200, { status: "existing_download", existing_download: true, message: "Download task is already active.", task: current });
    }
    if (!["failed", "canceled"].includes(current.status)) return sendJson(res, 409, { detail: "Only failed or canceled downloads can be retried." });
    const provider = String(current.metadata?.provider ?? "");
    const repoId = String(current.metadata?.repo_id ?? "");
    const alias = String(current.metadata?.alias ?? "");
    if (!provider || !repoId || !alias) return sendJson(res, 400, { detail: "Download metadata is incomplete; start a new download from the model URL." });
    const url = provider === "modelscope" ? "https://modelscope.cn/models/" + repoId : "https://huggingface.co/" + repoId;
    try {
      const result = await startDownload({ url, alias, provider, expected_runtime: String(current.metadata?.expected_runtime ?? "auto"), force: true }, workspaceRoot, logsRoot);
      const cleared_task_ids = deleteRestartedDownloadTaskGroup(current);
      sendJson(res, 202, { ...result, cleared_task_ids });
    } catch (error) {
      if (error instanceof DownloadConflictError) {
        const cleared_task_ids = deleteRestartedDownloadTaskGroup(current);
        return sendJson(res, 200, { status: "existing_download", existing_download: true, message: error.message, task: error.task, cleared_task_ids });
      }
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  route("DELETE", "/tasks/:task_id", async (req: any, res: any, params: any) => {
    const task = getTask(params.task_id);
    if (!task) return sendJson(res, 404, { detail: "Unknown task: " + params.task_id });
    if (["queued", "running", "paused", "canceling"].includes(task.status)) {
      return sendJson(res, 409, { detail: "Active tasks must be canceled before they can be cleared." });
    }
    const body = await readBody<{ delete_files?: boolean }>(req).catch(() => ({ delete_files: false }));
    let deleted_target_path: string | undefined;
    if (body.delete_files === true && task.type === "download" && ["failed", "canceled"].includes(task.status)) {
      deleted_target_path = await cleanupDownloadTarget(task.metadata, workspaceRoot);
    }
    const deletedTaskIds = deleteFinishedDownloadTaskGroup(task);
    const deleted = deletedTaskIds.length > 0;
    sendJson(res, deleted ? 200 : 404, { ok: deleted, task_id: task.id, deleted_task_ids: deletedTaskIds, deleted_target_path });
  });
}

const finishedDownloadStatuses = new Set(["succeeded", "failed", "canceled"]);

function downloadTaskCleanupKey(task: any): string {
  const metadata = task.metadata ?? {};
  return [
    metadata.target_path,
    metadata.provider,
    metadata.repo_id,
    metadata.alias,
    metadata.model_id
  ].filter(Boolean).join(":") || task.id;
}

function deleteFinishedDownloadTaskGroup(task: any): string[] {
  if (task.type !== "download" || !finishedDownloadStatuses.has(task.status)) {
    return deleteTask(task.id) ? [task.id] : [];
  }
  const key = downloadTaskCleanupKey(task);
  const deleted: string[] = [];
  for (const candidate of listTasks()) {
    if (candidate.type !== "download" || !finishedDownloadStatuses.has(candidate.status)) continue;
    if (downloadTaskCleanupKey(candidate) !== key) continue;
    if (deleteTask(candidate.id)) deleted.push(candidate.id);
  }
  return deleted;
}

function deleteRestartedDownloadTaskGroup(task: any): string[] {
  if (task.type !== "download") return [];
  const restartableStatuses = new Set(["failed", "canceled"]);
  const key = downloadTaskCleanupKey(task);
  const deleted: string[] = [];
  for (const candidate of listTasks()) {
    if (candidate.type !== "download" || !restartableStatuses.has(candidate.status)) continue;
    if (downloadTaskCleanupKey(candidate) !== key) continue;
    if (deleteTask(candidate.id)) deleted.push(candidate.id);
  }
  return deleted;
}

async function taskWithFiles(task: any, workspaceRoot: string) {
  const reconciled = await reconcileTask(task, workspaceRoot);
  if (!reconciled) return reconciled;
  const diagnostic = await diagnoseTask(reconciled);
  const base = diagnostic ? { ...reconciled, diagnostic } : reconciled;
  if (base.type !== "download") return base;
  await syncDownloadTaskFiles(base as any, workspaceRoot);
  return { ...base, model_files: listModelFilesForTask(base.id) };
}

async function runRepairAction(task: any, action: string, workspaceRoot: string, logsRoot: string, requestedRuntime?: string, requestedPort?: number, requestedImage?: string) {
  const runtime = requestedRuntime || runtimeFromTask(task);
  if (action === "view_logs") {
    return { action, executable: true, logs_url: "/tasks/" + encodeURIComponent(task.id) + "/logs" };
  }
  if (action === "inspect_model_files") {
    const modelId = String(task.metadata?.model_id ?? task.metadata?.alias ?? "");
    return modelId
      ? { action, executable: true, model_files_url: "/models/" + encodeURIComponent(modelId) + "/files" }
      : { action, executable: false, detail: "No model id or alias is available on this task." };
  }
  if (action === "redownload_model") {
    const cleaned_temp_path = await cleanupDownloadTemp(task.metadata, workspaceRoot);
    return { action, executable: true, cleaned_temp_path, detail: "Staged download files were cleaned. Start the download again from the model URL." };
  }
  if (action === "pull_image") {
    if (!runtime) return { action, executable: false, detail: "No runtime key is available for this task." };
    return { action, executable: true, ...(await createImagePullTask(runtime, workspaceRoot, logsRoot)) };
  }
  if (action === "stop_other_runtimes") {
    const payload = await listContainers();
    const currentContainerName = String(task.metadata?.container_name ?? "");
    const stopped = [];
    for (const container of payload.containers) {
      if (!["vllm", "trtllm", "pytorch"].includes(container.runtime)) continue;
      if (container.state !== "running") continue;
      const name = container.instance_name || container.name;
      if (currentContainerName && name === currentContainerName) continue;
      stopped.push(await containerAction(name, "stop"));
    }
    return { action, executable: true, stopped };
  }
  if (action === "restart_runtime") {
    const payload = await listContainers();
    const container = payload.containers.find((item) => item.runtime === runtime);
    if (!container) return { action, executable: false, detail: "No matching runtime container was found." };
    const name = container.instance_name || container.name;
    return { action, executable: true, result: await containerAction(name, "restart") };
  }
  if (action === "stop_conflicting_service") {
    return { action, executable: false, detail: "The conflicting process may be outside AMUIN. Change the runtime port or stop the process manually." };
  }
  if (action === "change_port") {
    if (!runtime) return { action, executable: false, detail: "No runtime key is available for this task." };
    const publicPort = Number(requestedPort);
    if (!Number.isInteger(publicPort) || publicPort < 1024 || publicPort > 65535) {
      return { action, executable: false, detail: "public_port must be an integer between 1024 and 65535." };
    }
    const current = getContainerConfig(runtime);
    if (!current) return { action, executable: false, detail: "No runtime configuration was found for " + runtime + "." };
    const settings = setContainerConfig(runtime, { ...current, public_port: publicPort });
    return { action, executable: true, settings, apply: await applyContainerRuntimeConfig(runtime, settings), detail: "Runtime public port was updated to " + publicPort + ". Recreate or redeploy the runtime to use the new port." };
  }
  if (action === "change_image") {
    if (!runtime) return { action, executable: false, detail: "No runtime key is available for this task." };
    const image = String(requestedImage ?? "").trim();
    if (!image || /\s/.test(image)) {
      return { action, executable: false, detail: "image must be a non-empty container image reference without whitespace." };
    }
    const current = getContainerConfig(runtime);
    if (!current) return { action, executable: false, detail: "No runtime configuration was found for " + runtime + "." };
    const settings = setContainerConfig(runtime, { ...current, image });
    return { action, executable: true, settings, detail: "Runtime image was updated to " + image + ". Pull the image or redeploy the runtime to use it." };
  }
  if (action === "reset_runtime_params") {
    return { action, executable: false, detail: "Runtime parameters are request-scoped. Open the deploy panel and use the default parameter values." };
  }
  if (action === "increase_gpu_memory_utilization") {
    return { action, executable: false, detail: "Increase GPU memory utilization in the deploy panel, stop other GPU runtimes, then retry." };
  }
  if (action === "lower_context_length") {
    return { action, executable: false, detail: "Lower context length/max tokens in the deploy panel, then retry." };
  }
  if (action === "choose_smaller_model") {
    return { action, executable: false, detail: "Choose a smaller or quantized model from the model library." };
  }
  if (action === "check_network") {
    return { action, executable: false, detail: "Check proxy/network settings in configs/proxy.env, then retry." };
  }
  if (action === "start_docker" || action === "check_docker_socket") {
    return { action, executable: false, detail: "Docker must be started or repaired on the host outside the API process." };
  }
  return { action, executable: false, detail: "Unsupported repair action: " + action };
}

function runtimeFromTask(task: any): string | undefined {
  const value = String(task.metadata?.key ?? task.metadata?.service_type ?? task.metadata?.runtime ?? "");
  return ["vllm", "trtllm", "pytorch"].includes(value) ? value : undefined;
}

function repairActionAllowed(task: any, action?: string): boolean {
  if (!action) return false;
  if (action === "view_logs") return true;
  return Boolean(task?.diagnostic?.repair_actions?.some((item: any) => item.action === action));
}
