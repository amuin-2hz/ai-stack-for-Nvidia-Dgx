import { test } from "node:test";
import assert from "node:assert/strict";
import { healthUrl, publicBaseUrl, runtimeCommandFor, settingsFor } from "../src/runtimePlan.js";

test("runtimeCommandFor renders vLLM deployment command and configured env", () => {
  const settings = settingsFor("vllm", {
    key: "vllm",
    public_port: 30123,
    management_mode: "resident",
    restart_policy: "no",
    auto_restart: false,
    updated_at: "2026-06-21T00:00:00.000Z"
  });
  const command = runtimeCommandFor("vllm", "qwen", "local-qwen", { max_model_len: 8192, gpu_memory_utilization: 45 }, settings);
  assert.equal(command.command, "bash");
  assert.equal(command.env.MODEL_ALIAS, "qwen");
  assert.equal(command.env.OPENAI_MODEL, "local-qwen");
  assert.equal(command.env.VLLM_PUBLIC_PORT, "30123");
  assert.equal(command.env.VLLM_MAX_MODEL_LEN, "8192");
  assert.equal(command.env.VLLM_GPU_MEMORY_UTILIZATION, "45");
  assert.equal(command.env.VLLM_CONTAINER_NAME, "vllm_qwen_local_qwen");
  assert.match(command.args.join(" "), /docker run -d/);
  assert.match(command.args.join(" "), /--name "\$VLLM_CONTAINER_NAME"/);
  assert.match(command.args.join(" "), /"\$VLLM_IMAGE" "\/models\/\$MODEL_ALIAS"/);
  assert.doesNotMatch(command.args.join(" "), /--swap-space/);


  assert.equal(command.env.VLLM_SWAP_SPACE, undefined);
  assert.match(command.args.join(" "), /__AMUIN_STAGE__:pull:running/);
  assert.match(command.args.join(" "), /__AMUIN_STAGE__:start:running/);
});

test("runtimeCommandFor gives OmniCoder enough engine budget without changing other models", () => {
  const command = runtimeCommandFor("vllm", "omnicoder-9b", "omnicoder-9b", { gpu_memory_utilization: 0.2, max_num_seqs: 16 });
  assert.equal(command.env.VLLM_GPU_MEMORY_UTILIZATION, "0.3");
  assert.equal(command.env.VLLM_MAX_NUM_SEQS, "4");
});

test("runtime URLs match public OpenAI and health endpoints", () => {
  assert.equal(publicBaseUrl("vllm", 30000), "http://localhost:30000/v1");
  assert.equal(healthUrl("vllm", 30000), "http://localhost:30000/health");
  assert.equal(publicBaseUrl("pytorch", 32000), "http://localhost:32000");
  assert.equal(healthUrl("pytorch", 32000), "http://localhost:32000/healthz");
});


test("runtime plan exposes prepare, pull, start, and health stages", async () => {
  const { createRuntimePlan } = await import("../src/runtimePlan.js");
  const model: any = {
    id: "demo-model",
    compatibility: { vllm: { status: "compatible", reason: "ok" } }
  };
  const deployment: any = {
    deployment_id: "svc_vllm",
    model_id: null,
    status: "not_started",
    service_type: "vllm",
    runtime: "vllm",
    container_name: "vllm-service",
    public_port: 30000,
    base_url: "http://localhost:30000/v1",
    health_url: "http://localhost:30000/health",
    worker_endpoint: null,
    openai_models: [],
    warnings: []
  };
  const plan = createRuntimePlan(deployment, model, "vllm", "demo", {}, "/workspace");
  assert.deepEqual(plan.stages.map((stage) => stage.id), ["prepare", "pull", "start", "load", "health"]);
  assert.equal(plan.stages[1].label, "Pull image");
  assert.equal(plan.stages[2].label, "Start runtime");
  assert.equal(plan.stages[3].label, "Load model");
});

test("runtimeCommandFor prefers configured runtime image", () => {
  const vllm = runtimeCommandFor("vllm", "qwen", "local-qwen", {}, {
    key: "vllm", public_port: 30123, management_mode: "resident", restart_policy: "no", auto_restart: false, image: "registry.example.com/vllm:fixed", updated_at: "2026-06-21T00:00:00.000Z"
  });
  assert.equal(vllm.env.VLLM_IMAGE, "registry.example.com/vllm:fixed");

  const trt = runtimeCommandFor("trtllm", "qwen", "local-qwen", {}, {
    key: "trtllm", public_port: 31123, management_mode: "resident", restart_policy: "no", auto_restart: false, image: "registry.example.com/trtllm:fixed", updated_at: "2026-06-21T00:00:00.000Z"
  });
  assert.equal(trt.env.TRTLLM_IMAGE, "registry.example.com/trtllm:fixed");
});

