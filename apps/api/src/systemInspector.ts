import { cpus, freemem, hostname, loadavg, networkInterfaces, platform, release, totalmem, uptime } from "node:os";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { runCommand } from "./utils.js";
import { listContainerConfigs } from "./store.js";
import { presets } from "./containerPresets.js";

export const servicePorts = {
  vllm: Number(process.env.VLLM_PUBLIC_PORT ?? "30000"),
  trtllm: Number(process.env.TRTLLM_PUBLIC_PORT ?? "31000"),
  pytorch: Number(process.env.PYTORCH_PUBLIC_PORT ?? process.env.AUDIO_PUBLIC_PORT ?? "32000")
};

export function configuredServicePorts(): Record<string, number> {
  const configured = new Map(
    listContainerConfigs().map((item) => [item.key, Number(item.public_port)])
  );
  return Object.fromEntries(Object.entries(servicePorts).map(([key, fallback]) => {
    const port = configured.get(key);
    return [key, Number.isInteger(port) && Number(port) > 0 ? Number(port) : fallback];
  }));
}

export async function systemCheck(): Promise<Record<string, unknown>> {
  const ports: Record<string, unknown> = {};
  const runtimeStates = await inspectDefaultRuntimeStates();
  for (const [name, port] of Object.entries(configuredServicePorts())) {
    const preset = presets.find((item) => item.key === name);
    const containerName = preset?.names[0] ?? name;
    const state = runtimeStates.get(containerName) ?? "missing";
    ports[name] = {
      port,
      in_allowed_range: port >= 30000 && port <= 60000,
      available: state === "running" ? false : await portAvailable(port),
      source: "system",
      state,
      label: preset?.title ?? name,
      container_name: containerName
    };
  }
  for (const item of await inspectCustomContainerPorts()) {
    ports[item.key] = {
      port: item.public_port,
      internal_port: item.internal_port,
      protocol: item.protocol,
      available: item.state === "running" ? false : await portAvailable(item.public_port),
      source: "custom",
      state: item.state,
      label: item.label,
      container_name: item.container_name
    };
  }
  return {
    product: {
      name: "AMUIN AI STACK",
      short_name: "AI Stack"
    },
    management_url: "http://localhost:8888",
    backend_url: "http://localhost:8000",
    service_ports: ports,
    lan_addresses: lanAddresses(),
    device: await inspectDevice(),
    docker: await dockerStatus(),
    nvidia_runtime: await nvidiaStatus(),
    status: runtimeStatus()
  };
}

async function inspectDefaultRuntimeStates(): Promise<Map<string, string>> {
  const result = await runCommand("docker", ["ps", "-a", "--format", "{{.Names}}\t{{.State}}"], 5000);
  const states = new Map<string, string>();
  if (!result.ok || !result.stdout) return states;
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const [name, state = "unknown"] = line.split("\t");
    if (name) states.set(name, normalizeDockerState(state));
  }
  return states;
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
}

async function inspectDevice(): Promise<Record<string, unknown>> {
  const cpuInfo = await inspectCpu();
  const osRelease = await parseOsRelease();
  const productName = await readFirst(["/sys/class/dmi/id/product_name", "/host/sys/class/dmi/id/product_name"]);
  const productVersion = await readFirst(["/sys/class/dmi/id/product_version", "/host/sys/class/dmi/id/product_version"]);
  const boardName = await readFirst(["/sys/class/dmi/id/board_name", "/host/sys/class/dmi/id/board_name"]);
  const serialReadable = await readFirst(["/sys/class/dmi/id/product_serial", "/host/sys/class/dmi/id/product_serial"]);
  return {
    hostname: hostname(),
    vendor: await readFirst(["/sys/class/dmi/id/sys_vendor", "/host/sys/class/dmi/id/sys_vendor"]),
    model: normalizeDeviceModel(productName, productVersion, boardName),
    board: boardName,
    serial_available: Boolean(serialReadable),
    os: {
      platform: platform(),
      kernel: release(),
      name: osRelease.PRETTY_NAME ?? osRelease.NAME ?? "unknown",
      arch: process.arch,
      version: osRelease.VERSION_ID ?? osRelease.VERSION ?? "",
      build: osRelease.BUILD_ID ?? ""
    },
    cpu: cpuInfo,
    memory: {
      total_bytes: totalmem(),
      free_bytes: freemem()
    },
    storage: await inspectStorage(),
    gpu: await inspectGpu(),
    temperatures: await inspectTemperatures()
  };
}

