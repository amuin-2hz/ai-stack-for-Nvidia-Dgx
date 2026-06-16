import { getDb } from "./db.js";
import type { ActiveDeploymentRecord, ChatMessage, ChatRecord, ContainerSettings, TaskRecord } from "./types.js";

const now = () => new Date().toISOString();

// ── Tasks ──
export function createTask(task: TaskRecord): TaskRecord {
  const db = getDb();
  db.prepare(`INSERT INTO tasks (id, type, status, metadata, log_path, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(task.id, task.type, task.status, JSON.stringify(task.metadata ?? {}), task.log_path ?? null, task.created_at, task.updated_at);
  return task;
}

export function updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord | undefined {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
  if (!existing) return undefined;
  const merged = { ...existing, ...patch, updated_at: now() };
  db.prepare(`UPDATE tasks SET type=?, status=?, metadata=?, log_path=?, error=?, updated_at=? WHERE id=?`)
    .run(merged.type, merged.status, merged.metadata, merged.log_path ?? null, merged.error ?? null, merged.updated_at, taskId);
  return taskRowToRecord(merged);
}

export function getTask(taskId: string): TaskRecord | undefined {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
  return row ? taskRowToRecord(row) : undefined;
}

export function listTasks(): TaskRecord[] {
  return (getDb().prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as any[]).map(taskRowToRecord);
}

function taskRowToRecord(r: any): TaskRecord {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    command: "",
    cwd: "",
    log_path: r.log_path ?? "",
    metadata: JSON.parse(r.metadata ?? "{}"),
    error: r.error ?? undefined,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ── Deployments ──
export function upsertDeployment(d: ActiveDeploymentRecord): ActiveDeploymentRecord {
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO deployments (deployment_id, model_id, service_type, openai_model, container_name, status, config, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(d.deployment_id, d.model_id, d.service_type, d.openai_model, d.container_name ?? null, d.status, JSON.stringify((d as any).config ?? {}), d.updated_at, d.updated_at);
  return d;
}

export function listActiveDeployments(): ActiveDeploymentRecord[] {
  return (getDb().prepare("SELECT * FROM deployments ORDER BY service_type").all() as any[]).map(deploymentRowToRecord);
}

export function getActiveDeployment(id: string): ActiveDeploymentRecord | undefined {
  const row = getDb().prepare("SELECT * FROM deployments WHERE deployment_id = ?").get(id) as any;
  return row ? deploymentRowToRecord(row) : undefined;
}

export function deleteDeployment(id: string): void {
  getDb().prepare("DELETE FROM deployments WHERE deployment_id = ?").run(id);
}

function deploymentRowToRecord(r: any): ActiveDeploymentRecord {
  const config = JSON.parse(r.config ?? "{}");
  return {
    deployment_id: r.deployment_id,
    model_id: r.model_id,
    service_type: r.service_type,
    runtime: config.runtime ?? r.service_type,
    container_name: r.container_name ?? "",
    public_port: config.public_port ?? 30000,
    base_url: config.base_url ?? "",
    health_url: config.health_url ?? "",
    worker_endpoint: r.container_name ? `http://127.0.0.1:${config.public_port ?? 30000}/v1` : "",
    openai_model: r.openai_model,
    status: r.status,
    updated_at: r.updated_at,
  };
}

// ── Chats ──
export function listChats(): string[] {
  return (getDb().prepare("SELECT id FROM chats ORDER BY updated_at DESC").all() as any[]).map((r: any) => r.id);
}

export function getChat(chatId: string): ChatRecord | undefined {
  const chat = getDb().prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as any;
  if (!chat) return undefined;
  const messages = getDb().prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY id").all(chatId) as any[];
  return {
    id: chat.id,
    name: chat.name,
    messages: messages.map((m: any) => ({
      type: m.type,
      content: m.content,
      metadata: JSON.parse(m.metadata ?? "{}"),
    })) as ChatMessage[],
    created_at: chat.created_at,
    updated_at: chat.updated_at,
  };
}

export function getCurrentChatId(): string | undefined {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'current_chat_id'").get() as any;
  return row ? JSON.parse(row.value) : undefined;
}

export function setCurrentChatId(chatId: string): void {
  const db = getDb();
  if (!db.prepare("SELECT id FROM chats WHERE id = ?").get(chatId)) {
    const ts = now();
    db.prepare("INSERT INTO chats (id, name, created_at, updated_at) VALUES (?,?,?,?)").run(chatId, "New Chat", ts, ts);
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('current_chat_id', ?, ?)").run(JSON.stringify(chatId), now());
}

export function createChat(name = "New Chat"): ChatRecord {
  const id = "chat_" + Math.random().toString(36).slice(2, 10);
  const ts = now();
  const db = getDb();
  db.prepare("INSERT INTO chats (id, name, created_at, updated_at) VALUES (?,?,?,?)").run(id, name, ts, ts);
  return { id, name, messages: [], created_at: ts, updated_at: ts };
}

export function renameChat(chatId: string, name: string): void {
  getDb().prepare("UPDATE chats SET name=?, updated_at=? WHERE id=?").run(name, now(), chatId);
}

export function deleteChat(chatId: string): void {
  getDb().prepare("DELETE FROM chats WHERE id = ?").run(chatId);
}

export function clearChats(): { cleared: number; newChatId: string } {
  const db = getDb();
  const count = (db.prepare("SELECT COUNT(*) as c FROM chats").get() as any).c as number;
  db.exec("DELETE FROM messages; DELETE FROM chats;");
  const chat = createChat();
  return { cleared: count, newChatId: chat.id };
}

export function appendMessage(chatId: string, message: ChatMessage): void {
  const db = getDb();
  const metadata = (message as any).metadata;
  db.prepare("INSERT INTO messages (chat_id, type, content, metadata, created_at) VALUES (?,?,?,?,?)")
    .run(chatId, message.type, message.content, JSON.stringify(metadata ?? {}), now());
  const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as any;
  let name = chat?.name ?? "New Chat";
  if (message.type === "HumanMessage" && name === "New Chat") {
    name = message.content.slice(0, 42) || "New Chat";
  }
  db.prepare("UPDATE chats SET name=?, updated_at=? WHERE id=?").run(name, now(), chatId);
}

// ── Settings ──
export function getSetting(key: string): any | undefined {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return row ? JSON.parse(row.value) : undefined;
}

export function setSetting(key: string, value: any): void {
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)")
    .run(key, JSON.stringify(value), now());
}

