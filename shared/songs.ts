/**
 * The rhythm-game song library.
 *
 * To add a song, append a SongDef to DEFS. Melody is "NOTE:beats" tokens (quarter note = 1 beat, "|" is
 * decoration, "R" = rest); chords are one symbol per bar; bass/keys/drums are repeating one-bar patterns in
 * 16th-note steps. buildSong() expands them into per-instrument tracks of TrackNote.
 *
 * Content: public-domain compositions and original music only.
 */
import type { ScaleName } from './protocol.js';
import type { GameSong, TrackNote } from './game.js';

interface SongDef {
  id: string; title: string; artist: string; bpm: number; rating: 1 | 2 | 3; root: number; scale: ScaleName;
  /** one chord symbol per bar: C, Am, F#m ... (length = number of bars) */
  chords: string;
  melody: string;
  /** [step in bar, semitones above chord root, duration in steps] */
  bass: [number, number, number][];
  /** [step in bar, duration, chord tone 0-2 one octave up | -1 = whole chord] */
  keys: [number, number, number][];
  drums: { kick: number[]; snare: number[]; hat: number[]; clap?: number[] };
  /** bars (0-based) that end in a snare roll */
  fills?: number[];
}

const A_ODE = 'E5:1 E5:1 F5:1 G5:1 | G5:1 F5:1 E5:1 D5:1 | C5:1 C5:1 D5:1 E5:1 | E5:1.5 D5:.5 D5:2 | E5:1 E5:1 F5:1 G5:1 | G5:1 F5:1 E5:1 D5:1 | C5:1 C5:1 D5:1 E5:1 | D5:1.5 C5:.5 C5:2';
const CANON_A = 'F#5:2 E5:2 | D5:2 C#5:2 | B4:2 A4:2 | B4:2 C#5:2 | B4:.5 D5:.5 G5:.5 D5:.5 B4:.5 D5:.5 G5:.5 D5:.5 | A4:.5 D5:.5 F#5:.5 D5:.5 A4:.5 D5:.5 F#5:.5 D5:.5 | B4:.5 D5:.5 G5:.5 D5:.5 B4:.5 D5:.5 G5:.5 D5:.5 | A4:.5 C#5:.5 E5:.5 C#5:.5 A4:.5 C#5:.5 E5:.5 C#5:.5';
const NEON_A = 'A4:1 C5:.5 E5:.5 G5:1 E5:.5 D5:.5 | F5:1 E5:.5 C5:.5 A4:1 C5:1 | E5:.5 E5:.5 G5:1 E5:1 C5:.5 D5:.5 | D5:1 G4:.5 B4:.5 D5:2';
const NEON_B = 'A5:1 G5:.5 E5:.5 G5:1 E5:1 | F5:.5 A5:.5 C6:1 A5:1 F5:1 | G5:1 E5:.5 C5:.5 E5:1 G5:1 | D5:.5 E5:.5 D5:.5 B4:.5 G4:2';

