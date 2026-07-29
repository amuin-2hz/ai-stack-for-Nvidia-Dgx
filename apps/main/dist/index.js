"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
let mainWindow = null;
let apiProcess = null;
let frontendProcess = null;
let tray = null;
const API_PORT = 8000;
const FRONTEND_PORT = 8888;
const isDev = !electron_1.app.isPackaged;
function getAppRoot() {
    return isDev
        ? (0, node_path_1.join)(__dirname, "..", "..", "..")
        : (0, node_path_1.join)(process.resourcesPath, "app.asar.unpacked");
}
function getWorkspaceRoot() {
    if (isDev)
        return getAppRoot();
    const dataHome = process.env.XDG_DATA_HOME || (0, node_path_1.join)(electron_1.app.getPath("home"), ".local", "share");
    return (0, node_path_1.join)(dataHome, "ai-stack");
}
function copyRuntimeDir(sourceRoot, workspaceRoot, name, overwrite) {
    const source = (0, node_path_1.join)(sourceRoot, name);
    if (!(0, node_fs_1.existsSync)(source))
        return;
    (0, node_fs_1.cpSync)(source, (0, node_path_1.join)(workspaceRoot, name), {
        recursive: true,
        force: overwrite,
        errorOnExist: false,
    });
}
function prepareRuntimeWorkspace() {
    const workspaceRoot = getWorkspaceRoot();
    if (isDev)
        return workspaceRoot;
    (0, node_fs_1.mkdirSync)(workspaceRoot, { recursive: true });
    for (const name of ["models", "cache", "state", "logs", "tmp"]) {
        (0, node_fs_1.mkdirSync)((0, node_path_1.join)(workspaceRoot, name), { recursive: true });
    }
    const sourceRoot = getAppRoot();
    copyRuntimeDir(sourceRoot, workspaceRoot, "deploy", true);
    copyRuntimeDir(sourceRoot, workspaceRoot, "ops", true);
    copyRuntimeDir(sourceRoot, workspaceRoot, "configs", false);
    return workspaceRoot;
}
function apiEnv(workspaceRoot) {
    return {
        ...process.env,
        PORT: String(API_PORT),
        FRONTEND_PORT: String(FRONTEND_PORT),
        AI_STACK_BIND_ADDR: "127.0.0.1",
        AI_STACK_BASE: workspaceRoot,
        AI_STACK_DATA_DIR: workspaceRoot,
        MODELS_ROOT: (0, node_path_1.join)(workspaceRoot, "models"),
        STATE_ROOT: (0, node_path_1.join)(workspaceRoot, "state"),
        LOGS_ROOT: (0, node_path_1.join)(workspaceRoot, "logs"),
    };
}
function startApiServer() {
    const workspaceRoot = prepareRuntimeWorkspace();
    if (isDev) {
        apiProcess = (0, node_child_process_1.spawn)("npx", ["tsx", "apps/api/src/server.ts"], {
            cwd: getAppRoot(),
            env: apiEnv(workspaceRoot),
            stdio: "pipe",
        });
    }
    else {
        apiProcess = (0, node_child_process_1.spawn)(process.execPath, [(0, node_path_1.join)(getAppRoot(), "apps", "api", "dist", "server.js")], {
            cwd: workspaceRoot,
            env: { ...apiEnv(workspaceRoot), ELECTRON_RUN_AS_NODE: "1" },
            stdio: "pipe",
        });
    }
    apiProcess.stdout?.on("data", (d) => console.log(`[API] ${d.toString().trim()}`));
    apiProcess.stderr?.on("data", (d) => console.error(`[API] ${d.toString().trim()}`));
    apiProcess.on("exit", (code) => console.log(`[API] exited with code ${code}`));
}
function startFrontendServer() {
    if (!isDev)
        return; // In production, frontend is served as static files
    frontendProcess = (0, node_child_process_1.spawn)("npx", ["vite", "--host", "127.0.0.1", "--port", String(FRONTEND_PORT)], {
        cwd: (0, node_path_1.join)(getAppRoot(), "apps", "frontend"),
        env: { ...process.env },
        stdio: "pipe",
    });
    frontendProcess.stdout?.on("data", (d) => console.log(`[VITE] ${d.toString().trim()}`));
    frontendProcess.stderr?.on("data", (d) => console.error(`[VITE] ${d.toString().trim()}`));
    frontendProcess.on("exit", (code) => console.log(`[VITE] exited with code ${code}`));
}
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 2100,
        height: 1181,
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
function setupCSP() {
    electron_1.session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
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
electron_1.app.commandLine.appendSwitch("no-sandbox");
// When running under a virtual framebuffer (Xvfb), disable GPU
// compositing to avoid GLX / passthrough errors.
// Set ELECTRON_DISABLE_GPU=1 to force; otherwise auto-detect via Xvfb hint.
const display = process.env.DISPLAY ?? "";
const xvfbDisplay = process.env.XVFB_DISPLAY ?? "";
if (process.env.ELECTRON_DISABLE_GPU === "1" || display.startsWith(":99") || xvfbDisplay !== "") {
    electron_1.app.commandLine.appendSwitch("disable-gpu");
    electron_1.app.commandLine.appendSwitch("disable-software-rasterizer");
    console.log("[electron] GPU disabled — virtual display mode (DISPLAY=%s)", display);
}
electron_1.app.whenReady().then(() => {
    setupCSP();
    startApiServer();
    startFrontendServer();
    // Give Vite + API time to start before loading the window
    setTimeout(() => {
        createWindow();
    }, 4000);
});
electron_1.app.on("window-all-closed", () => {
    // Keep running in tray on Linux
});
electron_1.app.on("before-quit", () => {
    apiProcess?.kill("SIGTERM");
    frontendProcess?.kill("SIGTERM");
});
electron_1.app.on("activate", () => {
    if (mainWindow === null)
        createWindow();
});
//# sourceMappingURL=index.js.map