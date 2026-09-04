import type { IncomingMessage } from "node:http";

/** Detect if request originates from localhost (Electron). */
export function isLocalRequest(req: IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Detect local Electron access or a configured remote administrator token. */
export function isElectronRequest(req: IncomingMessage): boolean {
  if (isLocalRequest(req)) return true;
  const configuredToken = process.env.AI_STACK_ADMIN_TOKEN || process.env.ELECTRON_TOKEN;
  if (!configuredToken) return false;
  const headerToken = req.headers["x-ai-stack-admin"];
  const authorization = req.headers.authorization ?? "";
  const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const providedToken = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  return providedToken === configuredToken || bearerToken === configuredToken;
}

/** APIs that require Electron-level privilege (not available to LAN browser). */
const PRIVILEGED_PATHS: Array<{ method: string; path: string }> = [
  { method: "DELETE", path: "/models/" },
  { method: "POST", path: "/settings/" },
  { method: "DELETE", path: "/containers/" },
  { method: "POST", path: "/containers/cleanup-failed" },
  { method: "POST", path: "/containers/custom" },
  { method: "PUT", path: "/containers/custom" },
];

export function requiresElectronPrivilege(method: string, path: string): boolean {
  return PRIVILEGED_PATHS.some(
    (p) => method === p.method && path.startsWith(p.path)
  );
}
