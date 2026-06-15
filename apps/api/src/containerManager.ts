import { join } from "node:path";
import { createTask, runManagedCommand } from "./taskRunner.js";
import { runCommand, shellQuote, slugify } from "./utils.js";
import type { StateStore } from "./state.js";
import type { ContainerManagementMode, ContainerRestartPolicy, ContainerSettings } from "./types.js";

export interface ContainerRecord {
  key: string;
  name: string;
  slot_name: string;
  instance_name: string | null;
  title: string;
  image: string;
  status: string;
  state: "running" | "stopped" | "missing" | "unknown";
  ports: string;
  public_port: number;
  runtime: string;
  management_mode: ContainerManagementMode;
  restart_policy: ContainerRestartPolicy;
  auto_restart: boolean;
  preset: boolean;
  components: string[];
  official_image: string;
  image_pulled: boolean;
  test_status: "untested" | "running" | "passed" | "failed";
  software_versions: Record<string, string>;
}

const hiddenContainerNames = new Set(["api", "frontend", "postgres", "milvus-standalone", "milvus-etcd", "milvus-minio"]);
const modelRuntimePrefixes = ["vllm_", "trtllm_", "audio_", "custom_"];

type RuntimePreset = { key: string; title: string; runtime: string; names: string[]; prefix: string; port: number; image: string; components: string[]; versions: Record<string, string>; management_mode: "resident" | "once" };

const presets: RuntimePreset[] = [
  { key: "vllm", title: "vLLM", runtime: "vllm", names: ["vllm-service"], prefix: "vllm_", port: 30000, image: process.env.VLLM_IMAGE ?? "vllm/vllm-openai:latest", components: ["python", "cuda", "pytorch", "vllm"], versions: { "vLLM": "vllm/vllm-openai:latest", Python: "3.x (container)", CUDA: "NVIDIA runtime" }, management_mode: "resident" as const },
  { key: "trtllm", title: "TensorRT-LLM", runtime: "trtllm", names: ["trtllm-service"], prefix: "trtllm_", port: 31000, image: process.env.TRTLLM_IMAGE ?? "nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6", components: ["cuda", "tensorrt-llm"], versions: { "TensorRT-LLM": "v1.2.0-rc6", "NVIDIA Image": "nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6" }, management_mode: "resident" as const },
  { key: "audio", title: "Audio Service", runtime: "audio", names: ["audio-service"], prefix: "audio_", port: 32000, image: "compose-audio-service", components: ["python", "pytorch", "asr", "tts"], versions: { "Audio Service": "AMUIN v0.1", "PyTorch": "2.x (NVIDIA 25.04)", ASR: "FunASR-MLT-Nano-2512", TTS: "CosyVoice-300M-SFT" }, management_mode: "resident" as const }
];

export interface CustomContainerRequest {
  name?: string;
  image?: string;
  components?: string[];
  management_mode?: ContainerManagementMode;
  restart_policy?: ContainerRestartPolicy;
  auto_restart?: boolean;
}

export async function createCustomContainerTask(store: StateStore, request: CustomContainerRequest, baseDir: string, logsRoot: string) {
  const components = sanitizeComponents(request.components ?? []);
  const runtimeHint = components.includes("vllm") ? "vllm" : components.includes("tensorrt-llm") ? "trtllm" : "runtime";
  const rawName = request.name?.trim() || "custom_" + runtimeHint + "_" + Date.now();
  const name = normalizeContainerName(rawName.startsWith("custom_") ? rawName : "custom_" + rawName);
  const image = request.image || process.env.CUSTOM_RUNTIME_IMAGE || "compose-audio-service";
  const mode = request.management_mode === "once" ? "once" : "resident";
  const restartPolicy = normalizeRestartPolicy(request.restart_policy, request.auto_restart, mode);
  const createCommand = [
    "docker create",
    "--name", shellQuote(name),
    "--label", shellQuote("amuin.role=model-runtime"),
    "--label", shellQuote("amuin.components=" + components.join(",")),
    "--label", shellQuote("amuin.management_mode=" + mode),
    "--restart", shellQuote(restartPolicy),
    shellQuote(image),
    "sleep", "infinity"
  ].join(" ");
  const command = mode === "resident" ? createCommand + " && docker start " + shellQuote(name) : createCommand;
  const task = createTask("container", command, baseDir, join(logsRoot, "tasks", "container-" + name + ".log"), { name, image, components, management_mode: mode, restart_policy: restartPolicy });
  await store.createTask(task);
  void runManagedCommand(store, { taskId: task.id, command: "bash", args: ["-lc", command], cwd: baseDir, logPath: task.log_path });
  return { status: "starting", container: { name, image, components, management_mode: mode, restart_policy: restartPolicy }, task };
}

