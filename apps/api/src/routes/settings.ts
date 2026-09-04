import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readBody, sendJson } from "../serverUtils.js";
import { getWorkbenchSettings, setManagementPort, getNetworkSettings, setNetworkAccess } from "../store.js";

export function register(route: (method: string, path: string, handler: (...args: any[]) => Promise<void>) => void, workspaceRoot = process.cwd()) {
  route("GET", "/settings/workbench", async (_req: any, res: any) => {
    sendJson(res, 200, getWorkbenchSettings());
  });

  route("POST", "/settings/workbench", async (req: any, res: any) => {
    const body = await readBody<{ management_port?: number }>(req);
    try {
      sendJson(res, 200, setManagementPort(Number(body.management_port)));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  route("GET", "/settings/network", async (_req: any, res: any) => {
    sendJson(res, 200, getNetworkSettings());
  });

  route("POST", "/settings/network", async (req: any, res: any) => {
    const body = await readBody<{ lan_access_enabled?: boolean }>(req);
    if (typeof body.lan_access_enabled !== "boolean") {
      return sendJson(res, 400, { detail: "lan_access_enabled boolean is required" });
    }
    sendJson(res, 200, setNetworkAccess(body.lan_access_enabled));
  });

  route("GET", "/settings/proxy", async (_req: any, res: any) => {
    sendJson(res, 200, await getProxySettings(workspaceRoot));
  });

  route("POST", "/settings/proxy", async (req: any, res: any) => {
    const body = await readBody<Partial<ProxySettings>>(req);
    try {
      sendJson(res, 200, await setProxySettings(workspaceRoot, body));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });
}

interface ProxySettings {
  enabled: boolean;
  scope: ProxyScope;
  http_proxy: string;
  https_proxy: string;
  all_proxy: string;
  no_proxy: string;
  env_path: string;
  updated_at: string;
}

type ProxyScope = "all" | "huggingface" | "modelscope";

const LOCAL_NO_PROXY_ENTRIES = [
  "localhost",
  "127.0.0.1",
  "::1",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16"
];

function proxyEnvPath(workspaceRoot: string): string {
  return join(workspaceRoot, "configs", "proxy.env");
}

async function getProxySettings(workspaceRoot: string): Promise<ProxySettings> {
  const envPath = proxyEnvPath(workspaceRoot);
  const values = parseProxyEnv(await readFile(envPath, "utf-8").catch(() => ""));
  const httpProxy = values.HTTP_PROXY || values.http_proxy || "";
  const httpsProxy = values.HTTPS_PROXY || values.https_proxy || "";
  const allProxy = values.ALL_PROXY || values.all_proxy || "";
  const noProxy = normalizeNoProxy(values.NO_PROXY || values.no_proxy || "");
  return {
    enabled: Boolean(httpProxy || httpsProxy || allProxy),
    scope: normalizeProxyScope(values.AI_STACK_PROXY_SCOPE || values.ai_stack_proxy_scope, "all"),
    http_proxy: httpProxy,
    https_proxy: httpsProxy,
    all_proxy: allProxy,
    no_proxy: noProxy,
    env_path: envPath,
    updated_at: new Date().toISOString()
  };
}

async function setProxySettings(workspaceRoot: string, body: Partial<ProxySettings>): Promise<ProxySettings> {
  const enabled = body.enabled !== false;
  const settings: ProxySettings = {
    enabled,
    scope: normalizeProxyScope(body.scope),
    http_proxy: enabled ? normalizeProxyUrl(body.http_proxy) : "",
    https_proxy: enabled ? normalizeProxyUrl(body.https_proxy) : "",
    all_proxy: enabled ? normalizeProxyUrl(body.all_proxy) : "",
    no_proxy: enabled ? normalizeNoProxy(body.no_proxy) : "",
    env_path: proxyEnvPath(workspaceRoot),
    updated_at: new Date().toISOString()
  };
  await writeProxyEnv(settings);
  return settings;
}

function parseProxyEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^[ '\"]+|[ '\"]+$/g, "");
    values[key] = value;
  }
  return values;
}

function normalizeProxyUrl(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/\s/.test(text)) throw new Error("Proxy URL cannot contain whitespace.");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("Proxy URL must include a scheme, for example http://127.0.0.1:7890");
  }
  const allowed = new Set(["http:", "https:", "socks4:", "socks5:", "socks5h:"]);
  if (!allowed.has(parsed.protocol)) throw new Error("Proxy URL scheme must be http, https, socks4, socks5, or socks5h.");
  return text;
}

export function normalizeNoProxy(value: unknown): string {
  const text = String(value ?? "").trim();
  if (/\n|\r/.test(text)) throw new Error("NO_PROXY must be a comma-separated single line.");
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...text.split(",").map((item) => item.trim()).filter(Boolean), ...LOCAL_NO_PROXY_ENTRIES]) {
    if (seen.has(entry.toLowerCase())) continue;
    entries.push(entry);
    seen.add(entry.toLowerCase());
  }
  return entries.join(",");
}

function normalizeProxyScope(value: unknown, fallback?: ProxyScope): ProxyScope {
  const scope = String(value ?? "all").trim().toLowerCase();
  if (scope === "all" || scope === "huggingface" || scope === "modelscope") return scope;
  if (fallback) return fallback;
  throw new Error("Proxy scope must be all, huggingface, or modelscope.");
}

async function writeProxyEnv(settings: ProxySettings): Promise<void> {
  await mkdir(dirname(settings.env_path), { recursive: true });
  const lines = [
    "# Managed by AMUIN AI STACK. Used by download scripts.",
    "AI_STACK_PROXY_SCOPE=" + settings.scope,
    "HTTP_PROXY=" + settings.http_proxy,
    "HTTPS_PROXY=" + settings.https_proxy,
    "ALL_PROXY=" + settings.all_proxy,
    "http_proxy=" + settings.http_proxy,
    "https_proxy=" + settings.https_proxy,
    "all_proxy=" + settings.all_proxy,
    "NO_PROXY=" + settings.no_proxy,
    "no_proxy=" + settings.no_proxy,
    ""
  ];
  await writeFile(settings.env_path, lines.join("\n"), "utf-8");
}
