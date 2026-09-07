import test from "node:test";
import assert from "node:assert/strict";
import { runtimeArgsFromVllmCommand } from "../src/deploymentHelpers.js";
import { deploymentArgsMatch, validateDeploymentRuntimeArgs } from "../src/routes/deployments.js";

test("deployment argument comparison includes vLLM tool-call settings", () => {
  const existing = {
    max_model_len: 4096,
    enable_auto_tool_choice: true,
    enable_thinking: false,
    tool_call_parser: "qwen3_coder",
    reasoning_parser: "qwen3"
  };
  assert.equal(deploymentArgsMatch(existing, { ...existing }, "vllm"), true);
  assert.equal(deploymentArgsMatch(existing, { ...existing, reasoning_parser: "deepseek_r1" }, "vllm"), false);
  assert.equal(deploymentArgsMatch(existing, { ...existing, enable_auto_tool_choice: false }, "vllm"), false);
  assert.equal(deploymentArgsMatch(existing, { ...existing, enable_thinking: true }, "vllm"), false);
});

test("omitted and explicit false auto tool choice are equivalent", () => {
  assert.equal(deploymentArgsMatch({ enable_auto_tool_choice: false }, {}, "vllm"), true);
  assert.equal(deploymentArgsMatch({}, { enable_auto_tool_choice: false }, "vllm"), true);
});

test("deployment validation resolves Qwen parser before planning or starting", () => {
  const validated = validateDeploymentRuntimeArgs(
    { enable_auto_tool_choice: true, reasoning_parser: "qwen3" },
    "vllm",
    "Qwen3.8-27B",
    "qwen-local"
  );
  assert.equal(validated.detail, undefined);
  assert.deepEqual(validated.args, {
    enable_auto_tool_choice: true,
    tool_call_parser: "qwen3_coder",
    reasoning_parser: "qwen3"
  });
});

test("deployment validation rejects parser injection before runtime planning", () => {
  const validated = validateDeploymentRuntimeArgs(
    { enable_auto_tool_choice: true, tool_call_parser: "qwen3_coder;docker run evil" },
    "vllm",
    "Qwen3.8",
    "Qwen3.8"
  );
  assert.match(validated.detail ?? "", /valid parser identifier/);
});

test("running vLLM container flags restore tool-call deployment arguments", () => {
  assert.deepEqual(runtimeArgsFromVllmCommand([
    "/models/qwen3.8",
    "--served-model-name", "qwen3.8",
    "--max-model-len", "8192",
    "--enable-auto-tool-choice",
    "--tool-call-parser", "qwen3_coder",
    "--reasoning-parser", "qwen3",
    "--default-chat-template-kwargs", JSON.stringify({ enable_thinking: false })
  ]), {
    max_model_len: 8192,
    enable_auto_tool_choice: true,
    tool_call_parser: "qwen3_coder",
    reasoning_parser: "qwen3",
    enable_thinking: false
  });
  assert.deepEqual(runtimeArgsFromVllmCommand(["/models/llama"]), {
    enable_auto_tool_choice: false
  });
});

test("deployment arguments match independently of object key order", () => {
  assert.equal(
    deploymentArgsMatch(
      { max_model_len: 4096, gpu_memory_utilization: 0.75, nested: { a: 1, b: 2 } },
      { nested: { b: 2, a: 1 }, gpu_memory_utilization: 0.75, max_model_len: 4096 }
    ),
    true
  );
});

test("deployment arguments detect changed runtime and GPU settings", () => {
  assert.equal(
    deploymentArgsMatch(
      { max_model_len: 4096, gpu_memory_utilization: 0.15, gpu_device_ids: ["GPU-a"] },
      { max_model_len: 4096, gpu_memory_utilization: 0.75, gpu_device_ids: ["GPU-a"] },
      "vllm"
    ),
    false
  );
  assert.equal(
    deploymentArgsMatch(
      { tensor_parallel_size: 1, gpu_device_ids: ["GPU-a"] },
      { tensor_parallel_size: 1, gpu_device_ids: ["GPU-b"] },
      "vllm"
    ),
    false
  );
});

test("vLLM argument comparison ignores fields used only by other runtimes", () => {
  assert.equal(
    deploymentArgsMatch(
      { max_model_len: 4096, enable_auto_tool_choice: false },
      { max_model_len: 4096, enable_auto_tool_choice: false, max_batch_size: 8 },
      "vllm"
    ),
    true
  );
});

test("legacy deployments without saved arguments require reconfiguration", () => {
  assert.equal(deploymentArgsMatch(undefined, { gpu_memory_utilization: 0.75 }, "vllm"), false);
  assert.equal(deploymentArgsMatch(undefined, undefined, "vllm"), true);
});
