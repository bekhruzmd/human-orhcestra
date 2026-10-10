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

/** Easy: steps of unanswered notes before a part fades (one bar) and is silent (two bars). */
const FADE_FROM = 16, SILENT_AFTER = 32;
/** Medium and Hard: consecutive unanswered notes before a part goes silent. */
const SILENT_AFTER_NOTES = 2;

/** Judge expected chart notes, not elapsed silence: musical rests never count as misses. */
export class Participation {
  readonly chart: ChartNote[];
  private hits = new Set<number>();
  private first: number;
  private cursor: number;
  /** chart step of the latest note the player hit, and of the latest note that has passed unanswered */
  private lastHitStep: number;
  private lastPassedStep: number;
  /** index of the highest chart note the player has hit (first - 1 before any hit) */
  private lastHitIndex: number;

  constructor(song: GameSong, role: Role, difficulty: Difficulty, ts: TransportState, now: number) {
    this.chart = buildChart(song, role, difficulty);
    const earliest = stepPos(ts, now - DIFF[difficulty].good) - ts.game!.startStep;
    this.first = this.chart.findIndex((n) => n.step >= earliest);
    if (this.first < 0) this.first = this.chart.length;
    this.cursor = this.first;
    this.lastHitStep = this.lastPassedStep = this.chart[this.first]?.step ?? 0;
    this.lastHitIndex = this.first - 1;
  }

  hit(noteId: number, step: number, ts: TransportState) {
    const note = this.chart[noteId];
    if (!note || noteId < this.first || ts.game!.startStep + note.step !== step || this.hits.has(noteId)) return false;
    this.hits.add(noteId);
    this.lastHitStep = Math.max(this.lastHitStep, note.step);
    this.lastHitIndex = Math.max(this.lastHitIndex, noteId);
    return true;
  }

  /**
   * 1 = the part plays, 0 = it is silent. Medium and Hard: the part goes silent once two notes in a row go
   * unanswered (a single slip only sours it), and one hit brings it back. Easy is forgiving: it fades from one bar
   * of unanswered notes and is silent at two. A "Good" hit counts the same as a "Perfect" one, so an imperfect
   * player keeps the full song. Measured in chart notes, so rests never count and pausing freezes it.
   */
  quiet(ts: TransportState, now: number) {
    this.strength(ts, now); // advances the cursor and the latest unanswered note
    if (ts.game!.difficulty !== 'easy') return this.cursor - 1 - this.lastHitIndex >= SILENT_AFTER_NOTES ? 0 : 1;
    const idle = Math.max(0, this.lastPassedStep - this.lastHitStep);
    if (idle <= FADE_FROM) return 1;
    const k = Math.max(0, 1 - (idle - FADE_FROM) / (SILENT_AFTER - FADE_FROM));
    return k * k;
  }

  strength(ts: TransportState, now: number) {
    // Allow the phone's judgement window plus network slack before inferring a miss.
    const deadline = now - DIFF[ts.game!.difficulty].good - 350;
    while (this.cursor < this.chart.length && stepTime(ts, ts.game!.startStep + this.chart[this.cursor].step) <= deadline) this.cursor++;
    if (this.cursor > this.first) this.lastPassedStep = Math.max(this.lastPassedStep, this.chart[this.cursor - 1].step);
    let missed = 0;
    for (let i = Math.max(this.first, this.cursor - 4); i < this.cursor; i++) {
      if (!this.hits.has(this.chart[i].id)) missed++;
    }
    // Four recent opportunities: quick recovery, and a forgiving clean start.
    return 1 - missed / 4;
  }
}
