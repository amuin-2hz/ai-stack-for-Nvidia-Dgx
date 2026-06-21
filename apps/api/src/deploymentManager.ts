import { join } from "node:path";
import { createTask, runManagedCommand } from "./taskRunner.js";
import { createTask as persistTask, getTask, updateTask, upsertDeployment } from "./store.js";
import { createRuntimePlan, healthUrl, publicBaseUrl, runtimeCommandFor, settingsFor } from "./runtimePlan.js";
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
  return createRuntimePlan(deployment, model, serviceType, openaiModel, args, baseDir, containerSettings);
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
  const settings = settingsFor(serviceType, containerSettings);
  const plan = createDeploymentPlan(deployment, model, serviceType, openaiModel, args, baseDir, settings);
  const command = plan.launch.command;
  const task = createTask("deploy", command, baseDir, join(logsRoot, "tasks", "deploy-" + model.id + "-" + serviceType + ".log"), {
    model_id: model.id,
    service_type: serviceType,
    openai_model: openaiModel,
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
      if (marker) await updateDeploymentTaskStage(task.id, marker.stage, marker.status);
    },
    onSuccess: async () => {
      await updateDeploymentTaskStage(task.id, "start", "succeeded");
      await updateDeploymentTaskStage(task.id, "health", "running");
      await waitForDeploymentHealth(plan.health_url);
      await updateDeploymentTaskStage(task.id, "health", "succeeded");
      upsertDeployment(activeDeploymentFor(serviceType, model.id, openaiModel, task.id, settings));
    },
    onFailure: async () => {
      const currentStage = currentDeploymentTaskStage(task.id) ?? "prepare";
      await updateDeploymentTaskStage(task.id, currentStage, "failed");
    }
  });

  const activeTarget = activeDeploymentFor(serviceType, model.id, openaiModel, task.id, settings);
  return { ...plan, status: "starting", container_name: activeTarget.container_name, target_container_name: activeTarget.container_name, task };
}


type RuntimePlanStageId = "prepare" | "pull" | "start" | "health";
type RuntimePlanStageStatus = "pending" | "running" | "succeeded" | "failed";

function parseRuntimeStageMarker(line: string): { stage: RuntimePlanStageId; status: RuntimePlanStageStatus } | undefined {
  const match = line.trim().match(/^__AMUIN_STAGE__:(prepare|pull|start|health):(pending|running|succeeded|failed)$/);
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
  if (stage === "health" && status === "running") {
    statuses.prepare = "succeeded";
    statuses.pull = "succeeded";
    statuses.start = "succeeded";
  }
  const runtime_plan = { ...existingPlan, current_stage: stage, stage_statuses: statuses };
  await updateTask(taskId, { metadata: { ...task.metadata, runtime_plan } });
}

function activeDeploymentFor(serviceType: ServiceType, modelId: string, openaiModel: string, taskId: string, settings: ContainerSettings): ActiveDeploymentRecord {
  const now = new Date().toISOString();
  if (serviceType === "vllm") {
    return {
      deployment_id: "svc_vllm",
      model_id: modelId,
      service_type: serviceType,
      runtime: "vllm",
      container_name: "vllm-service",
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
    deployment_id: "svc_trtllm",
    model_id: modelId,
    service_type: serviceType,
    runtime: "TensorRT-LLM",
    container_name: "trtllm-service",
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

async function waitForDeploymentHealth(url: string, timeoutMs = 90000): Promise<void> {
  const started = Date.now();
  let lastError = "health check unavailable";
  while (Date.now() - started < timeoutMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) return;
      lastError = "health endpoint returned HTTP " + response.status;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("Runtime health check timeout for " + url + ": " + lastError);
}
