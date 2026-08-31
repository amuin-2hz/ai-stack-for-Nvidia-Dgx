import { proxyHttp } from "./httpProxy.js";
import { sendJson } from "./serverUtils.js";

const MAX_AUDIO_UPLOAD_BYTES = 100 * 1024 * 1024;

export async function proxyAudioMultipart(
  req: any,
  res: any,
  configuredUrl: string,
  upstreamPath: string,
  openAiErrors = true
): Promise<void> {
  let body: Buffer;
  try {
    body = await readRawBody(req, MAX_AUDIO_UPLOAD_BYTES);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Audio upload is too large.";
    sendJson(res, 413, openAiErrors ? {
      error: {
        message,
        type: "invalid_request_error",
        param: "file",
        code: "upload_too_large"
      }
    } : { detail: message });
    return;
  }

  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    sendJson(res, 415, openAiErrors ? {
      error: {
        message: "multipart/form-data with an audio file is required.",
        type: "invalid_request_error",
        param: "file",
        code: "invalid_content_type"
      }
    } : { detail: "multipart/form-data with audio files is required." });
    return;
  }

  const failures: Array<{ target: string; detail: string }> = [];
  for (const target of audioServiceTargets(configuredUrl)) {
    const result = await proxyHttp("POST", target + upstreamPath, body, {
      "content-type": contentType,
      "content-length": String(body.length)
    });
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
  sendJson(res, 502, openAiErrors ? {
    error: {
      message: "FunASR Gateway unavailable. Start the audio runtime before testing.",
      type: "server_error",
      param: null,
      code: "audio_service_unavailable"
    },
    failures
  } : {
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

export function audioServiceTargets(configuredUrl: string): string[] {
  const fallback = process.env.FUNASR_GATEWAY_SERVICE_URL
    ?? process.env.AUDIO_SERVICE_URL
    ?? "http://127.0.0.1:" + (process.env.FUNASR_PUBLIC_PORT ?? "8011");
  return [...new Set([configuredUrl, fallback].filter(Boolean).map((url) => url.replace(/\/$/, "")))];
}
