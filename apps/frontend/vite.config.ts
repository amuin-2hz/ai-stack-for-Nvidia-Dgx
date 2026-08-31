import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

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
