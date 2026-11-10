import assert from "node:assert/strict";
import test from "node:test";
import { runtimeLaunchShouldRemainRunning } from "../src/taskReconciler.js";

const now = Date.parse("2026-09-17T00:00:00.000Z");

test("keeps a new runtime task loading while its container is being replaced", () => {
  assert.equal(runtimeLaunchShouldRemainRunning({
    status: "running",
    created_at: new Date(now - 30_000).toISOString()
  }, "start", false, now), true);
});

test("restores a transient failed state while the launch process is still active", () => {
  assert.equal(runtimeLaunchShouldRemainRunning({
    status: "failed",
    created_at: new Date(now - 120_000).toISOString()
  }, "pull", true, now), true);
});

test("does not hide a stopped or post-launch runtime failure", () => {
  const oldTask = {
    status: "running",
    created_at: new Date(now - 120_000).toISOString()
  };
  assert.equal(runtimeLaunchShouldRemainRunning(oldTask, "start", false, now), false);
  assert.equal(runtimeLaunchShouldRemainRunning(oldTask, "load", true, now), false);
});
