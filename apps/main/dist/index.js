"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_child_process_1 = require("node:child_process");
const node_path_1 = require("node:path");
let mainWindow = null;
let apiProcess = null;
let tray = null;
const API_PORT = 8000;
const FRONTEND_PORT = 8888;
const isDev = !electron_1.app.isPackaged;
function getAppRoot() {
    return isDev
        ? (0, node_path_1.join)(__dirname, "..", "..", "..")
        : (0, node_path_1.join)(process.resourcesPath, "app.asar.unpacked");
}
function startApiServer() {
    if (isDev) {
        apiProcess = (0, node_child_process_1.spawn)("npx", ["tsx", "apps/api/src/server.ts"], {
            cwd: getAppRoot(),
            env: {
                ...process.env,
                PORT: String(API_PORT),
                FRONTEND_PORT: String(FRONTEND_PORT),
                AI_STACK_BIND_ADDR: "127.0.0.1",
            },
            stdio: "pipe",
        });
    }
    else {
        apiProcess = (0, node_child_process_1.spawn)("node", [(0, node_path_1.join)(getAppRoot(), "apps", "api", "dist", "server.js")], {
            env: {
                ...process.env,
                PORT: String(API_PORT),
                FRONTEND_PORT: String(FRONTEND_PORT),
                AI_STACK_BIND_ADDR: "127.0.0.1",
            },
            stdio: "pipe",
        });
    }
    apiProcess.stdout?.on("data", (d) => console.log(`[API] ${d.toString().trim()}`));
    apiProcess.stderr?.on("data", (d) => console.error(`[API] ${d.toString().trim()}`));
    apiProcess.on("exit", (code) => console.log(`[API] exited with code ${code}`));
}
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1024,
        minHeight: 700,
        title: "AMUIN AI STACK",
        webPreferences: {
            preload: (0, node_path_1.join)(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });
    if (isDev) {
        mainWindow.loadURL(`http://localhost:${FRONTEND_PORT}`);
        mainWindow.webContents.openDevTools({ mode: "detach" });
    }
    else {
        mainWindow.loadFile((0, node_path_1.join)(getAppRoot(), "apps", "frontend", "dist", "index.html"));
    }
    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}
// Allow running without SUID sandbox on machines without root access
electron_1.app.commandLine.appendSwitch("no-sandbox");
electron_1.app.whenReady().then(() => {
    startApiServer();
    // Small delay for API to start
    setTimeout(() => {
        createWindow();
    }, 2000);
});
electron_1.app.on("window-all-closed", () => {
    // Keep running in tray on Linux
});
electron_1.app.on("before-quit", () => {
    apiProcess?.kill("SIGTERM");
});
electron_1.app.on("activate", () => {
    if (mainWindow === null)
        createWindow();
});
//# sourceMappingURL=index.js.map