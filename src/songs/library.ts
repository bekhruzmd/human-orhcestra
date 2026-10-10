/**
 * Built-in song library: public-domain tunes plus common chord-loop backing tracks (chord progressions
 * aren't copyrightable). Anything else comes from .mid files you put in public/songs/ (see README).
 *
 * Melodies are written as "NOTE:beats" tokens (quarter note = 1 beat, "R" = rest); chords are one symbol
 * per bar. buildSong() turns a definition into the same Song structure the composer produces.
 */
import type { Song, SongEv } from '../stage/composer';
import type { ScaleName } from '../../shared/protocol';
import { NOTE_NAMES } from '../../shared/music';

export interface SongDef {
  id: string; title: string; blurb: string; bpm: number; root: number; scale: ScaleName;
  /** null = backing track only (jam over it) */
  melody: string | null;
  /** one chord symbol per bar: C, Am, G7, F#m ... */
  chords: string;
}

const A = 'E4:1 E4:1 F4:1 G4:1 | G4:1 F4:1 E4:1 D4:1 | C4:1 C4:1 D4:1 E4:1 | E4:1.5 D4:.5 D4:2 | E4:1 E4:1 F4:1 G4:1 | G4:1 F4:1 E4:1 D4:1 | C4:1 C4:1 D4:1 E4:1 | D4:1.5 C4:.5 C4:2';

