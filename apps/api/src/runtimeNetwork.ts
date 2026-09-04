/** Saved network settings take precedence over inherited environment variables. */
export interface RuntimeNetworkSettings {
  lan_access_enabled: boolean;
}

export function runtimeBindAddress(
  settings?: RuntimeNetworkSettings,
  env: NodeJS.ProcessEnv = process.env
): "0.0.0.0" | "127.0.0.1" {
  if (typeof settings?.lan_access_enabled === "boolean") {
    return settings.lan_access_enabled ? "0.0.0.0" : "127.0.0.1";
  }
  const configured = env.AI_STACK_BIND_ADDR || env.BIND_ADDR;
  if (configured === "127.0.0.1" || configured === "0.0.0.0") return configured;
  if (configured) throw new Error("AI_STACK_BIND_ADDR must be 0.0.0.0 or 127.0.0.1.");
  return env.LAN_ACCESS_ENABLED === "0" ? "127.0.0.1" : "0.0.0.0";
}

export function runtimeNetworkEnv(settings?: RuntimeNetworkSettings): Record<string, string> {
  const address = runtimeBindAddress(settings);
  // Export the legacy alias for imported templates as well.
  return { AI_STACK_BIND_ADDR: address, BIND_ADDR: address };
}

export function canReusePublishedService(stateJson: string, publicPort: number, address: string): boolean {
  try {
    const state = JSON.parse(stateJson);
    const bindings = state.ports?.["8000/tcp"];
    return state.running === true && Array.isArray(bindings) && bindings.length === 1
      && bindings[0].HostIp === address && bindings[0].HostPort === String(publicPort);
  } catch {
    return false;
  }
}
