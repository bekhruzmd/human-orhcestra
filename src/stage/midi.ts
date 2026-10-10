/**
 * Minimal Standard MIDI File importer: turns a .mid file YOU supply into a Song the band can play along with.
 * (We ship no song data; bring your own files.)
 *
 *  - channel 10 (index 9) -> drums via the General MIDI map; other channels are ranked by average pitch:
 *    highest -> melody, lowest (if there are 2+) -> bass, the rest -> pads
 *  - original pitches are kept (events carry explicit `midi`), the key is detected so phones' pads fit
 *  - at most 16 bars, padded to a multiple of 4 so the chord loop stays aligned
 */
import { STEPS_PER_BAR, type Role } from '../../shared/protocol';
import { detectKey, type Song, type SongEv } from './composer';
import { NOTE_NAMES, SCALE_LABEL } from '../../shared/music';

interface MNote { ch: number; track: number; midi: number; start: number; end: number; vel: number }

const GM_DRUM = (n: number) => (n === 35 || n === 36 ? 0 : [37, 38, 40, 41, 43, 45, 47, 48, 50].includes(n) ? 1 : n === 39 || n === 49 || n === 57 ? 3 : 2);

export function parseMidi(buf: ArrayBuffer, title: string): Song {
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let p = 0;
  const str = (n: number) => String.fromCharCode(...u8.slice(p, (p += n)));
  const u32 = () => { const x = v.getUint32(p); p += 4; return x; };
  const u16 = () => { const x = v.getUint16(p); p += 2; return x; };
  if (str(4) !== 'MThd') throw new Error('Not a MIDI file');
  u32(); u16();
  const ntrks = u16(), division = u16();
  if (division & 0x8000) throw new Error('SMPTE timing is not supported');
  const ppq = division;

  const notes: MNote[] = [];
  let tempo = 500000, tempoSet = false;
  for (let t = 0; t < ntrks && p < u8.length; t++) {
    if (str(4) !== 'MTrk') throw new Error('Bad track');
    const len = u32(), end = p + len;
    let tick = 0, status = 0;
    const active = new Map<number, { start: number; vel: number }>();
    const vlq = () => { let n = 0, b; do { b = u8[p++]; n = (n << 7) | (b & 0x7f); } while (b & 0x80); return n; };
    while (p < end) {
      tick += vlq();
      let b = u8[p];
      if (b & 0x80) { status = b; p++; } else b = status; // running status
      if (status === 0xff) {
        const type = u8[p++], l = vlq();
        if (type === 0x51 && !tempoSet) { tempo = (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2]; tempoSet = true; }
        p += l;
      } else if (status === 0xf0 || status === 0xf7) { p += vlq(); }
      else {
        const kind = status & 0xf0, ch = status & 15;
        const a = u8[p++], c = kind === 0xc0 || kind === 0xd0 ? 0 : u8[p++];
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
  const bars = Math.min(16, Math.max(4, Math.ceil(lastStep / STEPS_PER_BAR / 4) * 4));
  const steps = bars * STEPS_PER_BAR;

  // group melodic notes by (track, channel) and rank by average pitch
  const groups = new Map<string, MNote[]>();
  for (const n of notes) if (n.ch !== 9) (groups.get(`${n.track}:${n.ch}`) ?? groups.set(`${n.track}:${n.ch}`, []).get(`${n.track}:${n.ch}`)!).push(n);
  const ranked = [...groups.values()].filter((g) => g.length >= 4).map((g) => ({ g, avg: g.reduce((s, n) => s + n.midi, 0) / g.length })).sort((a, b) => b.avg - a.avg);
  const roleOf = (i: number): Role => (i === 0 ? 'melody' : i === ranked.length - 1 && ranked.length > 1 ? 'bass' : 'pads');

  const events: SongEv[] = [];
  ranked.forEach(({ g }, i) => {
    const role = roleOf(i);
    const byStart = new Map<number, MNote[]>();
    for (const n of g) { const s = toStep(n.start); if (s < steps) (byStart.get(s) ?? byStart.set(s, []).get(s)!).push(n); }
    for (const [s, ns] of byStart) {
      const top = ns.sort((a, b) => b.midi - a.midi).slice(0, role === 'melody' ? 3 : 4);
      events.push({ role, rel: s, d: 0, v: Math.max(...top.map((n) => n.vel)), dur: Math.max(1, Math.min(16, toStep(top[0].end) - s)), midi: top.map((n) => n.midi) });
    }
  });
  for (const n of notes) if (n.ch === 9) { const s = toStep(n.start); if (s < steps) events.push({ role: 'drums', rel: s, d: GM_DRUM(n.midi), v: n.vel, dur: 1 }); }

  const { root, scale } = detectKey(notes.filter((n) => n.ch !== 9).map((n) => ({ midi: n.midi, w: Math.min(1500, (n.end - n.start) * 60000 / (bpmOrig * ppq)) })));
  const used = new Set(events.map((e) => e.role));
  return {
    title, bpm, root, scale, steps, events, startStep: 0,
    info: [`${title}`, `${bpm} BPM · ${NOTE_NAMES[root]} ${SCALE_LABEL[scale]}`, `${events.length} events · ${[...used].join(', ')} · ${bars} bars`],
    credit: {},
  };
}
