import { test } from "node:test";
import assert from "node:assert/strict";
import { createDownloadPlan, sameDownloadSource } from "../src/downloadManager.js";

test("download plan rejects an empty or incomplete repository id", () => {
  const emptyRepo = createDownloadPlan({
    url: "https://modelscope.cn/models",
    provider: "modelscope",
    alias: "models-name-qwen3-20tts"
  }, "/workspace");

  assert.equal(emptyRepo.download_ready, false);
  assert.equal(emptyRepo.download, null);
  assert.match(emptyRepo.message, /owner\/model/);
});

test("download restart matching requires the same provider and repo", () => {
  const previousHfTask = {
    provider: "huggingface",
    repo_id: "Qwen/Qwen3-ASR-1.7B",
    alias: "qwen3-asr-1-7b",
    target_path: "models/qwen3-asr-1-7b"
  };

  assert.equal(sameDownloadSource(previousHfTask, "modelscope", "Qwen/Qwen3-ASR-1.7B"), false);
  assert.equal(sameDownloadSource(previousHfTask, "huggingface", "Qwen/Qwen3-ASR-1.7B"), true);
});

test("Qwen3-TTS downloads recommend the dedicated speech runtime", () => {
  const plan = createDownloadPlan({
    url: "https://modelscope.cn/models/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    provider: "modelscope"
  }, "/workspace");

  assert.equal(plan.download_ready, true);
  assert.equal(plan.runtime_hints[0].runtime, "qwen3-tts");
  assert.equal(plan.runtime_hints[0].status, "compatible");
  assert.equal(plan.runtime_hints.some((hint) => hint.runtime === "funasr-gateway"), false);
});