export async function listContainers(store: StateStore): Promise<{ containers: ContainerRecord[]; components: string[]; modes: string[]; restart_policies: string[] }> {
  const [dockerRows, settings, tasks] = await Promise.all([dockerContainers(), store.listContainerSettings(), store.listTasks()]);
  const containers = await Promise.all(presets.map(async (preset) => {
    const config = settings[preset.key] ?? defaultSettingsFor(preset.key, preset.port, preset.management_mode);
    const match = dockerRows.find((row) => preset.names.includes(row.name));
    const image = match?.image || preset.image;
    const imagePulled = await imageExists(image);
    const testStatus = latestImageTestStatus(tasks, preset.key);
    return match ? {
      key: preset.key,
      name: preset.names[0] ?? preset.key,
      slot_name: preset.names[0] ?? preset.key,
      instance_name: match.name,
      title: preset.title,
      image: match.image,
      status: match.status,
      state: match.state,
      ports: match.ports || String(config.public_port),
      public_port: config.public_port,
      runtime: preset.runtime,
      management_mode: config.management_mode,
      restart_policy: config.restart_policy,
      auto_restart: config.auto_restart,
      preset: true,
      components: preset.components,
      official_image: preset.image,
      image_pulled: imagePulled,
      test_status: testStatus,
      software_versions: preset.versions
    } : {
      key: preset.key,
      name: preset.names[0] ?? preset.key,
      slot_name: preset.names[0] ?? preset.key,
      instance_name: null,
      title: preset.title,
      image: preset.image,
      status: "missing",
      state: "missing" as const,
      ports: String(config.public_port),
      public_port: config.public_port,
      runtime: preset.runtime,
      management_mode: config.management_mode,
      restart_policy: config.restart_policy,
      auto_restart: config.auto_restart,
      preset: true,
      components: preset.components,
      official_image: preset.image,
      image_pulled: imagePulled,
      test_status: testStatus,
      software_versions: preset.versions
    };
  }));
  for (const row of dockerRows) {
    if (!isModelPublishingContainer(row.name)) continue;
    if (!containers.some((container) => container.instance_name === row.name || container.name === row.name)) {
      containers.push({
        key: "custom:" + row.name,
        name: row.name,
        slot_name: row.name,
        instance_name: row.name,
        title: row.name,
        image: row.image,
        status: row.status,
        state: row.state,
        ports: row.ports,
        public_port: 0,
        runtime: "custom",
        management_mode: "resident",
        restart_policy: "unless-stopped",
        auto_restart: true,
        preset: false,
        components: [],
        official_image: row.image,
        image_pulled: true,
        test_status: "untested",
        software_versions: {}
      });
    }
  }
  return {
    containers,
    components: ["cuda", "pytorch", "python", "nodejs", "modelscope", "huggingface", "vllm", "tensorrt-llm", "asr", "tts"],
    modes: ["once", "resident"],
    restart_policies: ["no", "unless-stopped", "always", "on-failure"]
  };
}

export async function createImagePullTask(store: StateStore, key: string, baseDir: string, logsRoot: string) {
  const preset = presetForKey(key);
  if (!preset) throw new Error("Unknown preset runtime: " + key);
  const command = key === "audio"
    ? "docker compose -f deploy/compose/docker-compose.yml build audio-service"
    : "docker pull " + shellQuote(preset.image);
  const task = createTask("container", command, baseDir, join(logsRoot, "tasks", "image-" + key + "-pull.log"), { action: "pull_image", key, image: preset.image });
  await store.createTask(task);
  void runManagedCommand(store, { taskId: task.id, command: "bash", args: ["-lc", command], cwd: baseDir, logPath: task.log_path });
  return { status: "starting", image: preset.image, task };
}

