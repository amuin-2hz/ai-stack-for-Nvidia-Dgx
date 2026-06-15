import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.FRONTEND_PORT ?? '8888'),
    proxy: {
      '/api': {
        target: process.env.API_BASE_URL ?? 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  },
  preview: {
    host: '0.0.0.0',
    port: Number(process.env.FRONTEND_PORT ?? '8888')
  }
});
