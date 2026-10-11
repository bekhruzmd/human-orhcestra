/**
 * Per-frame musical activity. Mutable on purpose: the render loop reads it every frame, so it must not
 * allocate or trigger React renders. Events arrive from the adapter with the time they SOUND (local clock);
 * `tick` applies the ones that are due, so visuals line up with the audio rather than with packet arrival.
 */
import { ROLES, type Role } from '../networking/protocol';

export interface XRNote {
  type: 'instrument:note';
  instrumentId: Role;
  source: 'phone' | 'song';
  playerId?: string;
  /** 0 kick, 1 snare, 2 hat, 3 clap, 4 open (drums only) */
  drumVoice?: number;
  midi?: number[];
  /** 0..1 */
  velocity: number;
  durSteps: number;
  /** server ms at which the note sounds */
  timestamp: number;
}

export type HitListener = (n: XRNote) => void;

const MAX_PENDING = 512;

class Activity {
  energy = Object.fromEntries(ROLES.map((r) => [r, 0])) as Record<Role, number>;
  drum = new Float32Array(5);
  keys = Object.fromEntries(ROLES.map((r) => [r, new Float32Array(128)])) as Record<Role, Float32Array>;
  /** Total notes applied per role since connect, for HUD counters. */
  counts = Object.fromEntries(ROLES.map((r) => [r, 0])) as Record<Role, number>;
  private pending: { due: number; n: XRNote }[] = [];
  private listeners = new Set<HitListener>();

  onHit(l: HitListener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }

  /** Queue a note to be shown at local time `due` (performance.now() scale). */
  schedule(n: XRNote, due: number) {
    const p = this.pending;
    let i = p.length;
    while (i > 0 && p[i - 1].due > due) i--;
    p.splice(i, 0, { due, n });
    if (p.length > MAX_PENDING) p.shift();
  }

  /** Show a note right now. */
  fire(n: XRNote) {
    const e = this.energy;
    e[n.instrumentId] = Math.min(1.4, e[n.instrumentId] + 0.5 + n.velocity * 0.6);
    this.counts[n.instrumentId]++;
    if (n.instrumentId === 'drums') {
      const v = Math.max(0, Math.min(4, n.drumVoice ?? 0));
      this.drum[v] = Math.min(1.2, this.drum[v] + 0.6 + n.velocity * 0.6);
    } else if (n.midi) {
      const k = this.keys[n.instrumentId];
      for (const m of n.midi) if (m >= 0 && m < 128) k[m] = Math.min(1.2, k[m] + 0.8);
    }
    this.listeners.forEach((l) => l(n));
  }

  tick(now: number, dt: number) {
    const p = this.pending;
    let n = 0;
    while (n < p.length && p[n].due <= now) { this.fire(p[n].n); n++; }
    if (n) p.splice(0, n);
    const decay = Math.exp(-dt * 4.5);
    for (const r of ROLES) {
      this.energy[r] *= decay;
      const k = this.keys[r];
      for (let i = 0; i < 128; i++) if (k[i] > 0.002) k[i] *= decay; else k[i] = 0;
    }
    const dd = Math.exp(-dt * 7);
    for (let i = 0; i < 5; i++) this.drum[i] *= dd;
  }

  clear() {
    this.pending.length = 0;
    for (const r of ROLES) { this.energy[r] = 0; this.keys[r].fill(0); this.counts[r] = 0; }
    this.drum.fill(0);
  }
}

export const activity = new Activity();
