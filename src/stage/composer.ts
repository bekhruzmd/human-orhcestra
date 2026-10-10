/**
 * Composer: turns a sloppy freestyle jam into a song. Pure functions, no audio, no DOM.
 *
 *   analyze(rawLog)      -> Draft   what the players actually did: notes, drum hits, tempo, key
 *   arrange(draft, step) -> Song    a cleaned-up 8-bar loop with a band around it
 *
 * The pipeline (all free, deterministic, runs in the browser):
 *   1. Gesture -> notes. Pointer down starts a note, a pitch change starts the next one, pointer up ends it.
 *      Shakes/drum-pad taps become drum hits whose strength picks kick / snare / hat.
 *   2. Tempo. Grid search over 70-160 BPM x 24 phases for the 8th-note grid that the onsets fit best
 *      (sum of cos(2*pi*(t-phase)/eighth)), with a mild prior towards ~105 BPM to break half/double ties.
 *   3. Key. For each of 12 roots x 4 scales: how much of the (duration-weighted) pitch mass is in the scale,
 *      plus a bonus for tonic/fifth, minus a small penalty for bigger scales (they always cover more).
 *   4. Clean-up. Snap pitches to the scale, quantise starts/lengths to the 16th grid, make the lead
 *      monophonic, nudge notes that grind against the chord, tile the phrase over 8 bars with a lift in bars 5-8.
 *   5. Band. Anything a human played is kept (cleaned); every missing part is generated from how energetic
 *      the jam was.
 */
import { STEPS_PER_BAR, stepMs, type Role, type ScaleName, type RawKind } from '../../shared/protocol';
import {
  NOTE_NAMES, SCALE_INTERVALS, SCALE_LABEL, chordAt, freeMidi, freeZone, shakeVoice, snapToChord, resolveEvent,
} from '../../shared/music';
import { clamp, rnd as hash } from '../common/util';

export interface RawEv { pid: string; role: Role; k: RawKind; at: number; x: number; y: number; v?: number }
export interface PlayerMeta { id: string; name: string; color: string; role: Role }
export interface SongEv { role: Role; rel: number; d: number; v: number; dur: number; midi?: number[] }
export interface Song {
  title: string; bpm: number; root: number; scale: ScaleName;
  /** loop length in steps (multiple of 64 so the 4-bar chord loop stays aligned) */
  steps: number;
  events: SongEv[];
  info: string[];
  credit: Partial<Record<Role, { name: string; color: string }>>;
  /** absolute step the loop starts on (set by the player) */
  startStep: number;
}

interface PNote { pid: string; role: Role; start: number; end: number; midi: number; vel: number }
interface Hit { pid: string; start: number; voice: number; vel: number }
export interface Draft {
  notes: PNote[]; hits: Hit[]; bpm: number; phase: number; t0: number;
  root: number; scale: ScaleName; energy: number; players: PlayerMeta[]; shakes: number;
}

const SCALES = Object.keys(SCALE_INTERVALS) as ScaleName[];

// ---------------------------------------------------------------- analyze
export function analyze(log: RawEv[], players: PlayerMeta[]): Draft | null {
  const sorted = [...log].sort((a, b) => a.at - b.at);
  const open = new Map<string, PNote>();
  const notes: PNote[] = [];
  const hits: Hit[] = [];
  let shakes = 0;
  const close = (c: PNote, at: number) => { c.end = Math.max(at, c.start + 80); notes.push(c); };

  for (const e of sorted) {
    if (e.k === 't') continue;
    if (e.k === 's') {
      shakes++;
      hits.push({ pid: e.pid, start: e.at, voice: shakeVoice(e.v ?? 0.6, e.role === 'drums'), vel: clamp(e.v ?? 0.6, 0.35, 1) });
      continue;
    }
    if (e.role === 'drums') {
      if (e.k === 'd') hits.push({ pid: e.pid, start: e.at, voice: freeZone(e.x), vel: 0.35 + 0.65 * e.y });
      continue;
    }
    const midi = freeMidi(e.role, e.x);
    const cur = open.get(e.pid);
    if (e.k === 'd') {
      if (cur) close(cur, e.at);
      open.set(e.pid, { pid: e.pid, role: e.role, start: e.at, end: e.at + 250, midi, vel: 0.35 + 0.65 * e.y });
    } else if (e.k === 'm' && cur && midi !== cur.midi && e.at - cur.start > 110) {
      close(cur, e.at); // a slide across the pad becomes a run of notes
      open.set(e.pid, { pid: e.pid, role: e.role, start: e.at, end: e.at + 250, midi, vel: 0.35 + 0.65 * e.y });
    } else if (e.k === 'u' && cur) {
      close(cur, e.at); open.delete(e.pid);
    }
  }
  open.forEach((c) => close(c, c.start + 250));

  const onsets = [...notes.map((n) => n.start), ...hits.map((h) => h.start)].sort((a, b) => a - b);
  if (onsets.length < 3) return null;
  const t0 = onsets[0];
  const { bpm, phase } = estimateTempo(onsets.map((t) => t - t0));
  const { root, scale } = detectKey(notes.map((n) => ({ midi: n.midi, w: clamp(n.end - n.start, 80, 1500) })));
  const spanBars = (onsets[onsets.length - 1] - t0) / (stepMs(bpm) * STEPS_PER_BAR);
  const energy = clamp(onsets.length / (Math.max(1, spanBars) * 10), 0, 1);
  return { notes, hits, bpm, phase, t0, root, scale, energy, players, shakes };
}

