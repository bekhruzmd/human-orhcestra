// Synthetic "songs": kick on every beat + off-beat hats + noise, at known tempos and start offsets.
import { analyzeAudio } from '../src/stage/audioanalysis';
const SR = 22050;
function track(bpm: number, startSec: number, seconds: number, swingNoise = 0.02) {
  const x = new Float32Array(SR * seconds);
  const beat = 60 / bpm;
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
  for (let i = 0; i < x.length; i++) x[i] = rnd() * swingNoise;
  const burst = (t: number, freq: number, len: number, amp: number) => {
    for (let i = 0; i < len * SR; i++) { const k = Math.floor(t * SR) + i; if (k < x.length) x[k] += Math.sin((2 * Math.PI * freq * i) / SR) * Math.exp(-i / (len * SR * 0.3)) * amp; }
  };
  for (let t = startSec, b = 0; t < seconds; t += beat, b++) {
    burst(t, 60, 0.12, b % 4 === 0 ? 0.9 : 0.6);          // kick (downbeat louder)
    burst(t + beat / 2, 6000, 0.03, 0.25);                 // off-beat hat
    if (b % 2 === 1) burst(t, 220, 0.08, 0.5);             // snare-ish on 2 and 4
  }
  return x;
}
let bad = 0;
for (const [bpm, start] of [[118, 0.35], [92, 0.0], [128.4, 1.1], [75, 0.2], [150, 0.6]] as const) {
  const a = analyzeAudio(track(bpm, start, 40), SR);
  const beat = 60 / bpm;
  // the detected grid offset may be any whole number of beats away from the true start
  const phaseErr = Math.abs((((a.offset - start) / beat + 0.5) % 1 + 1) % 1 - 0.5) * beat * 1000;
  const ok = Math.abs(a.bpm - bpm) <= 1 && phaseErr <= 25;
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} true ${bpm} BPM start ${start}s -> detected ${a.bpm} BPM, grid phase error ${phaseErr.toFixed(1)} ms, confidence ${a.confidence.toFixed(2)}`);
}
const silent = analyzeAudio(new Float32Array(SR * 10), SR);
if (silent.confidence !== 0) { bad++; console.log('✗ silence should have zero confidence'); } else console.log('✓ silence handled');
console.log(bad ? `\n${bad} FAILED` : '\nall good');
process.exit(bad ? 1 : 0);
