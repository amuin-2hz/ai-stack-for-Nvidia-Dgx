import type { IncomingMessage, ServerResponse } from "node:http";

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
) => Promise<void>;

export interface RouteEntry {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export function defineRoute(
  method: string,
  path: string,
  handler: Handler
): RouteEntry {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:[^/]+/g, (match) => {
      keys.push(match.slice(1));
      return "([^/]+)";
    })}$`
  );
  return { method, pattern, keys, handler };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string
): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*"
  });
  res.end(body);
}

export async function readBody<T = Record<string, unknown>>(
  req: IncomingMessage
): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

export function getPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

export function createRouter(routes: RouteEntry[] = []) {
  function route(
    method: string,
    path: string,
    handler: Handler
  ): void {
    routes.push(defineRoute(method, path, handler));
  }

  function match(
    method: string,
    path: string
  ): { handler: Handler; params: Record<string, string> } | null {
    const matched = routes.find(
      (candidate) =>
        candidate.method === method && candidate.pattern.test(path)
    );
    if (!matched) return null;
    const matchResult = path.match(matched.pattern);
    const params = Object.fromEntries(
      matched.keys.map((key, index) => [
        key,
        decodeURIComponent(matchResult?.[index + 1] ?? "")
      ])
    );
    return { handler: matched.handler, params };
  }

  return { route, match };
}
