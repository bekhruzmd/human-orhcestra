import type { GameSong } from '../../shared/game';
import { validateGameSong } from '../../shared/game';
import type { Song } from './composer';

/** Preserve supplied pitches and arrangement; no inferred chord loop is added. */
export function toGameSong(song: Song, id: string, melodyOnly = false): GameSong {
  const tracks: GameSong['tracks'] = { drums: [], bass: [], pads: [], melody: [] };
  for (const e of song.events) {
    if (melodyOnly && e.role !== 'melody') continue;
    tracks[e.role].push({ step: e.rel, dur: e.dur, v: e.v, ...(e.role === 'drums' ? { d: e.d } : { midi: melodyOnly ? [Math.max(...e.midi!)] : e.midi }) });
  }
  const result = validateGameSong({ id, title: song.title.slice(0, 100), artist: 'Your MIDI arrangement', bpm: song.bpm, root: song.root, scale: song.scale, bars: song.steps / 16, rating: 1, tracks });
  if (!result) throw new Error(melodyOnly ? 'No melody was found in this file. Try the full arrangement.' : 'This arrangement cannot be used as a game chart.');
  return result;
}

export function toLoopSong(song: GameSong): Song {
  return { title: song.title, bpm: song.bpm, root: song.root, scale: song.scale, steps: song.bars * 16, startStep: 0, credit: {}, info: [song.artist],
    events: Object.entries(song.tracks).flatMap(([role, notes]) => notes.map((n) => ({ ...n, role: role as keyof GameSong['tracks'], rel: n.step, d: n.d ?? 0 }))) };
}
