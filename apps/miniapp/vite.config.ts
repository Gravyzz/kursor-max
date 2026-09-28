import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// В разработке API проксируется на локальный сервер; в Docker статику и /api отдаёт Caddy.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
