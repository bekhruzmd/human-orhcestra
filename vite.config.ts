import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Two pages: index.html = Player (phones), stage.html = Stage (laptop / big screen).
// In `npm run dev` the Node server (3000) owns /ws and /api; Vite proxies to it.
export default defineConfig({
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: { input: { player: resolve(__dirname, 'index.html'), stage: resolve(__dirname, 'stage.html') } },
  },
});
