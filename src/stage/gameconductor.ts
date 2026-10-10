/**
 * Plays the parts of a rhythm-game song that no human is playing (the "AUTO" band; this is also what makes
 * solo mode work). Same lookahead scheduling as the AUTO band and the song loop: events are emitted a few
 * hundred ms ahead, addressed by absolute step. A role is "auto" only while no connected player holds it, so if
 * someone drops mid-song the band quietly covers their instrument.
 *
 * Roles held by humans are NOT touched: their notes sound only when the player actually hits them.
 */
import { stepPos, type NoteEvent, type Role, type TransportState } from '../../shared/protocol';
import { getSong } from '../../shared/songs';
import { songSteps, type GameSong } from '../../shared/game';
import type { ClockSync } from '../common/clock';

export class GameConductor {
  private key = '';
  private next = 0;
  private song: GameSong | null = null;
  private byStep = new Map<number, { role: Role; n: GameSong['tracks'][Role][number] }[]>();

  constructor(
    private clock: ClockSync,
    private getTransport: () => TransportState | null,
    private autoRoles: () => Set<Role>,
    private emit: (ev: NoteEvent) => void,
  ) {
    setInterval(() => this.tick(), 40);
  }

  private load(ts: TransportState) {
    const g = ts.game!;
    this.key = `${g.songId}:${g.startStep}`;
    this.song = getSong(g.songId) ?? null;
    this.byStep.clear();
    if (!this.song) return;
    for (const role of Object.keys(this.song.tracks) as Role[]) {
      for (const n of this.song.tracks[role]) (this.byStep.get(n.step) ?? this.byStep.set(n.step, []).get(n.step)!).push({ role, n });
    }
    this.next = g.startStep;
  }

  private tick() {
    const ts = this.getTransport();
    if (!ts?.game || !this.clock.isLocked) { this.key = ''; return; }
    if (this.key !== `${ts.game.songId}:${ts.game.startStep}`) this.load(ts);
    const song = this.song;
    if (!song) return;
    const now = this.clock.serverNow();
    const horizon = Math.floor(stepPos(ts, now + 350));
    if (this.next < stepPos(ts, now) - 1) this.next = Math.ceil(stepPos(ts, now + 120)); // tab was asleep: don't burst
    const auto = this.autoRoles();
    const end = ts.game.startStep + songSteps(song);
    while (this.next <= horizon && this.next < end) {
      const rel = this.next - ts.game.startStep;
      if (rel >= 0) {
        for (const { role, n } of this.byStep.get(rel) ?? []) {
          if (auto.has(role)) this.emit({ pid: `auto:${role}`, role, step: this.next, d: n.d ?? 0, v: n.v, dur: n.dur, midi: n.midi });
        }
      }
      this.next++;
    }
  }
}
