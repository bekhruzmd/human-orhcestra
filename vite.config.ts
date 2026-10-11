import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';

// Stage is the home page; mobile.html serves phones, stage.html remains an alias, and xr.html serves Quest.
// In `npm run dev` the Node server (3000) owns /ws and /api; Vite proxies to it.
export default defineConfig({
  plugins: [react()],
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
    rollupOptions: { input: { home: resolve(__dirname, 'index.html'), player: resolve(__dirname, 'mobile.html'), stage: resolve(__dirname, 'stage.html'), xr: resolve(__dirname, 'xr.html') } },
    chunkSizeWarningLimit: 1500, // the VR page bundles three.js; phones and the Stage never load it
  },
});