export async function createImageTestTask(store: StateStore, key: string, baseDir: string, logsRoot: string) {
  const preset = presetForKey(key);
  if (!preset) throw new Error("Unknown preset runtime: " + key);
  const command = testCommandFor(key, preset.image);
  const task = createTask("container", command, baseDir, join(logsRoot, "tasks", "image-" + key + "-test.log"), { action: "test_image", key, image: preset.image });
  await store.createTask(task);
  void runManagedCommand(store, { taskId: task.id, command: "bash", args: ["-lc", command], cwd: baseDir, logPath: task.log_path });
  return { status: "starting", image: preset.image, task };
}

export async function applyContainerRuntimeConfig(key: string, settings: ContainerSettings): Promise<{ applied: boolean; detail: string }> {
  const preset = presets.find((item) => item.key === key);
  if (!preset) return { applied: false, detail: "Unknown preset runtime: " + key };
  const rows = await dockerContainers();
  const match = rows.find((row) => preset.names.includes(row.name));
  if (!match) return { applied: false, detail: "Settings saved. They will apply when the runtime is created." };
  const result = await runCommand("docker", ["update", "--restart", settings.restart_policy, match.name], 15000);
  const portNote = "Port changes apply on the next recreate/deployment of this runtime.";
  return { applied: result.ok, detail: (result.stdout || result.stderr || "Restart policy updated.") + " " + portNote };
}

export async function containerLogs(name: string, lines = 200): Promise<{ name: string; logs: string }> {
  const result = await runCommand("docker", ["logs", "--tail", String(lines), name], 8000);
  return { name, logs: result.stdout || result.stderr || "" };
}

export async function containerAction(name: string, action: "start" | "stop" | "restart"): Promise<{ name: string; action: string; ok: boolean; detail: string }> {
  if (["vllm-service", "trtllm-service"].includes(name)) {
    const exists = (await dockerContainers()).some((row) => row.name === name);
    if (!exists) {
      return {
        name,
        action,
        ok: false,
        detail: name === "vllm-service"
          ? "vLLM fixed runtime has not been created yet. Load a compatible model into the vLLM runtime first."
          : "TensorRT-LLM fixed runtime has not been created yet. Load a compatible model/profile into the TensorRT-LLM runtime first."
      };
    }
  }
  if (name === "audio-service" && action === "start") {
    const exists = (await dockerContainers()).some((row) => row.name === name);
    if (!exists) {
      const result = await runCommand("docker", ["compose", "-f", "deploy/compose/docker-compose.yml", "up", "-d", "audio-service"], 60000);
      return { name, action, ok: result.ok, detail: result.stdout || result.stderr };
    }
  }
  const result = await runCommand("docker", [action, name], 15000);
  return { name, action, ok: result.ok, detail: result.stdout || result.stderr };
}

export async function deleteContainer(key: string): Promise<{ key: string; ok: boolean; steps: string[] }> {
  const preset = presetForKey(key);
  if (!preset) return { key, ok: false, steps: ["Unknown container key: " + key] };
  const steps: string[] = [];
  let allOk = true;

  // 1. Stop all containers matching this preset's names
  for (const name of preset.names) {
    const existing = await dockerContainers();
    const match = existing.find((c) => c.name === name);
    if (match) {
      if (match.state === "running") {
        const stop = await runCommand("docker", ["stop", name], 15000);
        steps.push(`stop ${name}: ${stop.ok ? "ok" : stop.stderr}`);
        if (!stop.ok) allOk = false;
      }
      const rm = await runCommand("docker", ["rm", name], 10000);
      steps.push(`rm ${name}: ${rm.ok ? "ok" : rm.stderr}`);
      if (!rm.ok) allOk = false;
    } else {
      steps.push(`container ${name}: not found (skip)`);
    }
  }

  // 2. Remove the Docker image
  const image = preset.image;
  if (image && await imageExists(image)) {
    const rmi = await runCommand("docker", ["rmi", image], 30000);
    steps.push(`rmi ${image}: ${rmi.ok ? "ok" : rmi.stderr}`);
    if (!rmi.ok) allOk = false;
  } else {
    steps.push(`image ${image}: not found (skip)`);
  }

  // 3. Prune dangling volumes belonging to this container
  const volumePrune = await runCommand("docker", ["volume", "prune", "-f", "--filter", "label=com.docker.compose.project=chatbot-net"], 15000);
  steps.push(`volume prune: ${volumePrune.ok ? "ok" : volumePrune.stderr}`);

  return { key, ok: allOk, steps };
}

