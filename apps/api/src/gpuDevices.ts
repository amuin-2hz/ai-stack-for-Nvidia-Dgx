import { runCommand } from "./utils.js";

export interface GpuDeviceInfo {
  index: number;
  uuid: string;
  name: string;
  memory_total_mib: number | null;
  memory_used_mib: number | null;
  memory_free_mib: number | null;
}

export async function inspectGpuDevices(): Promise<{ devices: GpuDeviceInfo[]; detail?: string }> {
  const result = await runCommand(
    "nvidia-smi",
    ["--query-gpu=index,uuid,name,memory.total,memory.used", "--format=csv,noheader,nounits"],
    5000
  );
  if (!result.ok || !result.stdout.trim()) {
    return { devices: [], detail: result.stderr || "nvidia-smi is not available." };
  }
  const devices = result.stdout.split("\n").filter(Boolean).map((line) => {
    const [index, uuid, name, totalMiB, usedMiB] = line.split(",").map((value) => value.trim());
    const parsedTotal = Number(totalMiB);
    const parsedUsed = Number(usedMiB);
    const memoryTotal = Number.isFinite(parsedTotal) ? parsedTotal : null;
    const memoryUsed = Number.isFinite(parsedUsed) ? parsedUsed : null;
    return {
      index: Number(index),
      uuid,
      name,
      memory_total_mib: memoryTotal,
      memory_used_mib: memoryUsed,
      memory_free_mib: memoryTotal !== null && memoryUsed !== null ? Math.max(0, memoryTotal - memoryUsed) : null
    };
  }).filter((device) =>
    Number.isInteger(device.index) && device.index >= 0 && Boolean(device.uuid)
  );
  return devices.length ? { devices } : { devices: [], detail: "No NVIDIA GPU rows returned by nvidia-smi." };
}

export function requestedGpuDeviceIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!Array.isArray(value)) throw new Error("gpu_device_ids must be an array.");
  const ids = value.map((item) => String(item).trim());
  if (!ids.length) throw new Error("Select at least one GPU.");
  if (ids.some((id) => !id || !/^[A-Za-z0-9_.:/-]+$/.test(id))) throw new Error("gpu_device_ids contains an invalid GPU identifier.");
  if (new Set(ids).size !== ids.length) throw new Error("gpu_device_ids contains duplicate GPUs.");
  return ids;
}

export function resolveGpuDeviceIds(value: unknown, devices: GpuDeviceInfo[]): { ids?: string[]; devices: GpuDeviceInfo[] } {
  const requested = requestedGpuDeviceIds(value);
  if (!requested) return { devices: [] };
  const selected = requested.map((id) => devices.find((device) => device.uuid === id || String(device.index) === id));
  const missing = requested.filter((_id, index) => !selected[index]);
  if (missing.length) throw new Error("Unknown GPU device: " + missing.join(", "));
  const resolved = selected as GpuDeviceInfo[];
  return { ids: resolved.map((device) => device.uuid), devices: resolved };
}

export function gpuDeviceRequest(args: Record<string, unknown>): string {
  const ids = requestedGpuDeviceIds(args.gpu_device_ids);
  return ids ? "device=" + ids.join(",") : "all";
}

export function gpuVisibleDevices(args: Record<string, unknown>): string {
  return requestedGpuDeviceIds(args.gpu_device_ids)?.join(",") ?? "all";
}
