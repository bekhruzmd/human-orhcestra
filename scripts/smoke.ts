/** Protocol smoke test against a running server (npm run serve): sync, seating, relay, reconnect. */
import WebSocket from 'ws';
import { emptyStats } from '../shared/game';
import { stepTime } from '../shared/protocol';
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

// Malformed clients must not crash the room or poison the transport.
for (const value of [null, [], 5, { t: 'gstats' }, { t: 'stats', stats: {} }, { t: 'note', step: 1, d: null }]) phones[0].ws.send(JSON.stringify(value));
stage.ws.send(JSON.stringify({ t: 'cmd', cmd: 'bpm', value: 'invalid' }));
await sleep(100);
check(Number.isFinite(stage.ts?.bpm), 'malformed messages leave the room and transport healthy');

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

// Imported songs are distributed once with the start; legacy notes never reach the audio path.
const imported = { id: 'import:smoke', title: 'Imported tune', artist: 'Test', bpm: 120, bars: 4, root: 0, scale: 'majorPent', rating: 1,
  tracks: { drums: [], bass: [], pads: [], melody: [{ step: 0, dur: 4, v: 0.8, midi: [60] }, { step: 4, dur: 4, v: 0.8, midi: [64] }] } };
stage.ws.send(JSON.stringify({ t: 'game', action: 'start', song: imported, difficulty: 'easy' }));
await sleep(200);
check(stage.ts?.game?.song?.tracks.melody[1].midi?.[0] === 64, 'custom arrangement reaches clients without repitching');
check(phones[0].me.role === 'melody' && again.me.role === 'melody', 'players move to an instrument present in a melody-only import');
const late = client('player', 'late-import');
await sleep(200);
late.ws.send(JSON.stringify({ t: 'join', name: 'Late' }));
await sleep(200);
check(late.me?.role === 'melody', 'late joiner gets a playable imported-song role');
const noteCount = stage.log.filter((m) => m.t === 'note').length;
phones[0].ws.send(JSON.stringify({ t: 'note', step: stage.ts!.game!.startStep, d: 0, v: 1, dur: 1, midi: [60] }));
await sleep(100);
check(stage.log.filter((m) => m.t === 'note').length === noteCount, 'legacy game note packets cannot duplicate or scramble the arrangement');
stage.ws.send(JSON.stringify({ t: 'game', action: 'start', song: { ...imported, bpm: 0 }, difficulty: 'easy' }));
await sleep(100);
check(stage.log.some((m) => m.t === 'error') && stage.ts?.game?.song?.bpm === 120, 'invalid import produces an error without replacing the active song');
const firstStart = stage.ts!.game!.startStep;
const stats = { ...emptyStats(2), score: 100, perfect: 1, combo: 1, maxCombo: 1 };
phones[0].ws.send(JSON.stringify({ t: 'gstats', startStep: firstStart, s: stats }));
await sleep(1100);
check(stage.log.filter((m) => m.t === 'roster').at(-1)!.players.find((p) => p.id === 'p-a')?.game?.score === 100, 'current performance stats reach the Stage');
const waitForNote = stepTime(stage.ts!, firstStart) - stage.clock.serverNow();
if (waitForNote > 0) await sleep(waitForNote);
for (const packet of [
  { t: 'ghit', startStep: firstStart, step: firstStart, noteId: 999 },
  { t: 'ghit', startStep: firstStart, step: firstStart, noteId: 1 },
  { t: 'ghit', startStep: firstStart - 16, step: firstStart, noteId: 0 },
  { t: 'gstats', startStep: firstStart },
]) phones[0].ws.send(JSON.stringify(packet));
for (let i = 0; i < 2; i++) phones[0].ws.send(JSON.stringify({ t: 'ghit', startStep: firstStart, step: firstStart, noteId: 0 }));
await sleep(100);
check(stage.log.filter((m) => m.t === 'ghit').length === 1, 'invalid and stale hits rejected; duplicate note hits relay only once');
stage.ws.send(JSON.stringify({ t: 'game', action: 'start', song: imported, difficulty: 'easy' }));
await sleep(100);
check(stage.ts!.game!.startStep !== firstStart, 'restart gets a distinct performance identity');
phones[0].ws.send(JSON.stringify({ t: 'gstats', startStep: firstStart, s: stats }));
await sleep(1100);
check(stage.log.filter((m) => m.t === 'roster').at(-1)!.players.find((p) => p.id === 'p-a')?.game === null, 'old performance reports cannot contaminate a restart');
stage.ws.send(JSON.stringify({ t: 'game', action: 'stop' }));
await sleep(100);
check(stage.ts?.game === null, 'stop clears imported game');

