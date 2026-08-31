import test from "node:test";
import assert from "node:assert/strict";
import {
  deploymentApiKind,
  deploymentEndpointPath,
  directDeploymentUrl,
} from "../src/deploymentEndpoints.js";

const request = {
  headers: {
    host: "127.0.0.1:8000",
    "x-forwarded-host": "192.168.5.40:8888",
    "x-forwarded-proto": "http"
  }
} as any;

function deployment(runtime: string, model: string, port: number) {
  return {
    runtime,
    container_name: "custom_" + runtime,
    model_id: model,
    openai_model: model,
    public_port: port
  } as any;
}

test("deployment endpoint catalog maps model runtimes to their real APIs", () => {
  const cases = [
    [deployment("mineru", "mineru2.5-pro", 33040), "document", "/v1/documents/parse"],
    [deployment("vllm-embedding", "qwen3-embedding-8b", 33041), "embedding", "/v1/embeddings"],
    [deployment("vllm-reranker", "qwen3-reranker-8b", 33042), "rerank", "/v1/score"],
    [deployment("locate-anything", "locateanything-3b", 33043), "ground", "/v1/ground"],
    [deployment("qwen3-tts", "qwen3-tts-12hz-1.7b-customvoice", 18020), "speech", "/v1/audio/speech"],
    [deployment("funasr-gateway", "sensevoicesmall", 8011), "transcription", "/v1/audio/transcriptions"],
    [deployment("vllm", "omnicoder-9b", 33050), "chat", "/v1/chat/completions"]
  ] as const;

  for (const [record, kind, path] of cases) {
    assert.equal(deploymentApiKind(record), kind);
    assert.equal(deploymentEndpointPath(record), path);
  }
});

test("published endpoint URLs use the runtime port rather than the software port", () => {
  const mineru = deployment("mineru", "mineru2.5-pro", 33040);
  assert.equal(
    directDeploymentUrl(request, mineru),
    "http://192.168.5.40:33040/v1/documents/parse"
  );
});
