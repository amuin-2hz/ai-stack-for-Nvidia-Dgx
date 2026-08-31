import { test } from "node:test";
import assert from "node:assert/strict";
import { isManagedFailedContainer, type DockerCleanupInspect } from "../src/containerDocker.js";

const workspaceRoot = "/home/test/ai-stack";

test("cleanup selects failed AI Stack runtime containers", () => {
  const row: DockerCleanupInspect = { Name: "/vllm_model", Config: { Labels: { "amuin.role": "model-runtime" } }, State: { Status: "exited", Running: false, ExitCode: 1 } };
  assert.equal(isManagedFailedContainer(row, workspaceRoot), true);
});

test("cleanup never selects a running managed container", () => {
  const row: DockerCleanupInspect = { Name: "/vllm_model", Config: { Labels: { "amuin.role": "model-runtime" } }, State: { Status: "running", Running: true, ExitCode: 0 } };
  assert.equal(isManagedFailedContainer(row, workspaceRoot), false);
});

test("cleanup ignores failed containers that are not managed by AI Stack", () => {
  const row: DockerCleanupInspect = { Name: "/user_database", Config: { Labels: {} }, State: { Status: "exited", Running: false, ExitCode: 1 } };
  assert.equal(isManagedFailedContainer(row, workspaceRoot), false);
});

test("cleanup selects failed workspace compose containers and finished task containers", () => {
  const composeRow: DockerCleanupInspect = { Name: "/audio", Config: { Labels: { "com.docker.compose.project.working_dir": workspaceRoot } }, State: { Status: "exited", Running: false, ExitCode: 137 } };
  const taskRow: DockerCleanupInspect = { Name: "/ai-stack-task_123", Config: { Labels: {} }, State: { Status: "exited", Running: false, ExitCode: 0 } };
  assert.equal(isManagedFailedContainer(composeRow, workspaceRoot), true);
  assert.equal(isManagedFailedContainer(taskRow, workspaceRoot), true);
});
