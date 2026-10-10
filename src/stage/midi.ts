/**
 * Minimal Standard MIDI File importer: turns a .mid file YOU supply into a Song the band can play along with.
 * (We ship no song data; bring your own files.)
 *
 *  - channel 10 (index 9) -> drums via the General MIDI map; other channels are ranked by average pitch:
 *    highest -> melody, lowest (if there are 2+) -> bass, the rest -> pads
 *  - original pitches are kept (events carry explicit `midi`), the key is detected so phones' pads fit
 *  - up to 256 bars; rejects longer files rather than silently cutting off the tune
 */
import { STEPS_PER_BAR, type Role } from '../../shared/protocol';
import { detectKey, type Song, type SongEv } from './composer';
import { NOTE_NAMES, SCALE_LABEL } from '../../shared/music';

interface MNote { ch: number; track: number; midi: number; start: number; end: number; vel: number }

const GM_DRUM = (n: number) => (n === 35 || n === 36 ? 0 : [37, 38, 40, 41, 43, 45, 47, 48, 50].includes(n) ? 1 : n === 39 || n === 49 || n === 57 ? 3 : 2);

export interface MidiPart { id: string; label: string }
export function parseMidi(buf: ArrayBuffer, title: string, options: { melodyPart?: string; onParts?: (parts: MidiPart[]) => void } = {}): Song {
  if (buf.byteLength < 14 || buf.byteLength > 5_000_000) throw new Error('Choose a MIDI file smaller than 5 MB');
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let p = 0;
  const str = (n: number) => String.fromCharCode(...u8.slice(p, (p += n)));
  const u32 = () => { const x = v.getUint32(p); p += 4; return x; };
  const u16 = () => { const x = v.getUint16(p); p += 2; return x; };
  if (str(4) !== 'MThd') throw new Error('Not a MIDI file');
  const headerSize = u32(), format = u16();
  if (headerSize < 6 || headerSize + 8 > buf.byteLength || format > 1) throw new Error('Use a standard type 0 or type 1 MIDI file');
  const ntrks = u16(), division = u16();
  p = 8 + headerSize;
  if (!division) throw new Error('Invalid MIDI timing');
  if (division & 0x8000) throw new Error('SMPTE timing is not supported');
  const ppq = division;

  const notes: MNote[] = [];
  const trackNames = new Map<number, string>();
  let tempo = 500000, tempoSet = false;
  for (let t = 0; t < ntrks && p < u8.length; t++) {
    if (str(4) !== 'MTrk') throw new Error('Bad track');
    const len = u32(), end = p + len;
    if (end > u8.length) throw new Error('Truncated MIDI track');
    let tick = 0, status = 0;
    const active = new Map<number, { start: number; vel: number }>();
    const vlq = () => { let n = 0; for (let i = 0; i < 4; i++) { if (p >= end) throw new Error('Truncated MIDI event'); const b = u8[p++]; n = (n << 7) | (b & 0x7f); if (!(b & 0x80)) return n; } throw new Error('Invalid MIDI event length'); };
    while (p < end) {
      tick += vlq();
      let b = u8[p];
      if (b & 0x80) { status = b; p++; } else b = status; // running status
      if (status === 0xff) {
        const type = u8[p++], l = vlq();
        if (p + l > end) throw new Error('Truncated MIDI metadata');
        if (type === 0x03) trackNames.set(t, new TextDecoder().decode(u8.slice(p, p + l)).slice(0, 60));
        if (type === 0x51) {
          if (l !== 3) throw new Error('Invalid MIDI tempo');
          const nextTempo = (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2];
          if (!nextTempo) throw new Error('Invalid MIDI tempo');
          if (tempoSet && nextTempo !== tempo) throw new Error('This MIDI changes tempo. Export a constant-tempo version for the game.');
          tempo = nextTempo; tempoSet = true;
        }
        p += l;
      } else if (status === 0xf0 || status === 0xf7) { const l = vlq(); p += l; if (p > end) throw new Error('Truncated MIDI event'); }
      else {
        if (status < 0x80 || status >= 0xf0) throw new Error('Invalid MIDI running status');
        const kind = status & 0xf0, ch = status & 15;
        const a = u8[p++], c = kind === 0xc0 || kind === 0xd0 ? 0 : u8[p++];
        if (p > end || a > 127 || c > 127) throw new Error('Invalid MIDI note');
        const key = ch * 128 + a;
        if (kind === 0x90 && c > 0) active.set(key, { start: tick, vel: c / 127 });
        else if (kind === 0x80 || (kind === 0x90 && c === 0)) {
          const on = active.get(key);
          if (on) { notes.push({ ch, track: t, midi: a, start: on.start, end: Math.max(tick, on.start + 1), vel: on.vel }); active.delete(key); }
        }
      }
    }
    p = end;
  }
  if (!notes.length) throw new Error('No notes found');

  // Tempo into our 60-180 range; keep real-time speed by changing the grid, not the music.
  const bpmOrig = 60e6 / tempo;
  let bpm = bpmOrig;
  while (bpm > 180) bpm /= 2;
  while (bpm < 60) bpm *= 2;
  bpm = Math.round(bpm);
  const spq = 4 * (bpm / bpmOrig); // steps per quarter note
  const toStep = (tick: number) => Math.round((tick / ppq) * spq);

  const lastStep = Math.max(...notes.map((n) => toStep(n.end)));
  const bars = Math.max(4, Math.ceil(lastStep / STEPS_PER_BAR / 4) * 4);
  if (bars > 256 || notes.length > 12000) throw new Error('Use an excerpt of up to 256 bars and 12,000 notes');
  const steps = bars * STEPS_PER_BAR;

  // group melodic notes by (track, channel) and rank by average pitch
  const groups = new Map<string, MNote[]>();
  for (const n of notes) if (n.ch !== 9) (groups.get(`${n.track}:${n.ch}`) ?? groups.set(`${n.track}:${n.ch}`, []).get(`${n.track}:${n.ch}`)!).push(n);
  // Single-instrument files (e.g. an MP3->MIDI converter's piano output): split that one part by pitch
  // so the band still gets bass, pads and melody. Below E3 -> bass; the top note of each onset -> melody; the rest -> pads.
  if (groups.size === 1) {
    const [[id, g]] = [...groups.entries()];
    const low = g.filter((n) => n.midi < 52);
    const high = g.filter((n) => n.midi >= 52);
    const topAt = new Map<number, number>();
    for (const n of high) topAt.set(n.start, Math.max(topAt.get(n.start) ?? 0, n.midi));
    const mel = high.filter((n) => topAt.get(n.start) === n.midi);
    const pad = high.filter((n) => topAt.get(n.start) !== n.midi);
    groups.clear();
    for (const [suffix, part] of [['mel', mel], ['pad', pad], ['bass', low]] as const) if (part.length >= 4) groups.set(`${id}:${suffix}`, part);
    if (!groups.size) groups.set(id, g);
  }
  const ranked = [...groups.entries()].map(([id, g]) => ({ id, g, avg: g.reduce((s, n) => s + n.midi, 0) / g.length })).sort((a, b) => b.avg - a.avg);
  options.onParts?.(ranked.map(({ id, g }) => ({ id, label: `${trackNames.get(g[0].track) || `Track ${g[0].track + 1}`} · channel ${g[0].ch + 1} · ${g.length} notes` })));
  const selected = ranked.findIndex((part) => part.id === options.melodyPart);
  if (selected > 0) ranked.unshift(ranked.splice(selected, 1)[0]);
  const roleOf = (i: number): Role => (i === 0 ? 'melody' : i === ranked.length - 1 && ranked.length > 1 ? 'bass' : 'pads');

  const events: SongEv[] = [];
  ranked.forEach(({ g }, i) => {
    const role = roleOf(i);
    const byStart = new Map<number, MNote[]>();
    for (const n of g) { const s = toStep(n.start); if (s < steps) (byStart.get(s) ?? byStart.set(s, []).get(s)!).push(n); }
    for (const [s, ns] of byStart) {
      const top = ns.sort((a, b) => b.midi - a.midi).slice(0, 8);
      events.push({ role, rel: s, d: 0, v: Math.max(...top.map((n) => n.vel)), dur: Math.max(1, Math.min(256, toStep(top[0].end) - s)), midi: top.map((n) => n.midi) });
    }
  });
  for (const n of notes) if (n.ch === 9) { const s = toStep(n.start); if (s < steps) events.push({ role: 'drums', rel: s, d: GM_DRUM(n.midi), v: n.vel, dur: 1 }); }

  const { root, scale } = detectKey(notes.filter((n) => n.ch !== 9).map((n) => ({ midi: n.midi, w: Math.min(1500, (n.end - n.start) * 60000 / (bpmOrig * ppq)) })));
  if (!events.length) throw new Error('No playable notes found');
  events.sort((a, b) => a.rel - b.rel);
  const used = new Set(events.map((e) => e.role));
  return {
    title, bpm, root, scale, steps, events, startStep: 0,
    info: [`${title}`, `${bpm} BPM · ${NOTE_NAMES[root]} ${SCALE_LABEL[scale]}`, `${events.length} events · ${[...used].join(', ')} · ${bars} bars`],
    credit: {},
  };
}
