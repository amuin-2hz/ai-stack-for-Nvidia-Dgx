import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { getPath, sendJson } from "./serverUtils.js";

type ApiHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathPrefix?: string
) => Promise<void>;

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

export async function serveFrontendFile(
  req: IncomingMessage,
  res: ServerResponse,
  frontendRoot: string,
  handleApiRequest: ApiHandler
): Promise<void> {
  const requestPath = getPath(req);
  if (requestPath === "/api" || requestPath.startsWith("/api/")) {
    return handleApiRequest(req, res, "/api");
  }
  if (requestPath === "/models" || requestPath === "/v1/models") {
    return handleApiRequest(req, res);
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }

  const root = resolve(frontendRoot);
  const requested = resolve(root, "." + (requestPath === "/" ? "/index.html" : requestPath));
  const fallback = join(root, "index.html");
  const requestedStat = isInside(root, requested) ? await stat(requested).catch(() => null) : null;
  const file = requestedStat?.isFile() ? requested : fallback;
  try {
    const content = await readFile(file);
    res.writeHead(200, {
      "content-type": contentTypes[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": content.length,
      "cache-control": file === fallback ? "no-cache" : "public, max-age=31536000, immutable"
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(content);
  } catch {
    sendJson(res, 503, { detail: "Web console assets are unavailable. Build the frontend or set WEB_ROOT." });
  }
}