export const LIBRARY: SongDef[] = [
  { id: 'pd:ode', title: 'Ode to Joy', blurb: 'Beethoven · public domain', bpm: 108, root: 0, scale: 'majorPent', melody: `${A} | ${A}`, chords: 'C G C G C G C C C G C G C G C C' },
  { id: 'pd:twinkle', title: 'Twinkle Twinkle', blurb: 'traditional · public domain', bpm: 100, root: 0, scale: 'majorPent',
    melody: 'C4:1 C4:1 G4:1 G4:1 | A4:1 A4:1 G4:2 | F4:1 F4:1 E4:1 E4:1 | D4:1 D4:1 C4:2 | G4:1 G4:1 F4:1 F4:1 | E4:1 E4:1 D4:2 | G4:1 G4:1 F4:1 F4:1 | E4:1 E4:1 D4:2 | C4:1 C4:1 G4:1 G4:1 | A4:1 A4:1 G4:2 | F4:1 F4:1 E4:1 E4:1 | D4:1 D4:1 C4:2',
    chords: 'C F C G C G C G C F C C' },
  { id: 'pd:jingle', title: 'Jingle Bells', blurb: 'Pierpont 1857 · public domain', bpm: 130, root: 0, scale: 'majorPent',
    melody: 'E4:1 E4:1 E4:2 | E4:1 E4:1 E4:2 | E4:1 G4:1 C4:1.5 D4:.5 | E4:4 | F4:1 F4:1 F4:1.5 F4:.5 | F4:1 E4:1 E4:1 E4:.5 E4:.5 | E4:1 D4:1 D4:1 E4:1 | D4:2 G4:2',
    chords: 'C C C C F C G G' },
  { id: 'pd:mary', title: 'Mary Had a Little Lamb', blurb: 'traditional · public domain', bpm: 110, root: 0, scale: 'majorPent',
    melody: 'E4:1 D4:1 C4:1 D4:1 | E4:1 E4:1 E4:2 | D4:1 D4:1 D4:2 | E4:1 G4:1 G4:2 | E4:1 D4:1 C4:1 D4:1 | E4:1 E4:1 E4:1 E4:1 | D4:1 D4:1 E4:1 D4:1 | C4:4',
    chords: 'C C G C C C G C' },
  { id: 'pd:frere', title: 'Frère Jacques', blurb: 'traditional · public domain', bpm: 112, root: 0, scale: 'majorPent',
    melody: 'C4:1 D4:1 E4:1 C4:1 | C4:1 D4:1 E4:1 C4:1 | E4:1 F4:1 G4:2 | E4:1 F4:1 G4:2 | G4:.5 A4:.5 G4:.5 F4:.5 E4:1 C4:1 | G4:.5 A4:.5 G4:.5 F4:.5 E4:1 C4:1 | C4:1 G3:1 C4:2 | C4:1 G3:1 C4:2',
    chords: 'C C C C C C C C' },
  // ---- backing tracks (no melody): tap/jam over them
  { id: 'loop:axis', title: 'Four-chord pop loop', blurb: 'C G Am F · the one behind countless hits', bpm: 100, root: 0, scale: 'majorPent', melody: null, chords: 'C G Am F C G Am F' },
  { id: 'loop:canon', title: 'Canon progression', blurb: 'D A Bm F♯m G D G A · Pachelbel', bpm: 90, root: 2, scale: 'majorPent', melody: null, chords: 'D A Bm F#m G D G A' },
  { id: 'loop:sad', title: 'Sad minor loop', blurb: 'Am F C G', bpm: 85, root: 9, scale: 'minorPent', melody: null, chords: 'Am F C G Am F C G' },
  { id: 'loop:andalusian', title: 'Andalusian', blurb: 'Am G F E · flamenco / epic', bpm: 100, root: 9, scale: 'minorPent', melody: null, chords: 'Am G F E Am G F E' },
  { id: 'loop:blues', title: '12-bar blues in E', blurb: 'E E E E A A E E B A E B', bpm: 110, root: 4, scale: 'blues', melody: null, chords: 'E E E E A A E E B A E B' },
];

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const midiOf = (tok: string) => {
  const m = /^([A-G])([#b]?)(\d)$/.exec(tok);
  if (!m) throw new Error(`bad note ${tok}`);
  return 12 * (Number(m[3]) + 1) + PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
};
const chordPcs = (sym: string) => {
  const m = /^([A-G])([#b]?)(m?)/.exec(sym);
  if (!m) throw new Error(`bad chord ${sym}`);
  const root = (PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return { root, third: m[3] ? 3 : 4 };
};

export function buildSong(def: SongDef): Song {
  const chords = def.chords.split(/\s+/);
  const bars = chords.length;
  const steps = bars * 16;
  const events: SongEv[] = [];

  if (def.melody) {
    let beat = 0;
    for (const tok of def.melody.replace(/\|/g, ' ').trim().split(/\s+/)) {
      const [n, d] = tok.split(':');
      const beats = Number(d);
      if (n !== 'R') events.push({ role: 'melody', rel: Math.round(beat * 4), d: 0, v: 0.8, dur: Math.max(1, Math.round(beats * 4 * 0.95)), midi: [midiOf(n)] });
      beat += beats;
    }
    if (Math.round(beat * 4) !== steps) throw new Error(`${def.title}: melody is ${beat} beats, chords say ${bars} bars`);
  }
  chords.forEach((sym, b) => {
    const { root, third } = chordPcs(sym);
    const bassRoot = 36 + ((((root - 36) % 12) + 12) % 12);
    const padRoot = 55 + ((((root - 55) % 12) + 12) % 12);
    events.push({ role: 'pads', rel: b * 16, d: 0, v: 0.5, dur: 16, midi: [padRoot, padRoot + third, padRoot + 7] });
    for (const [s, off, dur, v] of [[0, 0, 8, 0.75], [8, 0, 4, 0.6], [12, 7, 4, 0.6]] as const) {
      events.push({ role: 'bass', rel: b * 16 + s, d: 0, v, dur, midi: [bassRoot + off] });
    }
    for (let s = 0; s < 16; s++) {
      if (s === 0 || s === 8) events.push({ role: 'drums', rel: b * 16 + s, d: 0, v: 0.7, dur: 1 });
      if (s === 4 || s === 12) events.push({ role: 'drums', rel: b * 16 + s, d: 1, v: 0.55, dur: 1 });
      if (s % 2 === 0) events.push({ role: 'drums', rel: b * 16 + s, d: 2, v: s % 4 === 2 ? 0.4 : 0.28, dur: 1 });
    }
  });
  return {
    title: def.title, bpm: def.bpm, root: def.root, scale: def.scale, steps, events, startStep: 0, credit: {},
    info: [def.blurb, `${def.bpm} BPM · ${NOTE_NAMES[def.root]} · ${bars} bars`, def.melody ? 'melody + band' : 'backing track: jam over it'],
  };
}
