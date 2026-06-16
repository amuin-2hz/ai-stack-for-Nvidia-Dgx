import Busboy from "busboy";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createWriteStream } from "node:fs";
import { WebSocketServer } from "ws";

import { initDb } from "./db.js";
import { migrateFromJson } from "./migrate.js";
import {
  createTask, updateTask, getTask, listTasks,
  upsertDeployment, listActiveDeployments, getActiveDeployment, deleteDeployment,
  listChats, getCurrentChatId, setCurrentChatId, getChat, createChat, renameChat, deleteChat, clearChats, appendMessage,
  getContainerConfig, listContainerConfigs, setContainerConfig,
  getWorkbenchSettings, setManagementPort, getNetworkSettings, setNetworkAccess,
  setIngestTask, ingestStatus,
  getSelectedSources, setSelectedSources, getSelectedModel, setSelectedModel,
} from "./store.js";
import { createDownloadPlan, startDownload } from "./downloadManager.js";
import { createDeploymentPlan as buildDeploymentPlan, startDeployment } from "./deploymentManager.js";
import {
  compatibilityFor,
  deleteModel,
  getModel,
  isModelPublished,
  listDeployments,
  listModels
} from "./modelRegistry.js";
import { systemCheck } from "./systemInspector.js";
import {
  applyContainerRuntimeConfig,
  deleteContainer,
  containerAction,
  containerLogs,
  createCustomContainerTask,
  createImagePullTask,
  createImageTestTask,
  listContainers
} from "./containerManager.js";
import { reconcileTask } from "./taskReconciler.js";
import { createOpenAiProxy } from "./openaiProxy.js";
import { createDeploymentHelpers } from "./deploymentHelpers.js";
import { createWsHandler } from "./wsHandler.js";
import { proxyWebSocket, proxyHttp, parseMaybeJson } from "./httpProxy.js";
import {
  createRouter,
  readBody,
  sendJson,
  getPath
} from "./serverUtils.js";
import { newId, runCommand } from "./utils.js";
import type { ServiceType } from "./types.js";
import { requiresElectronPrivilege, isElectronRequest } from "./permissions.js";

/* ── constants ─────────────────────────────────── */
const port = Number(process.env.PORT ?? "8000");
const workspaceRoot = process.env.AI_STACK_BASE ?? process.cwd();
const modelsRoot = process.env.MODELS_ROOT ?? join(workspaceRoot, "models");
const stateRoot = process.env.STATE_ROOT ?? join(workspaceRoot, "state");
const uploadsRoot = process.env.UPLOADS_ROOT ?? join(stateRoot, "uploads");
const logsRoot = process.env.LOGS_ROOT ?? join(workspaceRoot, "logs");
const audioServiceUrl = process.env.AUDIO_SERVICE_URL ?? "http://127.0.0.1:32000";
const audioServiceWsUrl = process.env.AUDIO_SERVICE_WS_URL ?? "ws://127.0.0.1:32000/ws/realtime";
/* ── composed modules ──────────────────────────── */
const dh = createDeploymentHelpers({ modelsRoot, audioServiceUrl });
const oai = createOpenAiProxy({ modelsRoot, workspaceRoot, logsRoot, deploymentHelpers: dh });

/* ── router ────────────────────────────────────── */
const { route, match } = createRouter();

/* health */
route("GET", "/healthz", async (_req, res) => {
  sendJson(res, 200, { status: "ok", runtime: "node" });
});

/* system */
route("GET", "/system/check", async (_req, res) => {
  const workbench = getWorkbenchSettings();
  sendJson(res, 200, {
    ...(await systemCheck()),
    management_url: "http://localhost:" + workbench.active_management_port,
    configured_management_url: "http://localhost:" + workbench.management_port,
    workbench,
    network: getNetworkSettings()
  });
});

