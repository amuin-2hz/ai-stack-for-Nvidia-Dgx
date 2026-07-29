import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { WebSocket } from "ws";
import type { WebSocketServer } from "ws";

export interface ProxyResult {
  ok: boolean;
  status: number;
  body: string;
  contentType?: string;
}

export function proxyHttp(
  method: string,
  url: string,
  body?: string | Buffer,
  headers: Record<string, string> = {}
): Promise<ProxyResult> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const request = client(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () =>
        resolve({
          ok: Boolean(response.statusCode && response.statusCode < 400),
          status: response.statusCode ?? 502,
          body: Buffer.concat(chunks).toString("utf-8"),
          contentType: Array.isArray(response.headers["content-type"])
            ? response.headers["content-type"][0]
            : response.headers["content-type"]
        })
      );
    });
    request.on("error", (error) =>
      resolve({ ok: false, status: 502, body: error.message })
    );
    if (body) request.write(body);
    request.end();
  });
}

export function proxyWebSocket(
  req: IncomingMessage,
  socket: any,
  head: Buffer,
  target: string,
  wss: WebSocketServer
): void {
  const upstream = new WebSocket(target);
  wss.handleUpgrade(req, socket, head, (downstream) => {
    upstream.on("open", () => {
      downstream.on("message", (message) => upstream.send(message));
      upstream.on("message", (message) => downstream.send(message));
      downstream.on("close", () => upstream.close());
      upstream.on("close", () => downstream.close());
    });
    upstream.on("error", (error) => {
      downstream.send(
        JSON.stringify({ type: "error", detail: error.message })
      );
      downstream.close();
    });
  });
}

export function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
