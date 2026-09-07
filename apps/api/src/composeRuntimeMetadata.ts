import { parse as parseYaml } from "yaml";
import type { DeploymentSuite } from "./types.js";

export function parseComposeRuntimeDeclaration(source: string): DeploymentSuite | null {
  try {
    const document = parseYaml(source) as any;
    const runtime = document?.["x-ai-stack"]?.runtime;
    if (!runtime || runtime.kind !== "suite") return null;
    const components = (Array.isArray(runtime.components) ? runtime.components : [])
      .map((item: any) => ({
        model_id: String(item?.model_id ?? "").trim(),
        role: String(item?.role ?? "component").trim() || "component",
        required: item?.required === true
      }))
      .filter((item: any) => item.model_id);
    const endpointPath = String(runtime.primary_endpoint?.path ?? "").trim();
    const apiModels: string[] = (Array.isArray(runtime.api_models) ? runtime.api_models : [])
      .map((item: unknown): string => String(item ?? "").trim())
      .filter((item: string) => Boolean(item));
    return {
      kind: "suite",
      title: String(runtime.title ?? "").trim() || undefined,
      title_zh: String(runtime.title_zh ?? "").trim() || undefined,
      api_models: apiModels.length ? [...new Set(apiModels)] : undefined,
      publish_policy: runtime.publish_policy === "selected" ? "selected" : "all_ready",
      load_policy: runtime.load_policy === "eager" ? "eager" : "lazy",
      card_mode: runtime.card_mode === "individual" ? "individual" : "grouped",
      health_path: String(runtime.health_path ?? "").trim() || undefined,
      primary_endpoint: endpointPath ? {
        kind: String(runtime.primary_endpoint?.kind ?? "").trim() || undefined,
        method: String(runtime.primary_endpoint?.method ?? "POST").trim().toUpperCase(),
        path: endpointPath.startsWith("/") ? endpointPath : "/" + endpointPath
      } : undefined,
      components
    };
  } catch {
    return null;
  }
}