function presetForKey(key: string) {
  return presets.find((preset) => preset.key === key);
}

async function imageExists(image: string): Promise<boolean> {
  if (!image) return false;
  const result = await runCommand("docker", ["image", "inspect", image], 5000);
  return result.ok;
}

function latestImageTestStatus(tasks: Array<{ status: string; metadata: Record<string, unknown>; updated_at: string }>, key: string): ContainerRecord["test_status"] {
  const task = tasks
    .filter((item) => item.metadata?.action === "test_image" && item.metadata?.key === key)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  if (!task) return "untested";
  if (task.status === "succeeded") return "passed";
  if (task.status === "failed") return "failed";
  return "running";
}

function testCommandFor(key: string, image: string): string {
  if (key === "vllm") return "docker run --rm --gpus all --entrypoint vllm " + shellQuote(image) + " --version";
  if (key === "trtllm") return "docker run --rm --entrypoint python " + shellQuote(image) + " -c " + shellQuote("import tensorrt_llm; print(\"tensorrt_llm=\" + getattr(tensorrt_llm, \"__version__\", \"unknown\"))");
  if (key === "audio") return "docker run --rm " + shellQuote(image) + " python -c " + shellQuote("import torch; print(\"torch=\" + getattr(torch, \"__version__\", \"unknown\"))");
  return "docker image inspect " + shellQuote(image);
}

function defaultSettingsFor(key: string, publicPort: number, managementMode: ContainerManagementMode): ContainerSettings {
  const lazyRuntime = key === "vllm" || key === "trtllm";
  return { key, public_port: publicPort, management_mode: managementMode, restart_policy: lazyRuntime ? "no" : "unless-stopped", auto_restart: !lazyRuntime, updated_at: new Date().toISOString() };
}

function normalizeRestartPolicy(policy: unknown, autoRestart: unknown, mode: ContainerManagementMode): ContainerRestartPolicy {
  if (policy === "always" || policy === "on-failure" || policy === "unless-stopped" || policy === "no") return policy;
  if (mode === "once" || autoRestart === false) return "no";
  return "unless-stopped";
}

function normalizeContainerName(value: string): string {
  const normalized = slugify(value).replace(/-/g, "_").replace(/[^a-zA-Z0-9_.-]/g, "_");
  return normalized || "custom_runtime";
}

function sanitizeComponents(components: string[]): string[] {
  const allowed = new Set(["cuda", "pytorch", "python", "nodejs", "modelscope", "huggingface", "vllm", "tensorrt-llm", "asr", "tts"]);
  return [...new Set(components.filter((component) => allowed.has(component)))];
}

function isModelPublishingContainer(name: string): boolean {
  if (hiddenContainerNames.has(name)) return false;
  return modelRuntimePrefixes.some((prefix) => name.startsWith(prefix));
}

async function dockerContainers(): Promise<Array<{ name: string; image: string; status: string; state: ContainerRecord["state"]; ports: string }>> {
  const result = await runCommand("docker", ["ps", "-a", "--format", "{{json .}}"], 8000);
  if (!result.ok || !result.stdout) return [];
  return result.stdout.split("\n").filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line) as Record<string, string>;
      const state: ContainerRecord["state"] = row.State === "running" ? "running" : row.State === "exited" ? "stopped" : "unknown";
      return [{ name: row.Names ?? "", image: row.Image ?? "", status: row.Status ?? row.State ?? "unknown", state, ports: row.Ports ?? "" }];
    } catch {
      return [];
    }
  }).filter((row) => row.name);
}