function estimateTempo(on: number[]): { bpm: number; phase: number } {
  if (on.length < 4) return { bpm: 100, phase: 0 };
  let best = { score: -Infinity, bpm: 100, phase: 0 };
  for (let bpm = 70; bpm <= 160; bpm++) {
    const eighth = 30000 / bpm;
    for (let k = 0; k < 24; k++) {
      const phase = (k / 24) * eighth;
      let s = 0;
      for (const t of on) s += Math.cos((2 * Math.PI * (t - phase)) / eighth);
      s *= 1 - 0.15 * Math.abs(Math.log2(bpm / 105));
      if (s > best.score) best = { score: s, bpm, phase };
    }
  }
  return { bpm: best.bpm, phase: best.phase };
}

export function detectKey(pitches: { midi: number; w: number }[]): { root: number; scale: ScaleName } {
  if (!pitches.length) return { root: 0, scale: 'minorPent' };
  const hist = new Array(12).fill(0);
  let total = 0;
  for (const p of pitches) { hist[((p.midi % 12) + 12) % 12] += p.w; total += p.w; }
  let best = { score: -Infinity, root: 0, scale: 'minorPent' as ScaleName };
  for (const scale of SCALES) {
    const iv = SCALE_INTERVALS[scale];
    for (let root = 0; root < 12; root++) {
      let inScale = 0;
      for (const i of iv) inScale += hist[(root + i) % 12];
      const score = inScale / total + 0.15 * (hist[root] + 0.5 * hist[(root + 7) % 12]) / total - 0.02 * (iv.length - 5);
      if (score > best.score) best = { score, root, scale };
    }
  }
  return { root: best.root, scale: best.scale };
}

