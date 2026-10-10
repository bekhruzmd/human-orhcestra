/** Protocol smoke test against a running server (npm run serve): sync, seating, relay, reconnect. */
import WebSocket from 'ws';
import { ClockSync } from '../src/common/clock';
import { stepPos, type ServerMsg, type TransportState } from '../shared/protocol';

const URL = process.env.URL ?? 'ws://localhost:3000/ws';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failed++; };

function client(kind: 'stage' | 'player', id?: string) {
  const ws = new WebSocket(URL);
  const log: ServerMsg[] = [];
  const c: { ws: WebSocket; log: ServerMsg[]; clock: ClockSync; ts?: TransportState; me?: any } = {
    ws, log, clock: new ClockSync((m) => ws.send(JSON.stringify(m))),
  };
  ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', kind, id })); c.clock.start(true); });
  ws.on('message', (raw) => {
    const m: ServerMsg = JSON.parse(raw.toString());
    if (m.t === 'pong') return c.clock.onPong(m);
    log.push(m);
    if (m.t === 'welcome') { c.ts = m.state; c.me = m.you; }
    if (m.t === 'state') c.ts = m.state;
    if (m.t === 'you') c.me = m.you;
  });
  return c;
}

const stage = client('stage');
const phones = ['a', 'b', 'c', 'd', 'e'].map((x) => client('player', 'p-' + x));
await sleep(1500);
phones.forEach((p, i) => p.ws.send(JSON.stringify({ t: 'join', name: 'P' + i })));
await sleep(500);
check(phones.slice(0, 4).map((p) => p.me?.role).join() === 'drums,bass,melody,pads', 'roles assigned in order drums,bass,melody,pads');
check(new Set(phones.map((p) => p.me?.color)).size >= 5, 'colours unique');
check(stage.log.some((m) => m.t === 'roster' && m.players.length === 5), 'stage sees 5 players');
check(phones.every((p) => p.clock.isLocked), 'all clocks locked');
const errs = phones.map((p) => Math.abs((p.clock.serverNow() - stage.clock.serverNow())));
check(Math.max(...errs) < 3, `phone/stage server-time estimates agree (max diff ${Math.max(...errs).toFixed(2)} ms)`);

// note relay + guardrails
const cur = stepPos(stage.ts!, stage.clock.serverNow());
phones[2].ws.send(JSON.stringify({ t: 'note', step: Math.ceil(cur) + 2, d: 3, v: 0.8, dur: 2 }));
phones[2].ws.send(JSON.stringify({ t: 'note', step: Math.ceil(cur) + 9999, d: 3, v: 0.8, dur: 2 }));
await sleep(200);
const notes = stage.log.filter((m) => m.t === 'note');
check(notes.length === 1 && (notes[0] as any).role === 'melody', 'stage got exactly 1 note (far-future one rejected)');
check(!phones[2].log.some((m) => m.t === 'note'), 'sender does not get its own note echoed');

// conductor: bpm change keeps the step position continuous
const before = stepPos(stage.ts!, stage.clock.serverNow());
stage.ws.send(JSON.stringify({ t: 'cmd', cmd: 'bpm', value: 140 }));
await sleep(100);
const after = stepPos(stage.ts!, stage.clock.serverNow());
check(stage.ts!.bpm === 140 && Math.abs(after - before - 0.1 / (60 / 140 / 4)) < 0.6, 'BPM change keeps step position continuous');
phones[0].ws.send(JSON.stringify({ t: 'cmd', cmd: 'bpm', value: 70 }));
await sleep(100);
check(stage.ts!.bpm === 140, 'players cannot use conductor commands');

// reconnect keeps the seat
phones[1].ws.terminate();
await sleep(300);
check(stage.log.filter((m) => m.t === 'roster').at(-1)!.players.find((p: any) => p.id === 'p-b')?.connected === false, 'dropped phone shown offline');
const again = client('player', 'p-b');
await sleep(600);
check(again.me?.role === 'bass' && again.me?.name === 'P1', 'reconnect restores role + name');

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
