import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    host: "127.0.0.1",
    port: 8888,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
  base: "./", // Electron file:// 协议需要相对路径
  build: {
    outDir: "dist",
  },
});
