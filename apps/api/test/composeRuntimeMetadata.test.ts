import assert from "node:assert/strict";
import test from "node:test";
import { parseComposeRuntimeDeclaration } from "../src/composeRuntimeMetadata.js";

test("parses x-ai-stack suite metadata without affecting normal Compose fields", () => {
  const declaration = parseComposeRuntimeDeclaration(`
x-ai-stack:
  runtime:
    kind: suite
    api_models:
      - pipeline:general
      - pipeline:meeting
    publish_policy: all_ready
    load_policy: lazy
    card_mode: grouped
    health_path: /healthz
    primary_endpoint:
      kind: transcription
      path: /transcription/transcribe
    components:
      - model_id: asr-model
        role: asr
        required: true
      - model_id: vad-model
        role: vad
services:
  gateway:
    image: example/gateway
`);
  assert.equal(declaration?.kind, "suite");
  assert.equal(declaration?.publish_policy, "all_ready");
  assert.deepEqual(declaration?.api_models, ["pipeline:general", "pipeline:meeting"]);
  assert.equal(declaration?.primary_endpoint?.path, "/transcription/transcribe");
  assert.deepEqual(declaration?.components, [
    { model_id: "asr-model", role: "asr", required: true },
    { model_id: "vad-model", role: "vad", required: false }
  ]);
});

test("keeps Compose profiles without x-ai-stack in single-model mode", () => {
  assert.equal(parseComposeRuntimeDeclaration("services:\n  worker:\n    image: example/worker\n"), null);
});
