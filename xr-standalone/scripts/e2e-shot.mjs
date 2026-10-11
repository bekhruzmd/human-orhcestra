// Dev tool: drives the desktop preview in headless Chrome against a real Orchestra, with 5 scripted phones playing.
//   XR_URL=https://localhost:5173 ORCH_WS=ws://localhost:3977/ws node scripts/e2e-shot.mjs out-dir
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import fs from 'node:fs';

const XR = process.env.XR_URL ?? 'https://localhost:5173';
const ORCH = process.env.ORCH_WS ?? 'ws://localhost:3977/ws';
const out = process.argv[2] ?? '.';
fs.mkdirSync(out, { recursive: true });

const phones = ['drums', 'bass', 'melody', 'pads', 'guitar'].map((r, i) => {
  const ws = new WebSocket(ORCH);
  const p = { ws, role: r, ts: null, off: 0 };
  ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', kind: 'player', id: `e2e-${i}` })); ws.send(JSON.stringify({ t: 'join', name: `Phone ${i + 1}` }));
    setInterval(() => ws.send(JSON.stringify({ t: 'ping', id: 1, c0: 0 })), 1000); });
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'welcome' || m.t === 'state') p.ts = m.state; if (m.t === 'pong') p.off = m.s - performance.now(); });
  return p;
});
const tick = setInterval(() => {
  for (const [i, p] of phones.entries()) {
    if (!p.ts || p.ws.readyState !== 1) continue;
    const sm = 60000 / p.ts.bpm / 4;
    const step = Math.ceil((performance.now() + p.off - p.ts.epoch) / sm) + 2;
    if ((step + i) % 2) continue;
    p.ws.send(JSON.stringify({ t: 'note', step, d: step % (p.role === 'drums' ? 5 : 4), v: 0.8, dur: 2 }));
  }
}, 120);

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(XR);
await page.waitForSelector('.card');
await page.screenshot({ path: `${out}/1-connect.png` });
await page.click('button.primary');                       // address defaults to the /ws bridge
await page.waitForSelector('.hud', { timeout: 10000 });
await page.waitForTimeout(3500);
await page.screenshot({ path: `${out}/2-live.png` });
console.log('HUD text:\n' + (await page.innerText('.hud')).replace(/\n+/g, ' | '));
await page.click('button.ghost:has-text("Disconnect")'); await page.waitForSelector('.card');
await page.waitForTimeout(400);
await page.click('button.ghost:has-text("Preview with simulation")');
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/3-simulation.png` });
console.log('errors:', errors.length ? errors : 'none');
clearInterval(tick); phones.forEach((p) => p.ws.close()); await browser.close(); process.exit(0);
