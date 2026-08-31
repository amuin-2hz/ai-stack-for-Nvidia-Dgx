import test from "node:test";
import assert from "node:assert/strict";
import { mergeDeploymentRuntimeArgs } from "../src/deploymentHelpers.js";

test("running container flags override incomplete persisted vLLM arguments", () => {
  assert.deepEqual(
    mergeDeploymentRuntimeArgs(
      { max_model_len: 4096, gpu_device_ids: ["GPU-demo"] },
      { max_model_len: 8192, enable_auto_tool_choice: true, tool_call_parser: "qwen3_coder" }
    ),
    {
      max_model_len: 8192,
      gpu_device_ids: ["GPU-demo"],
      enable_auto_tool_choice: true,
      tool_call_parser: "qwen3_coder"
    }
  );
});