// ---------------------------------------------------------------- arrange
export function arrange(d: Draft, startStep: number): Song {
  const sm = stepMs(d.bpm);
  const key = { root: d.root, scale: d.scale };
  const SONG_STEPS = STEPS_PER_BAR * 8;
  const stepOf = (t: number) => Math.round((t - d.t0 - d.phase) / sm);
  const allSteps = [...d.notes.map((n) => stepOf(n.start)), ...d.hits.map((h) => stepOf(h.start))];
  const off = Math.floor(Math.min(...allSteps) / 4) * 4; // first note lands in beat 1
  const rel = (t: number) => stepOf(t) - off;

  const inKey = new Set(SCALE_INTERVALS[d.scale].map((i) => (d.root + i) % 12));
  const snapScale = (m: number) => { for (const dl of [0, 1, -1, 2, -2, 3, -3]) if (inKey.has((((m + dl) % 12) + 12) % 12)) return m + dl; return m; };
  const fold = (m: number, lo: number, hi: number) => { while (m < lo) m += 12; while (m > hi) m -= 12; return m; };

  const name = (id: string) => d.players.find((p) => p.id === id);
  const credit: Song['credit'] = {};
  const info: string[] = [];

  // --- who is the lead? melody players; if nobody chose melody, the most active pitched player
  let leadNotes = d.notes.filter((n) => n.role === 'melody');
  if (!leadNotes.length) {
    const counts = new Map<string, number>();
    d.notes.forEach((n) => counts.set(n.pid, (counts.get(n.pid) ?? 0) + 1));
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    leadNotes = d.notes.filter((n) => n.pid === top);
  }
  const bassNotes = d.notes.filter((n) => n.role === 'bass' && !leadNotes.includes(n));
  const padNotes = d.notes.filter((n) => n.role === 'pads' && !leadNotes.includes(n));
  const note = (r: Role, pid: string | undefined) => { const p = pid ? name(pid) : undefined; if (p) credit[r] = { name: p.name, color: p.color }; };

  // --- generic helper: monophonic, quantised, tiled phrase
  type Q = { rel: number; midi: number; v: number; dur: number };
  const quantise = (ns: PNote[], lo: number, hi: number, maxDur: number): Q[] => {
    const byRel = new Map<number, Q>();
    for (const n of ns) {
      const r = rel(n.start);
      if (r < 0 || r >= SONG_STEPS) continue;
      const q: Q = { rel: r, midi: fold(snapScale(n.midi), lo, hi), v: n.vel, dur: clamp(Math.round((n.end - n.start) / sm), 1, maxDur) };
      const prev = byRel.get(r);
      if (!prev || prev.v < q.v) byRel.set(r, q);
    }
    const out = [...byRel.values()].sort((a, b) => a.rel - b.rel);
    out.forEach((q, i) => { if (out[i + 1]) q.dur = clamp(Math.min(q.dur, out[i + 1].rel - q.rel), 1, maxDur); });
    return out;
  };
  const tile = <T extends { rel: number; dur?: number }>(items: T[]): { item: T; rel: number }[] => {
    if (!items.length) return [];
    const span = Math.max(...items.map((i) => i.rel + (i.dur ?? 1)));
    const pb = span <= 16 ? 1 : span <= 32 ? 2 : span <= 64 ? 4 : 8;
    const ps = pb * STEPS_PER_BAR;
    const out: { item: T; rel: number }[] = [];
    for (let t = 0; t * ps < SONG_STEPS; t++) for (const item of items) if (item.rel < ps) out.push({ item, rel: item.rel + t * ps });
    return out;
  };

  const events: SongEv[] = [];

  // --- LEAD (cleaned, tiled, chord-aware, lifted in the second half)
  const lead = tile(quantise(leadNotes, 57, 84, 8));
  lead.forEach(({ item, rel: r }) => {
    let m = item.midi, v = item.v;
    if (r >= 64) { v = Math.min(1, v + 0.1); if (hash(r) < 0.25 && m + 12 <= 88) m += 12; }
    m = snapToChord(m, chordAt(key, startStep + r), key);
    events.push({ role: 'melody', rel: r, d: 0, v, dur: item.dur, midi: [m] });
  });
  if (lead.length) note('melody', leadNotes[0]?.pid);

  // --- BASS: human if any, else generated
  if (bassNotes.length) {
    tile(quantise(bassNotes, 28, 52, 4)).forEach(({ item, rel: r }) =>
      events.push({ role: 'bass', rel: r, d: 0, v: item.v, dur: item.dur, midi: [item.midi] }));
    note('bass', bassNotes[0].pid);
  } else {
    const pat: Record<number, [number, number]> = { 0: [0, 3], 3: [0, 2], 6: [1, 2], 8: [0, 3], 10: [1, 2], 12: [0, 3], 14: [3, 2] };
    for (let r = 0; r < SONG_STEPS; r++) {
      const p = pat[r % 16];
      if (p && !(Math.floor(r / 16) % 2 && r % 16 === 3)) events.push({ role: 'bass', rel: r, d: p[0], v: 0.7, dur: p[1] });
    }
  }

  const guitarNotes = d.notes.filter((n) => n.role === 'guitar' && !leadNotes.includes(n));
  if (guitarNotes.length) {
    tile(quantise(guitarNotes, 40, 76, 8)).forEach(({ item, rel: r }) =>
      events.push({ role: 'guitar', rel: r, d: 0, v: item.v, dur: item.dur, midi: [item.midi] }));
    note('guitar', guitarNotes[0].pid);
  }

  // --- PADS: human chords by bar, else a chord every bar
  if (padNotes.length) {
    const bars = new Map<number, number>();
    for (const n of padNotes) { const r = rel(n.start); if (r >= 0 && r < SONG_STEPS) bars.set(Math.floor(r / 16), Math.min(3, Math.floor(((n.midi - 48) / 24) * 4))); }
    tile([...bars.entries()].map(([b, dd]) => ({ rel: b * 16, dur: 16, dd })))
      .forEach(({ item, rel: r }) => events.push({ role: 'pads', rel: r, d: item.dd, v: 0.6, dur: 16 }));
    note('pads', padNotes[0].pid);
  } else {
    for (let b = 0; b < 8; b++) events.push({ role: 'pads', rel: b * 16, d: [0, 1, 2, 1][b % 4], v: 0.55, dur: 16 });
  }

  // --- DRUMS: human hits (tiled) if there are enough, topped up with generated hats; else a generated groove scaled by energy
  const hitQ = new Map<string, { rel: number; voice: number; v: number }>();
  for (const h of d.hits) {
    const r = rel(h.start);
    if (r < 0 || r >= SONG_STEPS) continue;
    const k = `${r}:${h.voice}`;
    if (!hitQ.has(k) || hitQ.get(k)!.v < h.vel) hitQ.set(k, { rel: r, voice: h.voice, v: h.vel });
  }
  const humanDrums = d.hits.length >= 4;
  if (humanDrums) {
    tile([...hitQ.values()]).forEach(({ item, rel: r }) => events.push({ role: 'drums', rel: r, d: item.voice, v: item.v, dur: 1 }));
    const first = d.hits[0] && name(d.hits[0].pid);
    if (first) credit.drums = { name: first.name, color: first.color };
    for (let r = 0; r < SONG_STEPS; r += 2) events.push({ role: 'drums', rel: r, d: 2, v: 0.28, dur: 1 }); // glue hats
  } else {
    const busy = d.energy > 0.45;
    for (let r = 0; r < SONG_STEPS; r++) {
      const s = r % 16, bar = Math.floor(r / 16);
      if (s === 0 || s === 10 || (busy && s === 6 && bar % 2)) events.push({ role: 'drums', rel: r, d: 0, v: 0.75, dur: 1 });
      if (s === 4 || s === 12) events.push({ role: 'drums', rel: r, d: 1, v: 0.6, dur: 1 });
      if (busy ? true : s % 2 === 0) events.push({ role: 'drums', rel: r, d: 2, v: s % 4 === 2 ? 0.45 : busy ? 0.2 : 0.3, dur: 1 });
      if (bar === 7 && s >= 12) events.push({ role: 'drums', rel: r, d: 1, v: 0.4 + 0.15 * (s - 12), dur: 1 }); // fill into the loop
      if (bar % 4 === 3 && s === 12) events.push({ role: 'drums', rel: r, d: 3, v: 0.55, dur: 1 });
    }
  }

  const voices = new Set(d.notes.map((n) => n.pid).concat(d.hits.map((h) => h.pid))).size;
  info.push(`${d.bpm} BPM · ${NOTE_NAMES[d.root]} ${SCALE_LABEL[d.scale]}`);
  info.push(`${d.notes.length} notes + ${d.hits.length} drum hits from ${voices} player${voices === 1 ? '' : 's'}`);
  info.push(`energy ${Math.round(d.energy * 100)}% → ${humanDrums ? 'your drums, plus glue hats' : d.energy > 0.45 ? 'busy' : 'laid-back'} backing`);
  return { title: 'Your jam', bpm: d.bpm, root: d.root, scale: d.scale, steps: SONG_STEPS, events, info, credit, startStep };
}

