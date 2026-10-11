/**
 * Tempo from conducting beats. A beat (a drop-and-rebound of the baton hand, or a tap) is fed in with its time in
 * seconds; once the last few gaps agree, the tempo they imply is returned. Pure logic, no browser or XR calls.
 */
export class TempoTracker {
  private last = -Infinity;
  private gaps: number[] = [];

  reset() { this.last = -Infinity; this.gaps = []; }

  /** Register one beat at time `t` (s). Returns the tempo in BPM once the recent beats are steady, else null. */
  beat(t: number): number | null {
    const gap = t - this.last;
    this.last = t;
    if (gap > 2.0) { this.gaps = []; return null; }   // a pause in the conducting: start over
    if (gap < 0.28) return null;                      // double-trigger or jitter, not a beat
    this.gaps.push(gap);
    if (this.gaps.length > 5) this.gaps.shift();
    if (this.gaps.length < 3) return null;
    const sorted = [...this.gaps].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    // every recent gap must sit within 25% of the median, otherwise the beat is still unsteady
    if (this.gaps.some((g) => Math.abs(g - med) > med * 0.25)) return null;
    const bpm = 60 / med;
    return bpm >= 55 && bpm <= 190 ? bpm : null;
  }
}

/**
 * Detects the "ictus" of a conducting beat from a hand's height over time: a fast downward stroke that stops.
 * Feed `update(y, t)` every frame; it returns true on the frame a beat lands.
 */
export class BeatDetector {
  private y = NaN;
  private t = 0;
  private vy = 0;
  private falling = false;
  private top = -Infinity;
  private lastBeat = -Infinity;

  reset() { this.y = NaN; this.vy = 0; this.falling = false; this.top = -Infinity; }

  update(y: number, t: number): boolean {
    if (Number.isNaN(this.y) || t - this.t > 0.25) { this.y = y; this.t = t; this.top = y; this.vy = 0; this.falling = false; return false; }
    const dt = t - this.t;
    if (dt <= 0) return false;
    this.vy = this.vy * 0.6 + ((y - this.y) / dt) * 0.4;
    this.y = y; this.t = t;
    if (!this.falling) {
      this.top = Math.max(this.top, y);
      if (this.vy < -0.55) this.falling = true;
      return false;
    }
    if (this.vy > -0.15) { // the stroke has stopped or rebounded: that is the beat
      this.falling = false;
      const drop = this.top - y;
      this.top = y;
      if (drop > 0.06 && t - this.lastBeat > 0.28) { this.lastBeat = t; return true; }
    }
    return false;
  }
}
