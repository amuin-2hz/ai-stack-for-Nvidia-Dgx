import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createTask, runManagedCommand } from "./taskRunner.js";
import { runCommand, shellQuote, slugify } from "./utils.js";
import { createTask as persistTask, deleteDeployment, getSetting, setSetting, listTasks, listContainerConfigs } from "./store.js";
import type { ContainerManagementMode, ContainerRestartPolicy, ContainerSettings } from "./types.js";
import type { CustomContainerRequest, ContainerRecord, RuntimePreset } from "./containerPresets.js";
import {
  presets, presetForKey, isModelPublishingContainer, defaultSettingsFor
} from "./containerPresets.js";
import {
  dockerContainers, imageExists, testCommandFor, dockerContainerLogs,
  dockerContainerAction, dockerDeleteContainer
} from "./containerDocker.js";

/* ── name helpers ──────────────────────────────── */
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
  return [...new Set(components.filter((c) => allowed.has(c)))];
}

function saveRequestedContainerMetadata(name: string, request: CustomContainerRequest) {
  const note = String(request.note ?? "").trim().slice(0, 500);
  const suitableModels = [...new Set(
    (request.suitable_models ?? []).map((item) => String(item).trim()).filter(Boolean)
  )].slice(0, 64);
  setSetting("container_metadata:custom:" + name, { note, suitable_models: suitableModels });
}

/* ── task helpers ──────────────────────────────── */
function latestImageTestStatus(
  tasks: Array<{ status: string; metadata: Record<string, unknown>; updated_at: string }>,
  key: string
): ContainerRecord["test_status"] {
  const task = tasks
    .filter((item) => item.metadata?.action === "test_image" && item.metadata?.key === key)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  if (!task) return "untested";
  if (task.status === "succeeded") return "passed";
  if (task.status === "failed") return "failed";
  return "running";
}

function inferredContainerMetadata(name: string): { note: string; suitable_models: string[] } {
  const lower = name.toLowerCase();
  if (/custom_funasr_gateway/.test(lower)) {
    return {
      note: "FunASR ASR, VAD, punctuation, and speaker diarization runtime.",
      suitable_models: [
        "sensevoicesmall",
        "speech_fsmn_vad_zh-cn-16k-common-pytorch",
        "speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        "punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
        "speech_campplus_sv_zh-cn_16k-common",
        "speech_campplus_speaker-diarization_common"
      ]
    };
  }
  if (/custom_vibevoice_hf/.test(lower)) {
    return {
      note: "VibeVoice Hugging Face adapter runtime.",
      suitable_models: ["vibevoice", "vibevoice-asr-hf"]
    };
  }
  if (/custom_.*unlimited.*ocr/.test(lower)) {
    return { note: "Existing OCR runtime.", suitable_models: ["unlimited-ocr"] };
  }
  if (/custom_.*mineru/.test(lower)) {
    return { note: "Existing MinerU document runtime.", suitable_models: ["mineru2.5-pro-2605-1.2b"] };
  }
  if (/custom_.*locate/.test(lower)) {
    return { note: "Existing visual grounding runtime.", suitable_models: ["locateanything-3b"] };
  }
  if (/^vllm_/.test(lower)) {
    const modelId = lower.replace(/^vllm_/, "").replace(/_/g, "-");
    return { note: "Model publishing instance; managed from Loaded Models.", suitable_models: [modelId] };
  }
  return { note: "", suitable_models: [] };
}

function inferredContainerTitle(name: string): string {
  const lower = name.toLowerCase();
  if (/custom_funasr_gateway/.test(lower)) return "FunASR Gateway";
  if (/custom_vibevoice_hf/.test(lower)) return "VibeVoice HF";
  if (/custom_.*unlimited.*ocr/.test(lower)) return "Unlimited-OCR";
  if (/custom_.*mineru/.test(lower)) return "MinerU Document Parse";
  if (/custom_.*locate/.test(lower)) return "LocateAnything Visual Grounding";
  return name;
}

function containerMetadata(key: string, name: string): { note: string; suitable_models: string[] } {
  const inferred = inferredContainerMetadata(name);
  const saved = getSetting("container_metadata:" + key) as { note?: unknown; suitable_models?: unknown } | undefined;
  return {
    note: typeof saved?.note === "string" ? saved.note : inferred.note,
    suitable_models: Array.isArray(saved?.suitable_models)
      ? saved.suitable_models.filter((item): item is string => typeof item === "string")
      : inferred.suitable_models
  };
}

