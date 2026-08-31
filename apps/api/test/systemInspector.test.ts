import test from "node:test";
import assert from "node:assert/strict";
import { parsePublishedPorts } from "../src/systemInspector.js";

test("parsePublishedPorts extracts and deduplicates Docker host mappings", () => {
  assert.deepEqual(
    parsePublishedPorts("6006/tcp, 8888/tcp, 0.0.0.0:33000->8000/tcp, [::]:33000->8000/tcp"),
    [{ public_port: 33000, internal_port: 8000, protocol: "tcp" }]
  );
});
