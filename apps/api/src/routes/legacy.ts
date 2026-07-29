import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createWriteStream } from "node:fs";
import Busboy from "busboy";
import { readBody, sendJson } from "../serverUtils.js";
import {
  listChats, getCurrentChatId, setCurrentChatId, getChat, createChat, renameChat, deleteChat, clearChats, appendMessage,
  setIngestTask, ingestStatus,
  getSelectedSources, setSelectedSources, getSelectedModel, setSelectedModel,
} from "../store.js";
import { listModels } from "../modelRegistry.js";
import { getContainerConfig } from "../store.js";
import { proxyHttp } from "../httpProxy.js";
import { newId } from "../utils.js";

export function register(
  route: (method: string, path: string, handler: (...args: any[]) => Promise<void>) => void,
  modelsRoot: string,
  uploadsRoot: string,
  audioServiceUrl: string
) {
  /* sources / model selection */
  route("GET", "/selected_sources", async (_req: any, res: any) => {
    sendJson(res, 200, { sources: getSelectedSources() });
  });

  route("POST", "/selected_sources", async (req: any, res: any) => {
    const body = await readBody<unknown>(req);
    const sources = Array.isArray(body) ? body.map(String) : [];
    setSelectedSources(sources);
    sendJson(res, 200, { sources });
  });

  route("GET", "/selected_model", async (_req: any, res: any) => {
    sendJson(res, 200, { model: getSelectedModel() });
  });

  route("POST", "/selected_model", async (req: any, res: any) => {
    const body = await readBody<{ model?: string }>(req);
    setSelectedModel(body.model || "");
    sendJson(res, 200, { model: body.model || "" });
  });

  route("GET", "/available_models", async (_req: any, res: any) => {
    const registry = await listModels(modelsRoot);
    const runnable = registry
      .filter((m: any) => ["vllm", "pytorch", "trtllm", "lmstudio"].includes(m.runtime.preferred))
      .map((m: any) => m.id);
    sendJson(res, 200, { models: runnable.length ? runnable : [getSelectedModel()] });
  });

  route("GET", "/sources", async (_req: any, res: any) => {
    try {
      const entries = await readdir(uploadsRoot, { withFileTypes: true });
      sendJson(res, 200, { sources: entries.filter((e: any) => e.isFile()).map((e: any) => e.name) });
    } catch {
      sendJson(res, 200, { sources: [] });
    }
  });

  /* ingest */
  route("POST", "/ingest", async (req: any, res: any) => {
    const taskId = newId("ingest");
    await mkdir(uploadsRoot, { recursive: true });
    let fileCount = 0;
    const contentType = req.headers["content-type"] ?? "";
    if (contentType.includes("multipart/form-data")) {
      await new Promise<void>((resolve, reject) => {
        const busboy = Busboy({ headers: req.headers });
        const writes: Promise<void>[] = [];
        busboy.on("file", (_name: any, file: any, info: any) => {
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

  route("GET", "/ingest/status/:task_id", async (_req: any, res: any, params: any) => {
    sendJson(res, 200, { task_id: params.task_id, status: ingestStatus(params.task_id) ?? "unknown" });
  });

  /* chats */
  route("GET", "/chats", async (_req: any, res: any) => {
    sendJson(res, 200, { chats: listChats() });
  });

  route("GET", "/chat_id", async (_req: any, res: any) => {
    sendJson(res, 200, { chat_id: getCurrentChatId() });
  });

  route("POST", "/chat_id", async (req: any, res: any) => {
    const body = await readBody<{ chat_id?: string }>(req);
    if (!body.chat_id) return sendJson(res, 400, { detail: "chat_id is required" });
    setCurrentChatId(body.chat_id);
    sendJson(res, 200, { chat_id: body.chat_id });
  });

  route("GET", "/chat/:chat_id/metadata", async (_req: any, res: any, params: any) => {
    const chat = getChat(params.chat_id);
    if (!chat) return sendJson(res, 404, { detail: "Chat not found: " + params.chat_id });
    sendJson(res, 200, { name: chat.name });
  });

  route("POST", "/chat/rename", async (req: any, res: any) => {
    const body = await readBody<{ chat_id?: string; new_name?: string }>(req);
    if (!body.chat_id || !body.new_name) return sendJson(res, 400, { detail: "chat_id and new_name are required" });
    renameChat(body.chat_id, body.new_name);
    sendJson(res, 200, { ok: true });
  });

  route("POST", "/chat/new", async (_req: any, res: any) => {
    const chat = createChat();
    sendJson(res, 200, { chat_id: chat.id });
  });

  route("DELETE", "/chat/:chat_id", async (_req: any, res: any, params: any) => {
    deleteChat(params.chat_id);
    sendJson(res, 200, { ok: true });
  });

  route("DELETE", "/chats/clear", async (_req: any, res: any) => {
    const result = clearChats();
    sendJson(res, 200, { cleared_count: result.cleared, new_chat_id: result.newChatId });
  });

  route("DELETE", "/collections/:collection_name", async (_req: any, res: any, params: any) => {
    sendJson(res, 200, {
      ok: true,
      collection_name: params.collection_name,
      legacy: true,
      detail: "No local vector collection backend is configured; nothing was deleted."
    });
  });

  /* audio proxy */
  route("GET", "/audio/models", async (_req: any, res: any) => {
    const targets = audioServiceTargets(audioServiceUrl);
    const failures: Array<{ target: string; detail: string }> = [];
    for (const target of targets) {
      const result = await proxyHttp("GET", `${target}/v1/models`);
      if (!result.ok) {
        failures.push({ target, detail: result.body || "Audio service unavailable" });
        continue;
      }
      try {
        return sendJson(res, 200, JSON.parse(result.body));
      } catch {
        failures.push({ target, detail: "Audio service returned invalid JSON." });
      }
    }
    return sendJson(res, 502, {
      detail: "FunASR Gateway unavailable. Start deploy/compose/custom/docker-compose.funasr-gateway.yml or set AUDIO_SERVICE_URL.",
      targets,
      failures
    });
  });

  route("POST", "/audio/transcriptions", async (req: any, res: any) => {
    await proxyAudioMultipart(req, res, audioServiceUrl, "/transcription/transcribe");
  });

  route("POST", "/audio/speaker-verifications", async (req: any, res: any) => {
    await proxyAudioMultipart(req, res, audioServiceUrl, "/v1/audio/speaker-verifications");
  });
}

async function proxyAudioMultipart(
  req: any,
  res: any,
  configuredUrl: string,
  upstreamPath: string
): Promise<void> {
  let body: Buffer;
  try {
    body = await readRawBody(req, 100 * 1024 * 1024);
  } catch (error) {
    sendJson(res, 413, {
      detail: error instanceof Error ? error.message : "Audio upload is too large."
    });
    return;
  }

  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.includes("multipart/form-data")) {
    sendJson(res, 415, { detail: "multipart/form-data with audio files is required." });
    return;
  }

  const failures: Array<{ target: string; detail: string }> = [];
  for (const target of audioServiceTargets(configuredUrl)) {
    const result = await proxyHttp(
      "POST",
      target + upstreamPath,
      body,
      {
        "content-type": contentType,
        "content-length": String(body.length)
      }
    );
    if (result.ok || result.status !== 502) {
      res.writeHead(result.status, {
        "content-type": result.contentType || "application/json; charset=utf-8",
        "access-control-allow-origin": "*"
      });
      res.end(result.body);
      return;
    }
    failures.push({ target, detail: result.body || "Audio service unavailable" });
  }
  sendJson(res, 502, {
    detail: "FunASR Gateway unavailable. Start the audio runtime before testing.",
    failures
  });
}

async function readRawBody(req: any, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Audio upload exceeds the 100 MB limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function audioServiceTargets(configuredUrl: string): string[] {
  const fallback = process.env.FUNASR_GATEWAY_SERVICE_URL
    ?? process.env.AUDIO_SERVICE_URL
    ?? "http://127.0.0.1:" + (process.env.FUNASR_PUBLIC_PORT ?? "8011");
  return [...new Set([configuredUrl, fallback].map((url) => url.replace(/\/$/, "")))];
}
