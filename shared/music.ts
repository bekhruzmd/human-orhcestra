/**
 * Musical guardrails.
 *
 * Players never send pitches. They send *indices* ("column 5 of the melody pad"); this module turns an
 * index into a MIDI note using the CURRENT key, scale and chord at the event's step. Consequences:
 *   - an out-of-key note is unrepresentable (every index maps into the scale),
 *   - everything lands on the 16th grid (the step is an integer),
 *   - changing the key/scale on the Stage re-pitches every player instantly,
 *   - melody notes that would grind against the underlying chord are nudged to a neighbouring scale tone.
 */
import { STEPS_PER_BAR, PROGRESSION_BARS, type Role, type ScaleName, type NoteEvent, type TransportState } from './protocol.js';

export const SCALE_INTERVALS: Record<ScaleName, number[]> = {
  minorPent: [0, 3, 5, 7, 10],
  majorPent: [0, 2, 4, 7, 9],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  blues: [0, 3, 5, 6, 7, 10],
};
export const SCALE_LABEL: Record<ScaleName, string> = {
  minorPent: 'minor pentatonic', majorPent: 'major pentatonic', dorian: 'dorian', blues: 'blues',
};
export const NOTE_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
export const noteName = (midi: number) => NOTE_NAMES[((midi % 12) + 12) % 12];
export const mtof = (m: number) => 440 * 2 ** ((m - 69) / 12);

type Quality = 'm' | 'M';
/** 4-bar chord loops as (semitone offset from the key root, quality). Classic "always works" loops. */
const PROGRESSIONS: Record<ScaleName, { off: number; q: Quality }[]> = {
  minorPent: [{ off: 0, q: 'm' }, { off: 8, q: 'M' }, { off: 3, q: 'M' }, { off: 10, q: 'M' }], // i  VI  III  VII
  majorPent: [{ off: 0, q: 'M' }, { off: 7, q: 'M' }, { off: 9, q: 'm' }, { off: 5, q: 'M' }], // I  V  vi  IV
  dorian: [{ off: 0, q: 'm' }, { off: 5, q: 'M' }, { off: 0, q: 'm' }, { off: 10, q: 'M' }], //   i  IV  i  VII
  blues: [{ off: 0, q: 'm' }, { off: 5, q: 'm' }, { off: 0, q: 'm' }, { off: 10, q: 'M' }], //    i  iv  i  VII
};

export interface Chord {
  rootPc: number;
  minor: boolean;
  /** triad pitch classes */
  tones: number[];
  /** 7th pitch class (min7 / maj7 colour) */
  seventh: number;
  name: string;
  /** which bar of the loop (0..3) */
  index: number;
}

export interface Key { root: number; scale: ScaleName; nowPlaying?: TransportState['nowPlaying'] }

export function chordAt(key: Key, step: number): Chord {
  const bar = Math.floor(step / STEPS_PER_BAR);
  const index = ((bar % PROGRESSION_BARS) + PROGRESSION_BARS) % PROGRESSION_BARS;
  const { off, q } = PROGRESSIONS[key.scale][index];
  const jam = key.nowPlaying?.mode === 'jam' ? key.nowPlaying : null;
  const jamBar = jam ? Math.max(0, Math.floor((step - jam.startStep) / STEPS_PER_BAR)) : 0;
  const guide = jam?.chords[((jamBar % jam.chords.length) + jam.chords.length) % jam.chords.length];
  const rootPc = guide?.root ?? (key.root + off) % 12;
  const minor = guide?.minor ?? q === 'm';
  const third = minor ? 3 : 4;
  return {
    rootPc, minor, index,
    tones: [rootPc, (rootPc + third) % 12, (rootPc + 7) % 12],
    seventh: (rootPc + (minor ? 10 : 11)) % 12,
    name: NOTE_NAMES[rootPc] + (minor ? 'm' : ''),
  };
}

const scalePcs = (key: Key) => new Set(SCALE_INTERVALS[key.scale].map((i) => (key.root + i) % 12));

// ---------------------------------------------------------------- melody
export const MELODY_COLS = 8;
/** Ladder of the 8 scale notes starting at the key root around middle C. */
export function melodyLadder(key: Key): number[] {
  const iv = SCALE_INTERVALS[key.scale];
  const base = 60 + (key.root > 6 ? key.root - 12 : key.root);
  return Array.from({ length: MELODY_COLS }, (_, i) => base + iv[i % iv.length] + 12 * Math.floor(i / iv.length));
}

/**
 * Chord-aware nudge: a scale tone that sits a semitone from a chord tone sounds like a wrong note
 * (e.g. G over an A♭ chord). Move it to the nearest scale tone that doesn't.
 */
export function snapToChord(midi: number, chord: Chord, key: Key): number {
  const fixed = [...chord.tones, chord.seventh];
  // A non-chord tone a semitone above or below any chord tone grinds.
  const clashes = (pc: number) =>
    !fixed.includes(pc) && fixed.some((c) => { const d = (pc - c + 12) % 12; return d === 1 || d === 11; });
  if (!clashes(((midi % 12) + 12) % 12)) return midi;
  const inKey = scalePcs(key);
  for (const delta of [1, -1, 2, -2]) {
    const pc = (((midi + delta) % 12) + 12) % 12;
    if (inKey.has(pc) && !clashes(pc)) return midi + delta;
  }
  return midi;
}

