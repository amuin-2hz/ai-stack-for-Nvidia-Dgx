import { readFile } from "node:fs/promises";
import type { ActiveDeploymentRecord, DeploymentSuite, ServiceType } from "./types.js";
import { listDeployments } from "./modelRegistry.js";
import { listContainers } from "./containerManager.js";
import { runCommand } from "./utils.js";
import {
  deploymentInstanceId,
  healthUrl,
  publicBaseUrl
} from "./runtimePlan.js";
import {
  listContainerConfigs,
  listActiveDeployments,
  getActiveDeployment,
  deleteDeployment,
  upsertDeployment,
  listTasks,
  getTask,
} from "./store.js";
import { parseComposeRuntimeDeclaration } from "./composeRuntimeMetadata.js";

export interface DeploymentHelpersDeps {
  modelsRoot: string;
  audioServiceUrl: string;
}

export type ConfiguredDeployment = Awaited<
  ReturnType<typeof listDeployments>
>[number] & {
  public_port: number;
  base_url: string;
  health_url: string;
};

export function createDeploymentHelpers(deps: DeploymentHelpersDeps) {
  const { modelsRoot, audioServiceUrl } = deps;

  async function configuredDeployments(): Promise<ConfiguredDeployment[]> {
    const configs = listContainerConfigs();
    return (await listDeployments(modelsRoot)).map((deployment) => {
      const config = configs.find((c: any) => c.key === deployment.service_type);
      if (!config) return deployment as ConfiguredDeployment;
      const suffix = ["vllm", "trtllm"].includes(deployment.service_type)
        ? "/v1"
        : "";
      const healthSuffix =
        deployment.service_type === "pytorch" ? "/healthz" : "/health";
      return {
        ...deployment,
        public_port: config.public_port,
        base_url: "http://localhost:" + config.public_port + suffix,
        health_url: "http://localhost:" + config.public_port + healthSuffix
      };
    });
  }

  function normalizeDeployment<
    T extends {
      service_type: string;
      container_name?: string | null;
      worker_endpoint?: string | null;
      public_port?: number;
    }
  >(deployment: T): T {
    if (deployment.service_type === "vllm") {
      return {
        ...deployment,
        container_name: deployment.container_name || "vllm-service",
        worker_endpoint:
          "http://127.0.0.1:" + (deployment.public_port ?? 30000) + "/v1"
      };
    }
    if (deployment.service_type === "trtllm") {
      return {
        ...deployment,
        container_name: deployment.container_name || "trtllm-service",
        worker_endpoint:
          "http://127.0.0.1:" + (deployment.public_port ?? 31000) + "/v1"
      };
    }
    return deployment;
  }

  function canonicalizeSuiteDeployment(deployment: ActiveDeploymentRecord): ActiveDeploymentRecord {
    const apiModel = deployment.suite?.api_models?.[0];
    const primaryComponent = deployment.suite?.components.find((component) => component.required)
      ?? deployment.suite?.components[0];
    if (!apiModel || !primaryComponent) return deployment;
    return {
      ...deployment,
      model_id: primaryComponent.model_id,
      openai_model: apiModel
    };
  }

  async function deploymentContainerIsRunning(
    containerName: string | null | undefined
  ): Promise<boolean> {
    if (!containerName) return false;
    const payload = await listContainers();
    return payload.containers.some(
      (container) =>
        (container.name === containerName ||
          container.instance_name === containerName) &&
        container.state === "running"
    );
  }

  async function deploymentSuiteForTask(taskId?: string): Promise<DeploymentSuite | undefined> {
    if (!taskId) return undefined;
    const task = getTask(taskId);
    const metadata = task?.metadata ?? {};
    const savedSuite = metadata.suite && typeof metadata.suite === "object"
      ? metadata.suite as DeploymentSuite
      : undefined;
    const composePath = String(metadata.compose_yaml_path ?? "").trim();
    if (!composePath) return savedSuite;
    try {
      const declaredSuite = parseComposeRuntimeDeclaration(await readFile(composePath, "utf-8")) ?? undefined;
      if (!declaredSuite) return savedSuite;
      if (!savedSuite) return declaredSuite;
      return {
        ...savedSuite,
        api_models: declaredSuite.api_models ?? savedSuite.api_models,
        primary_endpoint: declaredSuite.primary_endpoint ?? savedSuite.primary_endpoint
      };
    } catch {
      return savedSuite;
    }
  }

  async function liveActiveDeployments(): Promise<ActiveDeploymentRecord[]> {
    const active = listActiveDeployments();
    const liveByContainer = new Map<string, ActiveDeploymentRecord>();
    for (const deployment of active) {
      const runtimeArgs = deployment.service_type === "vllm"
        ? await deploymentArgsForContainer(deployment.container_name)
        : undefined;
      const recoveredArgs = mergeDeploymentRuntimeArgs(deployment.args, runtimeArgs);
      const baseDeployment = normalizeDeployment({ ...deployment, args: recoveredArgs });
      const taskSuite = await deploymentSuiteForTask(baseDeployment.task_id);
      const normalized = canonicalizeSuiteDeployment({
        ...baseDeployment,
        suite: taskSuite ?? baseDeployment.suite
      });
      if (!(await deploymentContainerIsRunning(normalized.container_name))) {
        upsertDeployment({ ...normalized, status: "stopped", updated_at: new Date().toISOString() });
        continue;
      }
      const ready = await runtimeIsReady(normalized.health_url, normalized.base_url, normalized.openai_model, normalized.service_type, normalized.runtime);
      const current = { ...normalized, status: ready ? "running" : "loading", updated_at: new Date().toISOString() };
      upsertDeployment(current);
      const key = current.runtime === "qwen3-tts"
        ? current.deployment_id
        : current.container_name || current.deployment_id;
      const existing = liveByContainer.get(key);
      if (!existing) { liveByContainer.set(key, current); continue; }
      const preferCurrent = current.deployment_id.startsWith("svc_") && !existing.deployment_id.startsWith("svc_");
      const kept = preferCurrent ? current : existing;
      const removed = preferCurrent ? existing : current;
      if (removed.deployment_id !== kept.deployment_id) deleteDeployment(removed.deployment_id);
      liveByContainer.set(key, kept);
    }
    const live = [...liveByContainer.values()];
    const discovered = [
      ...(await recoverCustomProfileDeployments()),
      ...(await discoverDockerRuntimeDeployments())
    ];
    const knownIds = new Set(live.map((deployment) => deployment.deployment_id));
    const knownContainers = new Set(live.map((deployment) => deployment.container_name).filter(Boolean));
    for (const deployment of discovered) {
      if (knownIds.has(deployment.deployment_id) || knownContainers.has(deployment.container_name)) continue;
      live.push(deployment);
    }
    return live;
  }

  async function recoverCustomProfileDeployments(): Promise<ActiveDeploymentRecord[]> {
    const containerPayload = await listContainers();
    const runningNames = new Set(containerPayload.containers
      .filter((container) => container.state === "running")
      .flatMap((container) => [container.name, container.instance_name].filter(Boolean) as string[]));
    const recovered = new Map<string, ActiveDeploymentRecord>();
    for (const task of listTasks()) {
      const metadata = task.metadata ?? {};
      if (task.status !== "succeeded" || metadata.action !== "start_custom_profile") continue;
      const containerName = String(metadata.container_name ?? metadata.name ?? "");
      if (!containerName || !runningNames.has(containerName) || recovered.has(containerName)) continue;
      const modelId = String(metadata.model_id ?? metadata.openai_model ?? "").trim();
      if (!modelId) continue;
      const openaiModel = String(metadata.openai_model ?? modelId).trim();
      const profileId = String(metadata.profile_id ?? "custom");
      const suite = await deploymentSuiteForTask(task.id);
      const plan = (metadata.runtime_plan ?? {}) as Record<string, unknown>;
      const rawBaseUrl = String(plan.base_url ?? "").replace(/\/$/, "");
      const publicPort = Number(rawBaseUrl.match(/:(\d+)(?:\/|$)/)?.[1] ?? 0);
      if (!rawBaseUrl || !Number.isFinite(publicPort) || publicPort <= 0) continue;
      const serviceType: ServiceType = profileId.startsWith("vllm-") ? "vllm" : "pytorch";
      const baseUrl = serviceType === "vllm" ? rawBaseUrl.replace(/\/v1$/, "") + "/v1" : rawBaseUrl;
      const healthUrlValue = String(plan.health_url ?? (rawBaseUrl + (serviceType === "vllm" ? "/health" : "/healthz")));
      const ready = await runtimeIsReady(healthUrlValue, baseUrl, openaiModel, serviceType, profileId);
      const deployment = canonicalizeSuiteDeployment({
        deployment_id: suite ? "custom-profile:" + profileId + ":suite" : "custom-profile:" + profileId + ":" + openaiModel,
        model_id: modelId,
        service_type: serviceType,
        runtime: profileId,
        container_name: containerName,
        public_port: publicPort,
        base_url: baseUrl,
        health_url: healthUrlValue,
        worker_endpoint: baseUrl,
        openai_model: openaiModel,
        status: ready ? "running" : "loading",
        task_id: task.id,
        updated_at: new Date().toISOString(),
        suite
      });
      upsertDeployment(deployment);
      recovered.set(containerName, deployment);
    }
    return [...recovered.values()];
  }

  async function discoverDockerRuntimeDeployments(): Promise<ActiveDeploymentRecord[]> {
    const ps = await runCommand(
      "docker",
      ["ps", "--filter", "label=amuin.role=model-runtime", "--format", "{{.Names}}"],
      5000
    );
    if (!ps.ok || !ps.stdout.trim()) return [];
    const names = ps.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
    if (!names.length) return [];
    const inspected = await runCommand("docker", ["inspect", ...names], 8000);
    if (!inspected.ok || !inspected.stdout.trim()) return [];
    let containers: any[] = [];
    try {
      const parsed = JSON.parse(inspected.stdout);
      containers = Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
    const deployments = await Promise.all(containers.map(containerToDeployment));
    return deployments.filter((deployment): deployment is ActiveDeploymentRecord => Boolean(deployment));
  }

  function mergeDeployments(
    configured: Awaited<ReturnType<typeof listDeployments>>,
    active: ReturnType<typeof listActiveDeployments>
  ) {
    const byId = new Map<string, any>(
      configured.map((deployment) => [deployment.deployment_id, deployment])
    );
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
        openai_models: normalized.suite?.api_models?.length
          ? normalized.suite.api_models
          : [normalized.openai_model],
        warnings: [] as string[],
        args: (normalized as typeof normalized & { args?: Record<string, unknown> }).args,
        suite: normalized.suite
      });
    }
    return [...byId.values()];
  }

  async function findDeployment(deploymentId: string) {
    const active = getActiveDeployment(deploymentId);
    if (active) {
      const normalized = normalizeDeployment(active);
      if (await deploymentContainerIsRunning(normalized.container_name))
        return normalized;
      deleteDeployment(normalized.deployment_id);
    }
    const discovered = (await discoverDockerRuntimeDeployments()).find(
      (item) => item.deployment_id === deploymentId
    );
    if (discovered) return discovered;
    const deployment = (await configuredDeployments()).find(
      (item) => item.deployment_id === deploymentId
    );
    return deployment ? normalizeDeployment(deployment) : deployment;
  }

  function runtimeHealthUrl(serviceType: string): string {
    if (serviceType === "pytorch") return audioServiceUrl + "/healthz";
    if (serviceType === "vllm")
      return (
        process.env.VLLM_INTERNAL_HEALTH_URL ??
        "http://vllm-service:8000/health"
      );
    if (serviceType === "trtllm")
      return (
        process.env.TRTLLM_INTERNAL_HEALTH_URL ??
        "http://trtllm-service:8000/health"
      );
    return "http://127.0.0.1/health";
  }

  function runtimeOpenAiBaseUrl(serviceType: string): string | null {
    if (serviceType === "vllm")
      return (
        process.env.VLLM_INTERNAL_BASE_URL ??
        "http://127.0.0.1:30000/v1"
      );
    if (serviceType === "trtllm")
      return (
        process.env.TRTLLM_INTERNAL_BASE_URL ??
        "http://127.0.0.1:31000/v1"
      );
    return null;
  }

  async function containerToDeployment(container: any): Promise<ActiveDeploymentRecord | null> {
    const labels = container?.Config?.Labels ?? {};
    const serviceType = runtimeLabelToServiceType(labels["amuin.runtime"]);
    const modelId = String(labels["amuin.model"] ?? "").trim();
    if (!serviceType || !modelId) return null;
    const hostPort = Number(container?.NetworkSettings?.Ports?.["8000/tcp"]?.[0]?.HostPort);
    if (!Number.isFinite(hostPort) || hostPort <= 0) return null;
    const args = Array.isArray(container?.Args) ? container.Args.map(String) : [];
    const openaiModel = servedModelNameFromArgs(args) || modelId;
    const containerName = String(container?.Name ?? "").replace(/^\//, "") || deploymentInstanceId(serviceType, modelId, openaiModel);
    const now = new Date().toISOString();
    const base_url = publicBaseUrl(serviceType, hostPort);
    const health_url = healthUrl(serviceType, hostPort);
    const ready = await runtimeIsReady(health_url, base_url, openaiModel, serviceType, serviceType);
    const deployment: ActiveDeploymentRecord & { args?: Record<string, unknown> } = {
      deployment_id: deploymentInstanceId(serviceType, modelId, openaiModel),
      model_id: modelId,
      service_type: serviceType,
      runtime: serviceType,
      container_name: containerName,
      public_port: hostPort,
      base_url,
      health_url,
      worker_endpoint: base_url,
      openai_model: openaiModel,
      status: ready ? "running" : "loading",
      args: serviceType === "vllm" ? runtimeArgsFromVllmCommand(args) : undefined,
      updated_at: now
    };
    upsertDeployment(deployment);
    return deployment;
  }

  async function runtimeIsReady(
    healthUrlValue: string,
    baseUrlValue: string,
    openaiModel: string,
    serviceType: ServiceType,
    runtime: string
  ): Promise<boolean> {
    const health = await probeUrl(healthUrlValue);
    if (!health) return false;
    if (/funasr[-_ ]?gateway/i.test(runtime)) return true;
    const modelPath = serviceType === "pytorch" ? "/v1/models" : "/models";
    const models = await fetchRuntimeModels(baseUrlValue.replace(/\/$/, "") + modelPath);
    return models.includes(openaiModel);
  }

  async function probeUrl(url: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
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
      const timer = setTimeout(() => controller.abort(), 1200);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) return [];
      const payload = await response.json() as { data?: Array<{ id?: unknown }> };
      return (payload.data ?? []).map((item) => String(item.id ?? "")).filter(Boolean);
    } catch {
      return [];
    }
  }

  function runtimeLabelToServiceType(value: unknown): ServiceType | null {
    const runtime = String(value ?? "");
    if (runtime === "vllm" || runtime === "trtllm") return runtime;
    return null;
  }

  function servedModelNameFromArgs(args: string[]): string | null {
    const index = args.indexOf("--served-model-name");
    if (index < 0) return null;
    const value = args[index + 1]?.trim();
    return value || null;
  }

  async function deploymentArgsForContainer(containerName: string): Promise<Record<string, unknown> | undefined> {
    if (!containerName) return undefined;
    const inspected = await runCommand("docker", ["inspect", containerName, "--format", "{{json .Config.Cmd}}"], 5000);
    if (!inspected.ok || !inspected.stdout.trim()) return undefined;
    try {
      const args = JSON.parse(inspected.stdout.trim());
      return Array.isArray(args) ? runtimeArgsFromVllmCommand(args.map(String)) : undefined;
    } catch {
      return undefined;
    }
  }
  return {
    configuredDeployments,
    findDeployment,
    liveActiveDeployments,
    normalizeDeployment,
    mergeDeployments,
    deploymentContainerIsRunning,
    runtimeHealthUrl,
    runtimeOpenAiBaseUrl
  };
}

