import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4173',
        changeOrigin: true,
        ws: true,
      },
      '/v1': {
        target: 'http://127.0.0.1:4173',
        changeOrigin: true,
      },
      '/js/telegram-web-app.js': {
        target: 'http://127.0.0.1:4173',
        changeOrigin: true,
      },
      '/miniapps': {
        target: 'http://127.0.0.1:4173',
        changeOrigin: true,
      },
      '/oauth': {
        target: 'http://127.0.0.1:4173',
        changeOrigin: true,
      },
      '/mcp': {
        target: 'http://127.0.0.1:4173',
        changeOrigin: true,
      },
      '/.well-known': {
        target: 'http://127.0.0.1:4173',
        changeOrigin: true,
      },
      '/bot': {
        target: 'http://127.0.0.1:4173',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
});
