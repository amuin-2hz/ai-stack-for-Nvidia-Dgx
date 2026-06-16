# AMUIN AI STACK Electron 桌面应用 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 AMUIN AI STACK 改造为 Electron 独立窗口桌面应用，SQLite 存储，3 个标准容器模板，OpenAI API 全合规，`.deb` 打包分发。

**Architecture:** Electron 主进程内嵌 Node.js API + 加载 Vue 3 前端；推理容器通过 Docker Compose 模板独立管理；SQLite 替代 JSON 文件存储；多模型共容器加载。

**Tech Stack:** Electron 30+, Vue 3 + Vite, Node.js/TypeScript, better-sqlite3, Docker SDK, electron-builder

---

### Task 1: 清理遗留代码

**Files:**
- Delete: `services/audio/` (整个目录)
- Delete: `deploy/compose/docker-compose-models.yml`
- Delete: `deploy/compose/docker-compose.audio.yml`
- Delete: `deploy/dockerfiles/Dockerfile.llamacpp`
- Delete: `apps/api/Dockerfile`
- Delete: `apps/frontend/Dockerfile`
- Modify: `deploy/compose/docker-compose.yml` — 移除 postgres/etcd/minio/milvus 服务 + profiles

- [ ] **Step 1: 删除 services/audio/ 整个目录**

```bash
rm -rf /home/zhenz/ai-stack/services/audio
```

- [ ] **Step 2: 删除旧 Docker Compose 文件**

```bash
rm /home/zhenz/ai-stack/deploy/compose/docker-compose-models.yml
rm /home/zhenz/ai-stack/deploy/compose/docker-compose.audio.yml
```

- [ ] **Step 3: 删除旧 Dockerfiles**

```bash
rm /home/zhenz/ai-stack/deploy/dockerfiles/Dockerfile.llamacpp
```

- [ ] **Step 4: 删除 apps 下的 Dockerfiles（不再容器化管理面板）**

```bash
rm /home/zhenz/ai-stack/apps/api/Dockerfile
rm /home/zhenz/ai-stack/apps/frontend/Dockerfile
```

- [ ] **Step 5: 精简 docker-compose.yml — 移除 pg/etcd/minio/milvus 及 profile 逻辑**

用 `Read` 读取当前 `deploy/compose/docker-compose.yml`，然后用 `Edit` 替换：

移除 `api.frontend` 的 `profiles`、所有 4 个 infra 服务（postgres/etcd/minio/milvus）、`depends_on` 中的 infra 引用、`volumes: postgres_data:`、`networks:`。

精简后的 `deploy/compose/docker-compose.yml`：

```yaml
services:
  api:
    container_name: api
    build:
      context: ../../apps/api
      dockerfile: Dockerfile
    ports:
      - "${AI_STACK_BIND_ADDR:-0.0.0.0}:8000:8000"
    volumes:
      - ../../models:/models
      - ../../state:/state
      - ../../configs:/configs
      - ../../logs:/logs
      - /etc/os-release:/host/etc/os-release:ro
      - /sys/class/dmi/id:/host/sys/class/dmi/id:ro
    environment:
      - MODELS_ROOT=/models
      - STATE_ROOT=/state
      - VLLM_PUBLIC_PORT=30000
      - TRTLLM_PUBLIC_PORT=31000
      - AUDIO_PUBLIC_PORT=32000

  frontend:
    container_name: frontend
    build:
      context: ../../apps/frontend
      dockerfile: Dockerfile
    ports:
      - "${AI_STACK_BIND_ADDR:-0.0.0.0}:8888:3000"
    depends_on:
      - api
    restart: unless-stopped
```

- [ ] **Step 6: 删除 volumes/ 中的 orphan 数据**

```bash
rm -rf /home/zhenz/ai-stack/volumes/etcd
rm -rf /home/zhenz/ai-stack/volumes/minio
rm -rf /home/zhenz/ai-stack/volumes/milvus
# postgres data 保留备用（用户可能有聊天数据），标记为 deprecated
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Phase 1: 清理遗留代码 - 移除 pg/etcd/minio/milvus、edge-tts、llama.cpp、旧 compose"
```

---

### Task 2: SQLite 数据库层

**Files:**
- Create: `apps/api/src/db.ts` — SQLite 数据库封装
- Modify: `apps/api/package.json` — 添加 `better-sqlite3` 依赖
- Create: `apps/api/src/migrate.ts` — 从旧 JSON 迁移数据

- [ ] **Step 1: 安装 better-sqlite3**

