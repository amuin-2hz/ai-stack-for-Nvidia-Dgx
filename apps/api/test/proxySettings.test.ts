import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNoProxy } from "../src/routes/settings.js";

test("NO_PROXY always keeps localhost and private networks direct", () => {
  assert.equal(
    normalizeNoProxy("example.internal,localhost"),
    "example.internal,localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
  );
});

test("NO_PROXY normalization removes duplicate mandatory entries", () => {
  const normalized = normalizeNoProxy("127.0.0.1,192.168.0.0/16,127.0.0.1");
  assert.equal(normalized.split(",").filter((entry) => entry === "192.168.0.0/16").length, 1);
});
