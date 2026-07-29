# Deb Packaging Design

**Date**: 2026-07-29  
**Status**: approved

## Goal

Package AMUIN AI STACK as a `.deb` for direct user installation on Linux (DGX Spark).

## Directory Layout

### System install (`/opt/AMUIN AI STACK/`, root-owned, read-only)

```
/opt/AMUIN AI STACK/
├── amuin-ai-stack                 # Electron executable
├── apps/api/dist/                 # Compiled API (TypeScript → JS)
├── apps/api/node_modules/         # API runtime dependencies
├── apps/frontend/dist/            # Frontend static files (Vue/Vite)
├── configs/                       # Default configuration templates
├── deploy/                        # Docker compose files, dockerfiles, templates
└── ops/scripts/                   # Download scripts, model helpers

/usr/bin/amuin-ai-stack            # → /opt/AMUIN AI STACK/amuin-ai-stack
/usr/share/applications/amuin-ai-stack.desktop
/usr/share/icons/hicolor/256x256/apps/amuin-ai-stack.png
```

### User data (`~/.local/share/ai-stack/`, user-owned, read-write)

```
~/.local/share/ai-stack/
├── data.db                        # SQLite database
├── models/                        # Downloaded model files
├── state/uploads/                 # Uploaded files
├── logs/                          # Runtime logs
├── cache/                         # Download cache
├── deploy/                        # Copied from install on first run (user-editable)
├── ops/                           # Copied from install on first run
├── configs/                       # Copied from install on first run (if not exists)
└── tmp/                           # Temporary files
```

## Code Changes

Only one file needs modification to unify the data directory:

### `apps/main/index.ts` — `getWorkspaceRoot()`

**Current** (production mode): `join(app.getPath("userData"), "workspace")` → `~/.config/amuin-ai-stack/workspace`

**New**: `join(app.getPath("home"), ".local", "share", "ai-stack")` → `~/.local/share/ai-stack`

This makes the Electron workspace consistent with the API database location (`apps/api/src/db.ts` already defaults to `~/.local/share/ai-stack`).

### No-change files

- `apps/api/src/db.ts` — already uses `~/.local/share/ai-stack` via `XDG_DATA_HOME` fallback
- `apps/api/src/server.ts` — already reads `AI_STACK_BASE`, `MODELS_ROOT`, `STATE_ROOT`, `LOGS_ROOT` from environment variables set by the Electron main process

## Build Flow

Existing pipeline, no structural changes:

```
npm run build          # tsc for main + api, vite build for frontend
npm run pack:dir       # electron-builder --linux dir → dist-electron/linux-{arch}-unpacked
npm run pack           # scripts/package-deb.js → dist-electron/amuin-ai-stack_1.1.0_{arch}.deb
```

`scripts/package-deb.js` handles: control file, desktop entry, icon, permission normalization, `dpkg-deb --build`.

## Deb Metadata

| Field | Value |
|-------|-------|
| Package | `amuin-ai-stack` |
| Version | `1.1.0` |
| Section | `science` |
| Architecture | `amd64` / `arm64` |
| Depends | `bash`, `docker-ce \| docker.io`, `docker-compose-plugin \| docker-compose-v2`, `nvidia-container-toolkit \| nvidia-docker2`, `libgtk-3-0`, `libnotify4`, `libnss3`, `libxss1`, `libxtst6`, `xdg-utils`, `libatspi2.0-0`, `libuuid1`, `libsecret-1-0` |

## First-run Behavior

When the Electron app starts in production mode:
1. Creates `~/.local/share/ai-stack/` with subdirectories (`models`, `cache`, `state`, `logs`, `tmp`)
2. Copies `deploy/`, `ops/`, `configs/` from the install directory to the workspace (deploy/ops always overwritten, configs only if not present)
3. Starts the API server with `AI_STACK_BASE=~/.local/share/ai-stack`
4. Opens the frontend in an Electron BrowserWindow

## What This Does NOT Cover

- Auto-start on boot (systemd user service) — future enhancement
- Headless/server-only mode without Electron — separate package variant
- `.desktop` icon quality — currently reuses electron-builder's default icon; custom icon is a separate task
