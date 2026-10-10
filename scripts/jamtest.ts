import assert from 'node:assert/strict';
import { jamHarmony, melodyBacking } from '../shared/jam';
import { chordAt, resolveEvent, padLabels, COLS, NOTE_DUR, FREE_RANGE } from '../shared/music';
import { validateGameSong, type GameSong } from '../shared/game';
import { liveNotesAllowed, stepTime, type TransportState, type NoteEvent } from '../shared/protocol';
import { SongPlayer } from '../src/stage/song';
import { toLoopSong, toGameSong } from '../src/stage/importsong';
import { toMidi } from '../src/stage/composer';
import { parseMidi } from '../src/stage/midi';

const song: GameSong = {
  id: 'import:jam-test', title: 'C to F', artist: 'Test', rating: 1, root: 0, scale: 'majorPent', bpm: 120, bars: 4,
  tracks: {
    melody: [0, 4, 8, 12, 16, 20, 24, 28].map((step) => ({ step, dur: 2, v: 0.8, midi: [step < 16 ? 76 : 77] })),
    bass: [{ step: 0, dur: 16, v: 0.8, midi: [36] }, { step: 16, dur: 16, v: 0.8, midi: [41] }],
    pads: [{ step: 0, dur: 16, v: 0.6, midi: [60, 64, 67] }, { step: 16, dur: 16, v: 0.6, midi: [65, 69, 72] }],
    drums: [{ step: 0, dur: 1, v: 1, d: 0 }],
    guitar: [{ step: 8, dur: 3, v: 0.6, midi: [48, 52, 55] }],
  },
};
const chords = jamHarmony(song);
assert.deepEqual(chords.slice(0, 2), [{ root: 0, minor: false }, { root: 5, minor: false }]);
assert.deepEqual(chords[3], chords[1], 'silent bars keep the last harmonic guide');
const backing = melodyBacking(song);
assert.deepEqual(backing.tracks.melody, song.tracks.melody);
assert.ok(['drums', 'bass', 'pads', 'guitar'].every((r) => backing.tracks[r as keyof typeof backing.tracks].length === 0), 'jam never automates human accompaniment');
assert.equal(song.tracks.bass.length, 2, 'source arrangement remains intact');
const ts: TransportState = { bpm: 120, epoch: 0, root: 0, scale: 'majorPent', drop: null, autoBand: false, speakerMode: false, syncTest: false, freestyle: false, sample: null, paused: null, recording: null, game: null,
  nowPlaying: { mode: 'jam', title: song.title, song, chords, startStep: 32 } };
assert.ok(liveNotesAllowed(ts));
assert.equal(chordAt(ts, 48).name, 'F', 'pad harmony follows the song, not the default four-chord progression');
assert.equal(chordAt(ts, 96).name, 'C', 'harmony loops with the lead');
assert.equal(chordAt(ts, 0).name, 'C', 'count-in uses the first chord');
const guitar = resolveEvent({ role: 'guitar', step: 48, d: 0 }, ts);
assert.deepEqual(guitar, { kind: 'notes', midi: [41, 45, 48] }, 'guitar strums the source harmony');
assert.equal(padLabels('guitar', ts).length, COLS.guitar);
assert.ok(NOTE_DUR.guitar > 0 && FREE_RANGE.guitar[0] < FREE_RANGE.guitar[1]);
assert.ok(!liveNotesAllowed({ ...ts, paused: 100 }));
assert.ok(liveNotesAllowed({ ...ts, nowPlaying: { title: 'Concert', mode: 'band' } }), 'live instruments join a playing song');
assert.ok(liveNotesAllowed({ ...ts, nowPlaying: { ...ts.nowPlaying!, full: true } as TransportState['nowPlaying'] }));
assert.ok(!liveNotesAllowed({ ...ts, game: { songId: song.id, song, difficulty: 'easy', startStep: 32, endStep: 96 } }));

let now = 0;
const events: NoteEvent[] = [];
const player = new SongPlayer({ serverNow: () => now, isLocked: true }, () => ts, (n) => events.push(n), false);
player.start(toLoopSong(backing), 32);
for (; now < stepTime(ts, 160); now += 40) player.tick();
assert.equal(events.filter((n) => n.step < 160).length, song.tracks.melody.length * 2, 'melody loops without dropping or duplicating notes');
assert.ok(events.every((n) => n.role === 'melody'));
const count = events.length;
ts.paused = now; now += 10_000; player.tick();
assert.equal(events.length, count, 'pause does not advance the backing');
ts.epoch += now - ts.paused; ts.paused = null;
player.level = 0;
for (let i = 0; i < 20; i++) { now += 40; player.tick(); }
assert.equal(events.length, count, 'melody mixer can mute the backing');
player.level = 0.5;
for (let i = 0; i < 20; i++) { now += 40; player.tick(); }
assert.ok(events.length > count && events.at(-1)!.v === 0.4, 'mixer restores melody at the selected level');
player.stop(); now += 1000; player.tick();
assert.equal(player.song, null);

const imported = parseMidi(toMidi(toLoopSong(song)).slice().buffer as ArrayBuffer, 'roundtrip');
assert.ok(imported.events.some((n) => n.role === 'guitar' && n.midi?.includes(48)), 'GM guitar survives export and import');
const normalized = toGameSong(imported, 'import:guitar');
assert.ok(normalized.tracks.guitar.length);
const { guitar: _, ...oldTracks } = song.tracks;
assert.deepEqual(validateGameSong({ ...song, tracks: oldTracks })?.tracks.guitar, [], 'previously saved four-instrument MIDI songs remain compatible');
console.log('✓ Melody-only backing, inferred harmony, guitar voicings, live-input gating, looping, pause, mixer, guitar MIDI roundtrip and old imports');

// ---- live percussion on top of a song with no drums
assert.deepEqual(resolveEvent({ role: 'drums', step: 0, d: 4 }, ts), { kind: 'drum', voice: 4 }, 'open hat is a real drum voice');
assert.deepEqual(resolveEvent({ role: 'drums', step: 0, d: 9 }, ts), { kind: 'drum', voice: 4 }, 'out-of-range drum index clamps');
assert.equal(COLS.drums, padLabels('drums', ts).length, 'one label per drum column');

import { Sequencer } from '../src/stage/sequencer';
{
  let t = 0;
  const out: NoteEvent[] = [];
  const fresh: TransportState = { ...ts, epoch: 0, bpm: 120, paused: null };
  const seq = new Sequencer({ serverNow: () => t, isLocked: true }, () => fresh, (n) => out.push(n), false);
  seq.tick(); assert.equal(out.length, 0, 'a stopped sequencer is silent');
  seq.toggle(0, 0); seq.toggle(0, 8); seq.toggle(3, 4);
  seq.start(); // 120 BPM: 125 ms per step
  for (t = 0; t <= 4000; t += 40) seq.tick();
  assert.ok(out.length > 0 && out.every((n) => n.pid === 'seq:drums' && n.role === 'drums'));
  assert.ok(out.every((n) => (n.d === 0 && n.step % 16 % 8 === 0) || (n.d === 4 && n.step % 16 === 4)), 'hits land on the pattern columns of the shared step grid');
  const before = out.length; seq.stop(); t = 8000; seq.tick(); assert.equal(out.length, before, 'stop silences it');
  seq.clear(); assert.ok(seq.empty);
}
console.log('live percussion + sequencer checks passed');
