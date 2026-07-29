import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createTask, runManagedCommand } from "./taskRunner.js";
import { createTask as persistTask, getTask, listActiveDeployments, listTasks, updateTask, upsertDeployment } from "./store.js";
import { createRuntimePlan, deploymentContainerName, deploymentInstanceId, healthUrl, publicBaseUrl, runtimeCommandFor, settingsFor } from "./runtimePlan.js";
import { runCommand } from "./utils.js";
import type { ActiveDeploymentRecord, ContainerSettings, DeploymentRecord, ModelRecord, ServiceType } from "./types.js";

export interface DeploymentRequest {
  service_type?: ServiceType;
  openai_model?: string;
  args?: Record<string, unknown>;
}

export function createDeploymentPlan(
  deployment: DeploymentRecord,
  model: ModelRecord,
  serviceType: ServiceType,
  openaiModel: string,
  args: Record<string, unknown>,
  baseDir: string,
  containerSettings?: ContainerSettings
) {
  const settings = resolveDeploymentSettings(serviceType, model.id, openaiModel, settingsFor(serviceType, containerSettings));
  return createRuntimePlan(deployment, model, serviceType, openaiModel, args, baseDir, settings);
}

export async function startDeployment(
  deployment: DeploymentRecord,
  model: ModelRecord,
  request: DeploymentRequest,
  baseDir: string,
  logsRoot: string,
  containerSettings?: ContainerSettings
) {
  const serviceType = request.service_type ?? "vllm";
  const openaiModel = request.openai_model ?? model.id;
  const args = request.args ?? {};
  const settings = resolveDeploymentSettings(serviceType, model.id, openaiModel, settingsFor(serviceType, containerSettings));
  const plan = createDeploymentPlan(deployment, model, serviceType, openaiModel, args, baseDir, settings);
  const activeTarget = activeDeploymentFor(serviceType, model.id, openaiModel, "", settings);
  const command = plan.launch.command;
  const task = createTask("deploy", command, baseDir, join(logsRoot, "tasks", "deploy-" + activeTarget.deployment_id + ".log"), {
    deployment_id: activeTarget.deployment_id,
    model_id: model.id,
    service_type: serviceType,
    openai_model: openaiModel,
    container_name: activeTarget.container_name,
    public_port: settings.public_port,
    runtime_plan: runtimePlanMetadata(plan, "prepare")
  });
  persistTask(task);

  const runnable = runtimeCommandFor(serviceType, model.id, openaiModel, args, settings);
  void runManagedCommand({
    taskId: task.id,
    command: runnable.command,
    args: runnable.args,
    cwd: baseDir,
    env: { AI_STACK_BASE: baseDir, ...runnable.env },
    logPath: task.log_path,
    onOutputLine: async (line) => {
      const marker = parseRuntimeStageMarker(line);
      if (marker) {
        await appendDeploymentTaskLog(task.log_path, "stage " + marker.stage + " " + marker.status);
        await updateDeploymentTaskStage(task.id, marker.stage, marker.status);
      }
    },
    onSuccess: async () => {
      await appendDeploymentTaskLog(task.log_path, "stage start succeeded");
      await updateDeploymentTaskStage(task.id, "start", "succeeded");
      await appendDeploymentTaskLog(task.log_path, "stage load running: " + modelListUrl(plan));
      await updateDeploymentTaskStage(task.id, "load", "running");
      await waitForDeploymentReady(plan, openaiModel, deploymentHealthTimeoutMs(model), activeTarget.container_name);
      await appendDeploymentTaskLog(task.log_path, "stage load succeeded: " + modelListUrl(plan));
      await updateDeploymentTaskStage(task.id, "load", "succeeded");
      await appendDeploymentTaskLog(task.log_path, "stage health running: " + plan.health_url);
      await updateDeploymentTaskStage(task.id, "health", "running");
      await waitForDeploymentHealth(plan.health_url, 15000);
      await appendDeploymentTaskLog(task.log_path, "stage health succeeded: " + plan.health_url);
      await updateDeploymentTaskStage(task.id, "health", "succeeded");
      upsertDeployment({ ...activeTarget, task_id: task.id });
    },
    onFailure: async (error) => {
      const currentStage = currentDeploymentTaskStage(task.id) ?? "prepare";
      await appendDeploymentTaskLog(task.log_path, "stage " + currentStage + " failed");
      if (error) await appendDeploymentTaskLog(task.log_path, "failure: " + error);
      await appendContainerDiagnostics(task.log_path, activeTarget.container_name);
      await updateDeploymentTaskStage(task.id, currentStage, "failed");
    }
  });

  return { ...plan, status: "starting", container_name: activeTarget.container_name, target_container_name: activeTarget.container_name, task };
}

async function appendDeploymentTaskLog(logPath: string, message: string) {
  await appendFile(logPath, "\n[" + new Date().toISOString() + "] " + message + "\n", "utf-8").catch(() => {});
}

