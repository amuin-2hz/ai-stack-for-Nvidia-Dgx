import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { updateTask } from "./store.js";
import type { TaskRecord } from "./types.js";

export interface ManagedCommand {
  taskId: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  logPath: string;
  onSuccess?: () => Promise<void>;
}

export async function runManagedCommand(command: ManagedCommand): Promise<void> {
  await mkdir(dirname(command.logPath), { recursive: true });
  const log = createWriteStream(command.logPath, { flags: "a" });
  const startedAt = new Date().toISOString();
  log.write("[" + startedAt + "] $ " + [command.command, ...command.args].join(" ") + "\n");
  await updateTask(command.taskId, { status: "running", started_at: startedAt, updated_at: startedAt });

  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: { ...process.env, ...(command.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => log.write(chunk));
  child.stderr.on("data", (chunk) => log.write(chunk));

  let closed = false;
  child.on("error", async (error) => {
    if (closed) return;
    const finishedAt = new Date().toISOString();
    log.write("\n[" + finishedAt + "] ERROR " + error.message + "\n");
    log.end();
    await updateTask(command.taskId, { status: "failed", error: error.message, finished_at: finishedAt, updated_at: finishedAt });
    closed = true;
  });

  child.on("close", async (code) => {
    if (closed) return;
    const finishedAt = new Date().toISOString();
    const ok = code === 0;
    log.write("\n[" + finishedAt + "] exit " + code + "\n");
    log.end();
    await updateTask(command.taskId, { status: ok ? "succeeded" : "failed", exit_code: code ?? null, finished_at: finishedAt, updated_at: finishedAt, error: ok ? undefined : "Command exited with code " + code });
    if (ok && command.onSuccess) await command.onSuccess();
    closed = true;
  });
}

export function createTask(type: TaskRecord["type"], command: string, cwd: string, logPath: string, metadata: Record<string, unknown> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: "task_" + randomUUID(),
    type,
    status: "queued",
    command,
    cwd,
    log_path: logPath,
    metadata,
    created_at: now,
    updated_at: now
  };
}