async function inspectCpu(): Promise<Record<string, unknown>> {
  const cpuList = cpus();
  const cpuinfo = await readFirst(["/proc/cpuinfo", "/host/proc/cpuinfo"], false);
  const modelName = cpuinfo?.match(/(?:model name|Hardware)\s*:\s*(.+)/i)?.[1]?.trim();
  const implementer = cpuinfo?.match(/CPU implementer\s*:\s*(.+)/i)?.[1]?.trim();
  const part = cpuinfo?.match(/CPU part\s*:\s*(.+)/i)?.[1]?.trim();
  const nodeModel = cpuList[0]?.model && cpuList[0].model !== "unknown" ? cpuList[0].model : undefined;
  const model = modelName || nodeModel || (implementer && part ? "ARM CPU " + implementer + "/" + part : "unknown");
  return { model, cores: cpuList.length };
}

function runtimeStatus(): Record<string, unknown> {
  const loads = loadavg();
  const coreCount = cpus().length || 1;
  return {
    uptime_seconds: Math.round(uptime()),
    load_average: loads,
    cpu_load_percent: Math.round(Math.min(100, (loads[0] / coreCount) * 100))
  };
}

async function inspectStorage(): Promise<Record<string, unknown>> {
  const targets = [process.env.AI_STACK_BASE ?? process.cwd(), "/"];
  const result = await runCommand("df", ["-kP", ...targets], 5000);
  if (!result.ok || !result.stdout) return { available: false, detail: result.stderr || "df unavailable" };
  const rows = result.stdout.split("\n").slice(1).filter(Boolean).map((line) => {
    const parts = line.trim().split(/\s+/);
    const [filesystem, blocks, used, available, capacity, ...mountedParts] = parts;
    return {
      filesystem,
      mount: mountedParts.join(" "),
      total_bytes: Number(blocks) * 1024,
      used_bytes: Number(used) * 1024,
      free_bytes: Number(available) * 1024,
      used_percent: Number((capacity ?? "0").replace("%", ""))
    };
  });
  return { available: true, volumes: rows };
}

function normalizeDeviceModel(productName?: string, productVersion?: string, boardName?: string): string {
  const parts = [productName, productVersion].filter((part) => part && part !== "Default string" && part !== "To be filled by O.E.M.");
  if (parts.length) return parts.join(" ");
  return boardName || "unknown";
}

async function inspectGpu(): Promise<Record<string, unknown>> {
  const smi = await runCommand("nvidia-smi", ["--query-gpu=index,uuid,name,utilization.gpu,memory.total,memory.used,temperature.gpu,power.draw,driver_version", "--format=csv,noheader,nounits"], 5000);
  if (smi.ok && smi.stdout) {
    return {
      available: true,
      source: "nvidia-smi",
      devices: smi.stdout.split("\n").filter(Boolean).map((line, fallbackIndex) => {
        const [indexValue, uuid, name, utilizationGpuPercent, totalMiB, usedMiB, temperatureCelsius, powerDrawWatts, driver] = line.split(",").map((value) => value.trim());
        const memoryTotal = finiteNumber(totalMiB);
        const memoryUsed = finiteNumber(usedMiB);
        return {
          index: finiteNumber(indexValue) ?? fallbackIndex,
          uuid,
          name,
          utilization_gpu_percent: Number(utilizationGpuPercent),
          memory_total_mib: memoryTotal,
          memory_used_mib: memoryUsed,
          memory_free_mib: memoryTotal !== null && memoryUsed !== null ? Math.max(0, memoryTotal - memoryUsed) : null,
          temperature_celsius: finiteNumber(temperatureCelsius),
          power_draw_watts: finiteNumber(powerDrawWatts),
          driver_version: driver
        };
      })
    };
  }

  const procGpus = await readNvidiaProcGpus();
  if (procGpus.length) return { available: true, source: "/proc/driver/nvidia/gpus", devices: procGpus };

  return {
    available: false,
    source: "unavailable",
    detail: smi.stderr || "nvidia-smi is not available to the AMUIN AI STACK API process."
  };
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function inspectTemperatures(): Promise<Array<{ label: string; celsius: number; source: string }>> {
  const sensors: Array<{ label: string; celsius: number; source: string }> = [];
  const seen = new Set<string>();
  const add = (label: string, raw: string, source: string) => {
    const value = Number(raw.trim());
    if (!Number.isFinite(value)) return;
    const celsius = Math.abs(value) > 300 ? value / 1000 : value;
    if (celsius < -30 || celsius > 180) return;
    const normalizedLabel = label.trim() || source;
    const key = normalizedLabel.toLowerCase() + ":" + Math.round(celsius * 10);
    if (seen.has(key)) return;
    seen.add(key);
    sensors.push({ label: normalizedLabel, celsius: Math.round(celsius * 10) / 10, source });
  };

  for (const root of ["/sys/class/thermal", "/host/sys/class/thermal"]) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((item) => item.isDirectory() && item.name.startsWith("thermal_zone"))) {
      const base = root + "/" + entry.name;
      const [label, temp] = await Promise.all([
        readFile(base + "/type", "utf8").catch(() => entry.name),
        readFile(base + "/temp", "utf8").catch(() => "")
      ]);
      if (temp) add(label, temp, entry.name);
    }
    if (sensors.length) break;
  }

  for (const root of ["/sys/class/hwmon", "/host/sys/class/hwmon"]) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((item) => item.isDirectory() || item.isSymbolicLink())) {
      const base = root + "/" + entry.name;
      const chip = (await readFile(base + "/name", "utf8").catch(() => entry.name)).trim();
      const files = await readdir(base).catch(() => [] as string[]);
      for (const file of files.filter((name) => /^temp\d+_input$/.test(name))) {
        const index = file.match(/^temp(\d+)_input$/)?.[1] ?? "";
        const [label, temp] = await Promise.all([
          readFile(base + "/temp" + index + "_label", "utf8").catch(() => chip + (index ? " " + index : "")),
          readFile(base + "/" + file, "utf8").catch(() => "")
        ]);
        if (temp) add(label, temp, chip);
      }
    }
    if (sensors.length) break;
  }
  return sensors.slice(0, 12);
}

