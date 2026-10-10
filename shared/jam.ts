import type { GameSong } from './game';
import type { JamState } from './protocol';

/** Infer a simple per-bar chord guide from the source arrangement, before muting its backing. */
export function jamHarmony(song: GameSong): JamState['chords'] {
  const chords: JamState['chords'] = [];
  for (let bar = 0; bar < song.bars; bar++) {
    const weights = new Array<number>(12).fill(0);
    const bass = new Array<number>(12).fill(0);
    for (const role of ['bass', 'pads', 'guitar', 'melody'] as const) {
      for (const note of song.tracks[role]) {
        const overlap = Math.min(note.step + note.dur, (bar + 1) * 16) - Math.max(note.step, bar * 16);
        if (overlap <= 0) continue;
        for (const pitch of note.midi ?? []) {
          const weight = overlap * note.v;
          weights[pitch % 12] += weight * (role === 'melody' ? 0.5 : 1);
          if (role === 'bass') bass[pitch % 12] += weight;
        }
      }
    }
    const previous = chords.at(-1) ?? { root: song.root, minor: song.scale !== 'majorPent' };
    let best = previous;
    let score = -Infinity;
    if (weights.some((w) => w > 0)) for (let root = 0; root < 12; root++) for (const minor of [false, true]) {
      const third = (root + (minor ? 3 : 4)) % 12;
      const fifth = (root + 7) % 12;
      const candidate = weights[root] + weights[third] + weights[fifth] + bass[root] * 1.5
        + (root === previous.root && minor === previous.minor ? 0.001 : 0);
      if (candidate > score) { best = { root, minor }; score = candidate; }
    }
    chords.push(best);
  }
  return chords;
}

/** Only the selected lead is automated. Drums, bass, keys and guitar come from people. */
export function melodyBacking(song: GameSong): GameSong {
  return { ...song, tracks: { drums: [], bass: [], pads: [], guitar: [], melody: song.tracks.melody } };
}
