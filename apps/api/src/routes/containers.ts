import { access, appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { freemem, totalmem } from "node:os";
import { readBody, sendJson } from "../serverUtils.js";
import {
  applyContainerRuntimeConfig, cleanupFailedManagedContainers, deleteContainer, containerAction, containerLogs,
  createCustomContainerTask, createImagePullTask, createImageTestTask, createRuntimeStartTestTask, listContainers, imageExists
} from "../containerManager.js";
import { createTask as persistTask, deleteDeployment, getNetworkSettings, getSetting, getTask, listActiveDeployments, setContainerConfig, setSetting, updateTask, upsertDeployment } from "../store.js";
import { createTask, runManagedCommand } from "../taskRunner.js";
import { listModels } from "../modelRegistry.js";
import { parseComposeRuntimeDeclaration } from "../composeRuntimeMetadata.js";
import type { DeploymentSuite } from "../types.js";
import { runCommand, shellQuote } from "../utils.js";

type CustomComposeProfileMeta = {
  order: number;
  title: string;
  title_zh: string;
  description: string;
  description_zh: string;
  suitable_models: string[];
};

const customComposeProfileMeta: Record<string, Omit<CustomComposeProfileMeta, "suitable_models">> = {
  "funasr-gateway": {
    order: 10,
    title: "FunASR Gateway",
    title_zh: "FunASR 语音网关",
    description: "Single runtime profile for FunASR ASR, VAD, punctuation, and speaker diarization.",
    description_zh: "一个运行时包含 FunASR 语音识别、VAD、标点和说话人分离。"
  },
  "vibevoice-hf": {
    order: 20,
    title: "VibeVoice HF",
    title_zh: "VibeVoice HF",
    description: "Single runtime profile for the local VibeVoice Hugging Face adapter.",
    description_zh: "本地 VibeVoice Hugging Face 适配服务运行时。"
  },
  "qwen3-tts": {
    order: 25,
    title: "Qwen3-TTS",
    title_zh: "Qwen3-TTS 专用语音合成",
    description: "AI Stack-managed Qwen3-TTS service for preset voices, voice design, and voice cloning.",
    description_zh: "由 AI Stack 统一托管 Qwen3-TTS 预置音色、音色设计和参考音频克隆能力。"
  },
  "vllm-embedding": {
    order: 30,
    title: "vLLM Embedding",
    title_zh: "vLLM 向量",
    description: "Qwen3 embedding service with vLLM pooling runner.",
    description_zh: "使用 vLLM pooling runner 发布 Qwen3 向量模型。"
  },
  "vllm-reranker": {
    order: 40,
    title: "vLLM Reranker",
    title_zh: "vLLM 重排",
    description: "Qwen3 reranker service with sequence-classification overrides.",
    description_zh: "使用 sequence-classification overrides 发布 Qwen3 重排模型。"
  },
  "ocr-unlimited": {
    order: 50,
    title: "Unlimited-OCR",
    title_zh: "Unlimited-OCR",
    description: "OCR service profile for a purpose-built image with OCR dependencies.",
    description_zh: "面向专用 OCR 镜像和依赖的文档识别服务。"
  },
  mineru: {
    order: 60,
    title: "MinerU Document Parse",
    title_zh: "MinerU 文档解析",
    description: "Validated MinerU2.5-Pro image and PDF parsing service.",
    description_zh: "已验证的 MinerU2.5-Pro 图片和 PDF 文档解析服务。"
  },
  "locate-anything": {
    order: 70,
    title: "LocateAnything Visual Grounding",
    title_zh: "LocateAnything 视觉定位",
    description: "NVIDIA LocateAnything image grounding and object-location service.",
    description_zh: "NVIDIA LocateAnything 图片目标检测与视觉定位服务。"
  }
};

function customComposeProfileMetadata(id: string): CustomComposeProfileMeta {
  const fallback = customComposeProfileMeta[id] ?? {
    order: 999,
    title: id,
    title_zh: id,
    description: "Custom Docker Compose runtime profile.",
    description_zh: "自定义 Docker Compose 运行时方案。"
  };
  const saved = getSetting("custom_compose_profile:" + id) as Partial<CustomComposeProfileMeta> | undefined;
  return {
    ...fallback,
    title: typeof saved?.title === "string" && saved.title.trim() ? saved.title.trim() : fallback.title,
    title_zh: typeof saved?.title_zh === "string" && saved.title_zh.trim() ? saved.title_zh.trim() : fallback.title_zh,
    description: typeof saved?.description === "string" ? saved.description.trim() : fallback.description,
    description_zh: typeof saved?.description_zh === "string" ? saved.description_zh.trim() : fallback.description_zh,
    suitable_models: Array.isArray(saved?.suitable_models)
      ? [...new Set(saved.suitable_models.map((item) => String(item).trim()).filter(Boolean))].slice(0, 64)
      : customComposeProfileSuitableModels(id)
  };
}

function customComposeProfileSuitableModels(id: string): string[] {
  const models: Record<string, string[]> = {
    "funasr-gateway": [
      "sensevoicesmall",
      "speech_fsmn_vad_zh-cn-16k-common-pytorch",
      "speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
      "punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
      "speech_campplus_sv_zh-cn_16k-common",
      "speech_campplus_speaker-diarization_common"
    ],
    "vibevoice-hf": ["vibevoice", "vibevoice-asr-hf"],
    "qwen3-tts": [
      "qwen3-tts-12hz-1.7b-customvoice",
      "qwen3-tts-12hz-1.7b-voicedesign",
      "qwen3-tts-12hz-1.7b-base"
    ],
    "vllm-embedding": ["qwen3-embedding-8b"],
    "vllm-reranker": ["qwen3-reranker-8b"],
    "ocr-unlimited": ["unlimited-ocr"],
    mineru: ["mineru2.5-pro-2605-1.2b"],
    "locate-anything": ["locateanything-3b"]
  };
  return models[id] ?? [];
}

function customComposeProfileId(fileName: string): string {
  return basename(fileName).replace(/^docker-compose\./, "").replace(/\.ya?ml$/, "");
}

function safeCustomComposeProfileId(value: string): string {
  const id = value.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("Invalid custom compose profile id: " + value);
  return id;
}

function dockerfileIdFromName(value: string): string {
  const id = value.trim()
    .toLowerCase()
    .replace(/^custom[_-]+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || "custom-runtime";
}

function stripYamlValue(value: string): string {
  let raw = value.split("#")[0].trim();
  if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.charCodeAt(0) === 39 && raw.charCodeAt(raw.length - 1) === 39)) raw = raw.slice(1, -1);
  const defaultStart = raw.indexOf(":-");
  if (raw.startsWith("${") && defaultStart >= 0 && raw.endsWith("}")) return raw.slice(defaultStart + 2, -1);
  return raw;
}