```bash
cd /home/zhenz/ai-stack/apps/api && npm install better-sqlite3 && npm install -D @types/better-sqlite3
```

- [ ] **Step 2: 创建 `apps/api/src/db.ts`**

```typescript
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DATA_DIR = join(homedir(), ".local", "share", "ai-stack");
const DB_PATH = join(DATA_DIR, "data.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  return _db;
}

export function initDb(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'queued',
      metadata    TEXT,
      log_path    TEXT,
      error       TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deployments (
      deployment_id TEXT PRIMARY KEY,
      model_id      TEXT NOT NULL,
      service_type  TEXT NOT NULL,
      openai_model  TEXT NOT NULL,
      container_name TEXT,
      status        TEXT NOT NULL DEFAULT 'configured',
      config        TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chats (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      content    TEXT NOT NULL,
      metadata   TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS container_configs (
      key             TEXT PRIMARY KEY,
      public_port     INTEGER NOT NULL,
      management_mode TEXT NOT NULL DEFAULT 'resident',
      restart_policy  TEXT NOT NULL DEFAULT 'no',
      auto_restart    INTEGER NOT NULL DEFAULT 0,
      image           TEXT,
      components      TEXT,
      is_default      INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL
    );
  `);

  // Seed default containers
  const defaults = [
    { key: "vllm", port: 30000, image: "vllm/vllm-openai:latest" },
    { key: "trtllm", port: 31000, image: "nvcr.io/nvidia/tritonserver:25.04-trtllm-python-py3" },
    { key: "pytorch", port: 32000, image: "nvcr.io/nvidia/pytorch:25.04-py3" },
  ];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO container_configs (key, public_port, management_mode, restart_policy, auto_restart, image, is_default, updated_at)
     VALUES (@key, @port, 'resident', 'no', 0, @image, 1, datetime('now'))`
  );
  for (const d of defaults) {
    insert.run({ key: d.key, port: d.port, image: d.image });
  }
}

export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}
```

- [ ] **Step 3: 创建 `apps/api/src/migrate.ts`**

