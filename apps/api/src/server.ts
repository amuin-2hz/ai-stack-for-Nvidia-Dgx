import { createServer, type IncomingMessage } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { initDb } from "./db.js";
import { migrateFromJson } from "./migrate.js";
import { createOpenAiProxy } from "./openaiProxy.js";
import { createDeploymentHelpers } from "./deploymentHelpers.js";
import { createWsHandler } from "./wsHandler.js";
import { proxyWebSocket } from "./httpProxy.js";
import { createRouter, sendJson, getPath } from "./serverUtils.js";
import { requiresElectronPrivilege, isElectronRequest } from "./permissions.js";
import { resumeInterruptedDownloads } from "./downloadManager.js";

/* ── route modules ─────────────────────────────── */
import { register as systemRoutes } from "./routes/system.js";
import { register as settingsRoutes } from "./routes/settings.js";
import { register as modelRoutes } from "./routes/models.js";
import { register as downloadRoutes } from "./routes/downloads.js";
import { register as taskRoutes } from "./routes/tasks.js";
import { register as containerRoutes } from "./routes/containers.js";
import { register as deploymentRoutes } from "./routes/deployments.js";
import { register as openaiRoutes } from "./routes/openai.js";
import { register as legacyRoutes } from "./routes/legacy.js";

/* ── constants ─────────────────────────────────── */
const port = Number(process.env.PORT ?? "8000");
const inferredWorkspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workspaceRoot = process.env.AI_STACK_BASE ?? inferredWorkspaceRoot;
const modelsRoot = process.env.MODELS_ROOT ?? join(workspaceRoot, "models");
const stateRoot = process.env.STATE_ROOT ?? join(workspaceRoot, "state");
const uploadsRoot = process.env.UPLOADS_ROOT ?? join(stateRoot, "uploads");
const logsRoot = process.env.LOGS_ROOT ?? join(workspaceRoot, "logs");
const audioServiceUrl = process.env.AUDIO_SERVICE_URL ?? "http://127.0.0.1:8011";
const audioServiceWsUrl = process.env.AUDIO_SERVICE_WS_URL ?? "ws://127.0.0.1:8011/ws/realtime";

/* ── composed modules ──────────────────────────── */
const dh = createDeploymentHelpers({ modelsRoot, audioServiceUrl });
const oai = createOpenAiProxy({ modelsRoot, workspaceRoot, logsRoot, deploymentHelpers: dh });

/* ── router ────────────────────────────────────── */
const { route, match } = createRouter();

/* ── register all route groups ─────────────────── */
systemRoutes(route);
settingsRoutes(route, workspaceRoot);
modelRoutes(route, modelsRoot, workspaceRoot, dh);
downloadRoutes(route, workspaceRoot, logsRoot);
taskRoutes(route, workspaceRoot, logsRoot);
containerRoutes(route, workspaceRoot, logsRoot, stateRoot);
deploymentRoutes(route, dh, modelsRoot, workspaceRoot, logsRoot);
openaiRoutes(route, dh, oai);
legacyRoutes(route, modelsRoot, uploadsRoot, audioServiceUrl);

/* ── HTTP server ───────────────────────────────── */
const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  const parsedPath = getPath(req);
  const m = match(req.method ?? "GET", parsedPath);
  if (!m) return sendJson(res, 404, { detail: "Not found" });

  if (requiresElectronPrivilege(req.method ?? "GET", parsedPath)) {
    if (!isElectronRequest(req)) {
      return sendJson(res, 403, { detail: "This operation requires local Electron access." });
    }
  }

  try {
    await m.handler(req, res, m.params);
  } catch (error) {
    sendJson(res, 500, { detail: error instanceof Error ? error.message : String(error) });
  }
});

/* ── WebSocket ────────────────────────────────── */
const wss = new WebSocketServer({ noServer: true });
const wsHandler = createWsHandler({ wss, audioServiceWsUrl, proxyWebSocket: (req: IncomingMessage, socket: any, head: Buffer, target: string, w: WebSocketServer) => proxyWebSocket(req, socket, head, target, w) });

server.on("upgrade", (req, socket, head) => { wsHandler.handleUpgrade(req, socket, head); });
wss.on("connection", (ws, req) => { wsHandler.handleConnection(ws, req); });

/* ── init & start ──────────────────────────────── */
initDb();
const migrationResult = migrateFromJson(stateRoot);
if (migrationResult.migrated) console.log(`DB migration: ${migrationResult.detail}`);

void resumeInterruptedDownloads(workspaceRoot, logsRoot)
  .then((result) => {
    const touched = result.resumed.length + result.completed.length + result.canceled.length + result.failed.length;
    if (touched > 0) console.log(`Download recovery: ${JSON.stringify(result)}`);
  })
  .catch((error) => {
    console.error("Download recovery failed:", error instanceof Error ? error.message : error);
  });

server.listen(port, "0.0.0.0", () => {
  console.log(`AI Stack TypeScript API listening on 0.0.0.0:${port}`);
});