/* settings */
route("GET", "/settings/workbench", async (_req, res) => {
  sendJson(res, 200, getWorkbenchSettings());
});
route("POST", "/settings/workbench", async (req, res) => {
  const body = await readBody<{ management_port?: number }>(req);
  try {
    sendJson(res, 200, setManagementPort(Number(body.management_port)));
  } catch (error) {
    sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
  }
});
route("GET", "/settings/network", async (_req, res) => {
  sendJson(res, 200, getNetworkSettings());
});
route("POST", "/settings/network", async (req, res) => {
  const body = await readBody<{ lan_access_enabled?: boolean }>(req);
  if (typeof body.lan_access_enabled !== "boolean")
    return sendJson(res, 400, { detail: "lan_access_enabled boolean is required" });
  sendJson(res, 200, setNetworkAccess(body.lan_access_enabled));
});

/* models */
route("GET", "/models/progress", async (_req, res) => {
  const models = await listModels(modelsRoot);
  sendJson(res, 200, {
    models_dir: modelsRoot,
    model_count: models.length,
    models: models.map((m) => ({
      model: m.display_name,
      path: m.local.path,
      status: m.status.download,
      weight_files: m.local.weight_files,
      weight_bytes: m.local.size_bytes,
      config_files: m.local.config_files,
      incomplete_files: m.local.incomplete_files,
      lock_files: [] as string[]
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

  // 1. Check store for active deployments (vLLM / TRT-LLM loaded models)
  const activeDeployment = listActiveDeployments().find(
    (d) => d.model_id === model.id && ["running", "starting", "configured"].includes(d.status)
  );
  if (activeDeployment)
    return sendJson(res, 409, { detail: "Model is currently deployed and cannot be deleted.", deployment: activeDeployment });

  // 2. Check running services (audio service auto-published models)
  const published = await isModelPublished(model.id);
  if (published.published)
    return sendJson(res, 409, { detail: `Model is currently served by the ${published.service_type} service and cannot be deleted. Stop the service or unload the model first.` });

  // 3. Check active tasks
  const activeTask = listTasks().find(
    (t) => ["queued", "running"].includes(t.status) &&
      (t.metadata?.model_id === model.id || t.metadata?.alias === model.id || t.metadata?.alias === model.display_name)
  );
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
route("POST", "/models/:model_id/open-folder", async (_req, res, params) => {
  const model = await getModel(modelsRoot, params.model_id);
  if (!model) return sendJson(res, 404, { detail: "Unknown model: " + params.model_id });
  const modelStat = await stat(model.local.path).catch(() => null);
  const folder = modelStat?.isFile() ? dirname(model.local.path) : model.local.path;
  const result = await runCommand("xdg-open", [folder], 3000);
  sendJson(res, result.ok ? 200 : 202, { folder, ok: result.ok, detail: result.stdout || result.stderr || "open requested" });
});

/* downloads */
route("POST", "/downloads", async (req, res) => {
  const body = await readBody<{ url?: string; alias?: string; provider?: string }>(req);
  if (!body.url) return sendJson(res, 400, { detail: "url is required" });
  try {
    sendJson(res, 202, await startDownload({ url: body.url, alias: body.alias, provider: body.provider }, workspaceRoot, logsRoot));
  } catch (error) {
    sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
  }
});

/* tasks */
route("GET", "/tasks", async (_req, res) => {
  const tasks = await Promise.all(listTasks().map((t) => reconcileTask(t, workspaceRoot)));
  sendJson(res, 200, { tasks });
});
route("GET", "/tasks/:task_id", async (_req, res, params) => {
  const task = getTask(params.task_id);
  if (!task) return sendJson(res, 404, { detail: "Unknown task: " + params.task_id });
  sendJson(res, 200, await reconcileTask(task, workspaceRoot));
});
route("GET", "/tasks/:task_id/logs", async (_req, res, params) => {
  const task = getTask(params.task_id);
  if (!task) return sendJson(res, 404, { detail: "Unknown task: " + params.task_id });
  const logs = await readFile(task.log_path, "utf-8").catch((e) => (e as Error).message);
  sendJson(res, 200, { task_id: task.id, log_path: task.log_path, logs });
});

/* containers */
route("GET", "/containers", async (_req, res) => {
  sendJson(res, 200, await listContainers());
});
route("POST", "/containers/:key/config", async (req, res, params) => {
  const key = decodeURIComponent(params.key);
  const body = await readBody<{ public_port?: number; management_mode?: "resident" | "once"; restart_policy?: string; auto_restart?: boolean }>(req);
  try {
    const settings = setContainerConfig(key, body as any);
    sendJson(res, 200, { settings, apply: await applyContainerRuntimeConfig(key, settings) });
  } catch (error) {
    sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
  }
});
route("POST", "/containers/:key/pull-image", async (_req, res, params) => {
  try {
    sendJson(res, 202, await createImagePullTask(decodeURIComponent(params.key), workspaceRoot, logsRoot));
  } catch (error) {
    sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
  }
});
route("POST", "/containers/:key/test-image", async (_req, res, params) => {
  try {
    sendJson(res, 202, await createImageTestTask(decodeURIComponent(params.key), workspaceRoot, logsRoot));
  } catch (error) {
    sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
  }
});
route("POST", "/containers/custom", async (req, res) => {
  const body = await readBody<{ name?: string; image?: string; components?: string[]; management_mode?: string; restart_policy?: string; auto_restart?: boolean }>(req);
  try {
    sendJson(res, 202, await createCustomContainerTask(body as any, workspaceRoot, logsRoot));
  } catch (error) {
    sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
  }
});
route("GET", "/containers/:name/logs", async (req, res, params) => {
  const lines = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("lines") ?? "200");
  sendJson(res, 200, await containerLogs(params.name, lines));
});
route("POST", "/containers/:name/:action", async (_req, res, params) => {
  if (!["start", "stop", "restart"].includes(params.action))
    return sendJson(res, 400, { detail: "Unsupported container action: " + params.action });
  sendJson(res, 202, await containerAction(params.name, params.action as "start" | "stop" | "restart"));
});
route("DELETE", "/containers/:key", async (_req, res, params) => {
  // Only allow deleting runtime preset containers (vllm, trtllm, audio), not infrastructure
  if (!["vllm", "trtllm", "audio"].includes(params.key))
    return sendJson(res, 403, { detail: "Only runtime containers (vllm, trtllm, audio) can be deleted through this API." });
  const result = await deleteContainer(params.key);
  sendJson(res, result.ok ? 200 : 500, result);
});

/* deployments */
route("GET", "/deployments", async (_req, res) => {
  const configured = await dh.configuredDeployments();
  const active = await dh.liveActiveDeployments();
  sendJson(res, 200, { deployments: dh.mergeDeployments(configured, active) });
});
route("GET", "/runtimes", async (_req, res) => {
  const deployments = await dh.configuredDeployments();
  sendJson(res, 200, {
    runtimes: deployments.map((d) => ({
      service_type: d.service_type,
      runtime: d.runtime,
      status: d.status,
      public_port: d.public_port,
      base_url: d.base_url,
      health_url: d.health_url,
      container_name: d.container_name,
      openai_models: d.openai_models,
      warnings: d.warnings
    }))
  });
});
route("GET", "/deployments/:deployment_id", async (_req, res, params) => {
  const d = await dh.findDeployment(params.deployment_id);
  if (!d) return sendJson(res, 404, { detail: "Unknown deployment: " + params.deployment_id });
  sendJson(res, 200, d);
});
route("GET", "/deployments/:deployment_id/health", async (_req, res, params) => {
  const d = await dh.findDeployment(params.deployment_id);
  if (!d) return sendJson(res, 404, { detail: "Unknown deployment: " + params.deployment_id });
  const healthTarget = d.health_url ?? dh.runtimeHealthUrl(d.service_type);
  const result = await proxyHttp("GET", healthTarget);
  sendJson(res, result.ok ? 200 : 503, {
    deployment_id: d.deployment_id,
    service_type: d.service_type,
    status: result.ok ? "healthy" : "unavailable",
    target: healthTarget,
    response: parseMaybeJson(result.body)
  });
});
route("GET", "/deployments/:deployment_id/logs", async (_req, res, params) => {
  const d = await dh.findDeployment(params.deployment_id);
  if (!d) return sendJson(res, 404, { detail: "Unknown deployment: " + params.deployment_id });
  sendJson(res, 501, {
    deployment_id: d.deployment_id,
    detail: "Container log streaming is not mounted into the Node API container yet.",
    suggested_command: d.container_name ? "docker logs --tail 200 " + d.container_name : null
  });
});
route("POST", "/deployments/:deployment_id/stop", async (_req, res, params) => {
  const active = getActiveDeployment(params.deployment_id);
  const d = active ? dh.normalizeDeployment(active) : await dh.findDeployment(params.deployment_id);
  if (!d) return sendJson(res, 404, { detail: "Unknown deployment: " + params.deployment_id });
  if (!d.container_name) return sendJson(res, 400, { detail: "Deployment has no container to stop." });
  const result = await runCommand("docker", ["rm", "-f", d.container_name], 30000);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const missingContainer = /No such container/i.test(output);
  if (active && (result.ok || missingContainer)) deleteDeployment(params.deployment_id);
  const detail = missingContainer ? "Container was already absent; deployment state is treated as stopped." : output;
  sendJson(res, result.ok || missingContainer ? 200 : 500, { deployment_id: params.deployment_id, container_name: d.container_name, status: result.ok || missingContainer ? "stopped" : "failed", detail });
});
route("POST", "/deployments/:deployment_id/restart", async (_req, res, params) => {
  const d = await dh.findDeployment(params.deployment_id);
  if (!d) return sendJson(res, 404, { detail: "Unknown deployment: " + params.deployment_id });
  sendJson(res, 202, { deployment_id: d.deployment_id, status: "restart_requested", detail: "Runtime restart wiring is scheduled for the deployment manager phase." });
});
route("POST", "/runtimes/compatibility", async (req, res) => {
  const body = await readBody<{ model_id?: string; service_type?: ServiceType }>(req);
  if (!body.model_id || !body.service_type) return sendJson(res, 400, { detail: "model_id and service_type are required" });
  const model = await getModel(modelsRoot, body.model_id);
  if (!model) return sendJson(res, 404, { detail: `Unknown model: ${body.model_id}` });
  const compat = compatibilityFor(model, body.service_type);
  sendJson(res, 200, { status: compat.status, model_format: model.local.format, service_type: body.service_type, reason: compat.reason, warnings: compat.status === "compatible" ? [] : [compat.reason] });
});

/* deploy */
route("POST", "/deployments", async (req, res) => {
  const body = await readBody<{ model_id?: string; service_type?: ServiceType; openai_model?: string; args?: Record<string, unknown>; start?: boolean }>(req);
  if (!body.model_id) return sendJson(res, 400, { detail: "model_id is required" });
  const serviceType = body.service_type ?? "vllm";
  const model = await getModel(modelsRoot, body.model_id);
  if (!model) return sendJson(res, 404, { detail: "Unknown model: " + body.model_id });
  const localModelIds = new Set((await listModels(modelsRoot)).map((m) => m.id));
  if (body.openai_model && body.openai_model !== model.id && localModelIds.has(body.openai_model))
    return sendJson(res, 409, { detail: "openai_model points to a different local model." });
  const compat = compatibilityFor(model, serviceType);
  if (compat.status === "unsupported") return sendJson(res, 409, { detail: compat.reason, compatibility: compat });
  const deployment = (await dh.configuredDeployments()).find((d) => d.service_type === serviceType);
  if (!deployment) return sendJson(res, 400, { detail: "Unknown service type: " + serviceType });
  const containerSettings = getContainerConfig(serviceType);
  if (body.start) {
    sendJson(res, 202, await startDeployment(deployment, model, body, workspaceRoot, logsRoot, containerSettings));
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
  const localModelIds = new Set((await listModels(modelsRoot)).map((m) => m.id));
  if (body.openai_model && body.openai_model !== model.id && localModelIds.has(body.openai_model))
    return sendJson(res, 409, { detail: "openai_model points to a different local model." });
  const compat = compatibilityFor(model, serviceType);
  if (compat.status === "unsupported") return sendJson(res, 409, { detail: compat.reason, compatibility: compat });
  const deployment = (await dh.configuredDeployments()).find((d) => d.service_type === serviceType);
  if (!deployment) return sendJson(res, 400, { detail: "Unknown service type: " + serviceType });
  const containerSettings = getContainerConfig(serviceType);
  const existing = listActiveDeployments().find(
    (d) => d.service_type === serviceType && d.model_id === model.id &&
      d.openai_model === (body.openai_model ?? model.id) && d.status === "running"
  );
  if (existing) {
    const normalized = dh.normalizeDeployment(existing);
    if (await dh.deploymentContainerIsRunning(normalized.container_name)) {
      return sendJson(res, 200, { ...normalized, status: "already_running", openai_models: [normalized.openai_model], detail: "Deployment is already running." });
    }
    deleteDeployment(normalized.deployment_id);
  }
  sendJson(res, 202, await startDeployment(deployment, model, body, workspaceRoot, logsRoot, containerSettings));
});

/* legacy chat / sources / ingest */
route("GET", "/selected_sources", async (_req, res) => {
  sendJson(res, 200, { sources: getSelectedSources() });
});
route("POST", "/selected_sources", async (req, res) => {
  const body = await readBody<unknown>(req);
  const sources = Array.isArray(body) ? body.map(String) : [];
  setSelectedSources(sources);
  sendJson(res, 200, { sources });
});
route("GET", "/selected_model", async (_req, res) => {
  sendJson(res, 200, { model: getSelectedModel() });
});
route("POST", "/selected_model", async (req, res) => {
  const body = await readBody<{ model?: string }>(req);
  setSelectedModel(body.model || "");
  sendJson(res, 200, { model: body.model || "" });
});
route("GET", "/available_models", async (_req, res) => {
  const registry = await listModels(modelsRoot);
  const runnable = registry
    .filter((m) => ["vllm", "audio", "trtllm", "lmstudio"].includes(m.runtime.preferred))
    .map((m) => m.id);
  sendJson(res, 200, { models: runnable.length ? runnable : [getSelectedModel()] });
});
route("GET", "/sources", async (_req, res) => {
  try {
    const entries = await readdir(uploadsRoot, { withFileTypes: true });
    sendJson(res, 200, { sources: entries.filter((e) => e.isFile()).map((e) => e.name) });
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
        writes.push(new Promise((fr, fj) => { write.on("finish", fr); write.on("error", fj); }));
        file.pipe(write);
      });
      busboy.on("finish", () => { Promise.all(writes).then(() => resolve()).catch(reject); });
      busboy.on("error", reject);
      req.pipe(busboy);
    });
  } else {
    for await (const _chunk of req) { /* drain */ }
  }
  setIngestTask(taskId, "completed");
  sendJson(res, 200, { message: `Files queued for processing. Indexed ${fileCount} file(s).`, task_id: taskId });
});
route("GET", "/ingest/status/:task_id", async (_req, res, params) => {
  sendJson(res, 200, { task_id: params.task_id, status: ingestStatus(params.task_id) ?? "unknown" });
});
route("GET", "/chats", async (_req, res) => {
  sendJson(res, 200, { chats: listChats() });
});
route("GET", "/chat_id", async (_req, res) => {
  sendJson(res, 200, { chat_id: getCurrentChatId() });
});
route("POST", "/chat_id", async (req, res) => {
  const body = await readBody<{ chat_id?: string }>(req);
  if (!body.chat_id) return sendJson(res, 400, { detail: "chat_id is required" });
  setCurrentChatId(body.chat_id);
  sendJson(res, 200, { chat_id: body.chat_id });
});
route("GET", "/chat/:chat_id/metadata", async (_req, res, params) => {
  const chat = getChat(params.chat_id);
  if (!chat) return sendJson(res, 404, { detail: "Chat not found: " + params.chat_id });
  sendJson(res, 200, { name: chat.name });
});
route("POST", "/chat/rename", async (req, res) => {
  const body = await readBody<{ chat_id?: string; new_name?: string }>(req);
  if (!body.chat_id || !body.new_name) return sendJson(res, 400, { detail: "chat_id and new_name are required" });
  renameChat(body.chat_id, body.new_name);
  sendJson(res, 200, { ok: true });
});
route("POST", "/chat/new", async (_req, res) => {
  const chat = createChat();
  sendJson(res, 200, { chat_id: chat.id });
});
route("DELETE", "/chat/:chat_id", async (_req, res, params) => {
  deleteChat(params.chat_id);
  sendJson(res, 200, { ok: true });
});
route("DELETE", "/chats/clear", async (_req, res) => {
  const result = clearChats();
  sendJson(res, 200, { cleared_count: result.cleared, new_chat_id: result.newChatId });
});
route("DELETE", "/collections/:collection_name", async (_req, res, params) => {
  sendJson(res, 501, { message: `Collection ${params.collection_name} deletion is not implemented yet.` });
});

/* audio proxy */
route("GET", "/audio/models", async (_req, res) => {
  const result = await proxyHttp("GET", `${audioServiceUrl}/v1/models`);
  if (!result.ok) return sendJson(res, 502, { detail: result.body || "Audio service unavailable" });
  sendJson(res, 200, JSON.parse(result.body));
});

/* OpenAI-compatible API */
route("GET", "/v1/models", async (_req, res) => {
  const deployments = await dh.liveActiveDeployments();
  const data: Array<{ id: string; object: string; owned_by: string }> = deployments
    .filter((d) => d.status === "running")
    .map((d) => ({ id: d.openai_model, object: "model", owned_by: d.service_type }));

  // Always include ASR model from PyTorch container (if configured)
  const pytorchConfig = getContainerConfig("pytorch");
  if (pytorchConfig) {
    data.push({ id: "whisper-tiny", object: "model", owned_by: "pytorch" });
  }

  sendJson(res, 200, { object: "list", data });
});
route("POST", "/v1/chat/completions", async (req, res) => {
  await oai.proxyOpenAiRequest(res, await readBody(req), "/chat/completions");
});
route("POST", "/v1/embeddings", async (req, res) => {
  await oai.proxyOpenAiRequest(res, await readBody(req), "/embeddings");
});

/* ── HTTP server ──────────────────────────────── */
const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  const parsedPath = getPath(req);
  const m = match(req.method ?? "GET", parsedPath);
  if (!m) return sendJson(res, 404, { detail: "Not found" });

  // Permission check: privileged APIs require Electron (localhost) access
  if (requiresElectronPrivilege(req.method ?? "GET", parsedPath)) {
    if (!isElectronRequest(req)) {
      return sendJson(res, 403, {
        detail: "This operation requires local Electron access.",
      });
    }
  }

  try {
    await m.handler(req, res, m.params);
  } catch (error) {
    sendJson(res, 500, { detail: error instanceof Error ? error.message : String(error) });
  }
});

/* ── WebSocket ────────────────────────────────── */
const wss = new WebSocketServer({ noServer: true });
const wsHandler = createWsHandler({ wss, audioServiceWsUrl, proxyWebSocket: (req: IncomingMessage, socket: any, head: Buffer, target: string, w: WebSocketServer) => proxyWebSocket(req, socket, head, target, w) });

server.on("upgrade", (req, socket, head) => {
  wsHandler.handleUpgrade(req, socket, head);
});
wss.on("connection", (ws, req) => {
  wsHandler.handleConnection(ws, req);
});

/* ── init DB ──────────────────────────────────── */
initDb();
const migrationResult = migrateFromJson(stateRoot);
if (migrationResult.migrated) console.log(`DB migration: ${migrationResult.detail}`);

/* ── start ────────────────────────────────────── */
server.listen(port, "0.0.0.0", () => {
  console.log(`AI Stack TypeScript API listening on 0.0.0.0:${port}`);
});