// ── Container Configs ──
export function getContainerConfig(key: string): ContainerSettings | undefined {
  const row = getDb().prepare("SELECT * FROM container_configs WHERE key = ?").get(key) as any;
  if (!row) return undefined;
  return {
    key: row.key,
    public_port: row.public_port,
    management_mode: row.management_mode,
    restart_policy: row.restart_policy,
    auto_restart: !!row.auto_restart,
    image: row.image ?? undefined,
    components: row.components ? JSON.parse(row.components) : undefined,
    is_default: !!row.is_default,
    updated_at: row.updated_at,
  } as ContainerSettings;
}

export function listContainerConfigs(): ContainerSettings[] {
  return (getDb().prepare("SELECT * FROM container_configs").all() as any[]).map((r: any) => ({
    key: r.key,
    public_port: r.public_port,
    management_mode: r.management_mode,
    restart_policy: r.restart_policy,
    auto_restart: !!r.auto_restart,
    image: r.image ?? undefined,
    components: r.components ? JSON.parse(r.components) : undefined,
    is_default: !!r.is_default,
    updated_at: r.updated_at,
  } as ContainerSettings));
}

export function setContainerConfig(key: string, patch: Partial<ContainerSettings>): ContainerSettings {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM container_configs WHERE key = ?").get(key) as any;
  if (!existing) throw new Error(`Unknown container: ${key}`);
  const merged = { ...existing, ...patch, updated_at: now() };
  db.prepare(`UPDATE container_configs SET public_port=?, management_mode=?, restart_policy=?, auto_restart=?, image=?, components=?, updated_at=? WHERE key=?`)
    .run(merged.public_port, merged.management_mode ?? "resident", merged.restart_policy ?? "no", merged.auto_restart ? 1 : 0, merged.image ?? null, merged.components ? JSON.stringify(merged.components) : null, merged.updated_at, key);
  return {
    key: merged.key,
    public_port: merged.public_port,
    management_mode: merged.management_mode,
    restart_policy: merged.restart_policy,
    auto_restart: !!merged.auto_restart,
    image: merged.image ?? undefined,
    components: merged.components ? JSON.parse(merged.components as string) : undefined,
    is_default: !!merged.is_default,
    updated_at: merged.updated_at,
  } as ContainerSettings;
}

// ── Workbench / Network Settings (shortcuts for settings table) ──
export function getWorkbenchSettings(): any {
  return getSetting("workbench") ?? {
    management_port: 8888,
    active_management_port: Number(process.env.FRONTEND_PORT ?? "8888"),
    requires_restart: false,
    updated_at: now(),
  };
}

export function setManagementPort(port: number): any {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("management_port must be between 1024 and 65535");
  const active = Number(process.env.FRONTEND_PORT ?? "8888");
  const settings = { management_port: port, active_management_port: active, requires_restart: active !== port, updated_at: now() };
  setSetting("workbench", settings);
  return settings;
}

export function getNetworkSettings(): any {
  return getSetting("network") ?? {
    lan_access_enabled: process.env.LAN_ACCESS_ENABLED !== "0",
    desired_bind_address: process.env.AI_STACK_BIND_ADDR ?? "0.0.0.0",
    active_bind_address: process.env.AI_STACK_BIND_ADDR ?? "0.0.0.0",
    requires_restart: false,
    updated_at: now(),
  };
}

export function setNetworkAccess(lanAccessEnabled: boolean): any {
  const desired = lanAccessEnabled ? "0.0.0.0" : "127.0.0.1";
  const settings = {
    lan_access_enabled: lanAccessEnabled,
    desired_bind_address: desired,
    active_bind_address: process.env.AI_STACK_BIND_ADDR ?? "0.0.0.0",
    requires_restart: (process.env.AI_STACK_BIND_ADDR ?? "0.0.0.0") !== desired,
    updated_at: now(),
  };
  setSetting("network", settings);
  return settings;
}

// ── Ingest tasks ──
export function setIngestTask(taskId: string, status: string): void {
  setSetting(`ingest_${taskId}`, status);
}

export function ingestStatus(taskId: string): string | undefined {
  return getSetting(`ingest_${taskId}`) as string | undefined;
}

// ── Selected sources / model ──
export function getSelectedSources(): string[] {
  return getSetting("selected_sources") as string[] ?? [];
}

export function setSelectedSources(sources: string[]): void {
  setSetting("selected_sources", sources);
}

export function getSelectedModel(): string {
  return getSetting("selected_model") as string ?? process.env.DEFAULT_MODEL ?? "qwen3-8b";
}

export function setSelectedModel(model: string): void {
  setSetting("selected_model", model);
}
