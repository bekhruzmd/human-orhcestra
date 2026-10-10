import { buildChart, DIFF, type ChartNote, type GameSong, type Difficulty } from './game';
import { stepPos, stepTime, type Role, type TransportState } from './protocol';

/**
 * How a part sounds after recent misses. `loss` is 0 (clean) to 1 (all of the last four notes missed).
 * Timing and note count never change, only the sound: a sour slide, now and then a wrong neighbouring note,
 * thinner dynamics and clipped notes (drums swap pieces instead of changing pitch). Deterministic per step so
 * every Stage render of the same performance sounds the same. loss 0 returns the notes exactly as written.
 */
export function souring(role: Role, loss: number, step: number, drum: number) {
  const weird = Math.min(1, Math.max(0, loss) * 1.5); // one miss is already audible, three or more is a mess
  if (weird === 0) return { pitch: 0, drum, gain: 1, dur: 1 };
  const h = (Math.imul(Math.floor(step), 2654435761) >>> 0) % 100;
  const h2 = (Math.imul(Math.floor(step) + 7, 2246822519) >>> 0) % 100;
  const alternate = Math.floor(step / 4) % 2 === 0 ? 1 : -1;
  if (role === 'drums') {
    const swap = weird > 0.5 && h < 35;
    return { pitch: 0, drum: swap ? (drum + 1 + (h2 % 3)) % 4 : drum, gain: 1 - weird * 0.4 * (alternate < 0 ? 1.4 : 1), dur: 1 - weird * 0.3 };
  }
  const wrong = h < Math.min(0.7, Math.max(0, weird - 0.3) * 1.4) * 100;
  const shift = wrong ? [-2, -1, 1, 2][h2 % 4] : 0;
  return { pitch: weird * 0.85 * alternate + shift, drum, gain: 1 - weird * 0.5, dur: 1 - weird * 0.4 };
}

/** Judge expected chart notes, not elapsed silence: musical rests never count as misses. */
export class Participation {
  readonly chart: ChartNote[];
  private hits = new Set<number>();
  private first: number;
  private cursor: number;

  constructor(song: GameSong, role: Role, difficulty: Difficulty, ts: TransportState, now: number) {
    this.chart = buildChart(song, role, difficulty);
    const earliest = stepPos(ts, now - DIFF[difficulty].good) - ts.game!.startStep;
    this.first = this.chart.findIndex((n) => n.step >= earliest);
    if (this.first < 0) this.first = this.chart.length;
    this.cursor = this.first;
  }

  hit(noteId: number, step: number, ts: TransportState) {
    const note = this.chart[noteId];
    if (!note || noteId < this.first || ts.game!.startStep + note.step !== step || this.hits.has(noteId)) return false;
    this.hits.add(noteId);
    return true;
  }

  strength(ts: TransportState, now: number) {
    // Allow the phone's judgement window plus network slack before inferring a miss.
    const deadline = now - DIFF[ts.game!.difficulty].good - 350;
    while (this.cursor < this.chart.length && stepTime(ts, ts.game!.startStep + this.chart[this.cursor].step) <= deadline) this.cursor++;
    let missed = 0;
    for (let i = Math.max(this.first, this.cursor - 4); i < this.cursor; i++) {
      if (!this.hits.has(this.chart[i].id)) missed++;
    }
    // Four recent opportunities: quick recovery, and a forgiving clean start.
    return 1 - missed / 4;
  }
}
