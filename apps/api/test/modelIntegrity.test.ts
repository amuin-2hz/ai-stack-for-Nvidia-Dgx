import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectCompletedModelDownload } from "../src/modelIntegrity.js";

test("completed download accepts a TensorFlow protobuf language model (.pb)", async () => {
  const modelDir = join(tmpdir(), "ai-stack-pb-integrity-" + Date.now());
  await mkdir(modelDir, { recursive: true });
  try {
    await writeFile(join(modelDir, ".download-complete"), "", "utf-8");
    await writeFile(join(modelDir, "configuration.json"), "{}", "utf-8");
    await writeFile(join(modelDir, "lm.pb"), "protobuf-model", "utf-8");

    assert.deepEqual(await inspectCompletedModelDownload(modelDir), {
      complete: true,
      reason: "completion marker, configuration, weights and indexed shards are valid"
    });
  } finally {
    await rm(modelDir, { recursive: true, force: true });
  }
});

test("completed download accepts a compiled FST language model", async () => {
  const modelDir = join(tmpdir(), "ai-stack-fst-integrity-" + Date.now());
  await mkdir(modelDir, { recursive: true });
  try {
    await writeFile(join(modelDir, ".download-complete"), "", "utf-8");
    await writeFile(join(modelDir, "configuration.json"), "{}", "utf-8");
    await writeFile(join(modelDir, "TLG.fst"), "compiled-fst", "utf-8");

    assert.deepEqual(await inspectCompletedModelDownload(modelDir), {
      complete: true,
      reason: "completion marker, configuration, weights and indexed shards are valid"
    });
  } finally {
    await rm(modelDir, { recursive: true, force: true });
  }
});

test("completed FST download still rejects staged partial files", async () => {
  const modelDir = join(tmpdir(), "ai-stack-fst-staging-" + Date.now());
  await mkdir(join(modelDir, ".temp"), { recursive: true });
  try {
    await writeFile(join(modelDir, ".download-complete"), "", "utf-8");
    await writeFile(join(modelDir, "configuration.json"), "{}", "utf-8");
    await writeFile(join(modelDir, "TLG.fst"), "compiled-fst", "utf-8");
    await writeFile(join(modelDir, ".temp", "TLG.fst.part"), "partial", "utf-8");

    const inspection = await inspectCompletedModelDownload(modelDir);
    assert.equal(inspection.complete, false);
    assert.match(inspection.reason, /staged or partial file remains/);
  } finally {
    await rm(modelDir, { recursive: true, force: true });
  }
});
