import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const customDir = join(root, "deploy/compose/custom");
const profiles = [
  ...readdirSync(customDir).filter(name => /^docker-compose\..+\.ya?ml$/.test(name)).map(name => "deploy/compose/custom/" + name),
  "deploy/compose/docker-compose.yml", "deploy/compose/docker-compose.vllm.yml",
  "deploy/compose/docker-compose.pytorch.yml", "deploy/compose/docker-compose.ye.yml",
  "deploy/templates/vllm.yml", "deploy/templates/pytorch.yml", "deploy/templates/tensorrt-llm.yml"
].filter(path => { try { readFileSync(join(root, path)); return true; } catch { return false; } });
const composeAvailable = spawnSync("docker", ["compose", "version"], { encoding: "utf8", timeout: 10000 }).status === 0;

test("all bundled publication templates use the canonical network variable", () => {
  for (const path of profiles) {
    const source = readFileSync(join(root, path), "utf8");
    assert.match(source, /AI_STACK_BIND_ADDR/, path);
    assert.doesNotMatch(source, /AI_STACK_BIND_ADDR:-127\.0\.0\.1/, path);
    assert.doesNotMatch(source, /network_mode:\s*host/, path);
  }
  const frontend = readFileSync(join(root, "apps/frontend/src/components/model/CustomContainerModal.vue"), "utf8");
  assert.match(frontend, /AI_STACK_BIND_ADDR:-0\.0\.0\.0/);
  assert.doesNotMatch(frontend, /AI_STACK_BIND_ADDR:-127\.0\.0\.1/);
});

for (const mode of ["default", "lan", "local"] as const) {
  test("Compose publication policy: " + mode, { skip: !composeAvailable }, () => {
    const address = mode === "local" ? "127.0.0.1" : "0.0.0.0";
    for (const path of profiles) {
      const result = spawnSync("docker", ["compose", "-f", path, "config", "--format", "json"], {
        cwd: root, encoding: "utf8", timeout: 10000,
        env: { ...process.env, COMPOSE_DISABLE_ENV_FILE: "1", AI_STACK_BIND_ADDR: mode === "default" ? "" : address,
          BIND_ADDR: mode === "lan" ? "127.0.0.1" : "", MODEL_ALIAS: "test-model" }
      });
      assert.equal(result.status, 0, path + ": " + result.stderr);
      const services = Object.values(JSON.parse(result.stdout).services) as Array<{ ports?: Array<{host_ip: string}> }>;
      const ports = services.flatMap(service => service.ports ?? []);
      assert.ok(ports.length, path);
      for (const port of ports) assert.equal(port.host_ip, address, path);
    }
  });
}

test("TensorRT-LLM scripts publish through Docker port bindings, not host networking", () => {
  for (const script of ["start-trtllm-model.sh", "start-trtllm-handle.sh"]) {
    const source = readFileSync(join(root, "ops/scripts", script), "utf8");
    assert.doesNotMatch(source, /--network\s+host/);
    assert.ok(source.includes('-p "${AI_STACK_BIND_ADDR}:${PORT}:${PORT}"'));
  }
});