function composeValue(yaml: string, key: string): string {
  const line = yaml.split("\n").find((item) => item.trim().startsWith(key + ":")) ?? "";
  return stripYamlValue(line.split(key + ":").slice(1).join(key + ":"));
}

function customProfileImage(yaml: string): string {
  return composeValue(yaml, "image");
}

function customProfileContainerName(id: string, yaml: string): string {
  return composeValue(yaml, "container_name") || "custom_" + id.replace(/-/g, "_") + "_service";
}

async function firstExistingComposePath(profilesDir: string, id: string): Promise<string> {
  const candidates = [
    join(profilesDir, "docker-compose." + id + ".yml"),
    join(profilesDir, "docker-compose." + id + ".yaml")
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next suffix.
    }
  }
  return candidates[0];
}

function defaultDockerfilePath(id: string): string {
  return "deploy/dockerfiles/custom/" + id + ".Dockerfile";
}

function dockerfilePathFromCompose(_yaml: string, id: string): string {
  return defaultDockerfilePath(id);
}

function referencedDockerfilePathFromCompose(yaml: string): string {
  return composeValue(yaml, "dockerfile");
}

function safeWorkspaceFile(workspaceRoot: string, relativePath: string, allowedPrefix: string): string {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\0")) {
    throw new Error("Invalid path: " + relativePath);
  }
  const allowedRoot = resolve(workspaceRoot, allowedPrefix);
  const target = resolve(workspaceRoot, relativePath);
  if (!target.startsWith(allowedRoot + "/") && target !== allowedRoot) {
    throw new Error("Path must stay under " + relative(workspaceRoot, allowedRoot));
  }
  return target;
}

function defaultDockerfileContent(_image: string): string {
  return [
    "ARG BASE_IMAGE=nvcr.io/nvidia/pytorch:25.04-py3",
    "FROM ${BASE_IMAGE}",
    "",
    "WORKDIR /app",
    "ENV PYTHONUNBUFFERED=1",
    "ENV PIP_NO_CACHE_DIR=1",
    "",
    "# Install runtime dependencies here, for example:",
    "# RUN python -m pip install --no-cache-dir fastapi uvicorn",
    "",
    "# Copy service files from the AI Stack project into the image, for example:",
    "# COPY deploy/templates/my_runtime_server.py /app/my_runtime_server.py",
    "",
    "EXPOSE 8000",
    "# CMD [\"python\", \"-m\", \"my_runtime_server\", \"--host\", \"0.0.0.0\", \"--port\", \"8000\"]",
    ""
  ].join("\n");
}

