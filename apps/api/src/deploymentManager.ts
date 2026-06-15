import { join } from "node:path";
import { compatibilityFor, servicePorts } from "./modelRegistry.js";
import { createTask, runManagedCommand } from "./taskRunner.js";
import { shellQuote } from "./utils.js";
import type { StateStore } from "./state.js";
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
  const settings = settingsFor(serviceType, containerSettings);
  const env: Record<string, string> = {
    MODEL_ALIAS: model.id,
    OPENAI_MODEL: openaiModel
  };
  let command = "";
  const notes: string[] = [];

  if (serviceType === "vllm") {
    env.VLLM_IMAGE = String(args.image ?? process.env.VLLM_IMAGE ?? "vllm/vllm-openai:latest");
    env.VLLM_PUBLIC_PORT = String(settings.public_port);
    env.AI_STACK_BIND_ADDR = validBindAddress(process.env.AI_STACK_BIND_ADDR);
    env.AI_STACK_RESTART_POLICY = settings.restart_policy;
    command = [
      "MODEL_ALIAS=" + shellQuote(env.MODEL_ALIAS),
      "OPENAI_MODEL=" + shellQuote(env.OPENAI_MODEL),
      "VLLM_IMAGE=" + shellQuote(env.VLLM_IMAGE),
      "VLLM_PUBLIC_PORT=" + shellQuote(env.VLLM_PUBLIC_PORT),
      "AI_STACK_BIND_ADDR=" + shellQuote(env.AI_STACK_BIND_ADDR),
      "AI_STACK_RESTART_POLICY=" + shellQuote(env.AI_STACK_RESTART_POLICY),
      "docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.vllm.yml up -d vllm-worker"
    ].join(" ");
    notes.push("Uses configured public port " + settings.public_port + " and serves OpenAI traffic at /v1.");
  } else if (serviceType === "audio") {
    command = "AUDIO_PUBLIC_PORT=" + shellQuote(String(settings.public_port)) + " AI_STACK_RESTART_POLICY=" + shellQuote(settings.restart_policy) + " docker compose -f deploy/compose/docker-compose.yml up -d audio-service";
    notes.push("Audio service is part of the base stack and is routed through the Node API audio gateway.");
  } else if (serviceType === "trtllm") {
    command = "TRTLLM_RESTART_POLICY=" + shellQuote(settings.restart_policy) + " ops/scripts/start-trtllm-model.sh " + shellQuote(model.id) + " " + settings.public_port;
    notes.push("TensorRT-LLM remains an advanced route; validate checkpoint support before starting.");
  }

  return {
    ...deployment,
    deployment_id: "plan_" + model.id + "_" + serviceType,
    model_id: model.id,
    status: "planned",
    public_port: settings.public_port,
    base_url: publicBaseUrl(serviceType, settings.public_port),
    health_url: healthUrl(serviceType, settings.public_port),
    openai_models: [openaiModel],
    compatibility: compatibilityFor(model, serviceType),
    launch: {
      mode: "managed_task",
      env,
      command,
      working_directory: baseDir,
      notes
    },
    args
  };
}

export async function startDeployment(
  store: StateStore,
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
    public_port: settings.public_port
  });
  await store.createTask(task);

  const runnable = commandFor(serviceType, model.id, openaiModel, args, settings);
  void runManagedCommand(store, {
    taskId: task.id,
    command: runnable.command,
    args: runnable.args,
    cwd: baseDir,
    env: { AI_STACK_BASE: baseDir, ...runnable.env },
    logPath: task.log_path,
    onSuccess: async () => {
      await store.upsertDeployment(activeDeploymentFor(serviceType, model.id, openaiModel, task.id, settings));
    }
  });

  const activeTarget = activeDeploymentFor(serviceType, model.id, openaiModel, task.id, settings);
  return { ...plan, status: "starting", container_name: activeTarget.container_name, target_container_name: activeTarget.container_name, task };
}

