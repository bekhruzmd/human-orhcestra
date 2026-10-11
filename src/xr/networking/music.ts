/**
 * Index -> pitch resolution, mirrored from the original `shared/music.ts` (`resolveEvent` and helpers).
 * Phones send pad indices, not pitches; the original resolves them against the transport at playback time.
 * XR must do the same to light the pitches that are actually sounding. Keep in sync with the original.
 */
import { STEPS_PER_BAR, type Role, type ScaleName, type TransportState } from './protocol';

const SCALE_INTERVALS: Record<ScaleName, number[]> = {
  minorPent: [0, 3, 5, 7, 10], majorPent: [0, 2, 4, 7, 9], dorian: [0, 2, 3, 5, 7, 9, 10], blues: [0, 3, 5, 6, 7, 10],
};
type Quality = 'm' | 'M';
const PROGRESSIONS: Record<ScaleName, { off: number; q: Quality }[]> = {
  minorPent: [{ off: 0, q: 'm' }, { off: 8, q: 'M' }, { off: 3, q: 'M' }, { off: 10, q: 'M' }],
  majorPent: [{ off: 0, q: 'M' }, { off: 7, q: 'M' }, { off: 9, q: 'm' }, { off: 5, q: 'M' }],
  dorian: [{ off: 0, q: 'm' }, { off: 5, q: 'M' }, { off: 0, q: 'm' }, { off: 10, q: 'M' }],
  blues: [{ off: 0, q: 'm' }, { off: 5, q: 'm' }, { off: 0, q: 'm' }, { off: 10, q: 'M' }],
};
const PROGRESSION_BARS = 4;

interface Chord { rootPc: number; minor: boolean; tones: number[]; seventh: number }

export function chordAt(ts: TransportState, step: number): Chord {
  const bar = Math.floor(step / STEPS_PER_BAR);
  const index = ((bar % PROGRESSION_BARS) + PROGRESSION_BARS) % PROGRESSION_BARS;
  const { off, q } = PROGRESSIONS[ts.scale][index];
  const np = ts.nowPlaying;
  const jam = np && 'mode' in np && np.mode === 'jam' ? { chords: np.chords, startStep: np.startStep }
    : ts.game?.live && ts.game.chords?.length ? { chords: ts.game.chords, startStep: ts.game.startStep } : null;
  const jamBar = jam ? Math.max(0, Math.floor((step - jam.startStep) / STEPS_PER_BAR)) : 0;
  const guide = jam?.chords[((jamBar % jam.chords.length) + jam.chords.length) % jam.chords.length];
  const rootPc = guide?.root ?? (ts.root + off) % 12;
  const minor = guide?.minor ?? q === 'm';
  const third = minor ? 3 : 4;
  return { rootPc, minor, tones: [rootPc, (rootPc + third) % 12, (rootPc + 7) % 12], seventh: (rootPc + (minor ? 10 : 11)) % 12 };
}

function melodyLadder(ts: TransportState): number[] {
  const iv = SCALE_INTERVALS[ts.scale];
  const base = 60 + (ts.root > 6 ? ts.root - 12 : ts.root);
  return Array.from({ length: 8 }, (_, i) => base + iv[i % iv.length] + 12 * Math.floor(i / iv.length));
}

function snapToChord(midi: number, chord: Chord, ts: TransportState): number {
  const fixed = [...chord.tones, chord.seventh];
  const clashes = (pc: number) =>
    !fixed.includes(pc) && fixed.some((c) => { const d = (pc - c + 12) % 12; return d === 1 || d === 11; });
  if (!clashes(((midi % 12) + 12) % 12)) return midi;
  const inKey = new Set(SCALE_INTERVALS[ts.scale].map((i) => (ts.root + i) % 12));
  for (const delta of [1, -1, 2, -2]) {
    const pc = (((midi + delta) % 12) + 12) % 12;
    if (inKey.has(pc) && !clashes(pc)) return midi + delta;
  }
  return midi;
}

function bassNote(d: number, chord: Chord): number {
  const root = 28 + ((((chord.rootPc - 28) % 12) + 12) % 12);
  return root + [0, 7, (chord.seventh - chord.rootPc + 12) % 12, 12][Math.max(0, Math.min(3, d))];
}

function padVoicing(d: number, chord: Chord): number[] {
  const r = 48 + ((((chord.rootPc - 48) % 12) + 12) % 12);
  const t = chord.minor ? 3 : 4;
  const s = chord.minor ? 10 : 11;
  switch (Math.max(0, Math.min(3, d))) {
    case 0: return [r, r + t, r + 7];
    case 1: return [r + t, r + 7, r + 12];
    case 2: return [r + 7, r + 12, r + 12 + t];
    default: return [r - 12, r + 7, r + 12 + t, r + 12 + s];
  }
}

export type Resolved = { kind: 'drum'; voice: number } | { kind: 'notes'; midi: number[] };

export function resolveEvent(ev: { role: Role; step: number; d: number; midi?: number[] }, ts: TransportState): Resolved {
  if (ev.midi?.length && ev.role !== 'drums') return { kind: 'notes', midi: ev.midi };
  const chord = chordAt(ts, ev.step);
  switch (ev.role) {
    case 'drums': return { kind: 'drum', voice: Math.max(0, Math.min(4, ev.d)) };
    case 'bass': return { kind: 'notes', midi: [bassNote(ev.d, chord)] };
    case 'pads': return { kind: 'notes', midi: padVoicing(ev.d, chord) };
    case 'guitar': return { kind: 'notes', midi: padVoicing(ev.d, chord).slice(0, 3).map((n) => n - 12) };
    case 'melody': {
      const m = melodyLadder(ts)[Math.max(0, Math.min(7, ev.d))];
      return { kind: 'notes', midi: [snapToChord(m, chord, ts)] };
    }
  }
}