```typescript
import { readFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "./db.js";

export function migrateFromJson(stateRoot: string): { migrated: boolean; detail: string } {
  const jsonPath = join(stateRoot, "workbench-state.json");
  if (!existsSync(jsonPath)) return { migrated: false, detail: "No legacy state file found." };

  const raw = readFileSync(jsonPath, "utf-8");
  const state = JSON.parse(raw);
  const db = getDb();

  const insertTask = db.prepare(
    `INSERT OR REPLACE INTO tasks (id, type, status, metadata, log_path, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertDeployment = db.prepare(
    `INSERT OR REPLACE INTO deployments (deployment_id, model_id, service_type, openai_model, container_name, status, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertChat = db.prepare(
    `INSERT OR REPLACE INTO chats (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages (chat_id, type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?)`
  );
  const upsertSetting = db.prepare(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`
  );

  const migrate = db.transaction(() => {
    // tasks
    if (state.tasks) {
      for (const t of Object.values(state.tasks) as any[]) {
        insertTask.run(t.id, t.type ?? "unknown", t.status ?? "unknown",
          JSON.stringify(t.metadata ?? {}), t.log_path ?? null, t.error ?? null,
          t.created_at, t.updated_at);
      }
    }
    // deployments
    if (state.deployments) {
      for (const d of Object.values(state.deployments) as any[]) {
        insertDeployment.run(d.deployment_id, d.model_id, d.service_type,
          d.openai_model, d.container_name ?? null, d.status ?? "configured",
          JSON.stringify(d.config ?? {}), d.created_at, d.updated_at);
      }
    }
    // chats + messages
    if (state.chats) {
      for (const c of Object.values(state.chats) as any[]) {
        insertChat.run(c.id, c.name, c.created_at, c.updated_at);
        if (c.messages) {
          for (const m of c.messages) {
            insertMessage.run(c.id, m.type, m.content,
              JSON.stringify(m.metadata ?? {}), m.created_at ?? c.updated_at);
          }
        }
      }
    }
    // settings
    if (state.workbench) {
      upsertSetting.run("workbench", JSON.stringify(state.workbench), new Date().toISOString());
    }
    if (state.network) {
      upsertSetting.run("network", JSON.stringify(state.network), new Date().toISOString());
    }
    if (state.container_settings) {
      upsertSetting.run("container_settings", JSON.stringify(state.container_settings), new Date().toISOString());
    }
  });

  migrate();

  // backup old file
  renameSync(jsonPath, jsonPath + ".bak");
  return { migrated: true, detail: `Migrated to SQLite. Backup: ${jsonPath}.bak` };
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db.ts apps/api/src/migrate.ts apps/api/package.json apps/api/package-lock.json
git commit -m "Phase 2: SQLite 数据库层 - 替代 JSON StateStore"
```

---

### Task 3: TypeScript 编译配置 + 路径别名

**Files:**
- Modify: `apps/api/tsconfig.json` — 确保路径正确
- Modify: `apps/api/package.json` — 更新脚本

- [ ] **Step 1: 检查并更新 tsconfig.json**

读取 `apps/api/tsconfig.json`，确保 `outDir` 为 `dist`，开启 `esModuleInterop`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 2: 验证编译通过**

```bash
cd /home/zhenz/ai-stack/apps/api && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/tsconfig.json
git commit -m "Phase 2b: 确认 TypeScript 编译配置正确"
```

---

### Task 4: 替换 StateStore 为 SQLite 调用

**Files:**
- Modify: `apps/api/src/server.ts` — 替换 StateStore 导入和调用
- Create: `apps/api/src/store.ts` — 基于 SQLite 的状态读写函数

- [ ] **Step 1: 创建 `apps/api/src/store.ts`**

```typescript
import { getDb } from "./db.js";
import type { ActiveDeploymentRecord, ChatMessage, ChatRecord, ContainerSettings, NetworkSettings, TaskRecord, WorkbenchSettings } from "./types.js";

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
  return { id: r.id, type: r.type, status: r.status, metadata: JSON.parse(r.metadata ?? "{}"), log_path: r.log_path, error: r.error, created_at: r.created_at, updated_at: r.updated_at };
}

// ── Deployments ──
export function upsertDeployment(d: ActiveDeploymentRecord): ActiveDeploymentRecord {
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO deployments (deployment_id, model_id, service_type, openai_model, container_name, status, config, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(d.deployment_id, d.model_id, d.service_type, d.openai_model, d.container_name ?? null, d.status, JSON.stringify(d.config ?? {}), d.created_at, d.updated_at);
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
  return { deployment_id: r.deployment_id, model_id: r.model_id, service_type: r.service_type, openai_model: r.openai_model, container_name: r.container_name, status: r.status, config: JSON.parse(r.config ?? "{}"), created_at: r.created_at, updated_at: r.updated_at };
}

// ── Chats ──
export function listChats(): string[] {
  return (getDb().prepare("SELECT id FROM chats ORDER BY updated_at DESC").all() as any[]).map((r: any) => r.id);
}

export function getChat(chatId: string): ChatRecord | undefined {
  const chat = getDb().prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as any;
  if (!chat) return undefined;
  const messages = getDb().prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY id").all(chatId) as any[];
  return { id: chat.id, name: chat.name, messages: messages.map((m: any) => ({ type: m.type, content: m.content, metadata: JSON.parse(m.metadata ?? "{}") })), created_at: chat.created_at, updated_at: chat.updated_at };
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
  const count = (db.prepare("SELECT COUNT(*) as c FROM chats").get() as any).c;
  db.exec("DELETE FROM messages; DELETE FROM chats;");
  const chat = createChat();
  return { cleared: count, newChatId: chat.id };
}

export function appendMessage(chatId: string, message: ChatMessage): void {
  const db = getDb();
  db.prepare("INSERT INTO messages (chat_id, type, content, metadata, created_at) VALUES (?,?,?,?,?)")
    .run(chatId, message.type, message.content, JSON.stringify(message.metadata ?? {}), now());
  const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as any;
  let name = chat.name;
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
  return { key: row.key, public_port: row.public_port, management_mode: row.management_mode, restart_policy: row.restart_policy, auto_restart: !!row.auto_restart, image: row.image, components: row.components ? JSON.parse(row.components) : undefined, is_default: !!row.is_default, updated_at: row.updated_at };
}

export function listContainerConfigs(): ContainerSettings[] {
  return (getDb().prepare("SELECT * FROM container_configs").all() as any[]).map((r: any) => ({
    key: r.key, public_port: r.public_port, management_mode: r.management_mode, restart_policy: r.restart_policy, auto_restart: !!r.auto_restart, image: r.image, components: r.components ? JSON.parse(r.components) : undefined, is_default: !!r.is_default, updated_at: r.updated_at,
  }));
}

export function setContainerConfig(key: string, patch: Partial<ContainerSettings>): ContainerSettings {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM container_configs WHERE key = ?").get(key) as any;
  if (!existing) throw new Error(`Unknown container: ${key}`);
  const merged = { ...existing, ...patch, updated_at: now() };
  db.prepare(`UPDATE container_configs SET public_port=?, management_mode=?, restart_policy=?, auto_restart=?, image=?, components=?, updated_at=? WHERE key=?`)
    .run(merged.public_port, merged.management_mode ?? "resident", merged.restart_policy ?? "no", merged.auto_restart ? 1 : 0, merged.image ?? null, merged.components ? JSON.stringify(merged.components) : null, merged.updated_at, key);
  return { key: merged.key, public_port: merged.public_port, management_mode: merged.management_mode, restart_policy: merged.restart_policy, auto_restart: !!merged.auto_restart, image: merged.image, components: merged.components ? JSON.parse(merged.components) : undefined, is_default: !!merged.is_default, updated_at: merged.updated_at };
}
```

- [ ] **Step 2: 修改 `apps/api/src/server.ts` — 替换 StateStore 导入**

替换文件开头的 state 导入：
```typescript
// 删除: import { StateStore } from "./state.js";
// 新增:
import { initDb, getDb, closeDb } from "./db.js";
import { migrateFromJson } from "./migrate.js";
import {
  createTask, updateTask, getTask, listTasks,
  upsertDeployment, listActiveDeployments, getActiveDeployment, deleteDeployment,
  listChats, getChat, createChat, renameChat, deleteChat, clearChats, appendMessage,
  getSetting, setSetting,
  getContainerConfig, listContainerConfigs, setContainerConfig,
} from "./store.js";
import { newId } from "./utils.js";
```

删除以下行：
```typescript
// const store = new StateStore(join(stateRoot, "workbench-state.json"));
```

在 server.listen 之前添加初始化代码：
```typescript
// 初始化 SQLite + 迁移
initDb();
const result = migrateFromJson(stateRoot);
if (result.migrated) console.log(`DB migration: ${result.detail}`);
```

- [ ] **Step 3: 替换 server.ts 中所有 `store.xxx()` 调用**

将全部 `store.methodName(...)` 替换为对应的独立函数调用。例如：
- `await store.listTasks()` → `listTasks()`
- `await store.getTask(id)` → `getTask(id)`
- `await store.createTask(t)` → `createTask(t)`
- `await store.upsertDeployment(d)` → `upsertDeployment(d)`
- 等等

- [ ] **Step 4: 同步更新依赖 server.ts 的其他文件**

检查 `containerManager.ts`、`deploymentManager.ts`、`openaiProxy.ts`、`wsHandler.ts`、`httpProxy.ts`、`deploymentHelpers.ts` 中是否有 `StateStore` 引用，替换为对应的 store 函数调用。

- [ ] **Step 5: 编译验证**

```bash
cd /home/zhenz/ai-stack/apps/api && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/
git commit -m "Phase 2c: 替换 StateStore 为 SQLite 存储层"
```

---

### Task 5: Electron 主进程

**Files:**
- Create: `apps/main/index.ts` — Electron 入口
- Create: `apps/main/preload.ts` — 预加载脚本
- Modify: `package.json` (根目录) — Electron 配置
- Create: `apps/main/tsconfig.json`

- [ ] **Step 1: 安装 Electron + electron-builder 依赖**

```bash
cd /home/zhenz/ai-stack
npm init -y 2>/dev/null || true
npm install --save-dev electron electron-builder typescript @types/node
```

更新根 `package.json`：
```json
{
  "name": "amuin-ai-stack",
  "version": "1.1.0",
  "private": true,
  "main": "apps/main/dist/index.js",
  "scripts": {
    "dev": "tsc -p apps/main/tsconfig.json && electron .",
    "build:main": "tsc -p apps/main/tsconfig.json",
    "build:api": "npm --prefix apps/api run build",
    "build:frontend": "npm --prefix apps/frontend run build",
    "build": "npm run build:main && npm run build:api && npm run build:frontend",
    "pack": "electron-builder --linux deb",
    "postinstall": "npm --prefix apps/api install && npm --prefix apps/frontend install"
  },
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0",
    "typescript": "^5.7.0",
    "@types/node": "^20.17.0"
  },
  "build": {
    "appId": "com.amuin.ai-stack",
    "productName": "AMUIN AI STACK",
    "directories": { "output": "dist-electron" },
    "linux": {
      "target": ["deb"],
      "category": "Science",
      "maintainer": "amuin@example.com"
    },
    "deb": {
      "depends": ["docker-ce", "nvidia-container-toolkit"]
    },
    "files": [
      "apps/main/dist/**/*",
      "apps/api/dist/**/*",
      "apps/api/node_modules/**/*",
      "apps/frontend/dist/**/*",
      "configs/**/*",
      "deploy/templates/**/*",
      "deploy/dockerfiles/**/*"
    ]
  }
}
```

- [ ] **Step 2: 创建 `apps/main/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["./**/*.ts"]
}
```

- [ ] **Step 3: 创建 `apps/main/index.ts`**

```typescript
import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
import { spawn, ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

let mainWindow: BrowserWindow | null = null;
let apiProcess: ChildProcess | null = null;
let tray: Tray | null = null;

const API_PORT = 8000;
const FRONTEND_PORT = 8888;
const isDev = !app.isPackaged;

function getAppRoot(): string {
  return isDev ? resolve(__dirname, "..", "..", "..") : join(process.resourcesPath, "app.asar.unpacked");
}

function startApiServer(): void {
  const apiDist = isDev
    ? join(getAppRoot(), "apps", "api", "dist", "server.js")
    : join(process.resourcesPath, "app.asar.unpacked", "apps", "api", "dist", "server.js");

  // In dev mode, use tsx for hot reload
  if (isDev) {
    apiProcess = spawn("npx", ["tsx", "apps/api/src/server.ts"], {
      cwd: getAppRoot(),
      env: { ...process.env, PORT: String(API_PORT), FRONTEND_PORT: String(FRONTEND_PORT), AI_STACK_BIND_ADDR: "127.0.0.1" },
      stdio: "pipe",
    });
  } else {
    apiProcess = spawn("node", [apiDist], {
      env: { ...process.env, PORT: String(API_PORT), FRONTEND_PORT: String(FRONTEND_PORT), AI_STACK_BIND_ADDR: "127.0.0.1" },
      stdio: "pipe",
    });
  }

  apiProcess.stdout?.on("data", (d) => console.log(`[API] ${d.toString().trim()}`));
  apiProcess.stderr?.on("data", (d) => console.error(`[API] ${d.toString().trim()}`));
  apiProcess.on("exit", (code) => console.log(`[API] exited with code ${code}`));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "AMUIN AI STACK",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load frontend
  const frontendDist = isDev
    ? `http://localhost:${FRONTEND_PORT}`
    : `file://${join(process.resourcesPath, "app.asar.unpacked", "apps", "frontend", "dist", "index.html")}`;

  if (isDev) {
    mainWindow.loadURL(frontendDist);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadURL(frontendDist);
  }

  mainWindow.on("closed", () => { mainWindow = null; });
}

function createTray(): void {
  // Minimal tray icon — use a 16x16 transparent PNG as fallback
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: "Show", click: () => mainWindow?.show() },
    { label: "Quit", click: () => { app.quit(); } },
  ]);
  tray.setToolTip("AMUIN AI STACK");
  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => mainWindow?.show());
}

