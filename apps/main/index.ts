import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
import { spawn, ChildProcess } from "node:child_process";
import { join } from "node:path";

let mainWindow: BrowserWindow | null = null;
let apiProcess: ChildProcess | null = null;
let tray: Tray | null = null;

const API_PORT = 8000;
const FRONTEND_PORT = 8888;
const isDev = !app.isPackaged;

function getAppRoot(): string {
  return isDev
    ? join(__dirname, "..", "..", "..")
    : join(process.resourcesPath, "app.asar.unpacked");
}

function startApiServer(): void {
  if (isDev) {
    apiProcess = spawn("npx", ["tsx", "apps/api/src/server.ts"], {
      cwd: getAppRoot(),
      env: {
        ...process.env,
        PORT: String(API_PORT),
        FRONTEND_PORT: String(FRONTEND_PORT),
        AI_STACK_BIND_ADDR: "127.0.0.1",
      },
      stdio: "pipe",
    });
  } else {
    apiProcess = spawn(
      "node",
      [join(getAppRoot(), "apps", "api", "dist", "server.js")],
      {
        env: {
          ...process.env,
          PORT: String(API_PORT),
          FRONTEND_PORT: String(FRONTEND_PORT),
          AI_STACK_BIND_ADDR: "127.0.0.1",
        },
        stdio: "pipe",
      }
    );
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

  if (isDev) {
    mainWindow.loadURL(`http://localhost:${FRONTEND_PORT}`);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(
      join(getAppRoot(), "apps", "frontend", "dist", "index.html")
    );
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Allow running without SUID sandbox on machines without root access
app.commandLine.appendSwitch("no-sandbox");

app.whenReady().then(() => {
  startApiServer();
  // Small delay for API to start
  setTimeout(() => {
    createWindow();
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
