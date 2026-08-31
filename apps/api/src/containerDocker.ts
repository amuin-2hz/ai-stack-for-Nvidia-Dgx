import { runCommand, shellQuote } from "./utils.js";
import type { ContainerRecord } from "./containerPresets.js";

/* ── Docker container listing ──────────────────── */
export async function dockerContainers(): Promise<Array<{ name: string; image: string; status: string; state: ContainerRecord["state"]; ports: string }>> {
  const result = await runCommand("docker", ["ps", "-a", "--format", "{{json .}}"], 8000);
  if (!result.ok || !result.stdout) return [];
  return result.stdout.split("\n").filter(Boolean).flatMap((line: string) => {
    try {
      const row = JSON.parse(line) as Record<string, string>;
      const state: ContainerRecord["state"] =
        row.State === "running" ? "running" :
        row.State === "exited" ? "stopped" : "unknown";
      return [{ name: row.Names ?? "", image: row.Image ?? "", status: row.Status ?? row.State ?? "unknown", state, ports: row.Ports ?? "" }];
    } catch { return []; }
  }).filter((row) => row.name);
}

export type DockerCleanupInspect = {
  Id?: string;
  Name?: string;
  Config?: { Labels?: Record<string, string> | null };
  State?: { Status?: string; Running?: boolean; ExitCode?: number };
  SizeRw?: number;
};

