/** Regression tests for the audible timeline, independent of client scores and network arrival. */
import assert from 'node:assert/strict';
import { GameConductor } from '../src/stage/gameconductor';
import { SONGS } from '../shared/songs';
import { buildChart, validateGameSong } from '../shared/game';
import { stepTime, type NoteEvent, type TransportState } from '../shared/protocol';
import { parseMidi } from '../src/stage/midi';
import { toGameSong } from '../src/stage/importsong';
import { Participation } from '../shared/participation';
import { toMidi, type Song } from '../src/stage/composer';

function performanceRun(delay: number | null, song = SONGS[0], secondPlayer = false, stopAt = Infinity) {
  let now = 0;
  const ts: TransportState = { bpm: song.bpm, epoch: 0, root: song.root, scale: song.scale, drop: null, autoBand: false, speakerMode: false, syncTest: false, freestyle: false, nowPlaying: null, sample: null, paused: null, recording: null,
    game: { song, difficulty: 'easy', songId: song.id, startStep: 32, endStep: 32 + song.bars * 16 } };
  const events: NoteEvent[] = [];
  const c = new GameConductor({ get isLocked() { return true; }, serverNow: () => now }, () => ts, (role) => role === 'melody' ? (secondPlayer ? ['human', 'idle'] : ['human']) : [], (ev) => {
    assert.ok(stepTime(ts, ev.step) - now >= 80, 'every note reaches the audio scheduler before its deadline');
    events.push(ev);
  }, false);
  let hit = 0;
  const chart = buildChart(song, 'melody', 'easy');
  for (; now < stepTime(ts, ts.game!.endStep) + 1000; now += 40) {
    if (delay !== null) while (hit < chart.length && hit < stopAt && now >= stepTime(ts, 32 + chart[hit].step) + delay) {
      c.hit(32, 32 + chart[hit].step, 'melody', 'human', chart[hit].id);
      hit++;
    }
    c.tick();
  }
  assert.equal(events.length, Object.values(song.tracks).flat().length, 'full arrangement survives easy charts and missed taps');
  return events;
}
const silent = performanceRun(null);
const timeline = (notes: NoteEvent[]) => notes.map(({ v: _, midi: _m, dur: _d, ...n }) => n);
for (const delay of [0, 80, 250, 800, 2500]) {
  const played = performanceRun(delay);
  assert.deepEqual(timeline(played), timeline(silent), `${delay} ms delayed taps never change order, timing, or note count`);
  if (delay <= 800) assert.ok(played.some((n, i) => n.v > silent[i].v), 'hits lift future dynamics');
  else assert.deepEqual(played, silent, 'stale hits have no effect');
}
const clean = performanceRun(0).filter((n) => n.role === 'melody');
const idle = silent.filter((n) => n.role === 'melody');
assert.ok(idle.some((n, i) => n.midi?.[0] !== clean[i].midi?.[0]), 'missing notes audibly detunes the instrument');
assert.ok(idle.some((n, i) => n.dur < clean[i].dur), 'missing notes weaken articulation');
const mixed = performanceRun(0, SONGS[0], true).filter((n) => n.role === 'melody');
assert.ok(mixed.some((n, i) => n.v < clean[i].v && n.v > idle[i].v), 'every member matters in a shared section');
const stopped = performanceRun(0, SONGS[0], false, 4).filter((n) => n.role === 'melody');
assert.equal(stopped.at(-1)!.v, idle.at(-1)!.v, 'stopping participation loses the restored sound');
console.log('✓ Audible detune, articulation, collective participation, stopping, stale packets and stable timeline');

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