export function parsePublishedPorts(value: string): Array<{ public_port: number; internal_port: number; protocol: string }> {
  const ports = new Map<string, { public_port: number; internal_port: number; protocol: string }>();
  for (const match of value.matchAll(/(?:^|,\s*)(?:[^,\s]+:)?(\d+)->(\d+)\/(tcp|udp)/g)) {
    const item = { public_port: Number(match[1]), internal_port: Number(match[2]), protocol: match[3] };
    ports.set(item.public_port + ":" + item.internal_port + ":" + item.protocol, item);
  }
  return [...ports.values()];
}

function customContainerLabel(name: string): string {
  if (/custom_funasr_gateway/i.test(name)) return "FunASR Gateway";
  if (/custom_vibevoice_hf/i.test(name)) return "VibeVoice HF";
  return name.replace(/^custom[_-]+/, "").replace(/[_-]+service$/i, "").replace(/[_-]+/g, " ");
}

function customComposeProfileId(fileName: string): string {
  return basename(fileName).replace(/^docker-compose\./, "").replace(/\.ya?ml$/, "");
}

function composeValue(yaml: string, key: string): string {
  const line = yaml.split("\n").find((item) => item.trim().startsWith(key + ":")) ?? "";
  let value = line.split(key + ":").slice(1).join(key + ":").split("#")[0].trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value;
}

function parseComposePublishedPorts(yaml: string): Array<{ public_port: number; internal_port: number; protocol: string }> {
  const ports = new Map<string, { public_port: number; internal_port: number; protocol: string }>();
  for (const match of yaml.matchAll(/\$\{[A-Z0-9_]*PUBLIC_PORT:-([0-9]{2,5})\}:([0-9]{2,5})(?:\/(tcp|udp))?/g)) {
    const item = { public_port: Number(match[1]), internal_port: Number(match[2]), protocol: match[3] || "tcp" };
    ports.set(item.public_port + ":" + item.internal_port + ":" + item.protocol, item);
  }
  for (const match of yaml.matchAll(/(?:^|[\s\"':])([0-9]{2,5}):([0-9]{2,5})(?:\/(tcp|udp))?/g)) {
    const publicPort = Number(match[1]);
    const internalPort = Number(match[2]);
    if (!Number.isInteger(publicPort) || !Number.isInteger(internalPort)) continue;
    const item = { public_port: publicPort, internal_port: internalPort, protocol: match[3] || "tcp" };
    ports.set(item.public_port + ":" + item.internal_port + ":" + item.protocol, item);
  }
  return [...ports.values()];
}

function normalizeDockerState(value: string): string {
  const state = value.trim().toLowerCase();
  if (state === "running") return "running";
  if (["created", "dead", "exited", "removing"].includes(state)) return "stopped";
  return state || "unknown";
}

async function inspectCustomComposeProfilePorts(): Promise<Array<{
  key: string; label: string; container_name: string; state: string; public_port: number; internal_port: number; protocol: string;
}>> {
  const profilesDir = join(process.env.AI_STACK_BASE ?? process.cwd(), "deploy", "compose", "custom");
  const entries = await readdir(profilesDir, { withFileTypes: true }).catch(() => []);
  const rows: Array<{ key: string; label: string; container_name: string; state: string; public_port: number; internal_port: number; protocol: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^docker-compose\..+\.ya?ml$/.test(entry.name)) continue;
    const id = customComposeProfileId(entry.name);
    const yaml = await readFile(join(profilesDir, entry.name), "utf8").catch(() => "");
    const containerName = composeValue(yaml, "container_name") || "custom_" + id.replace(/-/g, "_") + "_service";
    for (const port of parseComposePublishedPorts(yaml)) {
      rows.push({
        key: "custom-profile:" + id + ":" + port.public_port,
        label: customContainerLabel(containerName),
        container_name: containerName,
        state: "missing",
        ...port
      });
    }
  }
  return rows;
}

async function inspectDockerCustomContainers(): Promise<Array<{
  container_name: string; state: string; ports: Array<{ public_port: number; internal_port: number; protocol: string }>;
}>> {
  const result = await runCommand("docker", ["ps", "-a", "--filter", "name=custom_", "--format", "{{.Names}}\t{{.State}}\t{{.Ports}}"], 5000);
  if (!result.ok) return [];
  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const [name, state = "unknown", ports = ""] = line.split("\t");
    return { container_name: name, state: normalizeDockerState(state), ports: parsePublishedPorts(ports) };
  });
}

