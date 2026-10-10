// Data-layer checks: every song/instrument/difficulty yields a sane, strictly-ordered chart.
import { SONGS } from '../shared/songs';
import { buildChart, DIFFICULTIES, DIFF, judge, applyHit, applyMiss, emptyStats, accuracy, songSeconds } from '../shared/game';
import { ROLES } from '../shared/protocol';
let bad = 0;
const check = (ok: boolean, what: string) => { if (!ok) { bad++; console.log('✗', what); } };
for (const s of SONGS) {
  console.log(`\n${s.title} · ${s.artist} · ${s.bpm} BPM · ${songSeconds(s).toFixed(0)} s · ${s.bars} bars`);
  for (const role of ROLES) {
    const counts = DIFFICULTIES.map((d) => buildChart(s, role, d));
    console.log(`  ${role.padEnd(7)} notes easy/medium/hard: ${counts.map((c) => c.length).join(' / ')}  lanes used: ${counts.map((c, i) => new Set(c.map((n) => n.lane)).size).join('/')}`);
    check(counts[0].length > 0 && counts[0].length <= counts[1].length && counts[1].length <= counts[2].length, `${s.id}/${role}: easy<=medium<=hard`);
    DIFFICULTIES.forEach((d, i) => {
      const c = counts[i];
      check(c.every((n) => n.lane >= 0 && n.lane < DIFF[d].lanes), `${s.id}/${role}/${d}: lanes in range`);
      check(c.every((n, j) => j === 0 || n.step >= c[j - 1].step), `${s.id}/${role}/${d}: ordered`);
      check(c.every((n) => n.step < s.bars * 16), `${s.id}/${role}/${d}: inside song`);
      const perSec = c.length / songSeconds(s);
      check(perSec < 9, `${s.id}/${role}/${d}: density ${perSec.toFixed(1)}/s`);
    });
    check(new Set(counts[2].map((n) => n.lane)).size >= (role === 'pads' ? 2 : 3), `${s.id}/${role}: hard uses several lanes`);
  }
}
// scoring is deterministic
let st = emptyStats(10);
for (let i = 0; i < 10; i++) st = applyHit(st, i % 2 ? 'good' : 'perfect');
check(st.maxCombo === 10 && st.perfect === 5 && st.good === 5 && Math.abs(accuracy(st) - 80) < 1e-9, 'scoring: combo and accuracy');
check(applyMiss(st).combo === 0, 'miss breaks combo');
check(judge('hard', 39) === 'perfect' && judge('hard', 41) === 'good' && judge('hard', -96) === null && judge('easy', 160) === 'good', 'timing windows');
console.log(bad ? `\n${bad} FAILED` : '\nall good');
process.exit(bad ? 1 : 0);