function commandFor(serviceType: ServiceType, modelId: string, openaiModel: string, args: Record<string, unknown>, settings: ContainerSettings): { command: string; args: string[]; env: Record<string, string> } {
  if (serviceType === "vllm") {
    return {
      command: "docker",
      args: ["compose", "-f", "deploy/compose/docker-compose.yml", "-f", "deploy/compose/docker-compose.vllm.yml", "up", "-d", "vllm-worker"],
      env: {
        MODEL_ALIAS: modelId,
        OPENAI_MODEL: openaiModel,
        VLLM_IMAGE: String(args.image ?? process.env.VLLM_IMAGE ?? "vllm/vllm-openai:latest"),
        VLLM_PUBLIC_PORT: String(settings.public_port),
        AI_STACK_BIND_ADDR: validBindAddress(process.env.AI_STACK_BIND_ADDR),
        AI_STACK_RESTART_POLICY: settings.restart_policy,
        VLLM_MAX_MODEL_LEN: String(args.max_model_len ?? process.env.VLLM_MAX_MODEL_LEN ?? "4096"),
        VLLM_GPU_MEMORY_UTILIZATION: String(args.gpu_memory_utilization ?? process.env.VLLM_GPU_MEMORY_UTILIZATION ?? "0.85"),
        VLLM_MAX_NUM_SEQS: String(args.max_num_seqs ?? process.env.VLLM_MAX_NUM_SEQS ?? "16"),
        VLLM_TENSOR_PARALLEL_SIZE: String(args.tensor_parallel_size ?? process.env.VLLM_TENSOR_PARALLEL_SIZE ?? "1"),
        VLLM_KV_CACHE_DTYPE: String(args.kv_cache_dtype ?? process.env.VLLM_KV_CACHE_DTYPE ?? "auto"),
        VLLM_SWAP_SPACE: String(args.swap_space ?? process.env.VLLM_SWAP_SPACE ?? "4")
      }
    };
  }
  if (serviceType === "audio") {
    return {
      command: "docker",
      args: ["compose", "-f", "deploy/compose/docker-compose.yml", "up", "-d", "audio-service"],
      env: { AUDIO_PUBLIC_PORT: String(settings.public_port), AI_STACK_RESTART_POLICY: settings.restart_policy }
    };
  }
  if (serviceType === "trtllm") {
    return { command: "bash", args: ["ops/scripts/start-trtllm-model.sh", modelId, String(settings.public_port)], env: {
      TRTLLM_RESTART_POLICY: settings.restart_policy,
      TRTLLM_MAX_BATCH_SIZE: String(args.max_batch_size ?? process.env.TRTLLM_MAX_BATCH_SIZE ?? "8"),
      TRTLLM_MAX_NUM_TOKENS: String(args.max_num_tokens ?? process.env.TRTLLM_MAX_NUM_TOKENS ?? "4096"),
      TRTLLM_KV_CACHE_FREE_GPU_MEMORY_FRACTION: String(args.kv_cache_free_gpu_memory_fraction ?? process.env.TRTLLM_KV_CACHE_FREE_GPU_MEMORY_FRACTION ?? "0.9"),
      TRTLLM_TP_SIZE: String(args.tp_size ?? process.env.TRTLLM_TP_SIZE ?? "1"),
      TRTLLM_PP_SIZE: String(args.pp_size ?? process.env.TRTLLM_PP_SIZE ?? "1")
    } };
  }
  throw new Error("Unsupported deployment service: " + serviceType);
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
  if (serviceType === "audio") {
    return {
      deployment_id: "svc_audio",
      model_id: modelId,
      service_type: serviceType,
      runtime: "audio-service",
      container_name: "audio-service",
      public_port: settings.public_port,
      base_url: publicBaseUrl(serviceType, settings.public_port),
      health_url: healthUrl(serviceType, settings.public_port),
      worker_endpoint: "http://audio-service:9000",
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

function validBindAddress(value: string | undefined): string {
  return value === "127.0.0.1" || value === "0.0.0.0" ? value : "0.0.0.0";
}

function settingsFor(serviceType: ServiceType, settings?: ContainerSettings): ContainerSettings {
  const fallbackPort = serviceType === "trtllm" ? servicePorts.trtllm : serviceType === "audio" ? servicePorts.audio : servicePorts.vllm;
  const lazyRuntime = serviceType === "vllm" || serviceType === "trtllm";
  return settings ?? { key: serviceType, public_port: fallbackPort, management_mode: "resident", restart_policy: lazyRuntime ? "no" : "unless-stopped", auto_restart: !lazyRuntime, updated_at: new Date().toISOString() };
}

function publicBaseUrl(serviceType: ServiceType, port: number): string {
  return "http://localhost:" + port + (["vllm", "trtllm"].includes(serviceType) ? "/v1" : "");
}

function healthUrl(serviceType: ServiceType, port: number): string {
  return "http://localhost:" + port + (serviceType === "audio" ? "/healthz" : "/health");
}