app.whenReady().then(() => {
  startApiServer();
  // Small delay for API to start
  setTimeout(() => {
    createWindow();
    createTray();
  }, 2000);
});

app.on("window-all-closed", () => {
  // Keep running in tray on Linux
});

app.on("before-quit", () => {
  apiProcess?.kill("SIGTERM");
});

app.on("activate", () => {
  if (mainWindow === null) createWindow();
});
```

- [ ] **Step 4: 创建 `apps/main/preload.ts`**

```typescript
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  platform: process.platform,
});
```

- [ ] **Step 5: 编译 Electron 主进程**

```bash
cd /home/zhenz/ai-stack && tsc -p apps/main/tsconfig.json
```

- [ ] **Step 6: Commit**

```bash
git add apps/main/ package.json package-lock.json
git commit -m "Phase 3: Electron 主进程搭建"
```

---

### Task 6: 权限中间件

**Files:**
- Create: `apps/api/src/permissions.ts` — 权限校验
- Modify: `apps/api/src/server.ts` — 注入权限中间件

- [ ] **Step 1: 创建 `apps/api/src/permissions.ts`**

```typescript
import type { IncomingMessage } from "node:http";

/** Detect if request originates from Electron (localhost loopback). */
export function isLocalRequest(req: IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Detect if request carries Electron's internal token. */
export function isElectronRequest(req: IncomingMessage): boolean {
  const token = req.headers["x-ai-stack-electron"] as string | undefined;
  return token === process.env.ELECTRON_TOKEN || isLocalRequest(req);
}

/** APIs that require Electron-level privilege. */
const PRIVILEGED_PATHS = [
  { method: "DELETE", path: "/models/" },        // 模型删除
  { method: "POST", path: "/settings/" },         // 设置修改
  { method: "DELETE", path: "/containers/" },     // 容器删除 (仅自定义容器)
  { method: "POST", path: "/containers/custom" }, // 创建自定义容器
];

export function requiresElectronPrivilege(method: string, path: string): boolean {
  return PRIVILEGED_PATHS.some((p) => method === p.method && path.startsWith(p.path));
}
```

- [ ] **Step 2: 在 server.ts 中集成权限检查**

修改 server.ts 的请求处理，在 `match` 之后、调用 handler 之前加入：

```typescript
const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});

  const parsedPath = getPath(req);
  const m = match(req.method ?? "GET", parsedPath);
  if (!m) return sendJson(res, 404, { detail: "Not found" });

  // 权限检查
  const { requiresElectronPrivilege, isElectronRequest } = await import("./permissions.js");
  if (requiresElectronPrivilege(req.method ?? "GET", parsedPath)) {
    if (!isElectronRequest(req)) {
      return sendJson(res, 403, { detail: "This operation requires Electron (local) access." });
    }
  }

  try {
    await m.handler(req, res, m.params);
  } catch (error) {
    sendJson(res, 500, { detail: error instanceof Error ? error.message : String(error) });
  }
});
```

- [ ] **Step 3: 前端 Axios 请求注入 Electron Token**

在前端 HTTP 客户端中注入 header（仅 Electron 环境）：
```typescript
// apps/frontend/src/main.ts 或 HTTP 拦截器中
if (window.electronAPI?.isElectron) {
  // 前端发往 localhost API 的请求自动带 token
  // token 由 preload 脚本提供
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/permissions.ts apps/api/src/server.ts
git commit -m "Phase 4: 权限中间件 - Electron 最高权限 + LAN 访问开关"
```

---

### Task 7: 容器模板系统

**Files:**
- Create: `deploy/templates/vllm.yml`
- Create: `deploy/templates/tensorrt-llm.yml`
- Create: `deploy/templates/pytorch.yml`
- Create: `deploy/templates/pytorch.Dockerfile`
- Modify: `apps/api/src/containerManager.ts` — 适配模板系统

- [ ] **Step 1: 创建 `deploy/templates/vllm.yml`**

```yaml
services:
  vllm-worker:
    image: ${VLLM_IMAGE:-vllm/vllm-openai:latest}
    container_name: vllm-service
    gpus: all
    ipc: host
    ports:
      - "${BIND_ADDR:-127.0.0.1}:${VLLM_PORT:-30000}:8000"
    restart: ${RESTART_POLICY:-no}
    volumes:
      - ${MODELS_ROOT:-/home/zhenz/ai-stack/models}:/models:ro
      - ${HF_CACHE_DIR:-~/.cache/huggingface}:/root/.cache/huggingface
    environment:
      - HF_TOKEN=${HF_TOKEN:-}
```

- [ ] **Step 2: 创建 `deploy/templates/tensorrt-llm.yml`**

```yaml
services:
  trtllm-worker:
    image: ${TRTLLM_IMAGE:-nvcr.io/nvidia/tritonserver:25.04-trtllm-python-py3}
    container_name: trtllm-service
    gpus: all
    ipc: host
    ports:
      - "${BIND_ADDR:-127.0.0.1}:${TRTLLM_PORT:-31000}:8000"
    restart: ${RESTART_POLICY:-no}
    volumes:
      - ${MODELS_ROOT:-/home/zhenz/ai-stack/models}:/models:ro
    environment:
      - HF_TOKEN=${HF_TOKEN:-}
```

- [ ] **Step 3: 创建 `deploy/templates/pytorch.yml`**

```yaml
services:
  pytorch-worker:
    build:
      context: .
      dockerfile: pytorch.Dockerfile
    image: local/ai-stack-pytorch:latest
    container_name: pytorch-service
    gpus: all
    ipc: host
    ports:
      - "${BIND_ADDR:-127.0.0.1}:${PYTORCH_PORT:-32000}:9000"
    restart: ${RESTART_POLICY:-no}
    volumes:
      - ${MODELS_ROOT:-/home/zhenz/ai-stack/models}:/models:ro
      - ${WHISPER_CACHE:-~/.cache/whisper}:/root/.cache/whisper
```

- [ ] **Step 4: 创建 `deploy/templates/pytorch.Dockerfile`**

```dockerfile
FROM nvcr.io/nvidia/pytorch:25.04-py3

WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1

RUN pip install --no-cache-dir \
    fastapi>=0.116.1 \
    uvicorn>=0.35.0 \
    pydantic>=2.11.7 \
    websockets>=15.0.1 \
    numpy>=1.26.4 \
    soundfile>=0.12.1 \
    openai-whisper>=20250625

COPY pytorch_asr.py .

CMD ["uvicorn", "pytorch_asr:app", "--host", "0.0.0.0", "--port", "9000"]
```

- [ ] **Step 5: 创建 `deploy/templates/pytorch_asr.py`**

```python
"""PyTorch ASR service — OpenAI Realtime API compatible over WebSocket."""
from __future__ import annotations

import asyncio
import base64
import io
import uuid
import wave
from typing import Any

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

app = FastAPI(title="AI Stack PyTorch ASR", version="0.1.0")

# ── Whisper model (lazy load) ──
_model = None

def get_model():
    global _model
    if _model is None:
        import whisper
        import os
        cache = os.path.expanduser("~/.cache/whisper")
        tiny = os.path.join(cache, "tiny.pt")
        if os.path.exists(tiny):
            _model = whisper.load_model(tiny)
        else:
            _model = whisper.load_model("tiny")
    return _model

def transcribe_pcm(pcm_bytes: bytes, sample_rate: int = 16000) -> str:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    buf.seek(0)
    with wave.open(buf, "rb") as wf:
        audio_data = wf.readframes(wf.getnframes())
    audio = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32) / 32768.0
    model = get_model()
    result = model.transcribe(audio, fp16=False, language="zh")
    return result.get("text", "").strip()