async function appendContainerDiagnostics(logPath: string, containerName: string) {
  if (!containerName) return;
  const logs = await runCommand("docker", ["logs", "--tail", "120", containerName], 15000);
  const output = [logs.stdout, logs.stderr].filter(Boolean).join("\n").trim();
  if (output) await appendDeploymentTaskLog(logPath, "container logs (tail):\n" + output);
}

type RuntimePlanStageId = "prepare" | "pull" | "start" | "load" | "health";
type RuntimePlanStageStatus = "pending" | "running" | "succeeded" | "failed";

function parseRuntimeStageMarker(line: string): { stage: RuntimePlanStageId; status: RuntimePlanStageStatus } | undefined {
  const match = line.trim().match(/^__AMUIN_STAGE__:(prepare|pull|start|load|health):(pending|running|succeeded|failed)$/);
  if (!match) return undefined;
  return { stage: match[1] as RuntimePlanStageId, status: match[2] as RuntimePlanStageStatus };
}

function runtimePlanMetadata(plan: ReturnType<typeof createRuntimePlan>, currentStage: RuntimePlanStageId) {
  return {
    deployment_id: plan.deployment_id,
    base_url: plan.base_url,
    health_url: plan.health_url,
    stages: plan.stages,
    current_stage: currentStage,
    progress_percent: deploymentProgressFor(currentStage, "running"),
    stage_statuses: Object.fromEntries(plan.stages.map((stage) => [stage.id, stage.id === currentStage ? "running" : "pending"]))
  };
}


function currentDeploymentTaskStage(taskId: string): string | undefined {
  const runtimePlan = getTask(taskId)?.metadata?.runtime_plan;
  if (!runtimePlan || typeof runtimePlan !== "object") return undefined;
  const currentStage = (runtimePlan as { current_stage?: unknown }).current_stage;
  return typeof currentStage === "string" ? currentStage : undefined;
}

async function updateDeploymentTaskStage(taskId: string, stage: string, status: RuntimePlanStageStatus) {
  const task = getTask(taskId);
  if (!task) return;
  const existingPlan = task.metadata?.runtime_plan && typeof task.metadata.runtime_plan === "object" ? task.metadata.runtime_plan as any : {};
  const statuses = { ...(existingPlan.stage_statuses ?? {}) };
  for (const item of existingPlan.stages ?? []) {
    if (!statuses[item.id]) statuses[item.id] = "pending";
  }
  statuses[stage] = status;
  if (stage === "pull" && status === "running") statuses.prepare = "succeeded";
  if (stage === "start" && status === "running") statuses.pull = "succeeded";
  if (stage === "load" && status === "running") {
    statuses.prepare = "succeeded";
    statuses.pull = "succeeded";
    statuses.start = "succeeded";
  }
  if (stage === "health" && status === "running") {
    statuses.prepare = "succeeded";
    statuses.pull = "succeeded";
    statuses.start = "succeeded";
    statuses.load = "succeeded";
  }
  const runtime_plan = { ...existingPlan, current_stage: stage, progress_percent: deploymentProgressFor(stage, status), stage_statuses: statuses };
  await updateTask(taskId, { metadata: { ...task.metadata, runtime_plan } });
}

function deploymentProgressFor(stage: string, status: RuntimePlanStageStatus): number {
  if (status === "failed") return 100;
  if (status === "succeeded" && stage === "health") return 100;
  const runningProgress: Record<string, number> = { prepare: 10, pull: 30, start: 55, load: 82, health: 96 };
  const succeededProgress: Record<string, number> = { prepare: 20, pull: 45, start: 70, load: 92, health: 100 };
  return status === "succeeded" ? succeededProgress[stage] ?? 100 : runningProgress[stage] ?? 5;
}

function activeDeploymentFor(serviceType: ServiceType, modelId: string, openaiModel: string, taskId: string, settings: ContainerSettings): ActiveDeploymentRecord {
  const now = new Date().toISOString();
  if (serviceType === "vllm") {
    const deploymentId = deploymentInstanceId(serviceType, modelId, openaiModel);
    return {
      deployment_id: deploymentId,
      model_id: modelId,
      service_type: serviceType,
      runtime: "vllm",
      container_name: deploymentContainerName(serviceType, modelId, openaiModel),
      public_port: settings.public_port,
      base_url: publicBaseUrl(serviceType, settings.public_port),
      health_url: healthUrl(serviceType, settings.public_port),
      worker_endpoint: publicBaseUrl(serviceType, settings.public_port),
      openai_model: openaiModel,
      status: "running",
      task_id: taskId,
      updated_at: now
    };
  }
  if (serviceType === "pytorch") {
    return {
      deployment_id: "svc_pytorch",
      model_id: modelId,
      service_type: serviceType,
      runtime: "pytorch-service",
      container_name: "pytorch-service",
      public_port: settings.public_port,
      base_url: publicBaseUrl(serviceType, settings.public_port),
      health_url: healthUrl(serviceType, settings.public_port),
      worker_endpoint: "http://pytorch-service:9000",
      openai_model: openaiModel,
      status: "running",
      task_id: taskId,
      updated_at: now
    };
  }
  return {
    deployment_id: deploymentInstanceId(serviceType, modelId, openaiModel),
    model_id: modelId,
    service_type: serviceType,
    runtime: "TensorRT-LLM",
    container_name: deploymentContainerName(serviceType, modelId, openaiModel),
    public_port: settings.public_port,
    base_url: publicBaseUrl(serviceType, settings.public_port),
    health_url: healthUrl(serviceType, settings.public_port),
    worker_endpoint: publicBaseUrl(serviceType, settings.public_port),
    openai_model: openaiModel,
    status: "running",
    task_id: taskId,
    updated_at: now
  };
}

