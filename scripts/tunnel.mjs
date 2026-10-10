#!/usr/bin/env node
/**
 * Free HTTPS for phones: a cloudflared "quick tunnel" (no account, no cost) pointing at the local server.
 * Phones need HTTPS for DeviceMotion/Orientation (shake + tilt) and, on iOS, for the permission prompt.
 *
 * Once the tunnel URL is known we tell the server (POST /api/public-url) so the Stage's QR code uses it.
 * We re-announce every 3 s, so restarting the server mid-demo doesn't lose the URL.
 */
import { spawn } from 'node:child_process';

const PORT = process.env.PORT ?? 3000;
const server = `http://localhost:${PORT}`;
let url = null;

const cf = spawn('cloudflared', ['tunnel', '--url', server, '--no-autoupdate'], { stdio: ['ignore', 'ignore', 'pipe'] });

cf.on('error', (e) => {
  if (e.code === 'ENOENT') {
    console.error('\n❌ cloudflared not found. Install it (free):\n   macOS:   brew install cloudflared\n   Windows: winget install --id Cloudflare.cloudflared\n   Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n');
    console.error('Without it you can still demo over Wi-Fi (http://<laptop-ip>:%s), but phones lose shake/tilt (HTTPS required).\n', PORT);
  } else console.error(e);
  process.exit(0); // non-fatal: the server keeps running (LAN demo still works)
});
cf.on('exit', (c) => { console.error(`cloudflared exited (${c})`); process.exit(c ?? 1); });

cf.stderr.on('data', (buf) => {
  const m = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !url) {
    url = m[0];
    console.log(`\n🌐  Public HTTPS URL:  ${url}\n    Stage (open this on the laptop):  ${server}/stage\n    Phones: scan the QR on the Stage.\n`);
  }
});

async function announce() {
  if (!url) return;
  try { await fetch(`${server}/api/public-url`, { method: 'POST', body: JSON.stringify({ url }) }); } catch { /* server not up yet */ }
}
setInterval(announce, 3000);

process.on('SIGINT', () => { cf.kill(); process.exit(0); });
process.on('SIGTERM', () => { cf.kill(); process.exit(0); });
