import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DATA_DIR = process.env.AI_STACK_DATA_DIR ?? join(homedir(), ".local", "share", "ai-stack");
const DB_PATH = process.env.AI_STACK_DB_PATH ?? join(DATA_DIR, "data.db");

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

    CREATE TABLE IF NOT EXISTS model_files (
      model_id         TEXT NOT NULL,
      relative_path    TEXT NOT NULL,
      status           TEXT NOT NULL,
      size_bytes       INTEGER,
      downloaded_bytes INTEGER,
      task_id          TEXT,
      error            TEXT,
      updated_at       TEXT NOT NULL,
      PRIMARY KEY (model_id, relative_path)
    );

    CREATE INDEX IF NOT EXISTS idx_model_files_task_id ON model_files(task_id);

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
    { key: "trtllm", port: 31000, image: "nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6" },
    { key: "pytorch", port: 32000, image: "nvcr.io/nvidia/pytorch:25.04-py3" },
  ];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO container_configs (key, public_port, management_mode, restart_policy, auto_restart, image, is_default, updated_at)
     VALUES (@key, @port, 'resident', 'no', 0, @image, 1, datetime('now'))`
  );
  for (const d of defaults) {
    insert.run({ key: d.key, port: d.port, image: d.image });
  }

  db.prepare(
    "UPDATE container_configs SET image = ?, updated_at = datetime('now') WHERE key = 'trtllm' AND image = ?"
  ).run(
    "nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6",
    "nvcr.io/nvidia/tritonserver:25.04-trtllm-python-py3"
  );
}

export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}