// ------------------------------------------------------------------ bass
export const BASS_COLS = 4;
export function bassNote(d: number, chord: Chord): number {
  const root = 28 + ((((chord.rootPc - 28) % 12) + 12) % 12); // E1..D#2
  const offsets = [0, 7, (chord.seventh - chord.rootPc + 12) % 12, 12];
  return root + offsets[Math.max(0, Math.min(BASS_COLS - 1, d))];
}

// ------------------------------------------------------------------ pads
export const PAD_COLS = 4;
export function padVoicing(d: number, chord: Chord): number[] {
  const r = 48 + ((((chord.rootPc - 48) % 12) + 12) % 12);
  const t = chord.minor ? 3 : 4;
  const s = chord.minor ? 10 : 11;
  switch (Math.max(0, Math.min(PAD_COLS - 1, d))) {
    case 0: return [r, r + t, r + 7];
    case 1: return [r + t, r + 7, r + 12];
    case 2: return [r + 7, r + 12, r + 12 + t];
    default: return [r - 12, r + 7, r + 12 + t, r + 12 + s];
  }
}

// ----------------------------------------------------------------- drums
export const DRUM_VOICES = ['kick', 'snare', 'hat', 'clap'] as const;
export type DrumVoice = (typeof DRUM_VOICES)[number];
/** Groove-aware pick so a shaken phone always makes a plausible pattern: kick 1 & 3.5, snare 2 & 4. */
export function grooveVoice(step: number, full = true): number {
  const s = ((step % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR;
  if (full) {
    if (s === 0 || s === 10) return 0;
    if (s === 4 || s === 12) return 1;
  }
  return s % 4 === 2 ? 3 : 2; // off-beat 8ths clap, the rest hats
}

export const COLS: Record<Role, number> = { melody: MELODY_COLS, bass: BASS_COLS, pads: PAD_COLS, guitar: 4, drums: 5 };

// -------------------------------------------------------------- freestyle
/** Freestyle pitch range per role: the whole pad is a continuous, UN-locked keyboard. */
export const FREE_RANGE: Record<Role, [number, number]> = { melody: [60, 84], bass: [36, 55], pads: [48, 72], guitar: [45, 76], drums: [0, 3] };
export const freeMidi = (role: Role, x: number) => {
  const [lo, hi] = FREE_RANGE[role];
  return lo + Math.round(Math.max(0, Math.min(1, x)) * (hi - lo));
};
export const freeZone = (x: number) => Math.max(0, Math.min(3, Math.floor(x * 4)));
/** A shake's strength picks the drum: hard = kick, medium = snare, soft = hat (clap for non-drummers). */
export const shakeVoice = (v: number, drummer: boolean) => (v > 0.78 ? 0 : v > 0.58 ? 1 : drummer ? 2 : 3);

export type Resolved = { kind: 'drum'; voice: number } | { kind: 'notes'; midi: number[] };

/** index -> sounding pitches, under the transport's key at the event's own step. */
export function resolveEvent(ev: Pick<NoteEvent, 'role' | 'step' | 'd'> & { midi?: number[] }, key: Key): Resolved {
  if (ev.midi?.length && ev.role !== 'drums') return { kind: 'notes', midi: ev.midi }; // composed / imported: pitches are explicit
  const chord = chordAt(key, ev.step);
  switch (ev.role) {
    case 'drums': return { kind: 'drum', voice: Math.max(0, Math.min(4, ev.d)) };
    case 'bass': return { kind: 'notes', midi: [bassNote(ev.d, chord)] };
    case 'pads': return { kind: 'notes', midi: padVoicing(ev.d, chord) };
    case 'guitar': return { kind: 'notes', midi: padVoicing(ev.d, chord).slice(0, 3).map((n) => n - 12) };
    case 'melody': {
      const m = melodyLadder(key)[Math.max(0, Math.min(MELODY_COLS - 1, ev.d))];
      return { kind: 'notes', midi: [snapToChord(m, chord, key)] };
    }
  }
}

/** Labels for the player's pad columns. */
export function padLabels(role: Role, key: Key): string[] {
  switch (role) {
    case 'melody': return melodyLadder(key).map(noteName);
    case 'guitar': return ['STRUM', 'LIFT', 'HIGH', 'LOW'];
    case 'bass': return ['ROOT', '5TH', '7TH', 'OCT'];
    case 'pads': return ['OPEN', 'LIFT', 'SOAR', 'WIDE'];
    case 'drums': return ['KICK', 'SNARE', 'HAT', 'CLAP', 'OPEN'];
  }
}

/** Ticks between repeats while a finger is held (steps). 0 = no repeat. */
export const HOLD_REPEAT: Record<Role, number> = { melody: 2, bass: 4, pads: STEPS_PER_BAR, guitar: 4, drums: 0 };
export const NOTE_DUR: Record<Role, number> = { melody: 2, bass: 3, pads: STEPS_PER_BAR, guitar: 3, drums: 1 };
