import type { IncomingMessage } from "node:http";
import type { ActiveDeploymentRecord } from "./types.js";

export type DeploymentApiKind =
  | "embedding"
  | "rerank"
  | "document"
  | "ground"
  | "transcription"
  | "speech"
  | "chat";

export function deploymentApiKind(
  deployment: Pick<ActiveDeploymentRecord, "runtime" | "container_name" | "model_id" | "openai_model" | "suite">
): DeploymentApiKind {
  const declaredKind = deployment.suite?.primary_endpoint?.kind;
  if (declaredKind && ["embedding", "rerank", "document", "ground", "transcription", "speech", "chat"].includes(declaredKind)) return declaredKind as DeploymentApiKind;
  const searchable = [
    deployment.runtime,
    deployment.container_name,
    deployment.model_id,
    deployment.openai_model
  ].filter(Boolean).join(" ").toLowerCase();

  if (/mineru|document[-_ ]?(parse|parser|analysis)/.test(searchable)) return "document";
  if (/locate[-_ ]?anything|visual[-_ ]?ground/.test(searchable)) return "ground";
  if (/rerank|reranker|cross[-_ ]?encoder/.test(searchable)) return "rerank";
  if (/embed|embedding|embeddings|feature[-_ ]?extraction/.test(searchable)) return "embedding";
  if (/qwen3[-_ ]?tts|text[-_ ]?to[-_ ]?speech/.test(searchable)) return "speech";
  if (/funasr[-_ ]?gateway/.test(searchable)) return "transcription";
  return "chat";
}

export function deploymentEndpointPath(
  deployment: Pick<ActiveDeploymentRecord, "runtime" | "container_name" | "model_id" | "openai_model" | "suite">
): string {
  const declaredPath = deployment.suite?.primary_endpoint?.path;
  if (declaredPath) return declaredPath.startsWith("/") ? declaredPath : "/" + declaredPath;
  const kind = deploymentApiKind(deployment);
  if (kind === "embedding") return "/v1/embeddings";
  if (kind === "rerank") return "/v1/score";
  if (kind === "document") return "/v1/documents/parse";
  if (kind === "ground") return "/v1/ground";
  if (kind === "speech") return "/v1/audio/speech";
  if (kind === "transcription") return "/transcription/transcribe";
  return "/v1/chat/completions";
}

export function requestOrigin(req: Pick<IncomingMessage, "headers">): string {
  const forwardedProto = firstHeader(req.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeader(req.headers["x-forwarded-host"]);
  const protocol = forwardedProto || "http";
  const host = forwardedHost || firstHeader(req.headers.host) || "localhost:8888";
  return protocol + "://" + host;
}

export function directDeploymentUrl(
  req: Pick<IncomingMessage, "headers">,
  deployment: Pick<ActiveDeploymentRecord, "public_port" | "runtime" | "container_name" | "model_id" | "openai_model" | "suite" | "suite">
): string {
  const origin = new URL(requestOrigin(req));
  origin.port = String(deployment.public_port);
  return origin.origin + deploymentEndpointPath(deployment);
}

function firstHeader(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw ?? "").split(",")[0].trim();
}
