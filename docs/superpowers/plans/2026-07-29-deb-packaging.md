# Deb Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the workspace path in the Electron main process to `~/.local/share/ai-stack`, then build and package a working `.deb`.

**Architecture:** One-line change in `apps/main/index.ts` to unify the data directory, then run the existing `build → electron-builder → package-deb.js` pipeline. The pipeline compiles TypeScript for all three apps (main/api/frontend), produces an unpacked Electron directory via electron-builder, and wraps it into a standard Debian package with desktop integration.

**Tech Stack:** TypeScript, Electron, electron-builder, dpkg-deb

## Global Constraints

- User data directory: `~/.local/share/ai-stack/` (models, DB, state, logs all under this root)
- Install directory: `/opt/AMUIN AI STACK/`
- Package name: `amuin-ai-stack`
- Deb architecture: auto-detected (`amd64` or `arm64`)
- Must use existing `electron-builder` + `scripts/package-deb.js` pipeline

---

### Task 1: Fix workspace path in Electron main process

**Files:**
- Modify: `apps/main/index.ts:21-23`

**Interfaces:**
- Produces: `getWorkspaceRoot()` returns `~/.local/share/ai-stack` in production mode (was `~/.config/<app>/workspace`)

- [ ] **Step 1: Change `getWorkspaceRoot()` to use XDG data home**

Replace line 22 in `apps/main/index.ts`:

```typescript
// Before:
function getWorkspaceRoot(): string {
  return isDev ? getAppRoot() : join(app.getPath("userData"), "workspace");
}

// After:
function getWorkspaceRoot(): string {
  if (isDev) return getAppRoot();
  const dataHome = process.env.XDG_DATA_HOME || join(app.getPath("home"), ".local", "share");
  return join(dataHome, "ai-stack");
}
```

This respects `XDG_DATA_HOME` if set, otherwise falls back to `~/.local/share/ai-stack`, matching the behavior in `apps/api/src/db.ts`.

- [ ] **Step 2: Recompile the main process**

```bash
cd /home/zhenz/ai-stack && npm run build:main
```

Expected: `tsc -p apps/main/tsconfig.json` completes without errors. Verify `apps/main/dist/index.js` was updated.

- [ ] **Step 3: Verify the compiled output contains the new path**

```bash
grep -n "local/share\|XDG_DATA_HOME\|getWorkspaceRoot\|ai-stack" /home/zhenz/ai-stack/apps/main/dist/index.js | head -10
```

Expected: the compiled JS references `.local/share/ai-stack` or `XDG_DATA_HOME`.

- [ ] **Step 4: Commit**

```bash
git add apps/main/index.ts apps/main/dist/index.js
git commit -m "fix: unify workspace path to ~/.local/share/ai-stack"
```

---

### Task 2: Build all application components

**Files:**
- Modify: none (build artifacts only)

**Interfaces:**
- Consumes: `getWorkspaceRoot()` returning `~/.local/share/ai-stack` (from Task 1)
- Produces: compiled JS in `apps/api/dist/`, `apps/frontend/dist/`, `apps/main/dist/`

- [ ] **Step 1: Build API**

```bash
cd /home/zhenz/ai-stack && npm run build:api
```

Expected: `tsc -p apps/api/tsconfig.json` completes. Verify `apps/api/dist/server.js` exists.

- [ ] **Step 2: Build frontend**

```bash
cd /home/zhenz/ai-stack && npm run build:frontend
```

Expected: `vite build` completes. Verify `apps/frontend/dist/index.html` exists.

- [ ] **Step 3: Verify all build artifacts**

```bash
ls -la /home/zhenz/ai-stack/apps/main/dist/index.js
ls -la /home/zhenz/ai-stack/apps/api/dist/server.js
ls -la /home/zhenz/ai-stack/apps/frontend/dist/index.html
```

Expected: all three files exist and are recent.

---

### Task 3: Package as .deb

**Files:**
- Execute: `scripts/package-deb.js` (no changes needed)
- Execute: `scripts/build-deb.sh` (wrapper, no changes needed)

**Interfaces:**
- Consumes: compiled artifacts from Task 2
- Produces: `dist-electron/amuin-ai-stack_1.1.0_{arch}.deb`

- [ ] **Step 1: Run electron-builder to create unpacked directory**

```bash
cd /home/zhenz/ai-stack && npx electron-builder --linux dir
```

Expected: creates `dist-electron/linux-{arch}-unpacked/` directory with all application files.

If the output directory name doesn't match what `package-deb.js` expects (`linux-${process.arch}-unpacked`), note the actual name and we'll adjust.

- [ ] **Step 2: Run package-deb.js to create the .deb**

```bash
cd /home/zhenz/ai-stack && node scripts/package-deb.js
```

Expected: outputs `Created dist-electron/amuin-ai-stack_1.1.0_amd64.deb` (or arm64).

- [ ] **Step 3: Verify .deb contents**

```bash
dpkg-deb --contents /home/zhenz/ai-stack/dist-electron/amuin-ai-stack_*.deb | head -40
```

Expected output should show:
- `/opt/AMUIN AI STACK/` — application files
- `/usr/bin/amuin-ai-stack` — launcher script
- `/usr/share/applications/amuin-ai-stack.desktop` — desktop entry
- `/usr/share/icons/` — application icon

- [ ] **Step 4: Verify .deb control metadata**

```bash
dpkg-deb --info /home/zhenz/ai-stack/dist-electron/amuin-ai-stack_*.deb
```

Expected: shows package name, version, architecture, depends list.

- [ ] **Step 5: Commit the .deb build scripts (if any adjustments were needed)**

```bash
git add -A
git commit -m "build: deb packaging pipeline verified"
```

---

### Task 4: Test installation (dry-run)

**Files:**
- None (verification only)

- [ ] **Step 1: Check for dpkg-deb availability**

```bash
which dpkg-deb && dpkg-deb --version
```

- [ ] **Step 2: Dry-run install check (does not actually install)**

```bash
sudo dpkg --dry-run -i /home/zhenz/ai-stack/dist-electron/amuin-ai-stack_*.deb 2>&1 || true
```

Expected: dpkg validates the package structure. Dependency warnings (docker, nvidia tools) are expected on a non-DGX machine — this is fine.

- [ ] **Step 3: Lint the .deb with lintian (if available)**

```bash
which lintian && lintian /home/zhenz/ai-stack/dist-electron/amuin-ai-stack_*.deb || echo "lintian not installed, skipping"
```

Expected: may show warnings about icon, man page, etc. — non-blocking for v1.