/* ── custom container ──────────────────────────── */
export async function createCustomContainerTask(request: CustomContainerRequest, baseDir: string, logsRoot: string) {
  if (request.compose_yaml) {
    const rawName = request.name?.trim() || "custom_compose_" + Date.now();
    const name = normalizeContainerName(rawName.startsWith("custom_") ? rawName : "custom_" + rawName);
    saveRequestedContainerMetadata(name, request);
    const composeDir = join(baseDir, "state", "compose", name);
    await mkdir(composeDir, { recursive: true });
    const yamlPath = join(composeDir, "docker-compose.yml");
    await writeFile(yamlPath, request.compose_yaml, "utf-8");
    const mode = request.management_mode === "once" ? "once" : "resident";
    const restartPolicy = normalizeRestartPolicy(request.restart_policy, request.auto_restart, mode);
    const command = ["docker compose -f", shellQuote(yamlPath), "-p", shellQuote(name), "up -d --wait"].join(" ");
    const task = createTask("container", command, baseDir, join(logsRoot, "tasks", "container-" + name + ".log"), { name, image: "compose:" + name, components: [], management_mode: mode, restart_policy: restartPolicy, compose_yaml_path: yamlPath });
    await persistTask(task);
    void runManagedCommand({ taskId: task.id, command: "bash", args: ["-lc", command], cwd: baseDir, logPath: task.log_path });
    return { status: "starting", container: { name, image: "compose", components: [], management_mode: mode, restart_policy: restartPolicy }, task };
  }

  const components = sanitizeComponents(request.components ?? []);
  const runtimeHint = components.includes("vllm") ? "vllm" : components.includes("tensorrt-llm") ? "trtllm" : "runtime";
  const rawName = request.name?.trim() || "custom_" + runtimeHint + "_" + Date.now();
  const name = normalizeContainerName(rawName.startsWith("custom_") ? rawName : "custom_" + rawName);
  saveRequestedContainerMetadata(name, request);
  const image = request.image || process.env.CUSTOM_RUNTIME_IMAGE || "nvcr.io/nvidia/pytorch:25.04-py3";
  const mode = request.management_mode === "once" ? "once" : "resident";
  const restartPolicy = normalizeRestartPolicy(request.restart_policy, request.auto_restart, mode);
  const createCommand = [
    "docker create", "--name", shellQuote(name),
    "--label", shellQuote("amuin.role=model-runtime"),
    "--label", shellQuote("amuin.components=" + components.join(",")),
    "--label", shellQuote("amuin.management_mode=" + mode),
    "--restart", shellQuote(restartPolicy),
    shellQuote(image), "sleep", "infinity"
  ].join(" ");
  const command = mode === "resident" ? createCommand + " && docker start " + shellQuote(name) : createCommand;
  const task = createTask("container", command, baseDir, join(logsRoot, "tasks", "container-" + name + ".log"), { name, image, components, management_mode: mode, restart_policy: restartPolicy });
  await persistTask(task);
  void runManagedCommand({ taskId: task.id, command: "bash", args: ["-lc", command], cwd: baseDir, logPath: task.log_path });
  return { status: "starting", container: { name, image, components, management_mode: mode, restart_policy: restartPolicy }, task };
}

/* ── image tasks ───────────────────────────────── */

export async function createRuntimeStartTestTask(key: string, baseDir: string, logsRoot: string) {
  const preset = presetForKey(key);
  if (!preset) throw new Error("Unknown preset runtime: " + key);
  const settings = ((listContainerConfigs() as ContainerSettings[]).find((c) => c.key === key)) ?? defaultSettingsFor(preset.key, preset.port, preset.management_mode);
  const name = preset.names[0] ?? preset.key;
  const bindAddress = process.env.AI_STACK_BIND_ADDR === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0";
  const internalPort = key === "pytorch" ? 9000 : 8000;
  const restartPolicy = normalizeRestartPolicy(settings.restart_policy, settings.auto_restart, settings.management_mode);
  const image = settings.image || preset.image;
  const runCommand = [
    "docker run -d",
    "--name", shellQuote(name),
    "--label", shellQuote("amuin.role=model-runtime"),
    "--label", shellQuote("amuin.runtime=" + key),
    "--label", shellQuote("amuin.loaded_model=false"),
    "--restart", shellQuote(restartPolicy),
    "--gpus", "all",
    "--ipc", "host",
    "-p", shellQuote(bindAddress + ":" + settings.public_port + ":" + internalPort),
    "--entrypoint", "sleep",
    shellQuote(image),
    "infinity"
  ].join(" ");
  const command = [
    "docker info >/dev/null",
    "echo " + shellQuote("[preflight] Docker is reachable"),
    "docker pull " + shellQuote(image),
    "echo " + shellQuote("[preflight] Image is available: " + image),
    "(docker rm -f " + shellQuote(name) + " >/dev/null 2>&1 || true)",
    runCommand,
    "sleep 3",
    "test \"$(docker inspect -f '{{.State.Running}}' " + shellQuote(name) + ")\" = \"true\"",
    "echo " + shellQuote("[ok] Runtime container is running without a loaded model: " + name)
  ].join(" && ");
  const task = createTask("container", command, baseDir, join(logsRoot, "tasks", "runtime-" + key + "-start-test.log"), { action: "test_image", mode: "runtime_start", key, image, name, public_port: settings.public_port, restart_policy: restartPolicy });
  await persistTask(task);
  void runManagedCommand({
    taskId: task.id,
    command: "bash",
    args: ["-lc", command],
    cwd: baseDir,
    logPath: task.log_path,
    onSuccess: async () => { deleteDeployment("svc_" + key); }
  });
  return { status: "starting", image, container_name: name, task };
}