export function isManagedFailedContainer(row: DockerCleanupInspect, workspaceRoot: string): boolean {
  const name = String(row.Name ?? "").replace(/^\//, "");
  const labels = row.Config?.Labels ?? {};
  const status = String(row.State?.Status ?? "").toLowerCase();
  const exitCode = Number(row.State?.ExitCode ?? 0);
  const failed = status === "dead" || (status === "exited" && exitCode !== 0);
  const finishedTask = status === "exited" && name.startsWith("ai-stack-task_");
  const composeRoot = String(labels["com.docker.compose.project.working_dir"] ?? "");
  const composeFiles = String(labels["com.docker.compose.project.config_files"] ?? "");
  const managed = Boolean(labels["amuin.role"])
    || name.startsWith("ai-stack-task_")
    || composeRoot === workspaceRoot
    || composeFiles.split(",").some((file) => file.startsWith(workspaceRoot + "/"));
  return managed && (failed || finishedTask) && row.State?.Running !== true;
}

export type FailedContainerCleanupResult = {
  ok: boolean;
  scanned: number;
  eligible: number;
  removed_count: number;
  reclaimed_bytes: number;
  removed: Array<{ id: string; name: string; exit_code: number; size_rw_bytes: number }>;
  failures: Array<{ id: string; name: string; detail: string }>;
};

export async function cleanupFailedManagedContainers(workspaceRoot: string): Promise<FailedContainerCleanupResult> {
  const listed = await runCommand("docker", ["ps", "-aq"], 8000);
  if (!listed.ok) throw new Error("Unable to list Docker containers: " + (listed.stderr || listed.stdout));
  const ids = listed.stdout.split("\n").map((id) => id.trim()).filter(Boolean);
  if (!ids.length) return { ok: true, scanned: 0, eligible: 0, removed_count: 0, reclaimed_bytes: 0, removed: [], failures: [] };

  const inspected = await runCommand(
    "docker",
    ["inspect", "--size", ...ids],
    15_000
  );
  if (!inspected.ok) throw new Error("Unable to inspect Docker containers: " + (inspected.stderr || inspected.stdout));

  let rows: DockerCleanupInspect[];
  try {
    rows = JSON.parse(inspected.stdout) as DockerCleanupInspect[];
  } catch {
    throw new Error("Docker returned invalid container inspection data.");
  }
  const candidates = rows.filter((row) => isManagedFailedContainer(row, workspaceRoot));
  const removed: FailedContainerCleanupResult["removed"] = [];
  const failures: FailedContainerCleanupResult["failures"] = [];
  let reclaimedBytes = 0;

  for (const row of candidates) {
    const id = String(row.Id ?? "");
    const name = String(row.Name ?? id).replace(/^\//, "");
    if (!id) continue;
    const result = await runCommand("docker", ["rm", id], 10_000);
    if (result.ok) {
      reclaimedBytes += Math.max(0, Number(row.SizeRw ?? 0));
      removed.push({ id, name, exit_code: Number(row.State?.ExitCode ?? 0), size_rw_bytes: Math.max(0, Number(row.SizeRw ?? 0)) });
    } else {
      failures.push({ id, name, detail: result.stderr || result.stdout || "docker rm failed" });
    }
  }

  return {
    ok: failures.length === 0,
    scanned: rows.length,
    eligible: candidates.length,
    removed_count: removed.length,
    reclaimed_bytes: reclaimedBytes,
    removed,
    failures
  };
}

/* ── Image helpers ─────────────────────────────── */
export async function imageExists(image: string): Promise<boolean> {
  if (!image) return false;
  const result = await runCommand("docker", ["image", "inspect", image], 5000);
  return result.ok;
}

export function testCommandFor(key: string, image: string): string {
  if (key === "vllm")
    return "docker run --rm --gpus all --entrypoint vllm " + shellQuote(image) + " --version";
  if (key === "trtllm")
    return "docker run --rm --entrypoint python " + shellQuote(image) + " -c " + shellQuote("import tensorrt_llm; print(\"tensorrt_llm=\" + getattr(tensorrt_llm, \"__version__\", \"unknown\"))");
  if (key === "pytorch")
    return "docker run --rm " + shellQuote(image) + " python3 -c " + shellQuote("import torch; print(\"torch=\" + torch.__version__)");
  return "docker image inspect " + shellQuote(image);
}

/* ── Container actions ─────────────────────────── */
export async function dockerContainerLogs(name: string, lines = 200): Promise<{ name: string; logs: string }> {
  const result = await runCommand("docker", ["logs", "--tail", String(lines), name], 8000);
  return { name, logs: result.stdout || result.stderr || "" };
}

export async function dockerContainerAction(name: string, action: "start" | "stop" | "restart"): Promise<{ name: string; action: string; ok: boolean; detail: string }> {
  if (["vllm-service", "trtllm-service"].includes(name)) {
    const exists = (await dockerContainers()).some((row) => row.name === name);
    if (!exists) {
      return {
        name, action, ok: false,
        detail: name === "vllm-service"
          ? "vLLM fixed runtime has not been created yet. Load a compatible model into the vLLM runtime first."
          : "TensorRT-LLM fixed runtime has not been created yet. Load a compatible model/profile into the TensorRT-LLM runtime first."
      };
    }
  }
  const result = await runCommand("docker", [action, name], 15000);
  return { name, action, ok: result.ok, detail: result.stdout || result.stderr };
}

export async function dockerDeleteContainer(key: string, presetImage: string, presetNames: string[]): Promise<{ key: string; ok: boolean; steps: string[] }> {
  const steps: string[] = [];
  let allOk = true;

  for (const name of presetNames) {
    const existing = await dockerContainers();
    const match = existing.find((c) => c.name === name);
    if (match) {
      if (match.state === "running") {
        const stop = await runCommand("docker", ["stop", name], 15000);
        steps.push(`stop ${name}: ${stop.ok ? "ok" : stop.stderr}`);
        if (!stop.ok) allOk = false;
      }
      const rm = await runCommand("docker", ["rm", name], 10000);
      steps.push(`rm ${name}: ${rm.ok ? "ok" : rm.stderr}`);
      if (!rm.ok) allOk = false;
    } else {
      steps.push(`container ${name}: not found (skip)`);
    }
  }

  if (presetImage && await imageExists(presetImage)) {
    const rmi = await runCommand("docker", ["rmi", presetImage], 30000);
    steps.push(`rmi ${presetImage}: ${rmi.ok ? "ok" : rmi.stderr}`);
    if (!rmi.ok) allOk = false;
  } else {
    steps.push(`image ${presetImage}: not found (skip)`);
  }

  const volumePrune = await runCommand("docker", ["volume", "prune", "-f", "--filter", "label=com.docker.compose.project=chatbot-net"], 15000);
  steps.push(`volume prune: ${volumePrune.ok ? "ok" : volumePrune.stderr}`);

  return { key, ok: allOk, steps };
}
