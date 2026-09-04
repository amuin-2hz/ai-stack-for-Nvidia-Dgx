import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "ai-stack-network-"));
process.env.AI_STACK_DATA_DIR = root;
process.env.AI_STACK_DB_PATH = join(root, "data.db");
const { initDb, closeDb, getDb } = await import("../src/db.js");
const { getNetworkSettings, setNetworkAccess } = await import("../src/store.js");
const { createDeploymentPlan } = await import("../src/deploymentManager.js");
initDb();
after(async () => { closeDb(); await rm(root, { recursive: true, force: true }); });

test("saved network policy survives restarts and overrides environment for every runtime plan", () => {
  const old = process.env.AI_STACK_BIND_ADDR;
  try {
    getDb().prepare("DELETE FROM settings WHERE key = ?").run("network");
    process.env.AI_STACK_BIND_ADDR = "127.0.0.1";
    assert.equal(getNetworkSettings().lan_access_enabled, false);
    process.env.AI_STACK_BIND_ADDR = "0.0.0.0";
    setNetworkAccess(false);
    assert.equal(getNetworkSettings().requires_restart, true);
    closeDb();
    initDb();
    for (const service of ["vllm", "pytorch", "trtllm"] as const) {
      const model: any = { id: "demo", compatibility: { [service]: { status: "compatible", reason: "test" } } };
      const plan = createDeploymentPlan({} as any, model, service, "demo", {}, root);
      assert.equal(plan.launch.env.AI_STACK_BIND_ADDR, "127.0.0.1", service);
    }
    // Simulate the next API process binding to the saved policy.
    process.env.AI_STACK_BIND_ADDR = "127.0.0.1";
    assert.equal(getNetworkSettings().active_bind_address, "127.0.0.1");
    assert.equal(getNetworkSettings().requires_restart, false);
    setNetworkAccess(true);
    assert.equal(getNetworkSettings().desired_bind_address, "0.0.0.0");
    assert.equal(getNetworkSettings().requires_restart, true);
  } finally {
    if (old === undefined) delete process.env.AI_STACK_BIND_ADDR;
    else process.env.AI_STACK_BIND_ADDR = old;
  }
});
