import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readBody, sendJson } from "../serverUtils.js";
import {
  applyContainerRuntimeConfig, deleteContainer, containerAction, containerLogs,
  createCustomContainerTask, createImagePullTask, createImageTestTask, createRuntimeStartTestTask, listContainers
} from "../containerManager.js";
import { setContainerConfig } from "../store.js";
import { runCommand } from "../utils.js";

export function register(
  route: (method: string, path: string, handler: (...args: any[]) => Promise<void>) => void,
  workspaceRoot: string,
  logsRoot: string,
  stateRoot: string
) {
  route("GET", "/containers", async (_req: any, res: any) => {
    sendJson(res, 200, await listContainers());
  });

  route("POST", "/containers/:key/config", async (req: any, res: any, params: any) => {
    const key = decodeURIComponent(params.key);
    const body = await readBody<{ public_port?: number; management_mode?: "resident" | "once"; restart_policy?: string; auto_restart?: boolean }>(req);
    try {
      const settings = setContainerConfig(key, body as any);
      sendJson(res, 200, { settings, apply: await applyContainerRuntimeConfig(key, settings) });
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  route("POST", "/containers/:key/pull-image", async (_req: any, res: any, params: any) => {
    try {
      sendJson(res, 202, await createImagePullTask(decodeURIComponent(params.key), workspaceRoot, logsRoot));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  route("POST", "/containers/:key/test-image", async (_req: any, res: any, params: any) => {
    try {
      sendJson(res, 202, await createImageTestTask(decodeURIComponent(params.key), workspaceRoot, logsRoot));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  route("POST", "/containers/:key/start-test", async (_req: any, res: any, params: any) => {
    try {
      sendJson(res, 202, await createRuntimeStartTestTask(decodeURIComponent(params.key), workspaceRoot, logsRoot));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  route("POST", "/containers/custom", async (req: any, res: any) => {
    const body = await readBody<{ name?: string; image?: string; components?: string[]; compose_yaml?: string; management_mode?: string; restart_policy?: string; auto_restart?: boolean }>(req);
    try {
      sendJson(res, 202, await createCustomContainerTask(body as any, workspaceRoot, logsRoot));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
  });

  route("GET", "/containers/:name/logs", async (req: any, res: any, params: any) => {
    const lines = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("lines") ?? "200");
    sendJson(res, 200, await containerLogs(params.name, lines));
  });

  route("POST", "/containers/:name/:action", async (_req: any, res: any, params: any) => {
    if (!["start", "stop", "restart"].includes(params.action))
      return sendJson(res, 400, { detail: "Unsupported container action: " + params.action });
    sendJson(res, 202, await containerAction(params.name, params.action as "start" | "stop" | "restart"));
  });

  route("DELETE", "/containers/:key", async (_req: any, res: any, params: any) => {
    if (!["vllm", "trtllm", "pytorch"].includes(params.key))
      return sendJson(res, 403, { detail: "Only runtime containers (vllm, trtllm, pytorch) can be deleted through this API." });
    const result = await deleteContainer(params.key);
    sendJson(res, result.ok ? 200 : 500, result);
  });

  route("POST", "/containers/compose/validate", async (req: any, res: any) => {
    const body = await readBody<{ yaml: string }>(req);
    if (!body.yaml) return sendJson(res, 400, { detail: "yaml field is required" });
    const tmpDir = join(stateRoot, "tmp", "compose-validate-" + Date.now());
    const yamlPath = join(tmpDir, "docker-compose.yml");
    try {
      await mkdir(tmpDir, { recursive: true });
      await writeFile(yamlPath, body.yaml, "utf-8");
      const result = await runCommand("docker", ["compose", "-f", yamlPath, "config", "--dry-run"], 15000);
      if (result.ok) {
        sendJson(res, 200, { valid: true, normalized: result.stdout || "" });
      } else {
        sendJson(res, 200, { valid: false, errors: (result.stderr || result.stdout || "Unknown docker compose error").slice(0, 2000) });
      }
    } catch (error) {
      sendJson(res, 200, { valid: false, errors: error instanceof Error ? error.message : String(error) });
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  route("DELETE", "/containers/custom/:name", async (_req: any, res: any, params: any) => {
    const name = decodeURIComponent(params.name);
    const psOutput = await runCommand("docker", ["ps", "-a", "--format", "{{.Names}}"], 5000);
    const exists = psOutput.stdout?.split("\n").map((s: string) => s.trim()).includes(name);
    if (!exists) return sendJson(res, 404, { detail: "Container not found: " + name });
    const result = await runCommand("docker", ["rm", "-f", name], 15000);
    sendJson(res, result.ok ? 200 : 500, { name, ok: result.ok, detail: result.stdout || result.stderr });
  });
}
