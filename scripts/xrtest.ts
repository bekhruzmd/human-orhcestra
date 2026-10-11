/**
 * Integration test for the VR page's networking: starts this repo's server (no DB) and drives the VR adapter
 * against it with a scripted phone.   npm run xrtest
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

(globalThis as any).location = { protocol: 'http:', host: 'localhost' };

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxBin = path.join(repo, 'node_modules/.bin/tsx');
if (!fs.existsSync(tsxBin)) { console.log('SKIP: server entry not found at', repo); process.exit(0); }

const PORT = 3987;
const env = { ...process.env, PORT: String(PORT) } as Record<string, string | undefined>;
for (const k of ['DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL', 'POSTGRES_URL_NON_POOLING']) delete env[k];
const server = spawn(tsxBin, ['server/index.ts'], { cwd: repo, env: env as NodeJS.ProcessEnv, stdio: 'pipe' });
let serverOut = '';
server.stdout.on('data', (d) => (serverOut += d));
server.stderr.on('data', (d) => (serverOut += d));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 6000, what = 'condition') => {
  const t = Date.now();
  while (!f()) { if (Date.now() - t > ms) throw new Error('timeout waiting for ' + what + '\n' + serverOut); await sleep(25); }
};

async function main() {
  await until(() => /listening|http:\/\/|Local/i.test(serverOut) || serverOut.length > 0, 15000, 'server start');
  await sleep(500);

  const { orchestra, clock } = await import('../src/xr/networking/orchestraAdapter');
  const { useStore } = await import('../src/xr/state/store');
  const { activity } = await import('../src/xr/state/activity');
  const url = `ws://localhost:${PORT}/ws`;

  // 1. observer connects and is verified
  assert.equal(orchestra.connect(url, 'observer'), null);
  await until(() => useStore.getState().status === 'connected', 6000, 'XR connected');
  assert.equal(useStore.getState().mode, 'live');
  assert.ok(useStore.getState().transport!.bpm > 0);
  await until(() => clock.locked, 4000, 'clock lock');
  console.log('ok  observer connected, bpm', useStore.getState().transport!.bpm, 'rtt', clock.rtt.toFixed(1), 'ms');

  // 2. a scripted phone joins; XR must see the roster
  const phone = new WebSocket(url);
  await new Promise((r) => phone.once('open', r));
  phone.send(JSON.stringify({ t: 'hello', kind: 'player', id: 'test-phone-1' }));
  phone.send(JSON.stringify({ t: 'join', name: 'TestPhone' }));
  await until(() => useStore.getState().roster.some((p) => p.name === 'TestPhone'), 4000, 'roster');
  const me = useStore.getState().roster.find((p) => p.name === 'TestPhone')!;
  console.log('ok  roster shows', me.name, 'as', me.role);

  // 3. the phone plays a note; XR must light the matching instrument
  const ts = useStore.getState().transport!;
  const stepNow = Math.ceil((clock.serverNow(performance.now()) - ts.epoch) / (60000 / ts.bpm / 4)) + 2;
  const before = activity.counts[me.role];
  phone.send(JSON.stringify({ t: 'note', step: stepNow, d: me.role === 'drums' ? 0 : 1, v: 0.9, dur: 2 }));
  const t0 = performance.now();
  await until(() => { orchestra.tick(0.016); return activity.counts[me.role] > before; }, 4000, 'note → activity');
  console.log('ok  note reached', me.role, 'visuals after', Math.round(performance.now() - t0), 'ms (scheduled for its step)');

  // 4. observer cannot command
  assert.equal(orchestra.command('pause', true), false);
  console.log('ok  observer is read-only (command refused locally)');

  // 4b. conductor mode: commands must change the server's authoritative transport
  orchestra.disconnect();
  assert.equal(orchestra.connect(url, 'conductor'), null);
  await until(() => useStore.getState().status === 'connected', 6000, 'conductor connected');
  assert.equal(orchestra.command('pause', true), true);
  await until(() => useStore.getState().transport!.paused != null, 3000, 'server paused');
  assert.equal(orchestra.command('pause', false), true);
  await until(() => useStore.getState().transport!.paused == null, 3000, 'server resumed');
  assert.equal(orchestra.command('bpm', 123), true);
  await until(() => Math.round(useStore.getState().transport!.bpm) === 123, 3000, 'server bpm 123');
  assert.equal(orchestra.command('drop'), true);
  await until(() => useStore.getState().transport!.drop != null, 3000, 'server drop');
  console.log('ok  conductor pause/resume, tempo and beat drop changed the real transport');


  // 4d. connection severed mid-session: XR reconnects by itself and subscribes exactly once
  const net = await import('node:net');
  const socks = new Set<import('node:net').Socket>();
  let accepting = true;
  const proxy = net.createServer((c) => {
    if (!accepting) return void c.destroy();
    const up = net.connect(PORT, '127.0.0.1'); socks.add(c); socks.add(up);
    c.pipe(up); up.pipe(c); c.on('error', () => {}); up.on('error', () => {});
  }).listen(3989);
  orchestra.disconnect();
  assert.equal(orchestra.connect('ws://localhost:3989/ws', 'observer'), null);
  await until(() => useStore.getState().status === 'connected', 6000, 'proxy connect');
  accepting = false; socks.forEach((x) => x.destroy());
  await until(() => useStore.getState().status === 'reconnecting', 4000, 'reconnecting state');
  accepting = true;
  await until(() => useStore.getState().status === 'connected', 8000, 'auto reconnect');
  await until(() => useStore.getState().roster.some((p) => p.name === 'TestPhone2'), 1, 'noop').catch(() => {});
  const phone2 = new WebSocket(url);
  await new Promise((r) => phone2.once('open', r));
  phone2.send(JSON.stringify({ t: 'hello', kind: 'player', id: 'test-phone-2' }));
  phone2.send(JSON.stringify({ t: 'join', name: 'TestPhone2' }));
  await until(() => useStore.getState().roster.some((p) => p.name === 'TestPhone2'), 4000, 'roster after reconnect');
  const p2 = useStore.getState().roster.find((p) => p.name === 'TestPhone2')!;
  activity.clear();
  const ts2 = useStore.getState().transport!;
  const step2 = Math.ceil((clock.serverNow(performance.now()) - ts2.epoch) / (60000 / ts2.bpm / 4)) + 2;
  phone2.send(JSON.stringify({ t: 'note', step: step2, d: 0, v: 0.9, dur: 2 }));
  await until(() => { orchestra.tick(0.016); return activity.counts[p2.role] > 0; }, 4000, 'note after reconnect');
  for (let i = 0; i < 40; i++) { orchestra.tick(0.016); await sleep(15); }
  assert.equal(activity.counts[p2.role], 1, 'one note must produce exactly one visual (no duplicate subscription)');
  console.log('ok  severed connection -> auto reconnect, one note = one event');
  phone2.close(); proxy.close(); socks.forEach((x) => x.destroy());

  // 4e. a Jam started on the Stage carries its MIDI tracks in the transport: XR visualises them from that real data
  orchestra.disconnect();
  assert.equal(orchestra.connect(url, 'observer'), null);
  await until(() => useStore.getState().status === 'connected', 6000, 'reconnect for jam');
  activity.clear();
  const stage = new WebSocket(url);
  await new Promise((r) => stage.once('open', r));
  stage.send(JSON.stringify({ t: 'hello', kind: 'stage' }));
  const empty = { drums: [], bass: [], melody: [] as any[], pads: [], guitar: [] };
  empty.melody = Array.from({ length: 24 }, (_, i) => ({ step: i * 2, dur: 2, v: 0.8, midi: [60 + (i % 7)] }));
  stage.send(JSON.stringify({ t: 'jam', action: 'start', song: { id: 'import:e2e', title: 'E2E Song', artist: 'x', bpm: 100, rating: 1, bars: 3, root: 9, scale: 'minorPent', tracks: empty } }));
  await until(() => useStore.getState().transport?.nowPlaying != null, 4000, 'jam in transport');
  await until(() => { orchestra.tick(0.016); return activity.counts.melody >= 3; }, 9000, 'song notes → melody visuals');
  console.log('ok  jam track notes visualised from broadcast song data:', activity.counts.melody, 'melody notes,', (await import('../src/xr/networking/orchestraAdapter')).songPlayer.source);
  stage.send(JSON.stringify({ t: 'jam', action: 'stop' }));
  stage.close();

  // 5. drop the server-side socket of XR: must reconnect
  orchestra.disconnect();
  assert.equal(useStore.getState().status, 'idle');
  phone.close();
  console.log('ok  clean disconnect');

  // 6. wrong endpoint is rejected, not trusted
  const bad = new (await import('ws')).WebSocketServer({ port: 3988 });
  bad.on('connection', (s) => s.send('{"hello":"not orchestra"}'));
  orchestra.connect('ws://localhost:3988/ws', 'observer');
  await until(() => useStore.getState().status === 'error', 8000, 'reject non-orchestra server');
  console.log('ok  non-Orchestra endpoint rejected:', useStore.getState().error);
  orchestra.disconnect(); bad.close();
}

main().then(() => { console.log('ALL PASSED'); }).catch((e) => { console.error('FAILED', e); process.exitCode = 1; })
  .finally(() => { server.kill(); setTimeout(() => process.exit(process.exitCode ?? 0), 200); });
