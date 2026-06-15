import Busboy from "busboy";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createWriteStream } from "node:fs";
import { WebSocket, WebSocketServer } from "ws";
import { StateStore } from "./state.js";
import { createDownloadPlan, startDownload } from "./downloadManager.js";
import { createDeploymentPlan as buildDeploymentPlan, startDeployment } from "./deploymentManager.js";
import {
  compatibilityFor,
  deleteModel,
  getModel,
  listDeployments,
  listModels
} from "./modelRegistry.js";
import { systemCheck } from "./systemInspector.js";
import { applyContainerRuntimeConfig, containerAction, containerLogs, createCustomContainerTask, createImagePullTask, createImageTestTask, listContainers } from "./containerManager.js";
import { enrichTaskProgress } from "./taskProgress.js";
import { newId, runCommand } from "./utils.js";
import type { ChatMessage, ServiceType } from "./types.js";

const port = Number(process.env.PORT ?? "8000");
const workspaceRoot = process.env.AI_STACK_BASE ?? resolve(process.cwd(), "../..");
const modelsRoot = process.env.MODELS_ROOT ?? join(workspaceRoot, "models");
const stateRoot = process.env.STATE_ROOT ?? join(workspaceRoot, "state");
const uploadsRoot = process.env.UPLOADS_ROOT ?? join(stateRoot, "uploads");
const logsRoot = process.env.LOGS_ROOT ?? join(workspaceRoot, "logs");
const audioServiceUrl = process.env.AUDIO_SERVICE_URL ?? "http://127.0.0.1:32000";
const audioServiceWsUrl = process.env.AUDIO_SERVICE_WS_URL ?? "ws://127.0.0.1:32000/ws/realtime";
const store = new StateStore(join(stateRoot, "workbench-state.json"));

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:[^/]+/g, (match) => {
    keys.push(match.slice(1));
    return "([^/]+)";
  })}$`);
  routes.push({ method, pattern, keys, handler });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*"
  });
  res.end(body);
}

async function readBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function getPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

async function reconcileTask(task: Awaited<ReturnType<StateStore["getTask"]>>) {
  if (!task) return task;
  const enriched = await enrichTaskProgress(task, workspaceRoot);
  if (task.type === "download" && enriched.complete_on_disk && task.status !== "succeeded") {
    const updated = await store.updateTask(task.id, { status: "succeeded", finished_at: new Date().toISOString(), error: undefined });
    return updated ? await enrichTaskProgress(updated, workspaceRoot) : { ...enriched, status: "succeeded" };
  }
  if (task.status === "running" && !(await isTaskProcessActive(task))) {
    const updated = await store.updateTask(task.id, { status: "failed", finished_at: new Date().toISOString(), error: "Task process was interrupted or the management service restarted before completion." });
    return updated ? await enrichTaskProgress(updated, workspaceRoot) : { ...enriched, status: "failed", error: "Task process was interrupted or the management service restarted before completion." };
  }
  if (task.status === "succeeded" && task.log_path) {
    const logErrors = await scanLogForErrors(task.log_path);
    if (logErrors) {
      const updated = await store.updateTask(task.id, { status: "failed", error: logErrors, finished_at: task.finished_at ?? new Date().toISOString() });
      return updated ? await enrichTaskProgress(updated, workspaceRoot) : { ...enriched, status: "failed", error: logErrors };
    }
  }
  return enriched;
}

async function scanLogForErrors(logPath: string): Promise<string | null> {
  try {
    const content = await readFile(logPath, "utf-8");
    const errorLines: string[] = [];
    for (const line of content.split("\n")) {
      if (/\b(ERROR|FATAL|Error:|error:|Traceback|exception|failed|Failed)\b/.test(line) &&
          !/\b(exit 0|succeeded|download completed|Download finished|100%|model ready)\b/i.test(line)) {
        errorLines.push(line.trim());
      }
    }
    if (errorLines.length > 0) {
      return "Log contains error indicators: " + errorLines.slice(0, 3).join(" | ") + (errorLines.length > 3 ? " ..." : "");
    }
  } catch { /* log file not readable */ }
  return null;
}

async function isTaskProcessActive(task: { command: string; metadata: Record<string, unknown>; type: string }): Promise<boolean> {
  const result = await runCommand("ps", ["-eo", "args="], 3000);
  if (!result.ok || !result.stdout) return true;
  const haystack = result.stdout;
  const tokens = [task.command, String(task.metadata?.repo_id ?? ""), String(task.metadata?.alias ?? ""), String(task.metadata?.model_id ?? ""), String(task.metadata?.name ?? "")].filter((token) => token.length > 4);
  return tokens.some((token) => haystack.includes(token));
}

route("GET", "/healthz", async (_req, res) => {
  sendJson(res, 200, { status: "ok", runtime: "node" });
});

route("GET", "/system/check", async (_req, res) => {
  const workbench = await store.workbenchSettings();
  sendJson(res, 200, {
    ...(await systemCheck()),
    management_url: "http://localhost:" + workbench.active_management_port,
    configured_management_url: "http://localhost:" + workbench.management_port,
    workbench,
    network: await store.networkSettings()
  });
});


route("GET", "/settings/workbench", async (_req, res) => {
  sendJson(res, 200, await store.workbenchSettings());
});

route("POST", "/settings/workbench", async (req, res) => {
  const body = await readBody<{ management_port?: number }>(req);
  const port = Number(body.management_port);
  try {
    sendJson(res, 200, await store.setManagementPort(port));
  } catch (error) {
    sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
  }
});

route("GET", "/settings/network", async (_req, res) => {
  sendJson(res, 200, await store.networkSettings());
});

route("POST", "/settings/network", async (req, res) => {
  const body = await readBody<{ lan_access_enabled?: boolean }>(req);
  if (typeof body.lan_access_enabled !== "boolean") return sendJson(res, 400, { detail: "lan_access_enabled boolean is required" });
  sendJson(res, 200, await store.setNetworkAccess(body.lan_access_enabled));
});

route("GET", "/models/progress", async (_req, res) => {
  const models = await listModels(modelsRoot);
  sendJson(res, 200, {
    models_dir: modelsRoot,
    model_count: models.length,
    models: models.map((model) => ({
      model: model.display_name,
      path: model.local.path,
      status: model.status.download,
      weight_files: model.local.weight_files,
      weight_bytes: model.local.size_bytes,
      config_files: model.local.config_files,
      incomplete_files: model.local.incomplete_files,
      lock_files: []
    }))
  });
});

route("GET", "/models", async (_req, res) => {
  const models = await listModels(modelsRoot);
  sendJson(res, 200, { models_dir: modelsRoot, model_count: models.length, models });
});

route("GET", "/models/:model_id", async (_req, res, params) => {
  const model = await getModel(modelsRoot, params.model_id);
  if (!model) return sendJson(res, 404, { detail: `Unknown model: ${params.model_id}` });
  sendJson(res, 200, model);
});

route("DELETE", "/models/:model_id", async (_req, res, params) => {
  const model = await getModel(modelsRoot, params.model_id);
  if (!model) return sendJson(res, 404, { detail: "Unknown model: " + params.model_id });
  const activeDeployment = (await store.listActiveDeployments()).find((deployment) => deployment.model_id === model.id && ["running", "starting", "configured"].includes(deployment.status));
  if (activeDeployment) return sendJson(res, 409, { detail: "Model is currently deployed and cannot be deleted.", deployment: activeDeployment });
  const activeTask = (await store.listTasks()).find((task) => ["queued", "running"].includes(task.status) && (task.metadata?.model_id === model.id || task.metadata?.alias === model.id || task.metadata?.alias === model.display_name));
  if (activeTask) return sendJson(res, 409, { detail: "Model has an active task and cannot be deleted.", task: activeTask });
  try {
    sendJson(res, 200, await deleteModel(modelsRoot, params.model_id));
  } catch (error) {
    sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
  }
});

route("POST", "/models/import", async (req, res) => {
  const body = await readBody<{ url?: string; alias?: string; provider?: string }>(req);
  if (!body.url) return sendJson(res, 400, { detail: "url is required" });
  sendJson(res, 200, createDownloadPlan({ url: body.url, alias: body.alias, provider: body.provider }, workspaceRoot));
});

route("POST", "/downloads", async (req, res) => {
  const body = await readBody<{ url?: string; alias?: string; provider?: string }>(req);
  if (!body.url) return sendJson(res, 400, { detail: "url is required" });
  try {
    sendJson(res, 202, await startDownload(store, { url: body.url, alias: body.alias, provider: body.provider }, workspaceRoot, logsRoot));
  } catch (error) {
    sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
  }
});

route("GET", "/tasks", async (_req, res) => {
  const tasks = await Promise.all((await store.listTasks()).map((task) => reconcileTask(task)));
  sendJson(res, 200, { tasks });
});

route("GET", "/tasks/:task_id", async (_req, res, params) => {
  const task = await store.getTask(params.task_id);
  if (!task) return sendJson(res, 404, { detail: "Unknown task: " + params.task_id });
  sendJson(res, 200, await reconcileTask(task));
});
route("GET", "/tasks/:task_id/logs", async (_req, res, params) => {
  const task = await store.getTask(params.task_id);
  if (!task) return sendJson(res, 404, { detail: "Unknown task: " + params.task_id });
  const logs = await readFile(task.log_path, "utf-8").catch((error) => error.message);
  sendJson(res, 200, { task_id: task.id, log_path: task.log_path, logs });
});

route("GET", "/containers", async (_req, res) => {
  sendJson(res, 200, await listContainers(store));
});

route("POST", "/containers/:key/config", async (req, res, params) => {
  const key = decodeURIComponent(params.key);
  const body = await readBody<{ public_port?: number; management_mode?: "resident" | "once"; restart_policy?: "no" | "unless-stopped" | "always" | "on-failure"; auto_restart?: boolean }>(req);
  try {
    const settings = await store.setContainerSettings(key, body);
    const applyResult = await applyContainerRuntimeConfig(key, settings);
    sendJson(res, 200, { settings, apply: applyResult });
  } catch (error) {
    sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
  }
});

route("POST", "/containers/:key/pull-image", async (_req, res, params) => {
  try {
    sendJson(res, 202, await createImagePullTask(store, decodeURIComponent(params.key), workspaceRoot, logsRoot));
  } catch (error) {
    sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
  }
});

route("POST", "/containers/:key/test-image", async (_req, res, params) => {
  try {
    sendJson(res, 202, await createImageTestTask(store, decodeURIComponent(params.key), workspaceRoot, logsRoot));
  } catch (error) {
    sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
  }
});

route("POST", "/containers/custom", async (req, res) => {
  const body = await readBody<{ name?: string; image?: string; components?: string[]; management_mode?: "resident" | "once"; restart_policy?: "no" | "unless-stopped" | "always" | "on-failure"; auto_restart?: boolean }>(req);
  try {
    sendJson(res, 202, await createCustomContainerTask(store, body, workspaceRoot, logsRoot));
  } catch (error) {
    sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
  }
});

route("GET", "/containers/:name/logs", async (req, res, params) => {
  const lines = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("lines") ?? "200");
  sendJson(res, 200, await containerLogs(params.name, lines));
});

route("POST", "/containers/:name/:action", async (_req, res, params) => {
  if (!["start", "stop", "restart"].includes(params.action)) return sendJson(res, 400, { detail: "Unsupported container action: " + params.action });
  sendJson(res, 202, await containerAction(params.name, params.action as "start" | "stop" | "restart"));
});


route("POST", "/models/audit", async (_req, res) => {
  const models = await listModels(modelsRoot);
  sendJson(res, 200, { models_dir: modelsRoot, model_count: models.length, models });
});
route("POST", "/models/:model_id/open-folder", async (_req, res, params) => {
  const model = await getModel(modelsRoot, params.model_id);
  if (!model) return sendJson(res, 404, { detail: "Unknown model: " + params.model_id });
  const modelStat = await stat(model.local.path).catch(() => null);
  const folder = modelStat?.isFile() ? dirname(model.local.path) : model.local.path;
  const result = await runCommand("xdg-open", [folder], 3000);
  sendJson(res, result.ok ? 200 : 202, { folder, ok: result.ok, detail: result.stdout || result.stderr || "open requested" });
});


route("GET", "/deployments", async (_req, res) => {
  const configured = await configuredDeployments();
  const active = await liveActiveDeployments();
  sendJson(res, 200, { deployments: mergeDeployments(configured, active) });
});

route("GET", "/runtimes", async (_req, res) => {
  const deployments = await configuredDeployments();
  sendJson(res, 200, {
    runtimes: deployments.map((deployment) => ({
      service_type: deployment.service_type,
      runtime: deployment.runtime,
      status: deployment.status,
      public_port: deployment.public_port,
      base_url: deployment.base_url,
      health_url: deployment.health_url,
      container_name: deployment.container_name,
      openai_models: deployment.openai_models,
      warnings: deployment.warnings
    }))
  });
});

route("GET", "/deployments/:deployment_id", async (_req, res, params) => {
  const deployment = await findDeployment(params.deployment_id);
  if (!deployment) return sendJson(res, 404, { detail: "Unknown deployment: " + params.deployment_id });
  sendJson(res, 200, deployment);
});

route("GET", "/deployments/:deployment_id/health", async (_req, res, params) => {
  const deployment = await findDeployment(params.deployment_id);
  if (!deployment) return sendJson(res, 404, { detail: "Unknown deployment: " + params.deployment_id });
  const healthTarget = deployment.health_url ?? runtimeHealthUrl(deployment.service_type);
  const result = await proxyHttp("GET", healthTarget);
  sendJson(res, result.ok ? 200 : 503, {
    deployment_id: deployment.deployment_id,
    service_type: deployment.service_type,
    status: result.ok ? "healthy" : "unavailable",
    target: healthTarget,
    response: parseMaybeJson(result.body)
  });
});

route("GET", "/deployments/:deployment_id/logs", async (_req, res, params) => {
  const deployment = await findDeployment(params.deployment_id);
  if (!deployment) return sendJson(res, 404, { detail: "Unknown deployment: " + params.deployment_id });
  sendJson(res, 501, {
    deployment_id: deployment.deployment_id,
    detail: "Container log streaming is not mounted into the Node API container yet.",
    suggested_command: deployment.container_name ? "docker logs --tail 200 " + deployment.container_name : null
  });
});

route("POST", "/deployments/:deployment_id/stop", async (_req, res, params) => {
  const active = await store.getActiveDeployment(params.deployment_id);
  const deployment = active ? normalizeDeployment(active) : await findDeployment(params.deployment_id);
  if (!deployment) return sendJson(res, 404, { detail: "Unknown deployment: " + params.deployment_id });
  if (!deployment.container_name) return sendJson(res, 400, { detail: "Deployment has no container to stop." });
  const result = await runCommand("docker", ["rm", "-f", deployment.container_name], 30000);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const missingContainer = /No such container/i.test(output);
  if (active && (result.ok || missingContainer)) await store.deleteDeployment(params.deployment_id);
  const detail = missingContainer ? "Container was already absent; deployment state is treated as stopped." : output;
  sendJson(res, result.ok || missingContainer ? 200 : 500, { deployment_id: params.deployment_id, container_name: deployment.container_name, status: result.ok || missingContainer ? "stopped" : "failed", detail });
});

route("POST", "/deployments/:deployment_id/restart", async (_req, res, params) => {
  const deployment = await findDeployment(params.deployment_id);
  if (!deployment) return sendJson(res, 404, { detail: "Unknown deployment: " + params.deployment_id });
  sendJson(res, 202, { deployment_id: deployment.deployment_id, status: "restart_requested", detail: "Runtime restart wiring is scheduled for the deployment manager phase." });
});

route("POST", "/runtimes/compatibility", async (req, res) => {
  const body = await readBody<{ model_id?: string; service_type?: ServiceType }>(req);
  if (!body.model_id || !body.service_type) return sendJson(res, 400, { detail: "model_id and service_type are required" });
  const model = await getModel(modelsRoot, body.model_id);
  if (!model) return sendJson(res, 404, { detail: `Unknown model: ${body.model_id}` });
  const compatibility = compatibilityFor(model, body.service_type);
  sendJson(res, 200, {
    status: compatibility.status,
    model_format: model.local.format,
    service_type: body.service_type,
    reason: compatibility.reason,
    warnings: compatibility.status === "compatible" ? [] : [compatibility.reason]
  });
});

route("POST", "/deployments", async (req, res) => {
  const body = await readBody<{ model_id?: string; service_type?: ServiceType; openai_model?: string; args?: Record<string, unknown>; start?: boolean }>(req);
  if (!body.model_id) return sendJson(res, 400, { detail: "model_id is required" });
  const serviceType = body.service_type ?? "vllm";
  const model = await getModel(modelsRoot, body.model_id);
  if (!model) return sendJson(res, 404, { detail: "Unknown model: " + body.model_id });
  const localModelIds = new Set((await listModels(modelsRoot)).map((item) => item.id));
  if (body.openai_model && body.openai_model !== model.id && localModelIds.has(body.openai_model)) return sendJson(res, 409, { detail: "openai_model points to a different local model. Use the selected model id or a custom alias that is not another model id." });
  const compatibility = compatibilityFor(model, serviceType);
  if (compatibility.status === "unsupported") return sendJson(res, 409, { detail: compatibility.reason, compatibility });
  const deployment = (await configuredDeployments()).find((item) => item.service_type === serviceType);
  if (!deployment) return sendJson(res, 400, { detail: "Unknown service type: " + serviceType });
  const containerSettings = await store.getContainerSettings(serviceType);
  if (body.start) {
    sendJson(res, 202, await startDeployment(store, deployment, model, body, workspaceRoot, logsRoot, containerSettings));
    return;
  }
  sendJson(res, 200, buildDeploymentPlan(deployment, model, serviceType, body.openai_model ?? model.id, body.args ?? {}, workspaceRoot, containerSettings));
});

route("POST", "/deployments/start", async (req, res) => {
  const body = await readBody<{ model_id?: string; service_type?: ServiceType; openai_model?: string; args?: Record<string, unknown> }>(req);
  if (!body.model_id) return sendJson(res, 400, { detail: "model_id is required" });
  const serviceType = body.service_type ?? "vllm";
  const model = await getModel(modelsRoot, body.model_id);
  if (!model) return sendJson(res, 404, { detail: "Unknown model: " + body.model_id });
  const localModelIds = new Set((await listModels(modelsRoot)).map((item) => item.id));
  if (body.openai_model && body.openai_model !== model.id && localModelIds.has(body.openai_model)) return sendJson(res, 409, { detail: "openai_model points to a different local model. Use the selected model id or a custom alias that is not another model id." });
  const compatibility = compatibilityFor(model, serviceType);
  if (compatibility.status === "unsupported") return sendJson(res, 409, { detail: compatibility.reason, compatibility });
  const deployment = (await configuredDeployments()).find((item) => item.service_type === serviceType);
  if (!deployment) return sendJson(res, 400, { detail: "Unknown service type: " + serviceType });
  const containerSettings = await store.getContainerSettings(serviceType);
  const existing = (await store.listActiveDeployments()).find((item) => item.service_type === serviceType && item.model_id === model.id && item.openai_model === (body.openai_model ?? model.id) && item.status === "running");
  if (existing) {
    const normalized = normalizeDeployment(existing);
    if (await deploymentContainerIsRunning(normalized.container_name)) {
      return sendJson(res, 200, { ...normalized, status: "already_running", openai_models: [normalized.openai_model], detail: "Deployment is already running." });
    }
    await store.deleteDeployment(normalized.deployment_id);
  }
  sendJson(res, 202, await startDeployment(store, deployment, model, body, workspaceRoot, logsRoot, containerSettings));
});

route("GET", "/selected_sources", async (_req, res) => {
  sendJson(res, 200, { sources: await store.selectedSources() });
});

route("POST", "/selected_sources", async (req, res) => {
  const body = await readBody<unknown>(req);
  const sources = Array.isArray(body) ? body.map(String) : [];
  await store.setSelectedSources(sources);
  sendJson(res, 200, { sources });
});

route("GET", "/selected_model", async (_req, res) => {
  sendJson(res, 200, { model: await store.selectedModel() });
});

route("POST", "/selected_model", async (req, res) => {
  const body = await readBody<{ model?: string }>(req);
  const model = body.model || "";
  await store.setSelectedModel(model);
  sendJson(res, 200, { model });
});

route("GET", "/available_models", async (_req, res) => {
  const registry = await listModels(modelsRoot);
  const runnable = registry
    .filter((model) => ["vllm", "audio", "trtllm", "lmstudio"].includes(model.runtime.preferred))
    .map((model) => model.id);
  const models = runnable.length ? runnable : [await store.selectedModel()];
  sendJson(res, 200, { models });
});

route("GET", "/sources", async (_req, res) => {
  try {
    const entries = await readdir(uploadsRoot, { withFileTypes: true });
    sendJson(res, 200, { sources: entries.filter((entry) => entry.isFile()).map((entry) => entry.name) });
  } catch {
    sendJson(res, 200, { sources: [] });
  }
});

route("POST", "/ingest", async (req, res) => {
  const taskId = newId("ingest");
  await mkdir(uploadsRoot, { recursive: true });
  let fileCount = 0;
  const contentType = req.headers["content-type"] ?? "";
  if (contentType.includes("multipart/form-data")) {
    await new Promise<void>((resolve, reject) => {
      const busboy = Busboy({ headers: req.headers });
      const writes: Promise<void>[] = [];
      busboy.on("file", (_name, file, info) => {
        fileCount += 1;
        const target = join(uploadsRoot, `${Date.now()}-${info.filename.replace(/[/\\]/g, "_")}`);
        const write = createWriteStream(target);
        writes.push(new Promise((fileResolve, fileReject) => {
          write.on("finish", fileResolve);
          write.on("error", fileReject);
        }));
        file.pipe(write);
      });
      busboy.on("finish", () => {
        Promise.all(writes).then(() => resolve()).catch(reject);
      });
      busboy.on("error", reject);
      req.pipe(busboy);
    });
  } else {
    for await (const _chunk of req) {
      // Drain the body.
    }
  }
  await store.setIngestTask(taskId, "completed");
  sendJson(res, 200, { message: `Files queued for processing. Indexed ${fileCount} file(s) in the Node control plane placeholder.`, task_id: taskId });
});

route("GET", "/ingest/status/:task_id", async (_req, res, params) => {
  sendJson(res, 200, { task_id: params.task_id, status: await store.ingestStatus(params.task_id) ?? "unknown" });
});

route("GET", "/chats", async (_req, res) => {
  sendJson(res, 200, { chats: await store.listChats() });
});

route("GET", "/chat_id", async (_req, res) => {
  sendJson(res, 200, { chat_id: await store.getCurrentChatId() });
});

route("POST", "/chat_id", async (req, res) => {
  const body = await readBody<{ chat_id?: string }>(req);
  if (!body.chat_id) return sendJson(res, 400, { detail: "chat_id is required" });
  await store.setCurrentChatId(body.chat_id);
  sendJson(res, 200, { chat_id: body.chat_id });
});

route("GET", "/chat/:chat_id/metadata", async (_req, res, params) => {
  const chat = await store.getChat(params.chat_id);
  sendJson(res, 200, { name: chat.name });
});

route("POST", "/chat/rename", async (req, res) => {
  const body = await readBody<{ chat_id?: string; new_name?: string }>(req);
  if (!body.chat_id || !body.new_name) return sendJson(res, 400, { detail: "chat_id and new_name are required" });
  await store.renameChat(body.chat_id, body.new_name);
  sendJson(res, 200, { ok: true });
});

route("POST", "/chat/new", async (_req, res) => {
  const chat = await store.createChat();
  sendJson(res, 200, { chat_id: chat.id });
});

route("DELETE", "/chat/:chat_id", async (_req, res, params) => {
  await store.deleteChat(params.chat_id);
  sendJson(res, 200, { ok: true });
});

route("DELETE", "/chats/clear", async (_req, res) => {
  const result = await store.clearChats();
  sendJson(res, 200, { cleared_count: result.cleared, new_chat_id: result.newChatId });
});

route("DELETE", "/collections/:collection_name", async (_req, res, params) => {
  sendJson(res, 501, { message: `Collection ${params.collection_name} deletion is not implemented in the Node control plane yet.` });
});

route("GET", "/audio/models", async (_req, res) => {
  const result = await proxyHttp("GET", `${audioServiceUrl}/v1/models`);
  if (!result.ok) return sendJson(res, 502, { detail: result.body || "Audio service unavailable" });
  sendJson(res, 200, JSON.parse(result.body));
});

route("GET", "/v1/models", async (_req, res) => {
  const deployments = await liveActiveDeployments();
  const data = deployments.map((deployment) => ({ id: deployment.openai_model, object: "model", owned_by: deployment.service_type }));
  sendJson(res, 200, { object: "list", data });
});

route("POST", "/v1/chat/completions", async (req, res) => {
  const body = await readBody<Record<string, unknown>>(req);
  await proxyOpenAiRequest(res, body, "/chat/completions");
});

route("POST", "/v1/embeddings", async (req, res) => {
  const body = await readBody<Record<string, unknown>>(req);
  await proxyOpenAiRequest(res, body, "/embeddings");
});

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  const path = getPath(req);
  const matched = routes.find((candidate) => candidate.method === req.method && candidate.pattern.test(path));
  if (!matched) return sendJson(res, 404, { detail: "Not found" });
  const match = path.match(matched.pattern);
  const params = Object.fromEntries(matched.keys.map((key, index) => [key, decodeURIComponent(match?.[index + 1] ?? "")]));
  try {
    await matched.handler(req, res, params);
  } catch (error) {
    sendJson(res, 500, { detail: error instanceof Error ? error.message : String(error) });
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const path = getPath(req);
  if (path.startsWith("/ws/audio/")) {
    proxyWebSocket(req, socket, head, audioServiceWsUrl);
    return;
  }
  if (!path.startsWith("/ws/chat/")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", async (ws, req) => {
  const chatId = decodeURIComponent(getPath(req).split("/").pop() || await store.getCurrentChatId());
  const chat = await store.getChat(chatId);
  ws.send(JSON.stringify({ type: "history", messages: chat.messages }));
  ws.on("message", async (data) => {
    try {
      const payload = JSON.parse(data.toString()) as { message?: string };
      const text = payload.message?.trim();
      if (!text) return;
      await store.appendMessage(chatId, { type: "HumanMessage", content: text });
      ws.send(JSON.stringify({ type: "node_start", data: "generate" }));
      const answer = await makeAssistantReply(text);
      for (const token of chunkText(answer)) {
        ws.send(JSON.stringify({ type: "token", token }));
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
      await store.appendMessage(chatId, { type: "AssistantMessage", content: answer });
      ws.send(JSON.stringify({ type: "node_end", data: "generate" }));
      const updated = await store.getChat(chatId);
      ws.send(JSON.stringify({ type: "history", messages: updated.messages }));
    } catch (error) {
      ws.send(JSON.stringify({ type: "error", content: error instanceof Error ? error.message : String(error) }));
    }
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`AI Stack TypeScript API listening on 0.0.0.0:${port}`);
});

async function makeAssistantReply(text: string): Promise<string> {
  const model = await store.selectedModel();
  return [
    `Node/TypeScript control plane is online.`,
    ``,
    `Selected model: ${model || "not selected"}.`,
    `Your message: ${text}`,
    ``,
    `Runtime inference is not connected yet; this compatibility reply confirms the WebSocket chat path has moved off Python.`
  ].join("\n");
}

function chunkText(text: string): string[] {
  return text.match(/.{1,18}(\s|$)/g) ?? [text];
}

async function configuredDeployments() {
  const settings = await store.listContainerSettings();
  return (await listDeployments(modelsRoot)).map((deployment) => {
    const config = settings[deployment.service_type];
    if (!config) return deployment;
    const suffix = ["vllm", "trtllm"].includes(deployment.service_type) ? "/v1" : "";
    const healthSuffix = deployment.service_type === "audio" ? "/healthz" : "/health";
    return {
      ...deployment,
      public_port: config.public_port,
      base_url: "http://localhost:" + config.public_port + suffix,
      health_url: "http://localhost:" + config.public_port + healthSuffix
    };
  });
}

async function findDeployment(deploymentId: string) {
  const active = await store.getActiveDeployment(deploymentId);
  if (active) {
    const normalized = normalizeDeployment(active);
    if (await deploymentContainerIsRunning(normalized.container_name)) return normalized;
    await store.deleteDeployment(normalized.deployment_id);
  }
  const deployment = (await configuredDeployments()).find((item) => item.deployment_id === deploymentId);
  return deployment ? normalizeDeployment(deployment) : deployment;
}

async function deploymentContainerIsRunning(containerName: string | null | undefined): Promise<boolean> {
  if (!containerName) return false;
  const payload = await listContainers(store);
  return payload.containers.some((container) => (container.name === containerName || container.instance_name === containerName) && container.state === "running");
}

async function liveActiveDeployments() {
  const active = await store.listActiveDeployments();
  const live = [];
  for (const deployment of active) {
    const normalized = normalizeDeployment(deployment);
    if (await deploymentContainerIsRunning(normalized.container_name)) {
      live.push(normalized);
    } else {
      await store.deleteDeployment(normalized.deployment_id);
    }
  }
  return live;
}

function normalizeDeployment<T extends { service_type: string; container_name?: string | null; worker_endpoint?: string | null; public_port?: number }>(deployment: T): T {
  if (deployment.service_type === "vllm") {
    return {
      ...deployment,
      container_name: deployment.container_name || "vllm-service",
      worker_endpoint: "http://127.0.0.1:" + (deployment.public_port ?? 30000) + "/v1"
    };
  }
  if (deployment.service_type === "trtllm") {
    return {
      ...deployment,
      container_name: deployment.container_name || "trtllm-service",
      worker_endpoint: "http://127.0.0.1:" + (deployment.public_port ?? 31000) + "/v1"
    };
  }
  return deployment;
}

function mergeDeployments(configured: Awaited<ReturnType<typeof listDeployments>>, active: Awaited<ReturnType<StateStore["listActiveDeployments"]>>) {
  const byId = new Map(configured.map((deployment) => [deployment.deployment_id, deployment]));
  for (const deployment of active) {
    const normalized = normalizeDeployment(deployment);
    byId.set(normalized.deployment_id, {
      deployment_id: normalized.deployment_id,
      model_id: normalized.model_id,
      status: normalized.status,
      service_type: normalized.service_type,
      runtime: normalized.runtime,
      container_name: normalized.container_name,
      public_port: normalized.public_port,
      base_url: normalized.base_url,
      health_url: normalized.health_url,
      worker_endpoint: normalized.worker_endpoint,
      openai_models: [normalized.openai_model],
      warnings: []
    });
  }
  return [...byId.values()];
}

function runtimeHealthUrl(serviceType: string): string {
  if (serviceType === "audio") return audioServiceUrl + "/healthz";
  if (serviceType === "vllm") return process.env.VLLM_INTERNAL_HEALTH_URL ?? "http://vllm-service:8000/health";
  if (serviceType === "trtllm") return process.env.TRTLLM_INTERNAL_HEALTH_URL ?? "http://trtllm-service:8000/health";
  return "http://127.0.0.1/health";
}

function runtimeOpenAiBaseUrl(serviceType: string): string | null {
  if (serviceType === "vllm") return process.env.VLLM_INTERNAL_BASE_URL ?? "http://127.0.0.1:30000/v1";
  if (serviceType === "trtllm") return process.env.TRTLLM_INTERNAL_BASE_URL ?? "http://127.0.0.1:31000/v1";
  return null;
}

async function autoLoadDeploymentForModel(modelId: string) {
  const model = await getModel(modelsRoot, modelId);
  if (!model) return null;
  const serviceType: ServiceType | null = compatibilityFor(model, "vllm").status === "compatible"
    ? "vllm"
    : compatibilityFor(model, "trtllm").status === "compatible"
      ? "trtllm"
      : null;
  if (!serviceType) return null;
  const deployment = (await configuredDeployments()).find((item) => item.service_type === serviceType);
  if (!deployment) return null;
  const containerSettings = await store.getContainerSettings(serviceType);
  await startDeployment(store, deployment, model, { service_type: serviceType, openai_model: modelId, args: {} }, workspaceRoot, logsRoot, containerSettings);
  return waitForDeploymentReady(modelId, serviceType);
}

async function waitForDeploymentReady(modelId: string, serviceType: ServiceType) {
  const deadline = Date.now() + Number(process.env.AI_STACK_LAZY_LOAD_TIMEOUT_MS ?? 900000);
  while (Date.now() < deadline) {
    const deployments = await liveActiveDeployments();
    const deployment = deployments.find((item) => item.service_type === serviceType && (item.openai_model === modelId || item.model_id === modelId));
    if (deployment) {
      const healthTarget = deployment.health_url ?? runtimeHealthUrl(deployment.service_type);
      const health = await proxyHttp("GET", healthTarget);
      if (health.ok) return deployment;
    }
    await sleep(3000);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function proxyOpenAiRequest(res: ServerResponse, body: Record<string, unknown>, path: string): Promise<void> {
  const modelId = String(body.model ?? "");
  if (!modelId) return sendJson(res, 400, { error: { message: "model is required" } });
  let deployments = await liveActiveDeployments();
  let deployment = deployments.find((item) => item.openai_model === modelId || item.model_id === modelId);
  let autoLoaded = false;
  if (!deployment) {
    const autoloaded = await autoLoadDeploymentForModel(modelId);
    if (autoloaded) {
      autoLoaded = true;
      deployments = await liveActiveDeployments();
      deployment = deployments.find((item) => item.openai_model === modelId || item.model_id === modelId);
    }
  }
  if (!deployment) {
    return sendJson(res, 404, {
      error: {
        message: "Model " + modelId + " is not registered on a running OpenAI-compatible runtime.",
        available_models: deployments.map((item) => item.openai_model)
      }
    });
  }
  const baseUrl = deployment.worker_endpoint ?? runtimeOpenAiBaseUrl(deployment.service_type);
  if (!baseUrl) return sendJson(res, 409, { error: { message: "Service " + deployment.service_type + " does not expose " + path + "." } });
  const result = await proxyHttp("POST", baseUrl + path, JSON.stringify(body), { "content-type": "application/json" });
  res.writeHead(result.status, {
    "content-type": result.contentType || "application/json; charset=utf-8",
    "access-control-allow-origin": "*"
  });
  res.end(result.body);
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function proxyHttp(method: string, url: string, body?: string, headers: Record<string, string> = {}): Promise<{ ok: boolean; status: number; body: string; contentType?: string }> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const request = client(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        ok: Boolean(response.statusCode && response.statusCode < 400),
        status: response.statusCode ?? 502,
        body: Buffer.concat(chunks).toString("utf-8"),
        contentType: Array.isArray(response.headers["content-type"]) ? response.headers["content-type"][0] : response.headers["content-type"]
      }));
    });
    request.on("error", (error) => resolve({ ok: false, status: 502, body: error.message }));
    if (body) request.write(body);
    request.end();
  });
}

function proxyWebSocket(req: IncomingMessage, socket: any, head: Buffer, target: string): void {
  const upstream = new WebSocket(target);
  wss.handleUpgrade(req, socket, head, (downstream) => {
    upstream.on("open", () => {
      downstream.on("message", (message) => upstream.send(message));
      upstream.on("message", (message) => downstream.send(message));
      downstream.on("close", () => upstream.close());
      upstream.on("close", () => downstream.close());
    });
    upstream.on("error", (error) => {
      downstream.send(JSON.stringify({ type: "error", detail: error.message }));
      downstream.close();
    });
  });
}
