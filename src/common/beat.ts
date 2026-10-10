/**
 * BeatTracker: turns "the synced clock" into frame-by-frame beat info for visuals (and haptics).
 *
 * The flash is NOT triggered by a network message. Each device computes
 *     beatIndex = floor((serverTimeAtPaint - epoch) / beatMs)
 * from its own synced clock, so two phones flash together exactly as well as their clocks agree.
 *
 * Frame quantisation: a 60 Hz screen can only show a new frame every 16.7 ms. We predict the paint
 * time as (rAF timestamp + one frame) and flash on the frame whose paint time is *closest* to the
 * beat (round, not floor), which bounds the quantisation error to +-8.3 ms. The signed error of
 * every flash frame is measured here and reported as `flashLate`.
 */
import { beatMs, type TransportState } from '../../shared/protocol';
import type { ClockSync } from './clock';

const FRAME_MS = 16.7;

export interface BeatFrame {
  /** global beat counter since epoch */
  beat: number;
  beatInBar: number;
  bar: number;
  /** ms since this beat's true time (>= 0 right on the flash frame) */
  since: number;
  /** 0..1 position inside the beat */
  phase: number;
  newBeat: boolean;
  downbeat: boolean;
  /** estimated server time at paint */
  serverMs: number;
}

export class BeatTracker {
  private last = -Infinity;
  private lates: number[] = [];

  frame(clock: ClockSync, ts: TransportState, rafTime: number): BeatFrame {
    const bm = beatMs(ts.bpm);
    const serverMs = clock.toServer(rafTime + FRAME_MS);
    const pos = (serverMs - ts.epoch) / bm;
    const beat = Math.floor(pos + 0.5 * (FRAME_MS / bm)); // round to the nearest frame
    const beatTime = ts.epoch + beat * bm;
    const since = Math.max(0, serverMs - beatTime);
    const newBeat = beat !== this.last;
    if (newBeat) {
      if (this.last !== -Infinity) {
        this.lates.push(serverMs - beatTime);
        if (this.lates.length > 32) this.lates.shift();
      }
      this.last = beat;
    }
    const beatInBar = ((beat % 4) + 4) % 4;
    return { beat, beatInBar, bar: Math.floor(beat / 4), since, phase: Math.min(1, since / bm), newBeat, downbeat: beatInBar === 0, serverMs };
  }

  /** Mean |flash frame time - true beat time| in ms: the quantisation part of the sync error. */
  get flashLate() {
    return this.lates.length ? this.lates.reduce((a, b) => a + Math.abs(b), 0) / this.lates.length : 0;
  }
}

/** Flash envelope: instant attack on the beat, fast exponential decay. */
export const flashEnv = (sinceMs: number, tauMs = 110) => Math.exp(-sinceMs / tauMs);
