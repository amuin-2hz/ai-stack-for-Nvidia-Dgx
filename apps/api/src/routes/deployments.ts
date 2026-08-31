import { readFile } from "node:fs/promises";
import { readBody, sendJson } from "../serverUtils.js";
import { getContainerConfig, listActiveDeployments, getActiveDeployment, deleteDeployment, listTasks } from "../store.js";
import { createDeploymentPlan as buildDeploymentPlan, startDeployment } from "../deploymentManager.js";
import { compatibilityFor, getModel, listModels } from "../modelRegistry.js";
import { proxyHttp, parseMaybeJson } from "../httpProxy.js";
import { runCommand } from "../utils.js";
import { validateVllmRuntimeArgs } from "../runtimePlan.js";
import type { ModelRecord, ServiceType } from "../types.js";

export function register(
  route: (method: string, path: string, handler: (...args: any[]) => Promise<void>) => void,
  dh: any,
  modelsRoot: string,
  workspaceRoot: string,
  logsRoot: string
) {
  route("GET", "/deployments", async (_req: any, res: any) => {
    const configured = await dh.configuredDeployments();
    const active = await dh.liveActiveDeployments();
    sendJson(res, 200, { deployments: dh.mergeDeployments(configured, active) });
  });

  route("GET", "/deployments/:deployment_id", async (_req: any, res: any, params: any) => {
    const d = await dh.findDeployment(params.deployment_id);
    if (!d) return sendJson(res, 404, { detail: "Unknown deployment: " + params.deployment_id });
    sendJson(res, 200, d);
  });

  route("GET", "/deployments/:deployment_id/health", async (_req: any, res: any, params: any) => {
    const d = await dh.findDeployment(params.deployment_id);
    if (!d) return sendJson(res, 404, { detail: "Unknown deployment: " + params.deployment_id });
    const healthTarget = d.health_url ?? dh.runtimeHealthUrl(d.service_type);
    const result = await proxyHttp("GET", healthTarget);
    sendJson(res, result.ok ? 200 : 503, {
      deployment_id: d.deployment_id, service_type: d.service_type,
      status: result.ok ? "healthy" : "unavailable",
      target: healthTarget, response: parseMaybeJson(result.body)
    });
  });

  route("GET", "/deployments/:deployment_id/logs", async (req: any, res: any, params: any) => {
    const d = await dh.findDeployment(params.deployment_id);
    if (!d) return sendJson(res, 404, { detail: "Unknown deployment: " + params.deployment_id });
    const lines = boundedLineCount(req.url);
    const task = latestDeploymentTask(d);
    const taskLogs = task?.log_path ? await readTailLines(task.log_path, lines) : null;
    const dockerLogs = d.container_name ? await runCommand("docker", ["logs", "--tail", String(lines), d.container_name], 10000) : null;
    const dockerOutput = dockerLogs ? [dockerLogs.stdout, dockerLogs.stderr].filter(Boolean).join("\n") : "";
    sendJson(res, dockerLogs?.ok || taskLogs !== null ? 200 : 503, {
      deployment_id: d.deployment_id,
      service_type: d.service_type,
      container_name: d.container_name,
      task_id: task?.id ?? null,
      log_path: task?.log_path ?? null,
      source: dockerLogs?.ok ? "docker" : taskLogs !== null ? "task" : "none",
      logs: dockerLogs?.ok ? dockerOutput : taskLogs ?? "",
      detail: dockerLogs?.ok
        ? "Container logs read successfully."
        : taskLogs !== null
          ? "Docker logs were unavailable; returned the latest deployment task log."
          : dockerOutput || "No deployment task log or container log is available yet."
    });
  });

  route("POST", "/deployments/:deployment_id/stop", async (_req: any, res: any, params: any) => {
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

  route("POST", "/deployments/:deployment_id/restart", async (_req: any, res: any, params: any) => {
    const d = await dh.findDeployment(params.deployment_id);
    if (!d) return sendJson(res, 404, { detail: "Unknown deployment: " + params.deployment_id });
    if (!d.container_name) return sendJson(res, 400, { detail: "Deployment has no container to restart." });
    const result = await runCommand("docker", ["restart", d.container_name], 30000);
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    sendJson(res, result.ok ? 200 : 500, {
      deployment_id: d.deployment_id,
      container_name: d.container_name,
      status: result.ok ? "restarted" : "failed",
      detail: detail || (result.ok ? "Container restarted." : "Container restart failed.")
    });
  });

  route("POST", "/deployments", async (req: any, res: any) => {
    const body = await readBody<{ model_id?: string; service_type?: ServiceType; openai_model?: string; args?: Record<string, unknown>; start?: boolean }>(req);
    if (!body.model_id) return sendJson(res, 400, { detail: "model_id is required" });
    const serviceType = body.service_type ?? "vllm";
    const model = await getModel(modelsRoot, body.model_id);
    if (!model) return sendJson(res, 404, { detail: "Unknown model: " + body.model_id });
    const localModelIds = new Set((await listModels(modelsRoot)).map((m: any) => m.id));
    if (body.openai_model && body.openai_model !== model.id && localModelIds.has(body.openai_model))
      return sendJson(res, 409, { detail: "openai_model points to a different local model." });
    const validatedArgs = validateDeploymentRuntimeArgs(body.args ?? {}, serviceType, model.id, body.openai_model ?? model.id);
    if (validatedArgs.detail) return sendJson(res, 400, { detail: validatedArgs.detail });
    body.args = validatedArgs.args;
    const blocker = deploymentBlocker(model, serviceType, body.start === true);
    if (blocker) return sendJson(res, 409, blocker);
    const deployment = (await dh.configuredDeployments()).find((d: any) => d.service_type === serviceType);
    if (!deployment) return sendJson(res, 400, { detail: "Unknown service type: " + serviceType });
    const containerSettings = getContainerConfig(serviceType);
    await dh.liveActiveDeployments();
    if (body.start) {
      sendJson(res, 202, await startDeployment(deployment, model, body, workspaceRoot, logsRoot, containerSettings));
      return;
    }
    sendJson(res, 200, buildDeploymentPlan(deployment, model, serviceType, body.openai_model ?? model.id, body.args ?? {}, workspaceRoot, containerSettings));
  });

  route("POST", "/deployments/start", async (req: any, res: any) => {
    const body = await readBody<{ model_id?: string; service_type?: ServiceType; openai_model?: string; args?: Record<string, unknown> }>(req);
    if (!body.model_id) return sendJson(res, 400, { detail: "model_id is required" });
    const serviceType = body.service_type ?? "vllm";
    const model = await getModel(modelsRoot, body.model_id);
    if (!model) return sendJson(res, 404, { detail: "Unknown model: " + body.model_id });
    const localModelIds = new Set((await listModels(modelsRoot)).map((m: any) => m.id));
    if (body.openai_model && body.openai_model !== model.id && localModelIds.has(body.openai_model))
      return sendJson(res, 409, { detail: "openai_model points to a different local model." });
    const validatedArgs = validateDeploymentRuntimeArgs(body.args ?? {}, serviceType, model.id, body.openai_model ?? model.id);
    if (validatedArgs.detail) return sendJson(res, 400, { detail: validatedArgs.detail });
    body.args = validatedArgs.args;
    const blocker = deploymentBlocker(model, serviceType, true);
    if (blocker) return sendJson(res, 409, blocker);
    const deployment = (await dh.configuredDeployments()).find((d: any) => d.service_type === serviceType);
    if (!deployment) return sendJson(res, 400, { detail: "Unknown service type: " + serviceType });
    const containerSettings = getContainerConfig(serviceType);
    await dh.liveActiveDeployments();
    const existing = listActiveDeployments().find(
      (d: any) => d.service_type === serviceType && d.model_id === model.id &&
        d.openai_model === (body.openai_model ?? model.id) && d.status === "running"
    );
    if (existing) {
      const normalized = dh.normalizeDeployment(existing);
      if (await dh.deploymentContainerIsRunning(normalized.container_name)) {
        if (deploymentArgsMatch(normalized.args, body.args, serviceType)) {
          return sendJson(res, 200, { ...normalized, status: "already_running", openai_models: [normalized.openai_model], detail: "Deployment is already running with the requested parameters." });
        }
      } else {
        deleteDeployment(normalized.deployment_id);
      }
    }
    sendJson(res, 202, await startDeployment(deployment, model, body, workspaceRoot, logsRoot, containerSettings));
  });

function boundedLineCount(rawUrl: string | undefined): number {
  const value = Number(new URL(rawUrl ?? "/", "http://localhost").searchParams.get("lines") ?? "200");
  if (!Number.isFinite(value)) return 200;
  return Math.max(1, Math.min(2000, Math.trunc(value)));
}

async function readTailLines(path: string, lines: number): Promise<string | null> {
  try {
    const body = await readFile(path, "utf-8");
    return body.split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return null;
  }
}

function latestDeploymentTask(deployment: any) {
  const taskId = typeof deployment.task_id === "string" ? deployment.task_id : "";
  const tasks = listTasks();
  if (taskId) {
    const task = tasks.find((item) => item.id === taskId);
    if (task) return task;
  }
  return tasks.find((task) =>
    task.type === "deploy" &&
    (
      task.metadata?.deployment_id === deployment.deployment_id ||
      task.metadata?.service_type === deployment.service_type ||
      task.metadata?.model_id === deployment.model_id
    )
  );
}

function deploymentBlocker(model: ModelRecord, serviceType: ServiceType, blockMemory: boolean) {
  const compat = compatibilityFor(model, serviceType);
  if (compat.status === "unsupported") {
    return { detail: compat.reason, compatibility: compat, audit: model.audit };
  }
  const memory = model.audit?.gpu_memory;
  if (blockMemory && memory?.status === "insufficient" && ["vllm", "trtllm", "pytorch"].includes(serviceType)) {
    return {
      detail: memory.reason,
      compatibility: compat,
      audit: model.audit,
      repair_actions: [
        { action: "lower_context_length", label: "Lower context length or max tokens." },
        { action: "stop_other_runtimes", label: "Stop other GPU runtimes and retry." },
        { action: "choose_smaller_model", label: "Choose a smaller or quantized model." }
      ]
    };
  }
  return null;
}

}

export function validateDeploymentRuntimeArgs(
  args: Record<string, unknown>,
  serviceType: ServiceType,
  modelId: string,
  openaiModel: string
): { args: Record<string, unknown>; detail?: string } {
  return serviceType === "vllm" ? validateVllmRuntimeArgs(args, modelId, openaiModel) : { args };
}

export function deploymentArgsMatch(
  existing: Record<string, unknown> | undefined,
  requested: Record<string, unknown> | undefined,
  serviceType?: ServiceType
): boolean {
  if (!existing) return !requested || Object.keys(requested).length === 0;
  const keys = serviceType === "vllm"
    ? ["max_model_len", "gpu_memory_utilization", "max_num_seqs", "tensor_parallel_size", "kv_cache_dtype",
        "enable_auto_tool_choice", "tool_call_parser", "reasoning_parser"]
    : undefined;
  const existingArgs = pickArgs(existing, keys);
  const requestedArgs = pickArgs(requested ?? {}, keys);
  if (serviceType === "vllm") {
    existingArgs.enable_auto_tool_choice = existingArgs.enable_auto_tool_choice === true;
    requestedArgs.enable_auto_tool_choice = requestedArgs.enable_auto_tool_choice === true;
  }
  return stableJson(existingArgs) === stableJson(requestedArgs);
}

function pickArgs(args: Record<string, unknown>, keys?: string[]): Record<string, unknown> {
  if (!keys) return args;
  return Object.fromEntries(keys.filter((key) => key in args).map((key) => [key, args[key]]));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + stableJson(item))
      .join(",") + "}";
  }
  return JSON.stringify(value) ?? "undefined";
}
