// Feed the composer a deliberately sloppy jam and check it recovers tempo + key and produces a sane song.
import { analyze, arrange, toMidi, type RawEv } from '../src/stage/composer';
import { parseMidi } from '../src/stage/midi';
import { SCALE_INTERVALS } from '../shared/music';

let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failed++; };
const rnd = (a: number) => (Math.random() - 0.5) * 2 * a;

// A minor pentatonic (A C D E G) => melody x positions; true tempo 120 BPM, +-60 ms human timing error, uneven holds.
const pent = [57, 60, 62, 64, 67, 69, 72, 74].map((m) => m); // midi values we want; melody range is 60..84
const wanted = [69, 72, 74, 76, 79, 76, 74, 72, 69, 72, 76, 79, 81, 79, 76, 72]; // A C D E G A... in A minor pent
const xFor = (m: number) => (m - 60) / 24;
const log: RawEv[] = [];
const eighth = 250; // 120 BPM
let t = 10_000;
for (let rep = 0; rep < 4; rep++) wanted.forEach((m, i) => {
  const at = t + (rep * 16 + i) * eighth + rnd(60);
  log.push({ pid: 'a', role: 'melody', k: 'd', at, x: xFor(m) + rnd(0.01), y: 0.6 });
  log.push({ pid: 'a', role: 'melody', k: 'u', at: at + 120 + Math.random() * 100, x: xFor(m), y: 0.6 });
});
for (let i = 0; i < 16; i++) log.push({ pid: 'd', role: 'drums', k: 's', at: t + i * 500 + rnd(70), x: 0.5, y: 0.5, v: i % 2 ? 0.6 : 0.85 });

const players = [{ id: 'a', name: 'Ada', color: '#ff4d6d', role: 'melody' as const }, { id: 'd', name: 'Dan', color: '#35d0ff', role: 'drums' as const }];
const d = analyze(log, players)!;
console.log(`detected ${d.bpm} BPM, root ${d.root}, ${d.scale}, energy ${d.energy.toFixed(2)}`);
check(Math.abs(d.bpm - 120) <= 3 || Math.abs(d.bpm - 60) <= 1.5, 'tempo within 3 BPM of 120 (or half-time)');
const inA = new Set([9, 0, 2, 4, 7]);
check(new Set(SCALE_INTERVALS[d.scale].map((i) => (d.root + i) % 12)).size > 0 && [...inA].every((pc) => SCALE_INTERVALS[d.scale].map((i) => (d.root + i) % 12).includes(pc)), 'detected scale contains every note that was played');

const song = arrange(d, 64);
const mel = song.events.filter((e) => e.role === 'melody');
const inKey = new Set(SCALE_INTERVALS[song.scale].map((i) => (song.root + i) % 12));
check(mel.length >= 16 && mel.every((e) => inKey.has(e.midi![0] % 12)), `melody: ${mel.length} notes, all in key`);
check(mel.every((e) => e.rel >= 0 && e.rel < song.steps), 'all events inside the loop');
check(['bass', 'pads', 'drums'].every((r) => song.events.some((e) => e.role === r)), 'band: bass, pads, drums all present');
check(song.steps % 64 === 0, 'loop length keeps the 4-bar chord loop aligned');

// MIDI round trip (our own export -> our own importer)
const mid = toMidi(song);
const back = parseMidi(mid.slice().buffer as ArrayBuffer, 'roundtrip');
check(Math.abs(back.bpm - song.bpm) <= 1, `MIDI round trip keeps tempo (${back.bpm})`);
check(back.events.length > 20 && back.events.some((e) => e.role === 'drums'), `MIDI round trip: ${back.events.length} events incl. drums`);

// Degenerate input must not crash
check(analyze([], players) === null, 'empty jam -> null (UI asks to play more)');
console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
