import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { proxyAudioMultipart } from "../src/audioProxy.js";
import { register as registerOpenAiRoutes } from "../src/routes/openai.js";

function responseCapture() {
  let status = 0;
  let headers: Record<string, string> = {};
  let body = "";
  return {
    response: {
      writeHead(value: number, nextHeaders: Record<string, string>) {
        status = value;
        headers = nextHeaders;
      },
      end(value = "") {
        body += String(value);
      }
    },
    result: () => ({ status, headers, body })
  };
}

test("OpenAI routes expose the canonical transcription endpoint", () => {
  const routes = new Map<string, (...args: any[]) => Promise<void>>();
  registerOpenAiRoutes(
    (method, path, handler) => routes.set(`${method} ${path}`, handler),
    { liveActiveDeployments: async () => [] },
    { proxyOpenAiRequest: async () => undefined }
  );
  assert.ok(routes.has("POST /v1/audio/transcriptions"));
});

test("audio multipart proxy preserves request bytes, content type, and upstream response", async () => {
  let receivedPath = "";
  let receivedType = "";
  let receivedBody = "";
  const upstream = createServer((req, res) => {
    receivedPath = req.url ?? "";
    receivedType = String(req.headers["content-type"] ?? "");
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      receivedBody = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"text":"ok"}');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const address = upstream.address();
    assert.ok(address && typeof address === "object");
    const boundary = "test-boundary";
    const raw = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\npipeline:general\r\n--${boundary}--\r\n`;
    const req = Readable.from([Buffer.from(raw)]) as any;
    req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
    const capture = responseCapture();

    await proxyAudioMultipart(req, capture.response, `http://127.0.0.1:${address.port}`, "/v1/audio/transcriptions");

    assert.equal(receivedPath, "/v1/audio/transcriptions");
    assert.equal(receivedType, `multipart/form-data; boundary=${boundary}`);
    assert.equal(receivedBody, raw);
    assert.deepEqual(capture.result(), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*"
      },
      body: '{"text":"ok"}'
    });
  } finally {
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test("audio multipart proxy reports OpenAI-style content type errors", async () => {
  const req = Readable.from([]) as any;
  req.headers = { "content-type": "application/json" };
  const capture = responseCapture();
  await proxyAudioMultipart(req, capture.response, "http://127.0.0.1:1", "/v1/audio/transcriptions");
  const result = capture.result();
  assert.equal(result.status, 415);
  assert.equal(JSON.parse(result.body).error.type, "invalid_request_error");
});