# ── REST ──
@app.get("/healthz")
async def healthz():
    return {"status": "ok"}

@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": "whisper-tiny", "object": "model", "owned_by": "openai"}]}

# ── WebSocket (OpenAI Realtime compatible) ──
@app.websocket("/v1/realtime")
async def realtime(ws: WebSocket):
    await ws.accept()
    session_id = f"session_{uuid.uuid4().hex}"
    await ws.send_json({
        "type": "session.created",
        "session": {"id": session_id, "object": "realtime.session",
                     "modalities": ["text"], "input_audio_format": {"type": "pcm16", "rate": 16000}}
    })
    buffer = bytearray()
    sample_rate = 16000

    try:
        while True:
            msg = await ws.receive_json()
            etype = msg.get("type")

            if etype == "session.update":
                cfg = msg.get("session", {})
                sample_rate = cfg.get("input_audio_format", {}).get("rate", sample_rate)
                await ws.send_json({"type": "session.updated", "session": {"id": session_id, "modalities": ["text"], "input_audio_format": {"type": "pcm16", "rate": sample_rate}}})

            elif etype == "input_audio_buffer.append":
                audio_b64 = msg.get("audio", "")
                if audio_b64:
                    buffer.extend(base64.b64decode(audio_b64))
                await ws.send_json({"type": "input_audio_buffer.status"})

            elif etype == "input_audio_buffer.commit":
                text = await asyncio.to_thread(transcribe_pcm, bytes(buffer), sample_rate)
                buffer.clear()
                item_id = f"item_{uuid.uuid4().hex}"
                await ws.send_json({"type": "conversation.item.created", "item": {"id": item_id, "object": "realtime.item", "type": "message", "status": "completed", "role": "user", "content": [{"type": "input_audio", "transcript": text}]}})
                await ws.send_json({"type": "conversation.item.input_audio_transcription.completed", "item_id": item_id, "content_index": 0, "transcript": text})

            elif etype == "input_audio_buffer.clear":
                buffer.clear()
                await ws.send_json({"type": "input_audio_buffer.cleared"})

            else:
                await ws.send_json({"type": "error", "error": {"type": "invalid_request_error", "message": f"Unknown event: {etype}"}})
    except WebSocketDisconnect:
        pass