function hasDockerfileInstruction(content: string): boolean {
  return content.split("\n").some((line) => /^FROM\s+\S+/i.test(line.trim()));
}

function ensureComposeBuildBlock(yaml: string, dockerfilePath: string): string {
  const lines = yaml.split("\n");
  const dockerfileIndex = lines.findIndex((line) => line.trim().startsWith("dockerfile:"));
  if (dockerfileIndex >= 0) {
    const indent = lines[dockerfileIndex].match(/^\s*/)?.[0] ?? "";
    lines[dockerfileIndex] = indent + "dockerfile: " + dockerfilePath;
    return lines.join("\n");
  }
  const buildIndex = lines.findIndex((line) => line.trim() === "build:");
  if (buildIndex >= 0) {
    const indent = (lines[buildIndex].match(/^\s*/)?.[0] ?? "") + "  ";
    lines.splice(buildIndex + 1, 0, indent + "dockerfile: " + dockerfilePath);
    return lines.join("\n");
  }
  const imageIndex = lines.findIndex((line) => line.trim().startsWith("image:"));
  if (imageIndex < 0) return yaml;
  const indent = lines[imageIndex].match(/^\s*/)?.[0] ?? "";
  lines.splice(imageIndex + 1, 0,
    indent + "build:",
    indent + "  context: ../../..",
    indent + "  dockerfile: " + dockerfilePath
  );
  return lines.join("\n");
}

function customProfilePublicPort(yaml: string): number | null {
  const envDefault = yaml.match(/\$\{[A-Z0-9_]*PUBLIC_PORT:-([0-9]+)\}/)?.[1];
  if (envDefault) return Number(envDefault);
  const direct = yaml.match(/(?:127\.0\.0\.1|0\.0\.0\.0|localhost):([0-9]+):[0-9]+/)?.[1];
  return direct ? Number(direct) : null;
}

function customProfileRuntimePlan(id: string, modelId: string, port: number | null) {
  const baseUrl = port ? "http://localhost:" + port : "";
  const healthPath = id.startsWith("vllm-") ? "/health" : "/healthz";
  const managedQwenTts = id === "qwen3-tts";
  return {
    deployment_id: "custom-profile:" + id + ":" + (modelId || "runtime"),
    base_url: baseUrl,
    health_url: baseUrl ? baseUrl + healthPath : "",
    stages: [
      { id: "start", label: managedQwenTts ? "Prepare managed service" : "Start runtime", detail: managedQwenTts ? "AI Stack prepares or reuses the managed Qwen3-TTS service." : "Build and start the custom Compose runtime." },
      { id: "load", label: "Load model", detail: managedQwenTts ? "Load the selected model and register all ready Qwen3-TTS models." : "Wait for the runtime to load model weights." },
      { id: "health", label: "Ready check", detail: "Verify the health and model-list endpoints." }
    ],
    current_stage: "start",
    progress_percent: 10,
    stage_statuses: { start: "running", load: "pending", health: "pending" }
  };
}

async function updateCustomProfileTaskStage(
  taskId: string,
  stage: "start" | "load" | "health",
  status: "pending" | "running" | "succeeded" | "failed",
  progress: number
) {
  const task = getTask(taskId);
  if (!task) return;
  const plan = task.metadata?.runtime_plan && typeof task.metadata.runtime_plan === "object"
    ? task.metadata.runtime_plan as any
    : {};
  const statuses = { ...(plan.stage_statuses ?? {}) };
  statuses[stage] = status;
  if (stage === "load") statuses.start = "succeeded";
  if (stage === "health") {
    statuses.start = "succeeded";
    statuses.load = "succeeded";
  }
  updateTask(taskId, {
    metadata: {
      ...task.metadata,
      runtime_plan: {
        ...plan,
        current_stage: stage,
        progress_percent: progress,
        stage_statuses: statuses
      }
    }
  });
}