// ------------------------------------------------------------ MIDI export
const vlq = (n: number) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
const DRUM_NOTE = [36, 38, 42, 39];
const PROGRAM: Record<Role, number> = { melody: 81, bass: 38, pads: 89, guitar: 24, drums: 0 };

/** Standard MIDI File (format 1, one track per role, GM drums on channel 10) for opening in a DAW. */
export function toMidi(song: Song): Uint8Array {
  const key = { root: song.root, scale: song.scale };
  const PPQ = 480, TICK = PPQ / 4;
  const bytes: number[] = [];
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const u16 = (n: number) => [(n >> 8) & 255, n & 255];
  const chunk = (id: string, data: number[]) => [...[...id].map((c) => c.charCodeAt(0)), ...u32(data.length), ...data];
  const trackBytes = (evs: { tick: number; b: number[] }[]) => {
    evs.sort((a, b) => a.tick - b.tick);
    const out: number[] = [];
    let last = 0;
    for (const e of evs) { out.push(...vlq(e.tick - last), ...e.b); last = e.tick; }
    out.push(0, 0xff, 0x2f, 0);
    return chunk('MTrk', out);
  };
  const usPerQ = Math.round(60e6 / song.bpm);
  const tracks: number[][] = [trackBytes([{ tick: 0, b: [0xff, 0x51, 3, (usPerQ >> 16) & 255, (usPerQ >> 8) & 255, usPerQ & 255] }])];
  (['melody', 'bass', 'pads', 'guitar', 'drums'] as Role[]).forEach((role, i) => {
    const ch = role === 'drums' ? 9 : i;
    const evs: { tick: number; b: number[] }[] = [{ tick: 0, b: [0xc0 | ch, PROGRAM[role]] }];
    for (const e of song.events.filter((x) => x.role === role)) {
      const r = resolveEvent({ role, step: song.startStep + e.rel, d: e.d, midi: e.midi }, key);
      const notes = r.kind === 'drum' ? [DRUM_NOTE[r.voice]] : r.midi;
      const vel = clamp(Math.round(e.v * 127), 20, 127);
      for (const m of notes) {
        evs.push({ tick: e.rel * TICK, b: [0x90 | ch, m, vel] });
        evs.push({ tick: (e.rel + Math.max(1, e.dur)) * TICK - 2, b: [0x80 | ch, m, 0] });
      }
    }
    tracks.push(trackBytes(evs));
  });
  bytes.push(...chunk('MThd', [...u16(1), ...u16(tracks.length), ...u16(PPQ)]));
  tracks.forEach((t) => bytes.push(...t));
  return new Uint8Array(bytes);
}
