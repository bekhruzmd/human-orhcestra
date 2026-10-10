/** Regression tests for the audible timeline, independent of client scores and network arrival. */
import assert from 'node:assert/strict';
import { GameConductor } from '../src/stage/gameconductor';
import { SONGS } from '../shared/songs';
import { buildChart, validateGameSong } from '../shared/game';
import { stepTime, type NoteEvent, type TransportState } from '../shared/protocol';
import { parseMidi } from '../src/stage/midi';
import { toGameSong } from '../src/stage/importsong';
import { toMidi, type Song } from '../src/stage/composer';

function performanceRun(delay: number | null) {
  const song = SONGS[0];
  let now = 0;
  const ts: TransportState = { bpm: song.bpm, epoch: 0, root: song.root, scale: song.scale, drop: null, autoBand: false, speakerMode: false, freestyle: false, nowPlaying: null, sample: null, recording: null,
    game: { difficulty: 'easy', songId: song.id, startStep: 32, endStep: 32 + song.bars * 16 } };
  const events: NoteEvent[] = [];
  const c = new GameConductor({ get isLocked() { return true; }, serverNow: () => now }, () => ts, () => 'human', (ev) => {
    assert.ok(stepTime(ts, ev.step) - now >= 80, 'every note reaches the audio scheduler before its deadline');
    events.push(ev);
  }, false);
  let hit = 0;
  const chart = buildChart(song, 'melody', 'easy');
  for (; now < stepTime(ts, ts.game!.endStep) + 1000; now += 40) {
    if (delay !== null) while (hit < chart.length && now >= stepTime(ts, 32 + chart[hit].step) + delay) {
      c.hit(32, 32 + chart[hit++].step, 'melody');
    }
    c.tick();
  }
  assert.equal(events.length, Object.values(song.tracks).flat().length, 'full arrangement survives easy charts and missed taps');
  return events;
}
const silent = performanceRun(null);
const timeline = (notes: NoteEvent[]) => notes.map(({ v: _, ...n }) => n);
for (const delay of [0, 80, 250, 800, 2500]) {
  const played = performanceRun(delay);
  assert.deepEqual(timeline(played), timeline(silent), `${delay} ms delayed taps never change pitches, order, timing, or note count`);
  if (delay <= 800) assert.ok(played.some((n, i) => n.v > silent[i].v), 'hits lift future dynamics');
  else assert.deepEqual(played, silent, 'stale hits have no effect');
}
console.log('✓ No taps and 0/80/250/800/2500 ms late taps: identical complete musical timelines; only future dynamics change');

// Independently encoded MIDI: three notes on a single channel, including running status.
function fixture(extra: number[] = []) {
  const track = [0, 0xff, 0x51, 3, 7, 0xa1, 0x20,
    0, 0x90, 60, 100, 96, 0x80, 60, 0,
    ...extra, 0, 0x90, 64, 90, 96, 64, 0,
    0, 0x90, 67, 80, 96, 0x80, 67, 0, 0, 0xff, 0x2f, 0];
  return new Uint8Array([77,84,104,100, 0,0,0,6, 0,0,0,1,0,96, 77,84,114,107,0,0,0,track.length,...track]).buffer;
}
const imported = parseMidi(fixture(), '<My tune>');
assert.deepEqual(imported.events.map((n) => n.midi), [[60], [64], [67]], 'short melody tracks must not disappear');
assert.deepEqual(imported.events.map((n) => n.rel), [0,4,8]);
const custom = toGameSong(imported, 'import:test');
assert.ok(validateGameSong(custom));
assert.equal(buildChart(custom, 'melody', 'easy').length, 3);
assert.throws(() => parseMidi(fixture([0,0xff,0x51,3,6,0x1a,0x80]), 'tempo change'), /changes tempo/);
assert.throws(() => parseMidi(fixture().slice(0,25), 'broken'), /Truncated/);
assert.equal(validateGameSong({ ...custom, bpm: NaN }), null);
assert.equal(validateGameSong({ ...custom, tracks: { ...custom.tracks, melody: [{ step: 0, dur: 1, v: 1, midi: [NaN] }] } }), null);
const longSong: Song = { ...imported, steps: 512, events: [...imported.events, { role: 'melody', rel: 400, dur: 4, d: 0, v: 0.8, midi: [72] }] };
const restored = parseMidi(toMidi(longSong).slice().buffer as ArrayBuffer, 'long song');
assert.ok(restored.events.some((n) => n.rel === 400), 'imports must not silently stop at 16 bars');
assert.deepEqual(toGameSong(imported, 'import:melody', true).tracks.melody.map((n) => n.midi), [[60],[64],[67]]);
console.log('✓ Independent MIDI fixture, short tracks, running status, long arrangements, melody import, malformed input and tempo-change rejection');

const partsSource: Song = { ...imported, events: [
  { role: 'melody', rel: 0, dur: 4, v: 0.8, d: 0, midi: [60] },
  { role: 'pads', rel: 0, dur: 4, v: 0.8, d: 0, midi: [84] },
] };
const partsBytes = toMidi(partsSource).slice().buffer as ArrayBuffer;
let parts: { id: string; label: string }[] = [];
parseMidi(partsBytes, 'parts', { onParts: (p) => { parts = p; } });
assert.equal(parts.length, 2);
const selected = parseMidi(partsBytes, 'parts', { melodyPart: parts[1].id });
assert.deepEqual(toGameSong(selected, 'import:part', true).tracks.melody[0].midi, [60], 'manual melody selection must override the highest-pitch heuristic');
console.log('✓ Manual melody-part selection preserves the selected lead rather than the highest accompaniment');
