/**
 * Offline accuracy test for the clock-sync algorithm (no sockets, no browser).
 * Each fake phone has a hidden clock skew and a lossy/spiky/asymmetric link to a fake server.
 * We compare ClockSync's estimate with the hidden truth. Run: npm run simtest
 */
import { ClockSync } from '../src/common/clock';

interface Profile { name: string; up: number; down: number; jit: number; spikeP: number; spike: number }
const profiles: Profile[] = [
  { name: 'good wifi          ', up: 3, down: 3, jit: 1.5, spikeP: 0.03, spike: 30 },
  { name: 'busy wifi (spiky)  ', up: 6, down: 6, jit: 4, spikeP: 0.15, spike: 80 },
  { name: 'asymmetric 2ms/14ms', up: 2, down: 14, jit: 2, spikeP: 0.05, spike: 40 },
  { name: 'hackathon wifi     ', up: 12, down: 18, jit: 10, spikeP: 0.25, spike: 150 },
];
const RUN_S = Number(process.env.SECS ?? 12);
const serverNow = () => performance.now(); // fake server's clock
const lat = (base: number, p: Profile) => Math.max(0.2, base + (Math.random() - 0.5) * 2 * p.jit + (Math.random() < p.spikeP ? Math.random() * p.spike : 0));

const results: string[] = [];
await Promise.all(profiles.map(async (p, i) => {
  const skew = (i + 1) * 123456.789 + Math.random() * 1000; // local = server + skew  =>  true offset = -skew
  const localNow = () => performance.now() + skew;
  const c: ClockSync = new ClockSync((m) => {
    setTimeout(() => {
      const s = serverNow();
      setTimeout(() => c.onPong({ id: m.id, c0: m.c0, s }), lat(p.down, p));
    }, lat(p.up, p));
  }, localNow);
  c.start(true);
  const errs: number[] = [];
  const t0 = performance.now();
  while (performance.now() - t0 < RUN_S * 1000) {
    await new Promise((r) => setTimeout(r, 100));
    if (c.isLocked && performance.now() - t0 > 3000) errs.push(Math.abs(c.offset - -skew));
  }
  c.stop();
  errs.sort((a, b) => a - b);
  const st = c.stats();
  const q = (f: number) => errs[Math.floor(errs.length * f)]?.toFixed(2);
  results.push(`${p.name}  true err p50 ${q(0.5)}  p90 ${q(0.9)}  max ${errs[errs.length - 1]?.toFixed(2)} ms   | self-reported err ${st.err.toFixed(2)} ms, rttMin ${st.rttMin.toFixed(1)}, jitter ${st.jitter.toFixed(2)}`);
}));
console.log(`\nClock-sync accuracy after ${RUN_S}s (error of applied offset vs hidden truth):\n`);
console.log(results.sort().join('\n'));
console.log('\nNote: asymmetric paths put a hard floor of (down-up)/2 on any NTP-style estimator.\n');
process.exit(0);
