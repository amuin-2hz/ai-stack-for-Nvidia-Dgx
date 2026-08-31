import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testRoot = await mkdtemp(join(tmpdir(), "ai-stack-deployment-persistence-"));
process.env.AI_STACK_DB_PATH = join(testRoot, "data.db");

const { closeDb, initDb } = await import("../src/db.js");
const { getActiveDeployment, upsertDeployment } = await import("../src/store.js");

after(async () => {
  closeDb();
  await rm(testRoot, { recursive: true, force: true });
});

test("deployment runtime arguments survive database round trips", () => {
  initDb();
  const timestamp = new Date().toISOString();
  const args = {
    gpu_device_ids: ["GPU-demo"],
    tensor_parallel_size: 1,
    enable_auto_tool_choice: true,
    tool_call_parser: "qwen3_coder",
    reasoning_parser: "qwen3"
  };
  upsertDeployment({
    deployment_id: "svc_vllm_qwen38",
    model_id: "qwen3.8",
    service_type: "vllm",
    runtime: "vllm",
    container_name: "vllm_qwen38",
    public_port: 30000,
    base_url: "http://localhost:30000/v1",
    health_url: "http://localhost:30000/health",
    worker_endpoint: "http://localhost:30000/v1",
    openai_model: "qwen3.8",
    status: "running",
    args,
    updated_at: timestamp
  });
  assert.deepEqual(getActiveDeployment("svc_vllm_qwen38")?.args, args);
});
