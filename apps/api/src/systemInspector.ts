import { cpus, freemem, hostname, loadavg, networkInterfaces, platform, release, totalmem, uptime } from "node:os";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { runCommand } from "./utils.js";

export const servicePorts = {
  vllm: Number(process.env.VLLM_PUBLIC_PORT ?? "30000"),
  trtllm: Number(process.env.TRTLLM_PUBLIC_PORT ?? "31000"),
  pytorch: Number(process.env.PYTORCH_PUBLIC_PORT ?? process.env.AUDIO_PUBLIC_PORT ?? "32000")
};

export async function systemCheck(): Promise<Record<string, unknown>> {
  const ports: Record<string, unknown> = {};
  for (const [name, port] of Object.entries(servicePorts)) {
    ports[name] = {
      port,
      in_allowed_range: port >= 30000 && port <= 60000,
      available: await portAvailable(port)
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
    gpu: await inspectGpu()
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
  const smi = await runCommand("nvidia-smi", ["--query-gpu=name,memory.total,memory.used,driver_version", "--format=csv,noheader,nounits"], 5000);
  if (smi.ok && smi.stdout) {
    return {
      available: true,
      source: "nvidia-smi",
      devices: smi.stdout.split("\n").filter(Boolean).map((line, index) => {
        const [name, totalMiB, usedMiB, driver] = line.split(",").map((value) => value.trim());
        return { index, name, memory_total_mib: Number(totalMiB), memory_used_mib: Number(usedMiB), driver_version: driver };
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
