/**
 * Tempo + beat-grid detection for an uploaded audio file. Pure functions (no Web Audio), so they run in Node tests.
 *
 *  1. Onset envelope: first-difference (cheap high-pass, emphasises transients) -> RMS per 256-sample hop ->
 *     log-compress -> positive difference.
 *  2. Tempo: autocorrelation of the envelope over the 60-180 BPM lag range, weighted by a mild prior around
 *     ~115 BPM (breaks octave ties), then a fine comb search (0.1 BPM steps, fractional positions) around the best peaks.
 *  3. Phase: the comb offset that lines the beat grid up with the strongest onsets, using a second envelope from
 *     the kick band (< ~150 Hz) weighted heavily: hats and snares often sit on the off-beat, kicks on the beat.
 *     The grid is then moved forward to the first real musical onset so slice 0 starts where the music does.
 *
 * It is a heuristic: half/double-time confusion is the classic failure, so the UI offers x2 / ÷2 buttons.
 */
export interface Analysis {
  bpm: number;
  /** seconds into the file where beat 0 of the grid sits */
  offset: number;
  /** 0..1: how much stronger the chosen grid is than the average grid (low = unreliable) */
  confidence: number;
  /** downsampled peak envelope for drawing, values 0..1 */
  peaks: number[];
}

const HOP = 256;
const MAX_SECONDS = 120; // analyse the first two minutes: plenty, and keeps long files fast

export function analyzeAudio(samples: Float32Array, sampleRate: number): Analysis {
  const n = Math.min(samples.length, Math.floor(sampleRate * MAX_SECONDS));
  const frames = Math.floor(n / HOP);
  const hopSec = HOP / sampleRate;
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * HOP + 1; i < (f + 1) * HOP; i++) { const d = samples[i] - samples[i - 1]; sum += d * d; }
    rms[f] = Math.sqrt(sum / HOP);
  }
  // kick-band energy: one-pole low-pass (~150 Hz), RMS per hop
  const lowRms = new Float32Array(frames);
  const a = Math.min(1, (2 * Math.PI * 150) / sampleRate);
  let y = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * HOP; i < (f + 1) * HOP; i++) { y += a * (samples[i] - y); sum += y * y; }
    lowRms[f] = Math.sqrt(sum / HOP);
  }
  const diffEnv = (r: Float32Array) => {
    const e = new Float32Array(frames);
    let m = 0;
    for (let f = 1; f < frames; f++) { e[f] = Math.max(0, Math.log1p(r[f] * 200) - Math.log1p(r[f - 1] * 200)); if (e[f] > m) m = e[f]; }
    if (m > 0) for (let f = 0; f < frames; f++) e[f] /= m;
    return e;
  };
  const broad = diffEnv(rms), low = diffEnv(lowRms);
  // combined onset envelope: broadband for general rhythm + extra weight on the kick band for the beat phase
  const env = new Float32Array(frames);
  let maxEnv = 0;
  for (let f = 0; f < frames; f++) { env[f] = 0.5 * broad[f] + 1.0 * low[f]; if (env[f] > maxEnv) maxEnv = env[f]; }

  // ---- display peaks (whole file, 600 buckets)
  const peaks: number[] = [];
  const bucket = Math.max(1, Math.floor(samples.length / 600));
  let pk = 0;
  for (let b = 0; b < 600; b++) {
    let m = 0;
    for (let i = b * bucket; i < Math.min(samples.length, (b + 1) * bucket); i += 16) m = Math.max(m, Math.abs(samples[i]));
    peaks.push(m); pk = Math.max(pk, m);
  }
  if (pk > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= pk;

  if (frames < 200 || maxEnv === 0) return { bpm: 100, offset: 0, confidence: 0, peaks };

  // ---- tempo: autocorrelation over plausible lags
  const lagMin = Math.floor(60 / 180 / hopSec), lagMax = Math.ceil(60 / 60 / hopSec);
  const ac: number[] = [];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let i = 0; i + lag < frames; i++) s += env[i] * env[i + lag];
    ac[lag] = s / (frames - lag);
  }
  const prior = (bpm: number) => Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.6) ** 2);
  const cands: { bpm: number; score: number }[] = [];
  for (let lag = lagMin + 1; lag < lagMax; lag++) {
    if (ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1]) {
      const bpm = 60 / (lag * hopSec);
      cands.push({ bpm, score: ac[lag] * (0.55 + 0.45 * prior(bpm)) });
    }
  }
  cands.sort((a, b) => b.score - a.score);

  // ---- fine search: comb score at fractional positions
  const at = (x: number) => { const i = Math.floor(x); if (i < 0 || i + 1 >= frames) return 0; const f = x - i; return env[i] * (1 - f) + env[i + 1] * f; };
  let best = { score: -1, bpm: cands[0]?.bpm ?? 100, phase: 0 };
  let sumAll = 0, countAll = 0;
  for (const c of cands.slice(0, 4)) {
    for (let bpm = c.bpm - 3; bpm <= c.bpm + 3; bpm += 0.1) {
      if (bpm < 60 || bpm > 180) continue;
      const period = 60 / bpm / hopSec;
      for (let ph = 0; ph < period; ph += 1) {
        let s = 0, k = 0;
        for (let x = ph; x < frames - 2; x += period) { s += at(x); k++; }
        s = (s / k) * (0.6 + 0.4 * prior(bpm));
        sumAll += s; countAll++;
        if (s > best.score) best = { score: s, bpm, phase: ph };
      }
    }
  }
  const confidence = Math.max(0, Math.min(1, countAll ? 1 - (sumAll / countAll) / best.score : 0));

  // ---- move the grid to the first real onset
  const period = 60 / best.bpm / hopSec;
  let first = 0;
  for (let f = 1; f < frames; f++) if (env[f] > maxEnv * 0.3) { first = f; break; }
  const k = Math.max(0, Math.round((first - best.phase) / period));
  const offset = (best.phase + k * period) * hopSec;
  return { bpm: Math.round(best.bpm * 10) / 10, offset, confidence, peaks };
}
