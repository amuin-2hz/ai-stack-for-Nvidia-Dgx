import { app, BrowserWindow, Tray, Menu, nativeImage, session } from "electron";
import { spawn, ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let mainWindow: BrowserWindow | null = null;
let apiProcess: ChildProcess | null = null;
let frontendProcess: ChildProcess | null = null;
let tray: Tray | null = null;

const API_PORT = 8000;
const FRONTEND_PORT = 8888;
const isDev = !app.isPackaged;

function getAppRoot(): string {
  return isDev
    ? join(__dirname, "..", "..", "..")
    : join(process.resourcesPath, "app.asar.unpacked");
}

function getWorkspaceRoot(): string {
  if (isDev) return getAppRoot();
  const dataHome = process.env.XDG_DATA_HOME || join(app.getPath("home"), ".local", "share");
  return join(dataHome, "ai-stack");
}

function copyRuntimeDir(sourceRoot: string, workspaceRoot: string, name: string, overwrite: boolean): void {
  const source = join(sourceRoot, name);
  if (!existsSync(source)) return;
  cpSync(source, join(workspaceRoot, name), {
    recursive: true,
    force: overwrite,
    errorOnExist: false,
  });
}

function prepareRuntimeWorkspace(): string {
  const workspaceRoot = getWorkspaceRoot();
  if (isDev) return workspaceRoot;

  mkdirSync(workspaceRoot, { recursive: true });
  for (const name of ["models", "cache", "state", "logs", "tmp"]) {
    mkdirSync(join(workspaceRoot, name), { recursive: true });
  }

  const sourceRoot = getAppRoot();
  copyRuntimeDir(sourceRoot, workspaceRoot, "deploy", true);
  copyRuntimeDir(sourceRoot, workspaceRoot, "ops", true);
  copyRuntimeDir(sourceRoot, workspaceRoot, "configs", false);
  return workspaceRoot;
}

function apiEnv(workspaceRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PORT: String(API_PORT),
    FRONTEND_PORT: String(FRONTEND_PORT),
    AI_STACK_BIND_ADDR: process.env.AI_STACK_BIND_ADDR ?? "0.0.0.0",
    AI_STACK_SERVE_FRONTEND: isDev ? "0" : "1",
    AI_STACK_BASE: workspaceRoot,
    AI_STACK_DATA_DIR: workspaceRoot,
    MODELS_ROOT: process.env.MODELS_ROOT ?? join(workspaceRoot, "models"),
    STATE_ROOT: join(workspaceRoot, "state"),
    LOGS_ROOT: join(workspaceRoot, "logs"),
  };
}

function startApiServer(): void {
  const workspaceRoot = prepareRuntimeWorkspace();
  if (isDev) {
    apiProcess = spawn("npx", ["tsx", "apps/api/src/server.ts"], {
      cwd: getAppRoot(),
      env: apiEnv(workspaceRoot),
      stdio: "pipe",
    });
  } else {
    apiProcess = spawn(
      process.execPath,
      [join(getAppRoot(), "apps", "api", "dist", "server.js")],
      {
        cwd: workspaceRoot,
        env: { ...apiEnv(workspaceRoot), ELECTRON_RUN_AS_NODE: "1" },
        stdio: "pipe",
      }
    );
  }

async function apiIsReady(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${API_PORT}/healthz`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

  apiProcess.stdout?.on("data", (d) => console.log(`[API] ${d.toString().trim()}`));
  apiProcess.stderr?.on("data", (d) => console.error(`[API] ${d.toString().trim()}`));
  apiProcess.on("exit", (code) => console.log(`[API] exited with code ${code}`));
}

function startFrontendServer(): void {
  if (!isDev) return; // In production, frontend is served as static files

  frontendProcess = spawn("npx", ["vite", "--host", "0.0.0.0", "--port", String(FRONTEND_PORT)], {
    cwd: join(getAppRoot(), "apps", "frontend"),
    env: { ...process.env },
    stdio: "pipe",
  });

  frontendProcess.stdout?.on("data", (d) => console.log(`[VITE] ${d.toString().trim()}`));
  frontendProcess.stderr?.on("data", (d) => console.error(`[VITE] ${d.toString().trim()}`));
  frontendProcess.on("exit", (code) => console.log(`[VITE] exited with code ${code}`));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 2100,
    height: 1181,
    minWidth: 1024,
    minHeight: 700,
    title: "AMUIN AI STACK",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (isDev) {
    mainWindow.loadURL(`http://localhost:${FRONTEND_PORT}`);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadURL(`http://localhost:${FRONTEND_PORT}`);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function setupCSP(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = isDev
      ? [
          "default-src 'self'",
          `script-src 'self' 'unsafe-eval' 'unsafe-inline' http://localhost:${FRONTEND_PORT}`,
          `style-src 'self' 'unsafe-inline' http://localhost:${FRONTEND_PORT}`,
          `connect-src 'self' http://localhost:${FRONTEND_PORT} ws://localhost:${FRONTEND_PORT} http://localhost:${API_PORT}`,
          "img-src 'self' data: http://localhost:*",
          "font-src 'self' data:",
        ].join("; ")
      : [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "font-src 'self' data:",
        ].join("; ");

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
}

// Allow running without SUID sandbox on machines without root access
app.commandLine.appendSwitch("no-sandbox");

// When running under a virtual framebuffer (Xvfb), disable GPU
// compositing to avoid GLX / passthrough errors.
// Set ELECTRON_DISABLE_GPU=1 to force; otherwise auto-detect via Xvfb hint.
const display = process.env.DISPLAY ?? "";
const xvfbDisplay = process.env.XVFB_DISPLAY ?? "";
if (process.env.ELECTRON_DISABLE_GPU === "1" || display.startsWith(":99") || xvfbDisplay !== "") {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  console.log("[electron] GPU disabled — virtual display mode (DISPLAY=%s)", display);
}

app.whenReady().then(() => {
  setupCSP();
  startApiServer();
  startFrontendServer();
  // Give Vite + API time to start before loading the window
  setTimeout(() => {
    createWindow();
  }, 4000);
});

app.on("window-all-closed", () => {
  // Keep running in tray on Linux
});

app.on("before-quit", () => {
  apiProcess?.kill("SIGTERM");
  frontendProcess?.kill("SIGTERM");
});

app.on("activate", () => {
  if (mainWindow === null) createWindow();
});
