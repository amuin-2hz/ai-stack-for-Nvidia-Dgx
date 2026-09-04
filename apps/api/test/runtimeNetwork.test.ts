import { test } from "node:test";
import assert from "node:assert/strict";
import { canReusePublishedService, runtimeBindAddress, runtimeNetworkEnv } from "../src/runtimeNetwork.js";
import { runtimeCommandFor, createRuntimePlan } from "../src/runtimePlan.js";

test("network defaults and legacy environment remain consistent", () => {
  assert.equal(runtimeBindAddress(undefined, {}), "0.0.0.0");
  assert.equal(runtimeBindAddress(undefined, { AI_STACK_BIND_ADDR: "127.0.0.1" }), "127.0.0.1");
  assert.equal(runtimeBindAddress(undefined, { BIND_ADDR: "127.0.0.1" }), "127.0.0.1");
  assert.equal(runtimeBindAddress(undefined, { LAN_ACCESS_ENABLED: "0" }), "127.0.0.1");
  assert.throws(() => runtimeBindAddress(undefined, { AI_STACK_BIND_ADDR: "invalid" }), /must be/);
  assert.equal(runtimeBindAddress(undefined, { AI_STACK_BIND_ADDR: "0.0.0.0", BIND_ADDR: "127.0.0.1" }), "0.0.0.0");
});

test("saved LAN setting overrides stale environment in both directions", () => {
  assert.equal(runtimeBindAddress({ lan_access_enabled: false }, { AI_STACK_BIND_ADDR: "0.0.0.0" }), "127.0.0.1");
  assert.equal(runtimeBindAddress({ lan_access_enabled: true }, { AI_STACK_BIND_ADDR: "127.0.0.1" }), "0.0.0.0");
  for (const enabled of [false, true]) {
    const address = enabled ? "0.0.0.0" : "127.0.0.1";
    assert.deepEqual(runtimeNetworkEnv({ lan_access_enabled: enabled }), { AI_STACK_BIND_ADDR: address, BIND_ADDR: address });
    for (const service of ["vllm", "pytorch", "trtllm"] as const) {
      const command = runtimeCommandFor(service, "demo", "demo", {}, undefined, { lan_access_enabled: enabled });
      assert.equal(command.env.AI_STACK_BIND_ADDR, address, service);
      assert.equal(command.env.BIND_ADDR, address, service);
    }
  }
});

test("deployment preview carries the same network policy as execution", () => {
  const plan = createRuntimePlan({} as any, { id: "demo", compatibility: { vllm: { status: "compatible", reason: "ok" } } } as any,
    "vllm", "demo", {}, "/workspace", undefined, { lan_access_enabled: false });
  assert.equal(plan.launch.env.AI_STACK_BIND_ADDR, "127.0.0.1");
  assert.match(plan.launch.command, /AI_STACK_BIND_ADDR=127\.0\.0\.1/);
});

test("running shared services are reused only with the requested port and bind scope", () => {
  const state = (ip: string, port = "18020", running = true) => JSON.stringify({
    running, ports: { "8000/tcp": [{ HostIp: ip, HostPort: port }] }
  });
  assert.equal(canReusePublishedService(state("127.0.0.1"), 18020, "127.0.0.1"), true);
  assert.equal(canReusePublishedService(state("0.0.0.0"), 18020, "127.0.0.1"), false);
  assert.equal(canReusePublishedService(state("127.0.0.1"), 18020, "0.0.0.0"), false);
  assert.equal(canReusePublishedService(state("127.0.0.1", "18021"), 18020, "127.0.0.1"), false);
  assert.equal(canReusePublishedService(state("127.0.0.1", "18020", false), 18020, "127.0.0.1"), false);
  assert.equal(canReusePublishedService("invalid", 18020, "127.0.0.1"), false);
  assert.equal(canReusePublishedService(JSON.stringify({ running: true, ports: { "8000/tcp": [
    { HostIp: "127.0.0.1", HostPort: "18020" }, { HostIp: "192.168.5.40", HostPort: "18020" }
  ] } }), 18020, "127.0.0.1"), false);
});
