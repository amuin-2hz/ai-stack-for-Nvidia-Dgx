import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

const testRoot = await mkdtemp(join(tmpdir(), "ai-stack-deployment-logs-"));
process.env.AI_STACK_DB_PATH = join(testRoot, "data.db");

const { initDb, closeDb } = await import("../src/db.js");
const { createTask } = await import("../src/store.js");
const { register } = await import("../src/routes/deployments.js");

const routes = new Map<string, any>();
const deployment = {
  deployment_id: "svc_vllm",
  model_id: "demo-model",
  service_type: "vllm",
  runtime: "vllm",
  container_name: "missing-vllm-service",
  public_port: 30000,
  base_url: "http://localhost:30000/v1",
  health_url: "http://localhost:30000/health",
  worker_endpoint: "http://localhost:30000/v1",
  openai_model: "demo-model",
  status: "running",
  task_id: "task_deploy_logs",
  updated_at: new Date().toISOString()
};
const helpers = {
  configuredDeployments: async () => [deployment],
  liveActiveDeployments: async () => [deployment],
  mergeDeployments: (_configured: any[], active: any[]) => active,
  findDeployment: async (id: string) => id === deployment.deployment_id ? deployment : null,
  runtimeHealthUrl: () => deployment.health_url,
  normalizeDeployment: (item: any) => item,
  deploymentContainerIsRunning: async () => false
};
register((method, path, handler) => routes.set(method + " " + path, handler), helpers, testRoot, testRoot, join(testRoot, "logs"));
const logsHandler = routes.get("GET /deployments/:deployment_id/logs");

beforeEach(() => {
  closeDb();
  initDb();
});

after(async () => {
  closeDb();
  await rm(testRoot, { recursive: true, force: true });
});

test("deployment logs route falls back to the deployment task log", async () => {
  const logPath = join(testRoot, "deploy.log");
  await writeFile(logPath, ["prepare ok", "pull ok", "health pending"].join("\n"), "utf-8");
  createTask({
    id: "task_deploy_logs",
    type: "deploy",
    status: "failed",
    command: "docker run demo",
    cwd: testRoot,
    log_path: logPath,
    metadata: { deployment_id: "svc_vllm", service_type: "vllm", model_id: "demo-model" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  const response = await callLogs("svc_vllm", "?lines=2");
  assert.equal(response.status, 200);
  assert.equal(response.body.source, "task");
  assert.equal(response.body.task_id, "task_deploy_logs");
  assert.match(response.body.logs, /pull ok/);
  assert.match(response.body.logs, /health pending/);
  assert.doesNotMatch(response.body.logs, /prepare ok/);
});

async function callLogs(deploymentId: string, query = "") {
  const req = Readable.from([]) as any;
  req.url = "/deployments/" + deploymentId + "/logs" + query;
  const chunks: Buffer[] = [];
  const res = {
    status: 0,
    headers: undefined as Record<string, string> | undefined,
    writeHead(status: number, headers: Record<string, string>) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.from(chunk));
    }
  } as any;
  await logsHandler(req, res, { deployment_id: deploymentId });
  return { status: res.status, body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) };
}
