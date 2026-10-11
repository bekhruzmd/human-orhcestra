import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Quest Browser only allows immersive WebXR in a secure context, so dev/preview run over HTTPS
// (self-signed; accept the warning once on the headset).
//
// /ws is a same-origin bridge to a Human Orchestra server on this machine. Because the page is HTTPS, a
// direct ws:// connection from the headset would be blocked as mixed content; wss://<this-mac>:5173/ws is not.
// The bridge only forwards to ORCHESTRA_TARGET and exists only while this dev/preview server runs.
const target = process.env.ORCHESTRA_TARGET ?? 'http://localhost:3000';
// TUNNEL=1: plain-HTTP dev server for a public HTTPS tunnel (the tunnel provides TLS; its random host must be allowed).
const tunnel = !!process.env.TUNNEL;
const bridge = { '/ws': { target, ws: true, changeOrigin: true } };

export default defineConfig({
  plugins: [react(), ...(tunnel ? [] : [basicSsl()])],
  server: { port: 5173, proxy: bridge, allowedHosts: tunnel ? true : ['.trycloudflare.com'] },
  preview: { port: 4173, proxy: bridge, allowedHosts: ['.trycloudflare.com'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
