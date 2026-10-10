/** The Stage owns every audible song note. Participation affects future pitch, articulation and dynamics, never note timing. */
import { stepPos, stepTime, type NoteEvent, type Role, type TransportState } from '../../shared/protocol';
import { getSong } from '../../shared/songs';
import { freeRoles, songSteps, type GameSong } from '../../shared/game';
import { Participation, souring } from '../../shared/participation';
import type { ClockSync } from '../common/clock';

export class GameConductor {
  private key = '';
  private next = 0;
  private song: GameSong | null = null;
  private players = new Map<string, { role: Role; performance: Participation }>();
  private byStep = new Map<number, { role: Role; n: GameSong['tracks'][Role][number] }[]>();
  constructor(
    private clock: Pick<ClockSync, 'serverNow' | 'isLocked'>,
    private getTransport: () => TransportState | null,
    private playersFor: (role: Role) => string[],
    private emit: (ev: NoteEvent) => void,
    autoTick = true,
  ) { if (autoTick) setInterval(() => this.tick(), 40); }

  hit(startStep: number, step: number, role: Role, pid: string, noteId: number) {
    const ts = this.getTransport();
    if (!ts?.game || ts.paused !== null || startStep !== ts.game.startStep) return;
    this.ensureSong(ts);
    const now = this.clock.serverNow();
    const age = now - stepTime(ts, step);
    if (age < -200 || age > 2000) return;
    this.syncPlayers(ts, now);
    const player = this.players.get(pid);
    if (player?.role === role) player.performance.hit(noteId, step, ts);
  }

  private syncPlayers(ts: TransportState, now: number) {
    if (!this.song) return;
    const present = new Set<string>();
    for (const role of Object.keys(this.song.tracks) as Role[]) {
      for (const pid of this.playersFor(role)) {
        present.add(pid);
        if (this.players.get(pid)?.role !== role) this.players.set(pid, {
          role, performance: new Participation(this.song, role, ts.game!.difficulty, ts, now),
        });
      }
    }
    for (const pid of this.players.keys()) if (!present.has(pid)) this.players.delete(pid);
  }

  /** Every connected player contributes equally to their section's sound. */
  strength(role: Role) {
    const ts = this.getTransport();
    if (!ts?.game) return 1;
    const section = [...this.players.values()].filter((p) => p.role === role);
    return section.length ? section.reduce((sum, p) => sum + p.performance.strength(ts, ts.paused ?? this.clock.serverNow()), 0) / section.length : 1;
  }

  private ensureSong(ts: TransportState) {
    const g = ts.game!;
    const key = `${g.songId}:${g.startStep}:${g.difficulty}`;
    if (key === this.key) return;
    this.key = key;
    this.song = g.song ?? getSong(g.songId) ?? null;
    this.byStep.clear(); this.players.clear();
    if (!this.song) return;
    for (const role of Object.keys(this.song.tracks) as Role[]) {
      for (const n of this.song.tracks[role]) (this.byStep.get(n.step) ?? this.byStep.set(n.step, []).get(n.step)!).push({ role, n });
    }
    this.next = g.startStep;
  }

  tick() {
    const ts = this.getTransport();
    if (!ts?.game || !this.clock.isLocked) { this.key = ''; return; }
    if (ts.paused !== null) return;
    this.ensureSong(ts);
    if (!this.song) return;
    const now = this.clock.serverNow();
    this.syncPlayers(ts, now);
    const strengths = new Map(Object.keys(this.song.tracks).map((role) => [role, this.strength(role as Role)]));
    // Full local arrangement gives a generous scheduling buffer, independent of phone RTT.
    const horizon = Math.floor(stepPos(ts, now + 600));
    if (this.next < stepPos(ts, now + 80)) this.next = Math.ceil(stepPos(ts, now + 120));
    const end = ts.game.startStep + songSteps(this.song);
    const free = freeRoles(ts.game, this.song);
    while (this.next <= horizon && this.next < end) {
      for (const { role, n } of this.byStep.get(this.next - ts.game.startStep) ?? []) {
        if (free.includes(role)) continue; // muted on purpose: people play this part live
        const sour = souring(role, 1 - strengths.get(role)!, this.next, n.d ?? 0);
        this.emit({ pid: `game:${role}`, role, step: this.next, d: sour.drum, v: n.v * sour.gain, dur: Math.max(0.5, n.dur * sour.dur),
          midi: n.midi?.map((pitch) => Math.max(0, Math.min(127, pitch + sour.pitch))) });
      }
      this.next++;
    }
  }
}
