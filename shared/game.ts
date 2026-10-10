/**
 * Rhythm-game data layer, shared by the server, Stage and phones.
 *
 *   GameSong   structured song data: metadata + one note track per instrument (Role)
 *   buildChart(song, role, difficulty)   the playable note chart for ONE player
 *   judge()    timing windows -> 'perfect' | 'good' | null
 *
 * Everything is addressed in 16th-note STEPS from the song start, exactly like the rest of the app, so a
 * note's time is  stepTime(transport, game.startStep + note.step)  on the one shared server clock.
 * Difficulty changes only WHICH notes a player sees (and the lanes/windows), never the tempo.
 *
 * Adding a song: write a SongDef in shared/songs.ts (see the three examples). Nothing else needs to change.
 */
import type { Role, ScaleName } from './protocol.js';

export type Difficulty = 'easy' | 'medium' | 'hard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

/** One note of a song track. `midi` for pitched roles (chords = several), `d` = drum voice (0 kick,1 snare,2 hat,3 clap). */
export interface TrackNote { step: number; dur: number; v: number; midi?: number[]; d?: number }

export interface GameSong {
  id: string;
  title: string;
  artist: string;
  bpm: number;
  /** 1 (gentle) .. 3 (busy) overall rating for the picker */
  rating: 1 | 2 | 3;
  bars: number;
  root: number;
  scale: ScaleName;
  tracks: Record<Role, TrackNote[]>;
}
export const songSteps = (s: GameSong) => s.bars * 16;
export const songSeconds = (s: GameSong) => (s.bars * 4 * 60) / s.bpm;

/** Player-facing instrument names (the Role ids are the existing ones). */
export const INSTRUMENT: Record<Role, { name: string; icon: string }> = {
  drums: { name: 'Percussion', icon: 'DRM' },
  bass: { name: 'Double Bass', icon: 'BSS' },
  guitar: { name: 'Guitar', icon: 'GTR' },
  pads: { name: 'Grand Piano', icon: 'PNO' },
  melody: { name: 'Solo Lead', icon: 'LEAD' },
};

// ---------------------------------------------------------------- difficulty
export interface DiffSpec {
  lanes: number;
  /** half-width of the PERFECT / GOOD windows in ms */
  perfect: number;
  good: number;
}
export const DIFF: Record<Difficulty, DiffSpec> = {
  easy: { lanes: 2, perfect: 75, good: 170 },
  medium: { lanes: 3, perfect: 55, good: 125 },
  hard: { lanes: 4, perfect: 40, good: 95 },
};

export interface ChartNote {
  id: number;
  step: number;
  lane: number;
  dur: number;
  v: number;
  midi?: number[];
  d?: number;
}

const DRUM_LANES: Record<Difficulty, number[]> = {
  // drum voice (kick, snare, hat, clap) -> lane (-1 = not in this chart)
  easy: [0, 1, -1, -1],
  medium: [0, 1, 2, 2],
  hard: [0, 1, 2, 3],
};

/**
 * Turn a full song track into the chart one player sees.
 *  - HARD:   every note, 4 lanes
 *  - MEDIUM: drops 16th-note off-beats (and most hats), 3 lanes
 *  - EASY:   keeps only notes on the quarter-note grid, 2 lanes (drums: kick + snare only)
 * Pitched lanes follow pitch height (lowest notes -> lane 0), so the highway "looks like" the melody.
 */