export function mergeDeploymentRuntimeArgs(
  persistedArgs: Record<string, unknown> | undefined,
  runtimeArgs: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!persistedArgs) return runtimeArgs;
  if (!runtimeArgs) return persistedArgs;
  return { ...persistedArgs, ...runtimeArgs };
}

export function runtimeArgsFromVllmCommand(args: string[]): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  const numericFlags: Record<string, string> = {
    "--max-model-len": "max_model_len",
    "--gpu-memory-utilization": "gpu_memory_utilization",
    "--max-num-seqs": "max_num_seqs",
    "--tensor-parallel-size": "tensor_parallel_size"
  };
  for (const [flag, key] of Object.entries(numericFlags)) {
    const value = Number(flagValue(args, flag));
    if (Number.isFinite(value)) result[key] = value;
  }
  const kvCache = flagValue(args, "--kv-cache-dtype");
  if (kvCache) result.kv_cache_dtype = kvCache;
  result.enable_auto_tool_choice = args.includes("--enable-auto-tool-choice");
  const toolCallParser = flagValue(args, "--tool-call-parser");
  if (toolCallParser) result.tool_call_parser = toolCallParser;
  const reasoningParser = flagValue(args, "--reasoning-parser");
  if (reasoningParser) result.reasoning_parser = reasoningParser;
  const templateKwargs = flagValue(args, "--default-chat-template-kwargs");
  if (templateKwargs) {
    try {
      const parsed = JSON.parse(templateKwargs) as { enable_thinking?: unknown };
      if (typeof parsed.enable_thinking === "boolean") result.enable_thinking = parsed.enable_thinking;
    } catch { /* Ignore malformed or externally managed template kwargs. */ }
  }
  return Object.keys(result).length ? result : undefined;
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1]?.trim() : "";
  return value || undefined;
}
