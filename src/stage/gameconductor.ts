/** The Stage owns every audible song note. Packets affect future dynamics, never note timing. */
import { stepPos, stepTime, type NoteEvent, type Role, type TransportState } from '../../shared/protocol';
import { getSong } from '../../shared/songs';
import { songSteps, type GameSong } from '../../shared/game';
import type { ClockSync } from '../common/clock';

export class GameConductor {
  private key = '';
  private next = 0;
  private song: GameSong | null = null;
  private lifts = new Map<Role, number>();
  private byStep = new Map<number, { role: Role; n: GameSong['tracks'][Role][number] }[]>();
  constructor(
    private clock: Pick<ClockSync, 'serverNow' | 'isLocked'>,
    private getTransport: () => TransportState | null,
    private playerFor: (role: Role) => string | undefined,
    private emit: (ev: NoteEvent) => void,
    autoTick = true,
  ) { if (autoTick) setInterval(() => this.tick(), 40); }

  hit(startStep: number, step: number, role: Role) {
    const ts = this.getTransport();
    if (!ts?.game || startStep !== ts.game.startStep) return;
    this.ensureSong(ts);
    const now = this.clock.serverNow();
    const age = now - stepTime(ts, step);
    if (age < -200 || age > 2000) return;
    this.lifts.set(role, now);
  }

  private ensureSong(ts: TransportState) {
    const g = ts.game!;
    const key = `${g.songId}:${g.startStep}`;
    if (key === this.key) return;
    this.key = key;
    this.song = g.song ?? getSong(g.songId) ?? null;
    this.byStep.clear(); this.lifts.clear();
    if (!this.song) return;
    for (const role of Object.keys(this.song.tracks) as Role[]) {
      for (const n of this.song.tracks[role]) (this.byStep.get(n.step) ?? this.byStep.set(n.step, []).get(n.step)!).push({ role, n });
    }
    this.next = g.startStep;
  }

  tick() {
    const ts = this.getTransport();
    if (!ts?.game || !this.clock.isLocked) { this.key = ''; return; }
    this.ensureSong(ts);
    if (!this.song) return;
    const now = this.clock.serverNow();
    // Full local arrangement gives a generous scheduling buffer, independent of phone RTT.
    const horizon = Math.floor(stepPos(ts, now + 600));
    if (this.next < stepPos(ts, now + 80)) this.next = Math.ceil(stepPos(ts, now + 120));
    const end = ts.game.startStep + songSteps(this.song);
    while (this.next <= horizon && this.next < end) {
      for (const { role, n } of this.byStep.get(this.next - ts.game.startStep) ?? []) {
        const player = this.playerFor(role);
        const lift = Math.max(0, 1 - (now - (this.lifts.get(role) ?? -Infinity)) / 2400);
        // The tune always remains audible. Hits gently lift the next phrase, with no duplicated notes.
        const gain = player ? 0.72 + 0.28 * lift : 0.82;
        this.emit({ pid: `game:${role}`, role, step: this.next, d: n.d ?? 0, v: n.v * gain, dur: n.dur, midi: n.midi });
      }
      this.next++;
    }
  }
}