// Melody jams allow live accompaniment while reserving the imported lead.
const jamSong = { ...imported, tracks: { ...imported.tracks, bass: [{ step: 0, dur: 16, v: 0.8, midi: [36] }], guitar: [] } };
phones[0].ws.send(JSON.stringify({ t: 'jam', action: 'start', song: jamSong }));
await sleep(100);
check(stage.ts?.nowPlaying === null, 'phones cannot start a jam without the host');
stage.ws.send(JSON.stringify({ t: 'jam', action: 'start', song: jamSong }));
await sleep(150);
check(stage.ts?.nowPlaying?.mode === 'jam' && stage.ts.game === null && !stage.ts.autoBand, 'jam starts atomically with automatic backing disabled');
check(phones[0].me.role === 'guitar', 'melody players get guitar while the imported lead loops');
const jamState = stage.ts!.nowPlaying;
const jamStart = jamState?.mode === 'jam' ? jamState.startStep : -1;
const jamNotes = stage.log.filter((m) => m.t === 'note').length;
phones[0].ws.send(JSON.stringify({ t: 'note', step: Math.ceil(stepPos(stage.ts!, stage.clock.serverNow())) + 2, d: 0, v: 0.8, dur: 3 }));
await sleep(100);
const strum = stage.log.filter((m) => m.t === 'note').at(-1);
check(stage.log.filter((m) => m.t === 'note').length === jamNotes + 1 && strum?.role === 'guitar' && strum.midi?.length === 3, 'live guitar strums relay with server-resolved chord pitches');
phones[0].ws.send(JSON.stringify({ t: 'role', role: 'bass' }));
phones[1].ws.send(JSON.stringify({ t: 'role', role: 'melody' }));
stage.ws.send(JSON.stringify({ t: 'cmd', cmd: 'bpm', value: 70 }));
await sleep(100);
check(phones[0].me.role === 'bass' && stage.ts?.bpm === 120, 'jam players can change accompaniment instruments while the MIDI tempo stays locked');
const jamLate = client('player', 'late-jam');
await sleep(100); jamLate.ws.send(JSON.stringify({ t: 'join', name: 'Jam late' }));
await sleep(150);
check(jamLate.ts?.nowPlaying?.mode === 'jam' && jamLate.me?.role !== 'melody', 'late joiners receive the jam and an accompaniment role');
stage.ws.send(JSON.stringify({ t: 'cmd', cmd: 'pause', value: true }));
await sleep(100);
const beforePauseNote = stage.log.filter((m) => m.t === 'note').length;
phones[0].ws.send(JSON.stringify({ t: 'note', step: jamStart, d: 0, v: 1, dur: 3 }));
await sleep(100);
check(stage.log.filter((m) => m.t === 'note').length === beforePauseNote, 'paused jams reject live notes');
stage.ws.send(JSON.stringify({ t: 'jam', action: 'start', song: { ...jamSong, tracks: { ...jamSong.tracks, melody: [] } } }));
await sleep(100);
check(stage.ts?.nowPlaying?.mode === 'jam' && stage.ts.nowPlaying.startStep === jamStart, 'missing melody cannot replace a working jam');
stage.ws.send(JSON.stringify({ t: 'jam', action: 'stop' }));
await sleep(100);
check(stage.ts?.nowPlaying === null && stage.ts.paused === null, 'stopping a paused jam returns to free play');
jamLate.ws.close();

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