function resolveDeploymentSettings(serviceType: ServiceType, modelId: string, openaiModel: string, settings: ContainerSettings): ContainerSettings {
  if (serviceType !== "vllm") return settings;
  const deploymentId = deploymentInstanceId(serviceType, modelId, openaiModel);
  const active = listActiveDeployments();
  const existing = active.find((item) => item.deployment_id === deploymentId);
  if (existing?.public_port) return { ...settings, public_port: existing.public_port };
  const usedPorts = new Set(active.filter((item) => item.service_type === serviceType).map((item) => item.public_port).filter((port) => Number.isFinite(port)));
  for (const task of listTasks()) {
    if (task.type !== "deploy" || !["queued", "running"].includes(task.status)) continue;
    if (task.metadata?.service_type !== serviceType) continue;
    if (task.metadata?.deployment_id === deploymentId) continue;
    const taskPort = Number(task.metadata?.public_port);
    if (Number.isFinite(taskPort)) usedPorts.add(taskPort);
  }
  let port = settings.public_port;
  while (usedPorts.has(port)) port += 1;
  return { ...settings, public_port: port };
}

function deploymentHealthTimeoutMs(model: ModelRecord): number {
  const gib = (model.local?.size_bytes ?? 0) / 1024 / 1024 / 1024;
  if (gib >= 60) return 30 * 60 * 1000;
  if (gib >= 25) return 20 * 60 * 1000;
  return 10 * 60 * 1000;
}

async function waitForDeploymentReady(
  plan: ReturnType<typeof createRuntimePlan>,
  openaiModel: string,
  timeoutMs = 600000,
  containerName = ""
): Promise<void> {
  const started = Date.now();
  let lastError = "model is still loading";
  while (Date.now() - started < timeoutMs) {
    if (containerName) {
      const container = await inspectContainerState(containerName);
      if (container.exists && !container.running) {
        throw new Error("Runtime container stopped before the model became ready: " + container.detail);
      }
    }

    const health = await probeUrl(plan.health_url);
    if (health.ok) {
      if (!requiresModelListCheck(plan.service_type)) return;
      const models = await fetchRuntimeModels(modelListUrl(plan));
      if (models.includes(openaiModel)) return;
      lastError = models.length
        ? "model list does not include " + openaiModel + ": " + models.join(", ")
        : "model list is empty or unavailable";
    } else {
      lastError = health.detail;
    }
    await sleep(3000);
  }
  throw new Error("Runtime model load timeout for " + plan.base_url + ": " + lastError);
}

async function waitForDeploymentHealth(url: string, timeoutMs = 600000): Promise<void> {
  const started = Date.now();
  let lastError = "health check unavailable";
  while (Date.now() - started < timeoutMs) {
    const result = await probeUrl(url);
    if (result.ok) return;
    lastError = result.detail;
    await sleep(3000);
  }
  throw new Error("Runtime health check timeout for " + url + ": " + lastError);
}

function modelListUrl(plan: ReturnType<typeof createRuntimePlan>): string {
  return plan.base_url.replace(/\/$/, "") + "/models";
}

function requiresModelListCheck(serviceType: string): boolean {
  return serviceType === "vllm" || serviceType === "trtllm";
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

async function probeUrl(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return { ok: response.ok, detail: response.ok ? "ok" : "endpoint returned HTTP " + response.status };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function inspectContainerState(name: string): Promise<{ exists: boolean; running: boolean; detail: string }> {
  const result = await runCommand("docker", ["inspect", "-f", "{{.State.Running}} {{.State.Status}} {{.State.ExitCode}}", name], 5000);
  const detail = [result.stdout, result.stderr].filter(Boolean).join(" ").trim();
  if (!result.ok) return { exists: false, running: false, detail: detail || "container is not available yet" };
  const [running, status, exitCode] = detail.split(/\s+/);
  return { exists: true, running: running === "true", detail: "status=" + (status || "unknown") + " exit_code=" + (exitCode || "unknown") };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