async function availableSystemMemoryBytes(): Promise<number> {
  try {
    const meminfo = await readFile("/proc/meminfo", "utf-8");
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    const availableKb = Number(match?.[1]);
    if (Number.isFinite(availableKb) && availableKb > 0) return availableKb * 1024;
  } catch { /* Fall back to Node's cross-platform value below. */ }
  return freemem();
}
async function probeJson(url: string): Promise<{ ok: boolean; body?: any; detail: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let body: any = undefined;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
    return { ok: response.ok, body, detail: response.ok ? "" : "HTTP " + response.status + (text ? ": " + text.slice(0, 300) : "") };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForCustomProfileReady(
  taskId: string,
  id: string,
  containerName: string,
  modelId: string,
  port: number,
  healthPath?: string,
  timeoutMs = 15 * 60 * 1000
) {
  const started = Date.now();
  let nextProgressUpdate = started + 15_000;
  const baseUrl = "http://localhost:" + port;
  const healthUrl = baseUrl + (healthPath || (id.startsWith("vllm-") ? "/health" : "/healthz"));
  const requireModelList = id.startsWith("vllm-");
  let lastError = "runtime is still loading";
  while (Date.now() - started < timeoutMs) {
    const memoryReserve = Math.max(12 * 1024 ** 3, totalmem() * 0.10);
    if (await availableSystemMemoryBytes() < memoryReserve) {
      throw new Error("Available unified memory fell below the safety reserve while loading " + modelId + ".");
    }
    const state = await runCommand("docker", ["inspect", "-f", "{{.State.Running}} {{.State.Status}} {{.State.ExitCode}}", containerName], 5000);
    const [running, status = "unknown", exitCode = "unknown"] = state.stdout.trim().split(/\s+/);
    if (!state.ok) {
      throw new Error("Unable to inspect custom runtime " + containerName + ": " + (state.stderr || state.stdout || "container not found"));
    }
    if (running !== "true") {
      throw new Error("Custom runtime stopped before becoming ready (status=" + status + ", exit_code=" + exitCode + ").");
    }
    const health = await probeJson(healthUrl);
    if (health.ok) {
      if (!requireModelList) return;
      const models = await probeJson(baseUrl + "/v1/models");
      const ids = Array.isArray(models.body?.data) ? models.body.data.map((item: any) => String(item?.id ?? "")) : [];
      if (models.ok && ids.includes(modelId)) return;
      lastError = models.ok ? "model list does not include " + modelId : models.detail;
    } else {
      lastError = health.detail;
    }
    if (Date.now() >= nextProgressUpdate) {
      const elapsed = Date.now() - started;
      const progress = Math.min(90, 45 + Math.floor(elapsed / 15_000) * 5);
      await updateCustomProfileTaskStage(taskId, "load", "running", progress);
      nextProgressUpdate = Date.now() + 15_000;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3000));
  }
  throw new Error("Custom runtime readiness timeout: " + lastError);
}