// Imported MIDI uses exactly the same consequence path as built-in songs.
const sustained: Song = { ...imported, steps: 64, events: Array.from({ length: 16 }, (_, i) => ({ role: 'melody', rel: i * 4, d: 0, v: 0.8, dur: 4, midi: [60 + i % 5] })) };
const midiGame = toGameSong(parseMidi(toMidi(sustained).slice().buffer as ArrayBuffer, 'MIDI participation'), 'import:participation');
const midiIdle = performanceRun(null, midiGame);
const midiActive = performanceRun(0, midiGame);
assert.ok(midiIdle.some((n, i) => n.v < midiActive[i].v && n.midi?.[0] !== midiActive[i].midi?.[0]), '.mid inactivity must change the sound');
assert.deepEqual(midiActive.map((n) => n.midi), midiGame.tracks.melody.map((n) => n.midi), 'consistent hits preserve original MIDI pitches');

const ts: TransportState = { bpm: 120, epoch: 0, root: 0, scale: 'majorPent', drop: null, autoBand: false, speakerMode: false, syncTest: false, freestyle: false, nowPlaying: null, sample: null, paused: null, recording: null,
  game: { song: midiGame, songId: midiGame.id, difficulty: 'easy', startStep: 32, endStep: 96 } };
let now = 0;
const emitted: NoteEvent[] = [];
const conductor = new GameConductor({ isLocked: true, serverNow: () => now }, () => ts, (role) => role === 'melody' ? ['a'] : [], (n) => emitted.push(n), false);
conductor.tick();
now = stepTime(ts, 52); conductor.tick();
assert.equal(conductor.strength('melody'), 0, 'four misses fully weaken a part');
const count = emitted.length;
ts.paused = now; now += 10_000; conductor.tick();
assert.equal(emitted.length, count, 'pause emits no new notes');
assert.equal(conductor.strength('melody'), 0);
ts.epoch += now - ts.paused; ts.paused = null;
for (let id = 5; id <= 9; id++) {
  now = stepTime(ts, 32 + id * 4);
  conductor.hit(32, 32 + id * 4, 'melody', 'a', id);
  conductor.tick();
}
now += 520; conductor.tick();
assert.equal(conductor.strength('melody'), 1, 'four hits restore pitch and strength after pause');
const state = new Participation(midiGame, 'melody', 'easy', ts, now);
assert.equal(state.strength(ts, now), 1, 'late joiners are not charged old misses');
assert.equal(state.hit(0, 32, ts), false, 'pre-join notes cannot replenish strength');
assert.equal(state.hit(10, 999, ts), false, 'wrong step rejected');
assert.equal(state.hit(10, 72, ts), true);
assert.equal(state.hit(10, 72, ts), false, 'duplicate rejected');
const rested = { ...midiGame, tracks: { ...midiGame.tracks, melody: [{ step: 0, midi: [60], dur: 4, v: 1 }] } };
const rest = new Participation(rested, 'melody', 'easy', ts, 0);
rest.hit(0, 32, ts);
assert.equal(rest.strength(ts, now + 60_000), 1, 'rests do not drain participation');
console.log('✓ Imported MIDI consequences, original pitches on hits, pause/resume, recovery, late joins, rests, duplicate and invalid hits');

const shortParts: Song = { ...imported, events: [
  ...Array.from({ length: 5 }, (_, i) => ({ role: 'melody' as const, rel: i * 4, dur: 2, v: 0.8, d: 0, midi: [72] })),
  { role: 'melody', rel: 0, dur: 2, v: 0.8, d: 0, midi: [40, 60] },
] };
const split = parseMidi(toMidi(shortParts).slice().buffer as ArrayBuffer, 'short parts');
assert.ok(split.events.some((n) => n.midi?.includes(40)), 'short bass parts survive a single-channel split');
assert.ok(split.events.some((n) => n.midi?.includes(60)), 'short chord parts survive a single-channel split');
console.log('✓ Short bass and accompaniment parts survive MIDI import');

