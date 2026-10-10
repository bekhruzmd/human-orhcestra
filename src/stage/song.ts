/** Loops a Song on the shared transport: emits NoteEvents a little ahead of time, like the AUTO band does. */
import { stepPos, type NoteEvent, type TransportState } from '../../shared/protocol';
import type { ClockSync } from '../common/clock';
import type { Song, SongEv } from './composer';

export class SongPlayer {
  song: Song | null = null;
  level = 1;
  private byRel = new Map<number, SongEv[]>();
  private next = 0;

  constructor(private clock: Pick<ClockSync, 'serverNow' | 'isLocked'>, private getTransport: () => TransportState | null, private emit: (ev: NoteEvent) => void, autoTick = true) {
    if (autoTick) setInterval(() => this.tick(), 40);
  }

  start(song: Song, startStep: number) {
    song.startStep = startStep;
    this.byRel.clear();
    for (const e of song.events) (this.byRel.get(e.rel) ?? this.byRel.set(e.rel, []).get(e.rel)!).push(e);
    this.song = song;
    this.next = startStep;
  }
  stop() { this.song = null; this.level = 1; }

  tick() {
    const ts = this.getTransport(), song = this.song;
    if (!ts || !song || !this.clock.isLocked || ts.paused !== null) return;
    const now = this.clock.serverNow();
    const horizon = Math.floor(stepPos(ts, now + 350));
    if (this.next < stepPos(ts, now) - 1) this.next = Math.ceil(stepPos(ts, now + 120));
    while (this.next <= horizon) {
      const rel = (((this.next - song.startStep) % song.steps) + song.steps) % song.steps;
      for (const e of this.byRel.get(rel) ?? []) {
        if (this.level <= 0) continue;
        this.emit({ pid: `song:${e.role}`, role: e.role, step: this.next, d: e.d, v: e.v * this.level, dur: e.dur, midi: e.midi });
      }
      this.next++;
    }
  }
}
