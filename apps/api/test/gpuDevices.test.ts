import test from "node:test";
import assert from "node:assert/strict";
import { gpuDeviceRequest, requestedGpuDeviceIds, resolveGpuDeviceIds } from "../src/gpuDevices.js";

const devices = [
  { index: 0, uuid: "GPU-a", name: "GPU A", memory_total_mib: 24576, memory_used_mib: 1024, memory_free_mib: 23552 },
  { index: 1, uuid: "GPU-b", name: "GPU B", memory_total_mib: 24576, memory_used_mib: 2048, memory_free_mib: 22528 }
];

test("GPU selection accepts indices and stores stable UUIDs", () => {
  const resolved = resolveGpuDeviceIds(["1", "GPU-a"], devices);
  assert.deepEqual(resolved.ids, ["GPU-b", "GPU-a"]);
  assert.deepEqual(resolved.devices.map((device) => device.index), [1, 0]);
});

test("GPU selection rejects unknown, duplicate, and unsafe identifiers", () => {
  assert.throws(() => resolveGpuDeviceIds(["2"], devices), /Unknown GPU device/);
  assert.throws(() => requestedGpuDeviceIds(["GPU-a", "GPU-a"]), /duplicate/);
  assert.throws(() => requestedGpuDeviceIds(["GPU-a;rm"]), /invalid/);
});

test("Docker GPU request defaults to all and renders selected devices", () => {
  assert.equal(gpuDeviceRequest({}), "all");
  assert.equal(gpuDeviceRequest({ gpu_device_ids: ["GPU-a", "GPU-b"] }), "device=GPU-a,GPU-b");
});