export async function createImagePullTask(key: string, baseDir: string, logsRoot: string) {
  const preset = presetForKey(key);
  if (!preset) throw new Error("Unknown preset runtime: " + key);
  const settings = ((listContainerConfigs() as ContainerSettings[]).find((c) => c.key === key)) ?? defaultSettingsFor(preset.key, preset.port, preset.management_mode);
  const image = settings.image || preset.image;
  const command = "docker pull " + shellQuote(image);
  const task = createTask("container", command, baseDir, join(logsRoot, "tasks", "image-" + key + "-pull.log"), { action: "pull_image", key, image });
  await persistTask(task);
  void runManagedCommand({ taskId: task.id, command: "bash", args: ["-lc", command], cwd: baseDir, logPath: task.log_path });
  return { status: "starting", image, task };
}

export async function createImageTestTask(key: string, baseDir: string, logsRoot: string) {
  const preset = presetForKey(key);
  if (!preset) throw new Error("Unknown preset runtime: " + key);
  const settings = ((listContainerConfigs() as ContainerSettings[]).find((c) => c.key === key)) ?? defaultSettingsFor(preset.key, preset.port, preset.management_mode);
  const image = settings.image || preset.image;
  const command = testCommandFor(key, image);
  const task = createTask("container", command, baseDir, join(logsRoot, "tasks", "image-" + key + "-test.log"), { action: "test_image", key, image });
  await persistTask(task);
  void runManagedCommand({ taskId: task.id, command: "bash", args: ["-lc", command], cwd: baseDir, logPath: task.log_path });
  return { status: "starting", image, task };
}

/* ── list containers ───────────────────────────── */
export async function listContainers(): Promise<{ containers: ContainerRecord[]; components: string[]; modes: string[]; restart_policies: string[] }> {
  const [dockerRows, settings, tasks] = await Promise.all([
    dockerContainers(),
    Promise.resolve(listContainerConfigs()),
    Promise.resolve(listTasks())
  ]);

  const containers: ContainerRecord[] = await Promise.all(presets.map(async (preset) => {
    const config = (settings as ContainerSettings[]).find((c) => c.key === preset.key) ?? defaultSettingsFor(preset.key, preset.port, preset.management_mode);
    const match = dockerRows.find((row) => preset.names.includes(row.name));
    const configuredImage = config.image || preset.image;
    const img = match?.image || configuredImage;
    const imgPulled = await imageExists(configuredImage);
    const testStatus = latestImageTestStatus(tasks as any[], preset.key);

    const metadata = containerMetadata(preset.key, preset.names[0] ?? preset.key);
    return match ? {
      key: preset.key, name: preset.names[0] ?? preset.key, slot_name: preset.names[0] ?? preset.key,
      instance_name: match.name, title: preset.title, image: match.image, status: match.status,
      state: match.state, ports: match.ports || String(config.public_port), public_port: config.public_port,
      runtime: preset.runtime, management_mode: config.management_mode, restart_policy: config.restart_policy,
      auto_restart: config.auto_restart, preset: true, components: preset.components,
      official_image: preset.image, image_pulled: imgPulled, test_status: testStatus,
      software_versions: preset.versions, category: "system" as const, ...metadata
    } : {
      key: preset.key, name: preset.names[0] ?? preset.key, slot_name: preset.names[0] ?? preset.key,
      instance_name: null, title: preset.title, image: configuredImage, status: "missing",
      state: "missing" as const, ports: String(config.public_port), public_port: config.public_port,
      runtime: preset.runtime, management_mode: config.management_mode, restart_policy: config.restart_policy,
      auto_restart: config.auto_restart, preset: true, components: preset.components,
      official_image: preset.image, image_pulled: imgPulled, test_status: testStatus, software_versions: preset.versions,
      category: "system" as const, ...metadata
    };
  }));

  for (const row of dockerRows) {
    if (!isModelPublishingContainer(row.name)) continue;
    if (!containers.some((c) => c.instance_name === row.name || c.name === row.name)) {
      const key = "custom:" + row.name;
      const category = row.name.startsWith("custom_") ? "custom" as const : "model-instance" as const;
      containers.push({
        key, name: row.name, slot_name: row.name, instance_name: row.name,
        title: inferredContainerTitle(row.name), image: row.image, status: row.status, state: row.state, ports: row.ports,
        public_port: 0, runtime: "custom", management_mode: "resident", restart_policy: "unless-stopped",
        auto_restart: true, preset: false, components: [], official_image: row.image,
        image_pulled: true, test_status: "untested", software_versions: {},
        category, ...containerMetadata(key, row.name)
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

/* ── runtime config ────────────────────────────── */
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

/* ── backward-compatible wrappers ─────────────── */
export { dockerContainerLogs as containerLogs };
export { dockerContainerAction as containerAction };

export async function deleteContainer(key: string): Promise<{ key: string; ok: boolean; steps: string[] }> {
  const preset = presetForKey(key);
  if (!preset) return { key, ok: false, steps: ["Unknown container key: " + key] };
  return dockerDeleteContainer(key, preset.image, preset.names);
}