@app.websocket("/ws/realtime")
async def realtime_legacy(ws: WebSocket):
    await realtime(ws)
```

- [ ] **Step 6: Commit**

```bash
git add deploy/templates/
git commit -m "Phase 5: 容器模板系统 - vLLM/TensorRT-LLM/PyTorch + ASR 服务"
```

---

### Task 8: 删除 docker-compose.vllm.yml（已迁移到模板）

- [ ] **Step 1: 删除旧 vLLM compose 文件**

```bash
rm /home/zhenz/ai-stack/deploy/compose/docker-compose.vllm.yml
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "Phase 5b: 移除旧 vLLM compose，已迁移到 deploy/templates/"
```

---

### Task 9: API 端点优化 — OpenAI 合规 + 多模型路由

**Files:**
- Modify: `apps/api/src/openaiProxy.ts` — 流式对话 (SSE) + 多模型聚合
- Modify: `apps/api/src/server.ts` — 路由更新

- [ ] **Step 1: 更新 `openaiProxy.ts` — 添加流式 (SSE) 代理**

关键改动：当请求 `stream: true` 时，将下游容器的 SSE 流原样转发给客户端。

```typescript
// 在 proxyOpenAiRequest 中添加流式转发逻辑
async function proxyStream(res: ServerResponse, targetUrl: string, body: any): Promise<void> {
  const upstream = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!upstream.ok || !upstream.body) {
    res.writeHead(upstream.status);
    res.end(await upstream.text());
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}
```

- [ ] **Step 2: 更新 `/v1/models` — 聚合所有容器模型**

```typescript
route("GET", "/v1/models", async (_req, res) => {
  const deployments = await listActiveDeployments();
  const data = deployments
    .filter((d) => d.status === "running")
    .map((d) => ({ id: d.openai_model, object: "model", owned_by: d.service_type }));
  sendJson(res, 200, { object: "list", data });
});
```

- [ ] **Step 3: 编译验证 + Commit**

```bash
cd /home/zhenz/ai-stack/apps/api && npm run build
git add apps/api/src/ && git commit -m "Phase 6: OpenAI API 合规 - 流式 SSE + 多模型聚合"
```

---

### Task 10: 构建脚本 + .deb 打包

**Files:**
- Create: `scripts/build-deb.sh`

- [ ] **Step 1: 创建构建脚本**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Building API ==="
npm --prefix apps/api run build

echo "=== Building Frontend ==="
npm --prefix apps/frontend run build

echo "=== Building Electron Main ==="
tsc -p apps/main/tsconfig.json

echo "=== Packaging .deb ==="
npx electron-builder --linux deb

echo "=== Done ==="
ls -la dist-electron/*.deb
```