async function inspectCustomContainerPorts(): Promise<Array<{
  key: string; label: string; container_name: string; state: string; public_port: number; internal_port: number; protocol: string;
}>> {
  const rows = new Map<string, { key: string; label: string; container_name: string; state: string; public_port: number; internal_port: number; protocol: string }>();
  for (const item of await inspectCustomComposeProfilePorts()) {
    rows.set(item.container_name + ":" + item.public_port + ":" + item.protocol, item);
  }
  for (const container of await inspectDockerCustomContainers()) {
    const matchedKeys = [...rows.keys()].filter((key) => key.startsWith(container.container_name + ":"));
    for (const key of matchedKeys) {
      const item = rows.get(key);
      if (item) rows.set(key, { ...item, state: container.state });
    }
    for (const port of container.ports) {
      const key = container.container_name + ":" + port.public_port + ":" + port.protocol;
      if (rows.has(key)) continue;
      rows.set(key, {
        key: "custom:" + container.container_name + ":" + port.public_port,
        label: customContainerLabel(container.container_name),
        container_name: container.container_name,
        state: container.state,
        ...port
      });
    }
  }
  return [...rows.values()];
}

async function readNvidiaProcGpus(): Promise<Array<Record<string, unknown>>> {
  try {
    const roots = ["/proc/driver/nvidia/gpus", "/host/proc/driver/nvidia/gpus"];
    for (const root of roots) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      if (!entries.length) continue;
      const devices: Array<Record<string, unknown>> = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const info = await readFile(root + "/" + entry.name + "/information", "utf8").catch(() => "");
        const model = info.split("\n").find((line) => line.toLowerCase().startsWith("model:"))?.split(":").slice(1).join(":").trim();
        devices.push({ id: entry.name, name: model || "NVIDIA GPU" });
      }
      return devices;
    }
  } catch {
    return [];
  }
  return [];
}

async function dockerStatus(): Promise<Record<string, unknown>> {
  const [psResult, verResult, composeResult] = await Promise.all([
    runCommand("docker", ["ps", "--format", "{{.Names}}\t{{.Status}}"], 5000),
    runCommand("docker", ["--version"], 3000),
    runCommand("docker", ["compose", "version"], 3000)
  ]);
  if (!psResult.ok) return { ok: false, detail: psResult.stderr || "Docker CLI is unavailable or cannot access the Docker socket." };
  const containers = psResult.stdout.split("\n").filter(Boolean).map((line) => {
    const [name, status] = line.split("\t");
    return { name, status };
  });
  const dockerVersion = verResult.ok ? (verResult.stdout || "").replace("Docker version ", "").split(",")[0].trim() : "unknown";
  const composeVersion = composeResult.ok ? (composeResult.stdout || "").replace("Docker Compose version ", "").trim() : "not installed";
  return {
    ok: true,
    detail: "Docker is reachable from the AMUIN AI STACK API process.",
    version: dockerVersion,
    compose_version: composeVersion,
    container_count: containers.length,
    containers
  };
}

async function nvidiaStatus(): Promise<Record<string, unknown>> {
  const result = await runCommand("nvidia-smi", ["--query-gpu=name,driver_version", "--format=csv,noheader"], 5000);
  if (!result.ok) return { ok: false, detail: result.stderr || "nvidia-smi is unavailable in the API container." };
  return { ok: true, detail: result.stdout };
}

async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "0.0.0.0");
  });
}

async function parseOsRelease(): Promise<Record<string, string>> {
  const text = await readFirst(["/host/etc/os-release", "/etc/os-release"], false);
  const out: Record<string, string> = {};
  for (const line of (text ?? "").split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return out;
}

async function readFirst(paths: string[], trim = true): Promise<string | undefined> {
  for (const path of paths) {
    try {
      const value = await readFile(path, "utf8");
      const cleaned = trim ? value.trim() : value;
      if (cleaned) return cleaned;
    } catch {
      // Try the next source.
    }
  }
  return undefined;
}
