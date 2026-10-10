/**
 * AUTO band: gentle generative backing for any role no human is playing, so one judge still gets a
 * whole band (and an empty stage still looks alive). It runs on the Stage, reads the SAME transport and
 * emits the SAME NoteEvents a phone would, so audio, guardrails and visuals treat it like any player.
 * Generated events are labelled pid = "auto:<role>".
 */
import { stepPos, STEPS_PER_BAR, type NoteEvent, type Role, type TransportState } from '../../shared/protocol';
import type { ClockSync } from '../common/clock';
import { rnd } from '../common/util';

export class AutoBand {
  private next = -1;
  private melCol = 3;

  constructor(
    private clock: ClockSync,
    private getTransport: () => TransportState | null,
    private activeRoles: () => Role[],
    private emit: (ev: NoteEvent) => void,
  ) {
    setInterval(() => this.tick(), 40);
  }

  private tick() {
    const ts = this.getTransport();
    if (!ts || !this.clock.isLocked) return;
    const now = this.clock.serverNow();
    // Plan ~350 ms ahead so audio can be scheduled precisely (the Stage hears AUTO parts with zero network delay).
    const horizon = Math.floor(stepPos(ts, now + 350));
    if (this.next < stepPos(ts, now) - 1 || this.next < 0) this.next = Math.ceil(stepPos(ts, now + 120));
    const roles = this.activeRoles();
    while (this.next <= horizon) {
      for (const r of roles) this.gen(r, this.next);
      this.next++;
    }
  }

  private ev(role: Role, step: number, d: number, v: number, dur: number) {
    this.emit({ pid: `auto:${role}`, role, step, d, v, dur });
  }

  private gen(role: Role, step: number) {
    const s = step % STEPS_PER_BAR, bar = Math.floor(step / STEPS_PER_BAR);
    switch (role) {
      case 'drums': {
        if (s === 0 || s === 10 || (s === 6 && bar % 2)) this.ev('drums', step, 0, 0.7, 1);
        if (s === 4 || s === 12) this.ev('drums', step, 1, 0.55, 1);
        if (s % 2 === 0) this.ev('drums', step, 2, s % 4 === 2 ? 0.45 : 0.3, 1);
        if (s === 12 && bar % 4 === 3) this.ev('drums', step, 3, 0.5, 1);
        break;
      }
      case 'bass': {
        const pat: Record<number, [number, number]> = { 0: [0, 3], 3: [0, 2], 6: [1, 2], 8: [0, 3], 10: [1, 2], 12: [0, 3], 14: [3, 2] };
        const p = pat[s];
        if (p && !(bar % 2 && s === 3)) this.ev('bass', step, p[0], 0.75, p[1]);
        break;
      }
      case 'pads':
        if (s === 0) this.ev('pads', step, [0, 1, 2, 1][bar % 4], 0.55, STEPS_PER_BAR);
        break;
      case 'melody': {
        const strong = s % 4 === 0, eighth = s % 2 === 0;
        const p = strong ? 0.5 : eighth ? 0.38 : 0.12;
        const restBar = bar % 4 === 3 && s >= 8; // breathe at the end of every phrase
        if (!restBar && rnd(step) < p) {
          const r = rnd(step + 999);
          this.melCol = Math.max(0, Math.min(7, this.melCol + (r < 0.25 ? -2 : r < 0.5 ? -1 : r < 0.75 ? 1 : 2)));
          if (rnd(step + 31) < 0.08) this.melCol = 4 + Math.floor(rnd(step + 7) * 4);
          this.ev('melody', step, this.melCol, 0.5 + 0.25 * rnd(step + 3), 2);
        }
        break;
      }
    }
  }
}
