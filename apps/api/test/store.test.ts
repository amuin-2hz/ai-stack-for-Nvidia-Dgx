import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testRoot = await mkdtemp(join(tmpdir(), "ai-stack-store-"));
process.env.AI_STACK_DB_PATH = join(testRoot, "data.db");

const { initDb, closeDb } = await import("../src/db.js");
const { createTask, deleteTask, listModelFiles, upsertModelFile } = await import("../src/store.js");

beforeEach(() => {
  closeDb();
  initDb();
});

after(async () => {
  closeDb();
  await rm(testRoot, { recursive: true, force: true });
});

test("deleted tasks cannot recreate model-file rows from a late callback", () => {
  const taskId = "task_deleted_download";
  const modelId = "compiled-fst";
  const timestamp = new Date().toISOString();
  createTask({
    id: taskId,
    type: "download",
    status: "running",
    command: "download",
    cwd: testRoot,
    log_path: join(testRoot, "download.log"),
    metadata: { model_id: modelId },
    created_at: timestamp,
    updated_at: timestamp
  });
  upsertModelFile({
    model_id: modelId,
    relative_path: "TLG.fst",
    status: "downloading",
    size_bytes: 100,
    downloaded_bytes: 99,
    task_id: taskId,
    updated_at: timestamp
  });

  assert.equal(deleteTask(taskId), true);
  assert.deepEqual(listModelFiles(modelId), []);

  upsertModelFile({
    model_id: modelId,
    relative_path: "TLG.fst",
    status: "canceled",
    size_bytes: 100,
    downloaded_bytes: 100,
    task_id: taskId,
    updated_at: timestamp
  });
  assert.deepEqual(listModelFiles(modelId), []);
});
