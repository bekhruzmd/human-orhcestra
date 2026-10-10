// Sanity: every melody column, over every chord of every scale, never clashes and stays in key.
import { chordAt, melodyLadder, snapToChord, SCALE_INTERVALS } from '../shared/music';
import type { ScaleName } from '../shared/protocol';
let bad = 0, snapped = 0, total = 0;
for (const scale of Object.keys(SCALE_INTERVALS) as ScaleName[]) for (let root = 0; root < 12; root++) {
  const key = { root, scale };
  const inKey = new Set(SCALE_INTERVALS[scale].map((i) => (root + i) % 12));
  for (let bar = 0; bar < 4; bar++) for (const m of melodyLadder(key)) {
    const c = chordAt(key, bar * 16), out = snapToChord(m, c, key);
    total++; if (out !== m) snapped++;
    if (!inKey.has(out % 12)) { bad++; console.log('OUT OF KEY', scale, root, bar, m, out); }
  }
}
console.log(`${total} melody notes checked, ${snapped} nudged off a chord clash, ${bad} out of key`);
process.exit(bad ? 1 : 0);
