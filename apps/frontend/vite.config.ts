import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootPackagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as { version: string };
const buildDate = process.env.APP_BUILD_DATE ?? new Date().toISOString().slice(0, 7);

const frontendPort = Number(process.env.FRONTEND_PORT ?? "8888");
const apiBaseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:8000";

const controlPlaneProxy = {
  target: apiBaseUrl,
  changeOrigin: true,
  rewrite: (path: string) => path.replace(/^\/api/, ""),
};

const modelListProxy = {
  target: apiBaseUrl,
  changeOrigin: false,
  xfwd: true,
  rewrite: () => "/v1/models",
};

export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPackage.version),
    __APP_BUILD_DATE__: JSON.stringify(buildDate)
  },
  server: {
    host: "0.0.0.0",
    port: frontendPort,
    proxy: {
      "/api": controlPlaneProxy,
      "^/models$": modelListProxy,
      "^/v1/models$": modelListProxy,
    },
  },
  preview: {
    host: "0.0.0.0",
    port: frontendPort,
    proxy: {
      "/api": controlPlaneProxy,
      "^/models$": modelListProxy,
      "^/v1/models$": modelListProxy,
    },
  },
  base: "./", // Electron file:// 协议需要相对路径
  build: {
    outDir: "dist",
  },
});
