import assert from "node:assert/strict";
import test from "node:test";
import { parseRuntimeExtensionImport } from "../src/runtimeExtensionPackages.js";

test("imports a standalone Compose profile into the requested category", () => {
  const result = parseRuntimeExtensionImport(
    "docker-compose.my-worker.yml",
    Buffer.from("services:\n  worker:\n    image: example/worker:latest\n"),
    "shared"
  );
  assert.equal(result.id, "my-worker");
  assert.equal(result.category, "shared");
  assert.equal(result.files.length, 0);
});

test("imports Compose, Dockerfile, and Python sources from a runtime package", () => {
  const result = parseRuntimeExtensionImport("speech.aistack-runtime.json", Buffer.from(JSON.stringify({
    format: "ai-stack-runtime/v1",
    manifest: {
      id: "speech-gateway",
      category: "shared",
      title: "Speech Gateway",
      suitable_models: ["asr-model"]
    },
    compose: "services:\n  gateway:\n    build:\n      context: ../../..\n      dockerfile: deploy/dockerfiles/custom/speech-gateway.Dockerfile\n",
    files: [
      { path: "deploy/dockerfiles/custom/speech-gateway.Dockerfile", content: "FROM python:3.12\nCOPY deploy/templates/speech_gateway.py /app/server.py\n" },
      { path: "deploy/templates/speech_gateway.py", content: "print('ready')\n" },
      { path: "ops/scripts/start-speech.sh", content: "python /app/server.py\n" }
    ]
  })));
  assert.equal(result.category, "shared");
  assert.deepEqual(result.files.map((file) => file.path), [
    "deploy/dockerfiles/custom/speech-gateway.Dockerfile",
    "deploy/templates/speech_gateway.py",
    "ops/scripts/start-speech.sh"
  ]);
});

test("rejects package files outside import-safe directories", () => {
  assert.throws(() => parseRuntimeExtensionImport("unsafe.json", Buffer.from(JSON.stringify({
    format: "ai-stack-runtime/v1",
    manifest: { id: "unsafe" },
    compose: "services:\n  worker:\n    image: example/worker\n",
    files: [{ path: "../settings.json", content: "{}" }]
  }))), /disallowed file path/);
});

test("rejects content that is not a Compose document", () => {
  assert.throws(
    () => parseRuntimeExtensionImport("invalid.yml", Buffer.from("name: invalid\n")),
    /at least one service/
  );
});