const DEFS: SongDef[] = [
  {
    id: 'ode', title: 'Ode to Joy', artist: 'Beethoven (public domain)', bpm: 100, rating: 1, root: 0, scale: 'majorPent',
    chords: 'C G C G C G C C C G C G C G C C',
    melody: `${A_ODE} | ${A_ODE}`,
    bass: [[0, 0, 6], [8, 7, 6]],
    keys: [[0, 4, -1], [4, 4, -1], [8, 4, -1], [12, 4, -1]],
    drums: { kick: [0, 8], snare: [4, 12], hat: [2, 6, 10, 14] },
    fills: [7, 15],
  },
  {
    id: 'canon', title: 'Canon in D (arr.)', artist: 'Pachelbel (public domain)', bpm: 80, rating: 2, root: 2, scale: 'majorPent',
    chords: 'D A Bm F#m G D G A D A Bm F#m G D G A',
    melody: `${CANON_A} | ${CANON_A}`,
    bass: [[0, 0, 8], [8, 7, 8]],
    keys: [[0, 2, 0], [2, 2, 1], [4, 2, 2], [6, 2, 1], [8, 2, 0], [10, 2, 1], [12, 2, 2], [14, 2, 1]],
    drums: { kick: [0, 8], snare: [4, 12], hat: [2, 6, 10, 14] },
  },
  {
    id: 'neon', title: 'Neon Run', artist: 'Human Orchestra (original)', bpm: 120, rating: 3, root: 9, scale: 'minorPent',
    chords: 'Am F C G Am F C G Am F C G Am F C G',
    melody: `${NEON_A} | ${NEON_B} | ${NEON_A} | ${NEON_B}`,
    bass: [[0, 0, 2], [2, 0, 2], [4, 0, 2], [6, 12, 2], [8, 0, 2], [10, 0, 2], [12, 7, 2], [14, 12, 2]],
    keys: [[0, 2, -1], [3, 2, -1], [6, 2, -1], [8, 2, -1], [11, 2, -1], [14, 2, -1]],
    drums: { kick: [0, 8, 11], snare: [4, 12], hat: [2, 6, 10, 14], clap: [15] },
    fills: [3, 7, 11, 15],
  },
];

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const acc = (a: string) => (a === '#' ? 1 : a === 'b' ? -1 : 0);
function midiOf(tok: string) {
  const m = /^([A-G])([#b]?)(\d)$/.exec(tok);
  if (!m) throw new Error(`bad note ${tok}`);
  return 12 * (Number(m[3]) + 1) + PC[m[1]] + acc(m[2]);
}
function chordOf(sym: string) {
  const m = /^([A-G])([#b]?)(m?)$/.exec(sym);
  if (!m) throw new Error(`bad chord ${sym}`);
  return { root: (PC[m[1]] + acc(m[2]) + 12) % 12, third: m[3] ? 3 : 4 };
}

function buildSong(def: SongDef): GameSong {
  const chords = def.chords.trim().split(/\s+/);
  const bars = chords.length;
  const tracks: GameSong['tracks'] = { melody: [], bass: [], pads: [], drums: [], guitar: [] };

  let beat = 0;
  for (const tok of def.melody.replace(/\|/g, ' ').trim().split(/\s+/)) {
    const [n, d] = tok.split(':');
    const beats = Number(d);
    if (n !== 'R') tracks.melody.push({ step: Math.round(beat * 4), dur: Math.max(1, Math.round(beats * 4 * 0.95)), v: 0.8, midi: [midiOf(n)] });
    beat += beats;
  }
  if (Math.round(beat * 4) !== bars * 16) throw new Error(`${def.title}: melody is ${beat} beats but there are ${bars} bars`);

  chords.forEach((sym, b) => {
    const { root, third } = chordOf(sym);
    const bassRoot = 36 + ((((root - 36) % 12) + 12) % 12);
    const keyRoot = 55 + ((((root - 55) % 12) + 12) % 12);
    const triad = [keyRoot, keyRoot + third, keyRoot + 7];
    const base = b * 16;
    for (const s of [0, 6, 8, 14]) tracks.guitar.push({ step: base + s, dur: 3, v: 0.48, midi: triad.map((n) => n - 12) });
    for (const [s, off, dur] of def.bass) tracks.bass.push({ step: base + s, dur, v: 0.75, midi: [bassRoot + off] });
    for (const [s, dur, tone] of def.keys) tracks.pads.push({ step: base + s, dur, v: 0.6, midi: tone < 0 ? triad : [triad[tone] + 12] });
    const drum = (steps: number[], d: number, v: number) => steps.forEach((s) => tracks.drums.push({ step: base + s, dur: 1, v, d }));
    drum(def.drums.kick, 0, 0.85); drum(def.drums.snare, 1, 0.75); drum(def.drums.hat, 2, 0.45); drum(def.drums.clap ?? [], 3, 0.7);
    if (def.fills?.includes(b)) drum([13, 14, 15], 1, 0.6);
  });
  (Object.keys(tracks) as (keyof typeof tracks)[]).forEach((r) => tracks[r].sort((a: TrackNote, b: TrackNote) => a.step - b.step));
  return { id: def.id, title: def.title, artist: def.artist, bpm: def.bpm, rating: def.rating, bars, root: def.root, scale: def.scale, tracks };
}

export const SONGS: GameSong[] = DEFS.map(buildSong);
export const getSong = (id: string) => SONGS.find((s) => s.id === id);
