import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveComposeNetworkEnv } from "../../../scripts/runtime-compose.mjs";

test("manual Compose launcher reads the saved LAN switch, not the API active bind", async () => {
  for (const enabled of [true, false]) {
    let url = "";
    const env = await resolveComposeNetworkEnv({ AI_STACK_API_URL: "http://localhost:9999/" }, async (value: string) => {
      url = value;
      return { ok: true, json: async () => ({ lan_access_enabled: enabled, active_bind_address: enabled ? "127.0.0.1" : "0.0.0.0" }) };
    });
    assert.equal(url, "http://localhost:9999/settings/network");
    const address = enabled ? "0.0.0.0" : "127.0.0.1";
    assert.deepEqual(env, { AI_STACK_BIND_ADDR: address, BIND_ADDR: address });
  }
});

test("manual launcher fails closed on missing or invalid network settings", async () => {
  for (const fetcher of [
    async () => { throw new Error("offline"); },
    async () => ({ ok: false, status: 500 }),
    async () => ({ ok: true, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ lan_access_enabled: "false" }) })
  ]) {
    await assert.rejects(resolveComposeNetworkEnv({}, fetcher), /Cannot read AI Stack network settings/);
  }
});

test("explicit offline overrides support the canonical variable and legacy alias", async () => {
  const fetcher = async () => { throw new Error("must not fetch"); };
  assert.deepEqual(await resolveComposeNetworkEnv({ AI_STACK_BIND_ADDR: "127.0.0.1", BIND_ADDR: "0.0.0.0" }, fetcher),
    { AI_STACK_BIND_ADDR: "127.0.0.1", BIND_ADDR: "127.0.0.1" });
  assert.deepEqual(await resolveComposeNetworkEnv({ BIND_ADDR: "0.0.0.0" }, fetcher),
    { AI_STACK_BIND_ADDR: "0.0.0.0", BIND_ADDR: "0.0.0.0" });
  await assert.rejects(resolveComposeNetworkEnv({ AI_STACK_BIND_ADDR: "invalid" }, fetcher), /must be/);
});