export function buildChart(song: GameSong, role: Role, diff: Difficulty): ChartNote[] {
  const lanes = DIFF[diff].lanes;
  let notes = song.tracks[role].filter((n) => {
    const s = n.step % 16;
    if (role === 'drums') {
      if (diff === 'easy') return (n.d === 0 || n.d === 1) && s % 2 === 0;
      if (diff === 'medium') return n.d !== 2 || s % 4 === 2;
      return true;
    }
    if (diff === 'easy') return n.step % 4 === 0;
    if (diff === 'medium') return n.step % 2 === 0;
    return true;
  });
  if (!notes.length) notes = song.tracks[role];
  notes = notes.slice().sort((a, b) => a.step - b.step);

  let laneOf: (n: TrackNote) => number;
  if (role === 'drums') {
    laneOf = (n) => DRUM_LANES[diff][n.d ?? 2];
    const playable = notes.filter((n) => laneOf(n) >= 0);
    if (playable.length) notes = playable;
    else laneOf = (n) => (n.d ?? 2) % lanes;
  } else {
    // pitch percentile -> lane
    const tops = notes.map((n) => Math.max(...(n.midi ?? [60]))).sort((a, b) => a - b);
    const ranks = new Map<number, number>();
    for (let i = 0; i < tops.length;) {
      let end = i + 1;
      while (end < tops.length && tops[end] === tops[i]) end++;
      ranks.set(tops[i], tops.length < 2 ? 0 : (i + end - 1) / 2 / (tops.length - 1));
      i = end;
    }
    laneOf = (n) => Math.min(lanes - 1, Math.floor((ranks.get(Math.max(...(n.midi ?? [60]))) ?? 0) * lanes * 0.9999));
  }
  const seen = new Set<string>();
  return notes.filter((n) => { const key = `${n.step}:${laneOf(n)}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .map((n, i) => ({ id: i, step: n.step, lane: laneOf(n), dur: n.dur, v: n.v, midi: n.midi, d: n.d }));
}

// ------------------------------------------------------------------- scoring
export type Judgement = 'perfect' | 'good';
/** Deterministic: depends only on |tap - note| and the difficulty's windows. */
export function judge(diff: Difficulty, errMs: number): Judgement | null {
  const e = Math.abs(errMs), w = DIFF[diff];
  return e <= w.perfect ? 'perfect' : e <= w.good ? 'good' : null;
}

export interface GameStats {
  score: number;
  combo: number;
  maxCombo: number;
  perfect: number;
  good: number;
  miss: number;
  /** notes in this player's chart that were playable (late joiners skip the ones already gone) */
  total: number;
}
export const emptyStats = (total = 0): GameStats => ({ score: 0, combo: 0, maxCombo: 0, perfect: 0, good: 0, miss: 0, total });
/** 1.0x .. 2.0x: +0.25x every 8 notes of combo. */
export const comboMultiplier = (combo: number) => 1 + Math.min(4, Math.floor(combo / 8)) * 0.25;
export function applyHit(s: GameStats, j: Judgement): GameStats {
  const combo = s.combo + 1;
  const pts = Math.round((j === 'perfect' ? 100 : 60) * comboMultiplier(s.combo));
  return { ...s, combo, maxCombo: Math.max(s.maxCombo, combo), score: s.score + pts, perfect: s.perfect + (j === 'perfect' ? 1 : 0), good: s.good + (j === 'good' ? 1 : 0) };
}
export const applyMiss = (s: GameStats): GameStats => ({ ...s, combo: 0, miss: s.miss + 1 });
/** Accuracy %: perfect counts fully, good counts 60%. */
export const accuracy = (s: Pick<GameStats, 'perfect' | 'good' | 'total'>) => (s.total ? ((s.perfect + 0.6 * s.good) / s.total) * 100 : 0);
export const grade = (acc: number) => (acc >= 95 ? 'S' : acc >= 85 ? 'A' : acc >= 70 ? 'B' : acc >= 50 ? 'C' : 'D');

/** Shared state of a running game (lives in TransportState.game). */
export interface GameState {
  /** Imported arrangement, distributed with the start so every phone has the same chart. */
  song?: GameSong;
  songId: string;
  difficulty: Difficulty;
  /** absolute transport step where the song's step 0 sounds */
  startStep: number;
  /** step after which the performance is over */
  endStep: number;
}

/** Bound and copy untrusted imported arrangements before broadcasting them. */
export function validateGameSong(value: unknown): GameSong | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as GameSong;
  if (typeof s.id !== 'string' || !s.id.startsWith('import:') || s.id.length > 100 ||
      typeof s.title !== 'string' || !s.title.trim() || s.title.length > 100 ||
      !Number.isInteger(s.bpm) || s.bpm < 60 || s.bpm > 180 ||
      !Number.isInteger(s.bars) || s.bars < 1 || s.bars > 256 ||
      !Number.isInteger(s.root) || s.root < 0 || s.root > 11 ||
      !['minorPent', 'majorPent', 'dorian', 'blues'].includes(s.scale) || !s.tracks) return null;
  const tracks = {} as GameSong['tracks'];
  let count = 0;
  for (const role of ['drums', 'bass', 'melody', 'pads', 'guitar'] as Role[]) {
    const notes = s.tracks[role] ?? (role === 'guitar' ? [] : undefined);
    if (!Array.isArray(notes) || (count += notes.length) > 12000) return null;
    tracks[role] = [];
    for (const n of notes) {
      if (!n || !Number.isInteger(n.step) || n.step < 0 || n.step >= s.bars * 16 ||
          !Number.isFinite(n.dur) || n.dur <= 0 || n.dur > 256 ||
          !Number.isFinite(n.v) || n.v < 0 || n.v > 1) return null;
      if (role === 'drums') {
        if (!Number.isInteger(n.d) || n.d! < 0 || n.d! > 3) return null;
      } else if (!Array.isArray(n.midi) || !n.midi.length || n.midi.length > 8 ||
          !n.midi.every((m) => Number.isInteger(m) && m >= 0 && m <= 127)) return null;
      tracks[role].push({ step: n.step, dur: n.dur, v: n.v, ...(role === 'drums' ? { d: n.d } : { midi: [...n.midi!] }) });
    }
    tracks[role].sort((a, b) => a.step - b.step);
  }
  return count ? { id: s.id, title: s.title.trim(), artist: 'Your MIDI arrangement', bpm: s.bpm, bars: s.bars, root: s.root, scale: s.scale, rating: 1, tracks } : null;
}
