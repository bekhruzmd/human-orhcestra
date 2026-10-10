/** Usage: node --import tsx scripts/midiinspect.ts <folder>. Reports what the app's importer would make of each .mid. */
import fs from 'node:fs';
import path from 'node:path';
import { parseMidi } from '../src/stage/midi';

const dir = process.argv[2] ?? 'midi_songs';
const sig = (u8: Uint8Array) => { // first time signature meta event: FF 58 04 nn dd cc bb
  for (let i = 0; i < u8.length - 7; i++) if (u8[i] === 0xff && u8[i + 1] === 0x58 && u8[i + 2] === 4) return `${u8[i + 3]}/${2 ** u8[i + 4]}`;
  return '4/4?';
};
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
console.log(pad('file', 40), pad('bpm', 4), pad('sig', 5), pad('drum hits (kick/snr/hat/clap)', 31), pad('roles → notes', 44), 'verdict');
for (const f of fs.readdirSync(dir).filter((x) => /\.midi?$/i.test(x)).sort()) {
  const buf = fs.readFileSync(path.join(dir, f));
  const name = f.replace(/\s*\[MIDIfind\.com\]|\.midi?$/gi, '');
  try {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const s = parseMidi(ab, name);
    const roles: Record<string, number> = {};
    const drums = [0, 0, 0, 0];
    for (const e of s.events) { roles[e.role] = (roles[e.role] ?? 0) + 1; if (e.role === 'drums') drums[e.d]++; }
    const hasDrums = drums.some(Boolean);
    const full = hasDrums && drums[0] > 8 && drums[1] > 8 && (roles.bass ?? 0) > 8 && (roles.guitar ?? 0) + (roles.pads ?? 0) > 8;
    const sg = sig(new Uint8Array(buf));
    const verdict = sg !== '4/4' && sg !== '4/4?' ? `odd meter ${sg}: skip` : full ? 'GOOD: full band' : hasDrums ? 'partial: drums but thin' : 'NO DRUMS';
    console.log(pad(name, 40), pad(String(s.bpm), 4), pad(sg, 5), pad(hasDrums ? drums.join(' / ') : '-', 31), pad(Object.entries(roles).map(([r, n]) => `${r}:${n}`).join(' '), 44), verdict);
  } catch (e) {
    console.log(pad(name, 40), '— cannot import:', e instanceof Error ? e.message : e);
  }
}
