/**
 * Optional 16-step percussion pattern for the playing song. It has no clock of its own: like SongPlayer it
 * emits NoteEvents ahead of time on the server-owned step grid, so it can never drift from the MIDI.
 * Pattern cells are toggled by people; nothing is pre-filled.
 */
import { stepPos, type NoteEvent, type TransportState } from '../../shared/protocol';
import type { ClockSync } from '../common/clock';

/** Row order on screen, with the drum voice index each row triggers (0 kick, 1 snare, 2 hat, 3 clap, 4 open hat). */
export const SEQ_ROWS = [
  { name: 'Kick', d: 0 }, { name: 'Snare', d: 1 }, { name: 'Hat', d: 2 }, { name: 'Open', d: 4 }, { name: 'Clap', d: 3 },
] as const;
export const SEQ_STEPS = 16;

export class Sequencer {
  /** cells[row][step] */
  cells: boolean[][] = SEQ_ROWS.map(() => new Array<boolean>(SEQ_STEPS).fill(false));
  running = false;
  level = 0.9;
  private next = 0;

  constructor(private clock: Pick<ClockSync, 'serverNow' | 'isLocked'>, private getTransport: () => TransportState | null, private emit: (ev: NoteEvent) => void, autoTick = true) {
    if (autoTick) setInterval(() => this.tick(), 40);
  }

  toggle(row: number, step: number) { this.cells[row][step] = !this.cells[row][step]; return this.cells[row][step]; }
  clear() { for (const r of this.cells) r.fill(false); }
  get empty() { return this.cells.every((r) => !r.some(Boolean)); }

  /** Begin on the next transport step; the pattern index is `step % 16`, so bar lines always line up with the song. */
  start() {
    const ts = this.getTransport();
    this.running = true;
    this.next = ts ? Math.ceil(stepPos(ts, this.clock.serverNow() + 120)) : 0;
  }
  stop() { this.running = false; }

  tick() {
    const ts = this.getTransport();
    if (!this.running || !ts || !this.clock.isLocked || ts.paused !== null) return;
    const now = this.clock.serverNow();
    const horizon = Math.floor(stepPos(ts, now + 350));
    if (this.next < stepPos(ts, now) - 1) this.next = Math.ceil(stepPos(ts, now + 120));
    while (this.next <= horizon) {
      const col = ((this.next % SEQ_STEPS) + SEQ_STEPS) % SEQ_STEPS;
      SEQ_ROWS.forEach((row, i) => {
        if (!this.cells[i][col]) return;
        const accent = col % 4 === 0 ? 1 : 0.8; // downbeats a touch stronger
        this.emit({ pid: 'seq:drums', role: 'drums', step: this.next, d: row.d, v: accent * this.level, dur: 1 });
      });
      this.next++;
    }
  }
}