// Miss feedback: the stronger the loss, the stranger the part sounds; never the timing or the note count.
import { souring } from '../shared/participation';
{
  const steps = Array.from({ length: 400 }, (_, i) => i * 2);
  const pitchWrong = (loss: number) => steps.filter((s) => Math.abs(souring('melody', loss, s, 0).pitch) >= 0.9).length / steps.length;
  assert.deepEqual(souring('melody', 0, 17, 0), { pitch: 0, drum: 0, gain: 1, dur: 1 }, 'no misses leaves the written notes untouched');
  assert.ok(steps.every((s) => souring('melody', 0.25, s, 0).pitch !== 0), 'a single miss already bends the pitch');
  assert.ok(pitchWrong(0.25) < 0.25, 'one miss mostly bends the pitch; wrong notes are still rare');
  assert.ok(pitchWrong(1) > 0.4 && pitchWrong(1) > pitchWrong(0.5), 'more misses mean more wrong notes');
  assert.ok(souring('melody', 1, 4, 0).gain < souring('melody', 0.25, 4, 0).gain, 'misses thin the part');
  assert.deepEqual(souring('melody', 0.75, 9, 0), souring('melody', 0.75, 9, 0), 'deterministic per step');
  assert.ok(steps.some((s) => souring('drums', 1, s, 0).drum !== 0), 'a failing drummer plays the wrong pieces');
  assert.ok(steps.every((s) => souring('drums', 0, s, 1).drum === 1));
}
console.log('✓ Miss feedback: bend, wrong notes and thinning scale with misses; drums swap pieces; clean play is untouched');

// A part nobody answers goes silent: Easy/Medium fade between one and two bars, Hard cuts at two bars; a hit restores it.
{
  const notes = Array.from({ length: 24 }, (_, i) => ({ step: i * 4, dur: 2, v: 0.8, midi: [60 + (i % 5)] }));
  const song = validateGameSong({ id: 'import:quiet', title: 'quiet', artist: 't', bpm: 120, root: 0, scale: 'majorPent', bars: 8, rating: 1,
    tracks: { melody: notes, bass: [], pads: [], drums: [], guitar: [] } })!;
  const run = (difficulty: 'easy' | 'medium' | 'hard') => {
    const ts: TransportState = { bpm: 120, epoch: 0, root: 0, scale: 'majorPent', drop: null, autoBand: false, speakerMode: false, syncTest: false, freestyle: false, nowPlaying: null, sample: null, paused: null, recording: null,
      game: { song, difficulty, songId: song.id, startStep: 32, endStep: 32 + 8 * 16 } };
    const p = new Participation(song, 'melody', difficulty, ts, 0);
    const at = (chartStep: number) => stepTime(ts, 32 + chartStep) + 800; // that note has passed unanswered
    return { ts, p, at };
  };
  for (const d of ['easy', 'medium'] as const) {
    const { ts, p, at } = run(d);
    assert.equal(p.quiet(ts, at(8)), 1, `${d}: a short gap stays at full volume`);
    const mid = p.quiet(ts, at(24));
    assert.ok(mid > 0 && mid < 1, `${d}: between one and two bars the part fades (${mid.toFixed(2)})`);
    assert.equal(p.quiet(ts, at(40)), 0, `${d}: two bars unanswered is silence`);
    p.hit(10, 32 + chartAt(10), ts);
    assert.equal(p.quiet(ts, at(44)), 1, `${d}: one hit brings the part back`);
  }
  const hard = run('hard');
  assert.equal(hard.p.quiet(hard.ts, hard.at(28)), 1, 'hard: full volume until the cut');
  assert.equal(hard.p.quiet(hard.ts, hard.at(36)), 0, 'hard: cuts straight to silence after two bars');
  function chartAt(i: number) { return i * 4; }
  // silence is audible-free but never removes notes from the timeline
  const q = run('easy');
  q.p.quiet(q.ts, q.at(60));
  assert.equal(q.p.chart.length, 24);
}
console.log('✓ Unanswered parts fade (Easy/Medium) or cut (Hard) to silence and a hit restores them');