```bash
chmod +x /home/zhenz/ai-stack/scripts/build-deb.sh
```

- [ ] **Step 2: Commit**

```bash
git add scripts/build-deb.sh
git commit -m "Phase 8: 构建脚本 + .deb 打包配置"
```

---

### Task 11: 前端适配 Electron 环境

**Files:**
- Modify: `apps/frontend/src/main.ts`
- Modify: `apps/frontend/vite.config.ts`
- Modify: `apps/frontend/src/App.vue` — 添加 LAN 访问开关 UI

- [ ] **Step 1: 更新 vite.config.ts — Electron 环境适配**

```typescript
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    host: "127.0.0.1",
    port: 8888,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
  base: "./", // Electron file:// 需要相对路径
  build: {
    outDir: "dist",
  },
});
```

- [ ] **Step 2: 更新 main.ts — 添加 Electron API 类型**

```typescript
import { createApp } from "vue";
import App from "./App.vue";

declare global {
  interface Window {
    electronAPI?: {
      isElectron: boolean;
      getAppVersion: () => Promise<string>;
      platform: string;
    };
  }
}

const app = createApp(App);
app.mount("#app");
```

- [ ] **Step 3: 构建验证**

```bash
cd /home/zhenz/ai-stack/apps/frontend && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/
git commit -m "Phase 9: 前端 Electron 适配"
```

---

### Task 12: 端到端验证

- [ ] **Step 1: 验证 TypeScript 编译**

```bash
cd /home/zhenz/ai-stack/apps/api && npm run build
cd /home/zhenz/ai-stack/apps/frontend && npm run build
cd /home/zhenz/ai-stack && tsc -p apps/main/tsconfig.json
echo "All builds pass"
```

- [ ] **Step 2: 验证 SQLite 初始化**

```bash
cd /home/zhenz/ai-stack/apps/api && node -e "
const { initDb, getDb } = require('./dist/db.js');
initDb();
const db = getDb();
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
console.log('Tables:', tables.map(t=>t.name));
const containers = db.prepare('SELECT key, public_port, is_default FROM container_configs').all();
console.log('Containers:', containers);
db.close();
"
```

- [ ] **Step 3: 提交所有剩余修改**

```bash
git add -A
git commit -m "Phase 9: 端到端验证通过"
```
