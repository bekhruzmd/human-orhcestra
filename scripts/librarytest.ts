import { LIBRARY, buildSong } from '../src/songs/library';
let bad = 0;
for (const def of LIBRARY) {
  try {
    const s = buildSong(def);
    const mel = s.events.filter((e) => e.role === 'melody');
    const ok = s.steps % 64 === 0 || s.steps % 16 === 0;
    const range = mel.every((e) => e.midi![0] >= 48 && e.midi![0] <= 84);
    console.log(`${ok && range ? '✓' : '✗'} ${def.title}: ${s.steps / 16} bars, ${mel.length} melody notes, ${s.events.length} events`);
    if (!ok || !range) bad++;
  } catch (e) { console.log('✗', def.title, (e as Error).message); bad++; }
}
process.exit(bad ? 1 : 0);
