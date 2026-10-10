import { buildChart, DIFF, type ChartNote, type GameSong, type Difficulty } from './game';
import { stepPos, stepTime, type Role, type TransportState } from './protocol';

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
