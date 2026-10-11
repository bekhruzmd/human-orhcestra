/**
 * Room codes: boots the real server and checks that rooms are isolated, that only a Stage can create one, and
 * that clients without a code still land in the original shared room.
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import type { ClientMsg, ServerMsg } from '../shared/protocol.js';

const PORT = 3990;
const server = spawn('node', ['--import', 'tsx', 'server/index.ts'], {
  env: { ...process.env, PORT: String(PORT), VERCEL: '', DOTENV_CONFIG_PATH: '/dev/null', GEMINI_API_KEY: '', DATABASE_URL: '', POSTGRES_URL: '', NEON_DATABASE_URL: '', POSTGRES_URL_NON_POOLING: '' },
  stdio: 'ignore',
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok: boolean, name: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failed++; };

class Client {
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  inbox: ServerMsg[] = [];
  constructor() { this.ws.on('message', (d) => this.inbox.push(JSON.parse(d.toString()))); }
  open() { return new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); }); }
  send(m: ClientMsg) { this.ws.send(JSON.stringify(m)); }
  last<T extends ServerMsg['t']>(t: T) { return [...this.inbox].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined; }
}
async function connect(hello: ClientMsg) { const c = new Client(); await c.open(); c.send(hello); await sleep(250); return c; }

async function main() {
  for (let i = 0; i < 50; i++) { try { await (await connect({ t: 'hello', kind: 'player' })).ws.close(); break; } catch { await sleep(200); } }

  const stageA = await connect({ t: 'hello', kind: 'stage', room: 'aaaa', create: true });
  const stageB = await connect({ t: 'hello', kind: 'stage', room: 'BBBB', create: true });
  check(stageA.last('welcome')?.room === 'AAAA' && stageB.last('welcome')?.room === 'BBBB', 'stages create rooms; codes are upper-cased');

  const pA = await connect({ t: 'hello', kind: 'player', id: 'p1', room: 'AAAA' });
  check(pA.last('welcome')?.room === 'AAAA', 'phone joins an existing room');
  pA.send({ t: 'join', name: 'Ada' }); await sleep(1300);
  check(stageA.last('roster')?.players.some((p) => p.name === 'Ada') === true, 'room A stage sees the phone');
  check((stageB.last('roster')?.players.length ?? 0) === 0, 'room B stage does not');

  stageA.send({ t: 'cmd', cmd: 'bpm', value: 140 }); await sleep(250);
  check(stageA.last('state')?.state.bpm === 140, 'tempo command applies in room A');
  check(stageB.last('state')?.state.bpm === undefined || stageB.last('state')!.state.bpm !== 140, 'tempo in room B unchanged');
  check(pA.last('state')?.state.bpm === 140, 'phone in room A hears it');

  stageB.inbox.length = 0;
  pA.send({ t: 'note', step: 100000, d: 3, v: 0.8, dur: 2 }); await sleep(250);
  check(!stageB.inbox.some((m) => m.t === 'note'), 'notes do not leak into room B');

  const typo = await connect({ t: 'hello', kind: 'player', room: 'ZZZZ' });
  check(typo.last('error')?.code === 'noroom' && !typo.last('welcome'), 'unknown code: error, no room created');
  const sneaky = await connect({ t: 'hello', kind: 'player', room: 'ZZZZ', create: true });
  check(sneaky.last('error')?.code === 'noroom', 'a phone cannot create a room');
  const bad = await connect({ t: 'hello', kind: 'player', room: 'a!' });
  check(bad.last('error')?.code === 'badroom', 'malformed code is rejected');

  const legacy = await connect({ t: 'hello', kind: 'player', id: 'old' });
  check(legacy.last('welcome')?.room === '' , 'no code => original shared room');
  legacy.send({ t: 'join', name: 'Old' }); await sleep(1300);
  check(!stageA.last('roster')?.players.some((p) => p.name === 'Old'), 'shared room is separate from coded rooms');

  const before = pA.inbox.length;
  pA.send({ t: 'note', step: 1, d: 1, v: 1, dur: 2 });
  const silent = await connect({ t: 'hello', kind: 'player', id: 'x', room: 'AAAA' });
  silent.send({ t: 'hello', kind: 'player', id: 'x', room: 'BBBB' }); await sleep(250);
  check(silent.last('welcome')?.room === 'AAAA' && silent.inbox.filter((m) => m.t === 'welcome').length === 1, 'a socket cannot hop rooms with a second hello');
  void before;

  const pB = await connect({ t: 'hello', kind: 'player', id: 'p2', room: 'BBBB' });
  const profile = { name: 'Player', interests: ['music'], musicalTastes: ['jazz'], vibe: 'calm' };
  const timestamp = Date.now();
  pA.send({ t: 'bump_spike', timestamp, profile });
  pB.send({ t: 'bump_spike', timestamp, profile });
  await sleep(100);
  check(!pA.last('bump_matched') && !pB.last('bump_matched'), 'phones on the same network cannot bump across rooms');
  silent.send({ t: 'bump_spike', timestamp, profile });
  await sleep(100);
  const match = pA.last('bump_matched');
  check(!!match && match.roomId === silent.last('bump_matched')?.roomId, 'phones in the same room can bump');
  if (match) {
    pA.send({ t: 'bump_start_jam', roomId: match.roomId, song_id: 'neon' });
    await sleep(100);
    check(!stageA.last('state')?.state.game, 'bump game waits for mutual confirmation');
    pA.send({ t: 'bump_confirm', roomId: match.roomId, profile });
    silent.send({ t: 'bump_confirm', roomId: match.roomId, profile });
    await sleep(150);
    check(!!pA.last('bump_reveal') && !!silent.last('bump_reveal'), 'confirmed pair receives a song recommendation');
    pA.send({ t: 'bump_start_jam', roomId: match.roomId, song_id: 'neon' });
    await sleep(150);
    const game = stageA.last('state')?.state.game;
    check(game?.songId === 'neon', 'bump starts the game in the paired room');
    check(!stageB.last('state')?.state.game, 'bump game does not affect another room');
    silent.send({ t: 'bump_start_jam', roomId: match.roomId, song_id: 'ode' });
    await sleep(100);
    check(stageA.last('state')?.state.game?.startStep === game?.startStep && stageA.last('state')?.state.game?.songId === 'neon', 'second partner cannot restart the bump game');
  }

  for (const c of [stageA, stageB, pA, pB, typo, sneaky, bad, legacy, silent]) c.ws.close();
}

main().catch((e) => { console.error(e); failed++; }).finally(() => { server.kill(); console.log(failed ? `\n${failed} FAILED` : '\nall room checks passed'); process.exit(failed ? 1 : 0); });
