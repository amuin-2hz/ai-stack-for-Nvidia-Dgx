#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Raw docker compose cannot read the application's persisted network settings.
// This entry point does, and fails closed when the API cannot be reached.
export async function resolveComposeNetworkEnv(env = process.env, fetcher = fetch) {
  const explicit = env.AI_STACK_BIND_ADDR || env.BIND_ADDR;
  if (explicit) {
    if (!["0.0.0.0", "127.0.0.1"].includes(explicit)) {
      throw new Error("AI_STACK_BIND_ADDR must be 0.0.0.0 or 127.0.0.1.");
    }
    return { AI_STACK_BIND_ADDR: explicit, BIND_ADDR: explicit };
  }
  const base = env.AI_STACK_API_URL || "http://127.0.0.1:8000";
  let settings;
  try {
    const response = await fetcher(base.replace(/\/$/, "") + "/settings/network", {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error("Network settings HTTP " + response.status);
    settings = await response.json();
    if (typeof settings?.lan_access_enabled !== "boolean") throw new Error("Invalid network settings.");
  } catch (error) {
    throw new Error("Cannot read AI Stack network settings. Start the API or explicitly set AI_STACK_BIND_ADDR=127.0.0.1 (local) / 0.0.0.0 (LAN).", { cause: error });
  }
  const address = settings.lan_access_enabled ? "0.0.0.0" : "127.0.0.1";
  return { AI_STACK_BIND_ADDR: address, BIND_ADDR: address };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) throw new Error("Usage: node scripts/runtime-compose.mjs -f <compose.yml> <compose arguments>");
  const networkEnv = await resolveComposeNetworkEnv();
  const result = spawnSync("docker", ["compose", ...args], {
    stdio: "inherit", env: { ...process.env, ...networkEnv }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
