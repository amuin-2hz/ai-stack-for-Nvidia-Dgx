"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("electronAPI", {
    isElectron: true,
    getAppVersion: () => electron_1.ipcRenderer.invoke("get-app-version"),
    platform: process.platform,
});
//# sourceMappingURL=preload.js.map