test("vLLM tool calling is disabled unless explicitly enabled", () => {
  const command = runtimeCommandFor("vllm", "llama-3", "llama-3", {});
  assert.doesNotMatch(command.args.join(" "), /--enable-auto-tool-choice|--tool-call-parser|--reasoning-parser/);
  assert.equal(command.env.VLLM_TOOL_CALL_PARSER, undefined);
  assert.equal(command.env.VLLM_REASONING_PARSER, undefined);
});

test("vLLM uses explicit tool-call and reasoning parsers", () => {
  const command = runtimeCommandFor("vllm", "custom-model", "custom-model", {
    enable_auto_tool_choice: true,
    tool_call_parser: "hermes",
    reasoning_parser: "qwen3"
  });
  assert.match(command.args.join(" "), /--enable-auto-tool-choice --tool-call-parser "\$VLLM_TOOL_CALL_PARSER"/);
  assert.match(command.args.join(" "), /--reasoning-parser "\$VLLM_REASONING_PARSER"/);
  assert.equal(command.env.VLLM_TOOL_CALL_PARSER, "hermes");
  assert.equal(command.env.VLLM_REASONING_PARSER, "qwen3");
});

test("vLLM recommends qwen3_coder for supported Qwen and OmniCoder models", () => {
  for (const model of ["Qwen3.5-9B", "qwen3.6", "qwen3.8-27b", "OmniCoder-9B"]) {
    const command = runtimeCommandFor("vllm", model, model, { enable_auto_tool_choice: true });
    assert.equal(command.env.VLLM_TOOL_CALL_PARSER, "qwen3_coder");
  }
});

test("vLLM rejects missing or unsafe parser identifiers", () => {
  assert.throws(
    () => runtimeCommandFor("vllm", "llama-3", "llama-3", { enable_auto_tool_choice: true }),
    /tool_call_parser is required/
  );
  assert.throws(
    () => runtimeCommandFor("vllm", "qwen3.8", "qwen3.8", { enable_auto_tool_choice: true, tool_call_parser: "qwen3_coder; touch /tmp/pwned" }),
    /valid parser identifier/
  );
});

test("runtime plan preview includes resolved vLLM tool-call flags", async () => {
  const { createRuntimePlan } = await import("../src/runtimePlan.js");
  const model: any = { id: "qwen3.8", compatibility: { vllm: { status: "compatible", reason: "ok" } } };
  const deployment: any = { deployment_id: "svc_vllm", model_id: null, status: "not_started", service_type: "vllm", runtime: "vllm", container_name: "vllm-service", public_port: 30000, base_url: "http://localhost:30000/v1", health_url: "http://localhost:30000/health", worker_endpoint: null, openai_models: [], warnings: [] };
  const plan = createRuntimePlan(deployment, model, "vllm", "qwen3.8", { enable_auto_tool_choice: true, reasoning_parser: "qwen3" }, "/workspace");
  assert.match(plan.launch.command, /--enable-auto-tool-choice/);
  assert.match(plan.launch.command, /--tool-call-parser/);
  assert.match(plan.launch.command, /--reasoning-parser/);
  assert.equal(plan.launch.env.VLLM_TOOL_CALL_PARSER, "qwen3_coder");
});

test("runtimeCommandFor restricts vLLM and TensorRT-LLM to selected GPU UUIDs", () => {
  const gpuIds = ["GPU-11111111-1111-1111-1111-111111111111", "GPU-22222222-2222-2222-2222-222222222222"];
  const vllm = runtimeCommandFor("vllm", "qwen", "qwen", { gpu_device_ids: gpuIds, tensor_parallel_size: 2 });
  assert.equal(vllm.env.GPU_DEVICE_REQUEST, "device=" + gpuIds.join(","));
  assert.match(vllm.args.join(" "), /--gpus "\$GPU_DEVICE_REQUEST"/);

  const trt = runtimeCommandFor("trtllm", "qwen", "qwen", { gpu_device_ids: [gpuIds[1]], tp_size: 1, pp_size: 1 });
  assert.equal(trt.env.GPU_DEVICE_REQUEST, "device=" + gpuIds[1]);
});

test("runtimeCommandFor exposes only selected GPUs to the generic PyTorch service", () => {
  const command = runtimeCommandFor("pytorch", "audio", "audio", { gpu_device_ids: ["GPU-demo"] });
  assert.equal(command.env.GPU_VISIBLE_DEVICES, "GPU-demo");
  assert.equal(command.env.GPU_DEVICE_REQUEST, "device=GPU-demo");
  assert.match(command.args.join(" "), /docker run -d --name pytorch-service/);
  assert.match(command.args.join(" "), /--gpus "\$GPU_DEVICE_REQUEST"/);
});
