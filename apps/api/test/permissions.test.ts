import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { isElectronRequest } from "../src/permissions.js";

function remoteRequest(headers: Record<string, string> = {}): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress: "192.168.10.20" }
  } as unknown as IncomingMessage;
}

test("remote privileged access is denied when no admin token is configured", () => {
  const previousAdminToken = process.env.AI_STACK_ADMIN_TOKEN;
  const previousElectronToken = process.env.ELECTRON_TOKEN;
  delete process.env.AI_STACK_ADMIN_TOKEN;
  delete process.env.ELECTRON_TOKEN;
  try {
    assert.equal(isElectronRequest(remoteRequest()), false);
  } finally {
    if (previousAdminToken === undefined) delete process.env.AI_STACK_ADMIN_TOKEN;
    else process.env.AI_STACK_ADMIN_TOKEN = previousAdminToken;
    if (previousElectronToken === undefined) delete process.env.ELECTRON_TOKEN;
    else process.env.ELECTRON_TOKEN = previousElectronToken;
  }
});

test("remote privileged access accepts the configured admin token", () => {
  const previousAdminToken = process.env.AI_STACK_ADMIN_TOKEN;
  process.env.AI_STACK_ADMIN_TOKEN = "test-admin-token";
  try {
    assert.equal(isElectronRequest(remoteRequest({ "x-ai-stack-admin": "test-admin-token" })), true);
    assert.equal(isElectronRequest(remoteRequest({ authorization: "Bearer test-admin-token" })), true);
    assert.equal(isElectronRequest(remoteRequest({ "x-ai-stack-admin": "wrong" })), false);
  } finally {
    if (previousAdminToken === undefined) delete process.env.AI_STACK_ADMIN_TOKEN;
    else process.env.AI_STACK_ADMIN_TOKEN = previousAdminToken;
  }
});
