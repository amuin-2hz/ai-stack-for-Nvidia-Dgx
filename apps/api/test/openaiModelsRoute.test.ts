import test from "node:test";
import assert from "node:assert/strict";
import { register } from "../src/routes/openai.js";

test("GET /v1/models advertises each runtime's direct endpoint", async () => {
  const routes = new Map<string, (...args: any[]) => Promise<void>>();
  const active = {
    deployment_id: "custom-profile:mineru:mineru2.5-pro",
    model_id: "mineru2.5-pro",
    status: "running",
    service_type: "pytorch",
    runtime: "mineru",
    container_name: "custom_mineru",
    public_port: 33040,
    base_url: "http://localhost:33040",
    health_url: "http://localhost:33040/healthz",
    worker_endpoint: "http://localhost:33040",
    openai_model: "mineru2.5-pro"
  };
  register(
    (method, path, handler) => routes.set(method + " " + path, handler),
    { liveActiveDeployments: async () => [active] },
    { proxyOpenAiRequest: async () => {} }
  );

  let status = 0;
  let raw = "";
  const response = {
    writeHead(code: number) { status = code; },
    end(body: string) { raw = body; }
  };
  const request = {
    headers: {
      host: "127.0.0.1:8000",
      "x-forwarded-host": "192.168.5.40:8888",
      "x-forwarded-proto": "http"
    }
  };

  await routes.get("GET /v1/models")!(request, response);
  const payload = JSON.parse(raw);
  assert.equal(status, 200);
  assert.equal(payload.data[0].endpoint, "http://192.168.5.40:33040/v1/documents/parse");
  assert.equal(payload.data[0].api_kind, "document");
  assert.deepEqual(payload.data[0].routing, {
    deployment_id: active.deployment_id,
    runtime: "mineru",
    public_port: 33040
  });
});

test("GET /v1/models advertises suite API models instead of a selected local model", async () => {
  const routes = new Map<string, (...args: any[]) => Promise<void>>();
  const active = {
    deployment_id: "custom-profile:funasr-gateway:suite",
    model_id: "sensevoicesmall", status: "running", service_type: "pytorch",
    runtime: "funasr-gateway", container_name: "custom_funasr_gateway_service",
    public_port: 8011, base_url: "http://localhost:8011", health_url: "http://localhost:8011/healthz",
    worker_endpoint: "http://localhost:8011", openai_model: "pipeline:general",
    suite: {
      kind: "suite", publish_policy: "all_ready", load_policy: "lazy", card_mode: "grouped",
      title: "FunASR Gateway", api_models: ["pipeline:general", "pipeline:meeting"],
      primary_endpoint: { kind: "transcription", method: "POST", path: "/v1/audio/transcriptions" },
      components: [{ model_id: "sensevoicesmall", role: "asr", required: true }]
    }
  };
  register(
    (method, path, handler) => routes.set(method + " " + path, handler),
    { liveActiveDeployments: async () => [active] },
    { proxyOpenAiRequest: async () => {} }
  );
  let raw = "";
  const response = { writeHead() {}, end(body: string) { raw = body; } };
  const request = { headers: { host: "192.168.5.40:8888" } };
  await routes.get("GET /v1/models")!(request, response);
  const payload = JSON.parse(raw);
  assert.deepEqual(payload.data.map((item: any) => item.id), ["pipeline:general", "pipeline:meeting"]);
  assert.equal(payload.data[0].endpoint, "http://192.168.5.40:8011/v1/audio/transcriptions");
  assert.equal(payload.data[0].service, "funasr-gateway");
  assert.equal(payload.data.some((item: any) => item.id === "whisper-large-v3"), false);
});