export function register(
  route: (method: string, path: string, handler: (...args: any[]) => Promise<void>) => void,
  workspaceRoot: string,
  logsRoot: string,
  stateRoot: string
) {
  route("GET", "/containers", async (_req: any, res: any) => {
    sendJson(res, 200, await listContainers());
  });

  route("POST", "/containers/cleanup-failed", async (_req: any, res: any) => {
    try {
      sendJson(res, 200, await cleanupFailedManagedContainers(workspaceRoot));
    } catch (error) {
      sendJson(res, 503, { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  route("POST", "/containers/:key/config", async (req: any, res: any, params: any) => {
    const key = decodeURIComponent(params.key);
    const body = await readBody<{ public_port?: number; management_mode?: "resident" | "once"; restart_policy?: string; auto_restart?: boolean }>(req);
    try {
      const settings = setContainerConfig(key, body as any);
      sendJson(res, 200, { settings, apply: await applyContainerRuntimeConfig(key, settings) });
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  route("POST", "/containers/:key/metadata", async (req: any, res: any, params: any) => {
    const key = decodeURIComponent(params.key);
    const body = await readBody<{ note?: string; suitable_models?: string[] }>(req);
    const note = String(body.note ?? "").trim().slice(0, 500);
    const suitableModels = [...new Set(
      (Array.isArray(body.suitable_models) ? body.suitable_models : [])
        .map((item) => String(item).trim())
        .filter(Boolean)
    )].slice(0, 64);
    const metadata = { note, suitable_models: suitableModels };
    setSetting("container_metadata:" + key, metadata);
    sendJson(res, 200, { key, ...metadata });
  });

  route("POST", "/containers/:key/pull-image", async (_req: any, res: any, params: any) => {
    try {
      sendJson(res, 202, await createImagePullTask(decodeURIComponent(params.key), workspaceRoot, logsRoot));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  route("POST", "/containers/:key/test-image", async (_req: any, res: any, params: any) => {
    try {
      sendJson(res, 202, await createImageTestTask(decodeURIComponent(params.key), workspaceRoot, logsRoot));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  route("POST", "/containers/:key/start-test", async (_req: any, res: any, params: any) => {
    try {
      sendJson(res, 202, await createRuntimeStartTestTask(decodeURIComponent(params.key), workspaceRoot, logsRoot));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });


  route("GET", "/containers/custom/profiles", async (_req: any, res: any) => {
    const profilesDir = join(workspaceRoot, "deploy", "compose", "custom");
    try {
      const entries = await readdir(profilesDir, { withFileTypes: true });
      const profiles = await Promise.all(entries
        .filter((entry) => entry.isFile() && /^docker-compose\..+\.ya?ml$/.test(entry.name))
        .map(async (entry) => {
          const id = customComposeProfileId(entry.name);
          const meta = customComposeProfileMetadata(id);
          const yaml = await readFile(join(profilesDir, entry.name), "utf-8");
          const runtimeDeclaration = parseComposeRuntimeDeclaration(yaml);
          const image = customProfileImage(yaml);
          return {
            id,
            file: "deploy/compose/custom/" + entry.name,
            ...meta,
            suitable_models: runtimeDeclaration?.components.map((item) => item.model_id) ?? meta.suitable_models,
            runtime_declaration: runtimeDeclaration,
            image,
            image_built: await imageExists(image),
            container_name: customProfileContainerName(id, yaml),
            yaml
          };
        }));
      sendJson(res, 200, { profiles: profiles.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)) });
    } catch (error) {
      sendJson(res, 200, { profiles: [], detail: error instanceof Error ? error.message : String(error) });
    }
  });


  route("PUT", "/containers/custom/profiles/:id", async (req: any, res: any, params: any) => {
    try {
      const id = safeCustomComposeProfileId(decodeURIComponent(params.id));
      const profilesDir = join(workspaceRoot, "deploy", "compose", "custom");
      const composePath = await firstExistingComposePath(profilesDir, id);
      await access(composePath);
      const body = await readBody<Partial<CustomComposeProfileMeta> & { yaml?: string }>(req);
      const current = customComposeProfileMetadata(id);
      const next: CustomComposeProfileMeta = {
        ...current,
        title: String(body.title ?? current.title).trim().slice(0, 80) || current.title,
        title_zh: String(body.title_zh ?? body.title ?? current.title_zh).trim().slice(0, 80) || current.title_zh,
        description: String(body.description ?? current.description).trim().slice(0, 500),
        description_zh: String(body.description_zh ?? body.description ?? current.description_zh).trim().slice(0, 500),
        suitable_models: Array.isArray(body.suitable_models)
          ? [...new Set(body.suitable_models.map((item) => String(item).trim()).filter(Boolean))].slice(0, 64)
          : current.suitable_models
      };
      const yaml = typeof body.yaml === "string" ? body.yaml.trim() : "";
      if (yaml) await writeFile(composePath, yaml.endsWith("\n") ? yaml : yaml + "\n", "utf-8");
      setSetting("custom_compose_profile:" + id, next);
      sendJson(res, 200, { ok: true, id, ...next, yaml: yaml || undefined });
    } catch (error) {
      sendJson(res, 400, { ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  });


  route("GET", "/containers/custom/profiles/:id/dockerfile", async (_req: any, res: any, params: any) => {
    try {
      const id = safeCustomComposeProfileId(decodeURIComponent(params.id));
      const profilesDir = join(workspaceRoot, "deploy", "compose", "custom");
      const composePath = await firstExistingComposePath(profilesDir, id);
      const yaml = await readFile(composePath, "utf-8");
      const dockerfilePath = dockerfilePathFromCompose(yaml, id);
      const absoluteDockerfilePath = safeWorkspaceFile(workspaceRoot, dockerfilePath, "deploy/dockerfiles");
      const referencedDockerfilePath = referencedDockerfilePathFromCompose(yaml);
      const image = composeValue(yaml, "image");
      let content = defaultDockerfileContent(image);
      let exists = false;
      try {
        content = await readFile(absoluteDockerfilePath, "utf-8");
        exists = true;
      } catch {
        if (referencedDockerfilePath && referencedDockerfilePath !== dockerfilePath) {
          try {
            const referencedAbsolutePath = safeWorkspaceFile(workspaceRoot, referencedDockerfilePath, "deploy/dockerfiles");
            content = await readFile(referencedAbsolutePath, "utf-8");
          } catch {
            // Fall back to the generated template below.
          }
        }
      }
      sendJson(res, 200, {
        id,
        exists,
        compose_file: relative(workspaceRoot, composePath).replace(/\\/g, "/"),
        dockerfile_path: dockerfilePath,
        source_dockerfile_path: referencedDockerfilePath && referencedDockerfilePath !== dockerfilePath ? referencedDockerfilePath : undefined,
        image,
        content
      });
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  route("PUT", "/containers/custom/profiles/:id/dockerfile", async (req: any, res: any, params: any) => {
    const body = await readBody<{ content?: string; dockerfile_path?: string }>(req);
    try {
      const id = safeCustomComposeProfileId(decodeURIComponent(params.id));
      const profilesDir = join(workspaceRoot, "deploy", "compose", "custom");
      const composePath = await firstExistingComposePath(profilesDir, id);
      const yaml = await readFile(composePath, "utf-8");
      const dockerfilePath = dockerfilePathFromCompose(yaml, id);
      const absoluteDockerfilePath = safeWorkspaceFile(workspaceRoot, dockerfilePath, "deploy/dockerfiles");
      const content = body.content ?? "";
      if (!hasDockerfileInstruction(content)) throw new Error("Dockerfile must include a FROM instruction.");
      await mkdir(dirname(absoluteDockerfilePath), { recursive: true });
      await writeFile(absoluteDockerfilePath, content, "utf-8");
      const nextYaml = ensureComposeBuildBlock(yaml, dockerfilePath);
      if (nextYaml !== yaml) await writeFile(composePath, nextYaml, "utf-8");
      sendJson(res, 200, {
        ok: true,
        id,
        compose_file: relative(workspaceRoot, composePath).replace(/\\/g, "/"),
        dockerfile_path: dockerfilePath,
        compose_yaml: nextYaml,
        compose_updated: nextYaml !== yaml
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  });

  route("POST", "/containers/custom/profiles/:id/build", async (_req: any, res: any, params: any) => {
    try {
      const id = safeCustomComposeProfileId(decodeURIComponent(params.id));
      const profilesDir = join(workspaceRoot, "deploy", "compose", "custom");
      const composePath = await firstExistingComposePath(profilesDir, id);
      await access(composePath);
      const yaml = await readFile(composePath, "utf-8");
      const image = customProfileImage(yaml);
      const name = customProfileContainerName(id, yaml);
      const projectName = "custom_" + id.replace(/-/g, "_");
      const command = ["docker compose -f", shellQuote(composePath), "-p", shellQuote(projectName), "build"].join(" " );
      const task = createTask("container", command, workspaceRoot, join(logsRoot, "tasks", "image-custom-" + id + "-build.log"), {
        action: "build_custom_image",
        key: "custom-profile:" + id,
        profile_id: id,
        name,
        container_name: name,
        image,
        compose_yaml_path: composePath
      });
      await persistTask(task);
      void runManagedCommand({ taskId: task.id, command: "bash", args: ["-lc", command], cwd: workspaceRoot, logPath: task.log_path });
      sendJson(res, 202, { status: "starting", id, task });
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });


  route("POST", "/containers/custom/profiles/:id/start", async (req: any, res: any, params: any) => {
    try {
      const body = await readBody<{ model_id?: string; openai_model?: string }>(req);
      const id = safeCustomComposeProfileId(decodeURIComponent(params.id));
      const profileMeta = customComposeProfileMetadata(id);
      const profilesDir = join(workspaceRoot, "deploy", "compose", "custom");
      const composePath = await firstExistingComposePath(profilesDir, id);
      await access(composePath);
      const yaml = await readFile(composePath, "utf-8");
      const image = customProfileImage(yaml);
      const name = customProfileContainerName(id, yaml);
      const projectName = "custom_" + id.replace(/-/g, "_");
      const modelId = String(body.model_id ?? "").trim();
      const openaiModel = String(body.openai_model ?? modelId).trim();
      const runtimeDeclaration = parseComposeRuntimeDeclaration(yaml);
      const modelCatalog = runtimeDeclaration ? await listModels(join(workspaceRoot, "models")) : [];
      const readyModelIds = new Set(modelCatalog.filter((model) => model.status.download === "ready").map((model) => model.id));
      const missingRequired = runtimeDeclaration?.components.filter((component) => component.required && !readyModelIds.has(component.model_id)) ?? [];
      if (missingRequired.length) throw new Error("Suite is missing required ready models: " + missingRequired.map((item) => item.model_id).join(", "));
      const suite: DeploymentSuite | undefined = runtimeDeclaration ? {
        ...runtimeDeclaration,
        title: runtimeDeclaration.title || profileMeta.title,
        title_zh: runtimeDeclaration.title_zh || profileMeta.title_zh,
        components: runtimeDeclaration.publish_policy === "all_ready"
          ? runtimeDeclaration.components.filter((component) => readyModelIds.has(component.model_id))
          : runtimeDeclaration.components.filter((component) => component.model_id === modelId)
      } : undefined;
      if (suite && !suite.components.length) throw new Error("Suite has no ready components to publish.");
      const publicPort = customProfilePublicPort(yaml);
      const runningState = id === "qwen3-tts"
        ? await runCommand("docker", ["inspect", "-f", "{{.State.Running}}", name], 5000)
        : null;
      const reuseManagedService = runningState?.ok === true && runningState.stdout.trim() === "true";
      const bindAddress = getNetworkSettings().lan_access_enabled ? "0.0.0.0" : "127.0.0.1";
      const runtimeEnv = [
        "AI_STACK_BIND_ADDR=" + shellQuote(bindAddress),
        modelId ? "MODEL_ALIAS=" + shellQuote(modelId) : "",
        openaiModel ? "OPENAI_MODEL=" + shellQuote(openaiModel) : "",
        id === "vibevoice-hf" && modelId ? "VIBEVOICE_RUNTIME_MODEL=" + shellQuote("/models/" + modelId) : "",
        id === "vibevoice-hf" && openaiModel ? "VIBEVOICE_MODEL=" + shellQuote(openaiModel) : ""
      ].filter(Boolean).join(" ");
      const command = reuseManagedService
        ? "echo " + shellQuote("[ai-stack] Reusing managed Qwen3-TTS service: " + name)
        : ["docker rm -f " + shellQuote(name) + " >/dev/null 2>&1 || true;", runtimeEnv, "docker compose -f", shellQuote(composePath), "-p", shellQuote(projectName), "up -d --build"].filter(Boolean).join(" " );
      const task = createTask("container", command, workspaceRoot, join(logsRoot, "tasks", "runtime-custom-" + id + "-start.log"), {
        action: "start_custom_profile",
        key: "custom-profile:" + id,
        profile_id: id,
        profile_title: profileMeta.title,
        profile_title_zh: profileMeta.title_zh,
        model_id: modelId || undefined,
        openai_model: openaiModel || undefined,
        name,
        container_name: name,
        image,
        compose_yaml_path: composePath,
        reused_managed_service: reuseManagedService,
        suite,
        runtime_plan: customProfileRuntimePlan(id, modelId, publicPort)
      });
      await persistTask(task);
      void runManagedCommand({
        taskId: task.id,
        command: "bash",
        args: ["-lc", command],
        cwd: workspaceRoot,
        logPath: task.log_path,
        onSuccess: async () => {
          await updateCustomProfileTaskStage(task.id, "load", "running", 45);
          if (!publicPort) throw new Error("Custom runtime profile has no detectable public port.");
          await waitForCustomProfileReady(task.id, id, name, id === "qwen3-tts" ? modelId : openaiModel || modelId, publicPort, suite?.health_path);
          await updateCustomProfileTaskStage(task.id, "health", "succeeded", 100);
          const serviceType = id.startsWith("vllm-") ? "vllm" : "pytorch";
          const baseUrl = "http://localhost:" + publicPort + (serviceType === "vllm" ? "/v1" : "");
          const healthUrl = "http://localhost:" + publicPort + (suite?.health_path || (serviceType === "vllm" ? "/health" : "/healthz"));
          const deployedModel = id === "qwen3-tts" ? modelId : openaiModel || modelId;
          if (suite) {
            const deploymentId = "custom-profile:" + id + ":suite";
            for (const existing of listActiveDeployments()) {
              if (existing.container_name === name && existing.deployment_id !== deploymentId) deleteDeployment(existing.deployment_id);
            }
            upsertDeployment({
              deployment_id: deploymentId,
              model_id: modelId || suite.components[0].model_id,
              service_type: serviceType,
              runtime: id,
              container_name: name,
              public_port: publicPort,
              base_url: baseUrl,
              health_url: healthUrl,
              worker_endpoint: baseUrl,
              openai_model: deployedModel || suite.components[0].model_id,
              status: "running",
              task_id: task.id,
              updated_at: new Date().toISOString(),
              suite
            });
          } else {
            const publishedModels = id === "qwen3-tts"
              ? profileMeta.suitable_models.map((candidate) => ({
                  modelId: candidate,
                  openaiModel: candidate === modelId ? deployedModel : candidate
                }))
              : [{ modelId, openaiModel: deployedModel }];
            for (const published of publishedModels) {
              upsertDeployment({
                deployment_id: "custom-profile:" + id + ":" + published.openaiModel,
                model_id: published.modelId,
                service_type: serviceType,
                runtime: id,
                container_name: name,
                public_port: publicPort,
                base_url: baseUrl,
                health_url: healthUrl,
                worker_endpoint: baseUrl,
                openai_model: published.openaiModel,
                status: "running",
                task_id: task.id,
                updated_at: new Date().toISOString()
              });
            }
          }
        },
        onFailure: async (error) => {
          const current = getTask(task.id);
          const stage = String((current?.metadata?.runtime_plan as any)?.current_stage ?? "start");
          const failedStage = stage === "load" || stage === "health" ? stage : "start";
          await updateCustomProfileTaskStage(task.id, failedStage, "failed", 100);
          const logs = await runCommand("docker", ["logs", "--tail", "240", name], 15000);
          const output = [logs.stdout, logs.stderr].filter(Boolean).join("\n").trim();
          await appendFile(
            task.log_path,
            "\n[" + new Date().toISOString() + "] runtime failure: " + error
              + (output ? "\ncontainer logs (tail):\n" + output : "")
              + "\n",
            "utf-8"
          ).catch(() => {});
          if (!reuseManagedService) {
            await runCommand("docker", ["compose", "-f", composePath, "-p", projectName, "stop"], 60000);
          }
        }
      });
      sendJson(res, 202, { status: "starting", id, task });
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });



  route("DELETE", "/containers/custom/profiles/:id", async (_req: any, res: any, params: any) => {
    try {
      const id = safeCustomComposeProfileId(decodeURIComponent(params.id));
      const profilesDir = join(workspaceRoot, "deploy", "compose", "custom");
      const yamlPath = join(profilesDir, "docker-compose." + id + ".yml");
      await rm(yamlPath, { force: true });
      sendJson(res, 200, { ok: true, id });
    } catch (error) {
      sendJson(res, 400, { ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  });

  route("POST", "/containers/custom", async (req: any, res: any) => {
    const body = await readBody<{
      name?: string;
      image?: string;
      components?: string[];
      compose_yaml?: string;
      dockerfile_content?: string;
      dockerfile_path?: string;
      management_mode?: string;
      restart_policy?: string;
      auto_restart?: boolean;
      note?: string;
      suitable_models?: string[];
    }>(req);
    try {
      let request = body;
      if (body.compose_yaml && body.dockerfile_content?.trim()) {
        const dockerfilePath = body.dockerfile_path?.trim() || defaultDockerfilePath(dockerfileIdFromName(body.name || "custom-runtime"));
        const absoluteDockerfilePath = safeWorkspaceFile(workspaceRoot, dockerfilePath, "deploy/dockerfiles");
        if (!hasDockerfileInstruction(body.dockerfile_content)) throw new Error("Dockerfile must include a FROM instruction.");
        await mkdir(dirname(absoluteDockerfilePath), { recursive: true });
        await writeFile(absoluteDockerfilePath, body.dockerfile_content, "utf-8");
        request = {
          ...body,
          dockerfile_path: dockerfilePath,
          compose_yaml: ensureComposeBuildBlock(body.compose_yaml, dockerfilePath)
        };
      }
      sendJson(res, 202, await createCustomContainerTask(request as any, workspaceRoot, logsRoot));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  route("POST", "/containers/compose/validate", async (req: any, res: any) => {
    const body = await readBody<{ yaml: string }>(req);
    if (!body.yaml) return sendJson(res, 400, { detail: "yaml field is required" });
    const tmpDir = join(stateRoot, "tmp", "compose-validate-" + Date.now());
    const yamlPath = join(tmpDir, "docker-compose.yml");
    try {
      await mkdir(tmpDir, { recursive: true });
      await writeFile(yamlPath, body.yaml, "utf-8");
      const result = await runCommand("docker", ["compose", "-f", yamlPath, "config", "--dry-run"], 15000);
      if (result.ok) {
        sendJson(res, 200, { valid: true, normalized: result.stdout || "" });
      } else {
        sendJson(res, 200, { valid: false, errors: (result.stderr || result.stdout || "Unknown docker compose error").slice(0, 2000) });
      }
    } catch (error) {
      sendJson(res, 200, { valid: false, errors: error instanceof Error ? error.message : String(error) });
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  route("GET", "/containers/:name/logs", async (req: any, res: any, params: any) => {
    const lines = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("lines") ?? "200");
    sendJson(res, 200, await containerLogs(params.name, lines));
  });

  route("POST", "/containers/:name/:action", async (_req: any, res: any, params: any) => {
    if (!["start", "stop", "restart"].includes(params.action))
      return sendJson(res, 400, { detail: "Unsupported container action: " + params.action });
    sendJson(res, 202, await containerAction(params.name, params.action as "start" | "stop" | "restart"));
  });

  route("DELETE", "/containers/:key", async (_req: any, res: any, params: any) => {
    if (!["vllm", "trtllm", "pytorch"].includes(params.key))
      return sendJson(res, 403, { detail: "Only runtime containers (vllm, trtllm, pytorch) can be deleted through this API." });
    const result = await deleteContainer(params.key);
    sendJson(res, result.ok ? 200 : 500, result);
  });

  route("DELETE", "/containers/custom/:name", async (_req: any, res: any, params: any) => {
    const name = decodeURIComponent(params.name);
    const psOutput = await runCommand("docker", ["ps", "-a", "--format", "{{.Names}}"], 5000);
    const exists = psOutput.stdout?.split("\n").map((s: string) => s.trim()).includes(name);
    if (!exists) return sendJson(res, 404, { detail: "Container not found: " + name });
    const result = await runCommand("docker", ["rm", "-f", name], 15000);
    sendJson(res, result.ok ? 200 : 500, { name, ok: result.ok, detail: result.stdout || result.stderr });
  });
}
