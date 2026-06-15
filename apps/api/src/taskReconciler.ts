import { readFile } from "node:fs/promises";
import { enrichTaskProgress } from "./taskProgress.js";
import { runCommand } from "./utils.js";
import type { StateStore } from "./state.js";
import type { TaskRecord } from "./types.js";

export async function reconcileTask(
  task: Awaited<ReturnType<StateStore["getTask"]>>,
  store: StateStore,
  workspaceRoot: string
) {
  if (!task) return task;
  const enriched = await enrichTaskProgress(task, workspaceRoot);
  if (task.type === "download" && enriched.complete_on_disk && task.status !== "succeeded") {
    const updated = await store.updateTask(task.id, {
      status: "succeeded",
      finished_at: new Date().toISOString(),
      error: undefined
    });
    return updated
      ? await enrichTaskProgress(updated, workspaceRoot)
      : { ...enriched, status: "succeeded" };
  }
  if (task.status === "running" && !(await isTaskProcessActive(task))) {
    const updated = await store.updateTask(task.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error:
        "Task process was interrupted or the management service restarted before completion."
    });
    return updated
      ? await enrichTaskProgress(updated, workspaceRoot)
      : {
          ...enriched,
          status: "failed",
          error:
            "Task process was interrupted or the management service restarted before completion."
        };
  }
  if (task.status === "succeeded" && task.log_path) {
    const logErrors = await scanLogForErrors(task.log_path);
    if (logErrors) {
      const updated = await store.updateTask(task.id, {
        status: "failed",
        error: logErrors,
        finished_at: task.finished_at ?? new Date().toISOString()
      });
      return updated
        ? await enrichTaskProgress(updated, workspaceRoot)
        : { ...enriched, status: "failed", error: logErrors };
    }
  }
  return enriched;
}

async function scanLogForErrors(logPath: string): Promise<string | null> {
  try {
    const content = await readFile(logPath, "utf-8");
    const errorLines: string[] = [];
    for (const line of content.split("\n")) {
      if (
        /\b(ERROR|FATAL|Error:|error:|Traceback|exception|failed|Failed)\b/.test(
          line
        ) &&
        !/\b(exit 0|succeeded|download completed|Download finished|100%|model ready)\b/i.test(
          line
        )
      ) {
        errorLines.push(line.trim());
      }
    }
    if (errorLines.length > 0) {
      return (
        "Log contains error indicators: " +
        errorLines.slice(0, 3).join(" | ") +
        (errorLines.length > 3 ? " ..." : "")
      );
    }
  } catch {
    /* log file not readable */
  }
  return null;
}

async function isTaskProcessActive(task: {
  command: string;
  metadata: Record<string, unknown>;
  type: string;
}): Promise<boolean> {
  const result = await runCommand("ps", ["-eo", "args="], 3000);
  if (!result.ok || !result.stdout) return true;
  const haystack = result.stdout;
  const tokens = [
    task.command,
    String(task.metadata?.repo_id ?? ""),
    String(task.metadata?.alias ?? ""),
    String(task.metadata?.model_id ?? ""),
    String(task.metadata?.name ?? "")
  ].filter((token) => token.length > 4);
  return tokens.some((token) => haystack.includes(token));
}
