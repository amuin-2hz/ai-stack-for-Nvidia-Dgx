import { readBody, sendJson } from "../serverUtils.js";
import { getContainerConfig, listActiveDeployments, getActiveDeployment, deleteDeployment } from "../store.js";
import { createDeploymentPlan as buildDeploymentPlan, startDeployment } from "../deploymentManager.js";
import { compatibilityFor, getModel, listModels } from "../modelRegistry.js";
import { proxyHttp, parseMaybeJson } from "../httpProxy.js";
import { runCommand } from "../utils.js";
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

  route("GET", "/deployments/:deployment_id/logs", async (_req: any, res: any, params: any) => {
    const d = await dh.findDeployment(params.deployment_id);
    if (!d) return sendJson(res, 404, { detail: "Unknown deployment: " + params.deployment_id });
    sendJson(res, 501, {
      deployment_id: d.deployment_id,
      detail: "Container log streaming is not mounted into the Node API container yet.",
      suggested_command: d.container_name ? "docker logs --tail 200 " + d.container_name : null
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
    sendJson(res, 202, { deployment_id: d.deployment_id, status: "restart_requested", detail: "Runtime restart wiring is scheduled for the deployment manager phase." });
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
    const blocker = deploymentBlocker(model, serviceType, body.start === true);
    if (blocker) return sendJson(res, 409, blocker);
    const deployment = (await dh.configuredDeployments()).find((d: any) => d.service_type === serviceType);
    if (!deployment) return sendJson(res, 400, { detail: "Unknown service type: " + serviceType });
    const containerSettings = getContainerConfig(serviceType);
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
    const blocker = deploymentBlocker(model, serviceType, true);
    if (blocker) return sendJson(res, 409, blocker);
    const deployment = (await dh.configuredDeployments()).find((d: any) => d.service_type === serviceType);
    if (!deployment) return sendJson(res, 400, { detail: "Unknown service type: " + serviceType });
    const containerSettings = getContainerConfig(serviceType);
    const existing = listActiveDeployments().find(
      (d: any) => d.service_type === serviceType && d.model_id === model.id &&
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
