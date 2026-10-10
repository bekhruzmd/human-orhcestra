/**
 * Clock sync: estimates   offset = serverTime - localTime   with NTP-style ping exchanges.
 *
 * One exchange:
 *      client                         server
 *   c0 = local.now()  ── ping(c0) ─────────▶  s = server.now()   (stamped on receipt)
 *   c3 = local.now()  ◀──── pong(c0, s) ────
 *
 *   rtt    = c3 - c0
 *   offset = s - (c0 + c3) / 2         (assumes the path is symmetric: s happened mid-flight)
 *
 * If the real path is asymmetric by δ ms the offset is off by δ/2, and δ can never exceed the RTT,
 * so   |error| <= rtt/2   for any sample. Hence the core trick:
 *
 *   1. Keep a sliding window of samples (last WINDOW exchanges).
 *   2. Keep only the lowest-RTT slice (default best 30%). Wi-Fi delay is "mostly fast with random
 *      spikes"; the spikes are what make paths asymmetric. A low-RTT sample has a tiny error bound.
 *   3. Take the MEDIAN offset of that slice (robust against one more outlier).
 *
 * Sync "error" shown in the UI is measured, not guessed: every fresh low-RTT probe is compared
 * with the offset we are currently applying (a held-out prediction test). The p90 of those
 * residuals is the number we display. The rtt/2 bound is shown next to it.
 *
 * To stay glitch-free the applied offset slews (max SLEW_MS per update) after the initial lock.
 */
import type { SyncStats } from '../../shared/protocol';

interface Sample { rtt: number; offset: number }

const WINDOW = 48;
const KEEP_FRACTION = 0.3;
const MIN_KEEP = 5;
const BURST = 24;
const BURST_GAP_MS = 40;
const STEADY_GAP_MS = 1500;
const SLEW_MS = 1.5;

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export class ClockSync {
  private samples: Sample[] = [];
  private residuals: number[] = [];
  private nextId = 1;
  private pending = new Map<number, number>(); // id -> c0
  private timer: ReturnType<typeof setTimeout> | null = null;
  private burstLeft = 0;
  private _offset = 0;
  private locked = false;
  private _jitter = 0;
  private _rttMin = Infinity;
  private _rttLast = 0;

  /** @param now local monotonic clock in ms (performance.now in browsers). Injectable for tests. */
  constructor(private send: (m: { t: 'ping'; id: number; c0: number }) => void, private now: () => number = () => performance.now()) {}

  /** Estimated server time (ms) right now. */
  serverNow() { return this.now() + this._offset; }
  /** Convert a local monotonic timestamp (e.g. a rAF timestamp) to server time. */
  toServer(local: number) { return local + this._offset; }
  toLocal(server: number) { return server - this._offset; }
  get offset() { return this._offset; }
  get isLocked() { return this.locked; }

  /** Begin (or restart) syncing: a fast burst to lock quickly, then a slow steady probe. */
  start(resetEstimate = false) {
    if (resetEstimate) { this.samples = []; this.residuals = []; this.locked = false; }
    this.burstLeft = BURST;
    this.pending.clear();
    this.tick();
  }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  private tick = () => {
    const id = this.nextId++;
    const c0 = this.now();
    this.pending.set(id, c0);
    if (this.pending.size > 20) this.pending.delete(this.pending.keys().next().value as number);
    this.send({ t: 'ping', id, c0 });
    const gap = this.burstLeft > 0 ? BURST_GAP_MS : STEADY_GAP_MS;
    if (this.burstLeft > 0) this.burstLeft--;
    this.timer = setTimeout(this.tick, gap);
  };

  onPong(m: { id: number; c0: number; s: number }) {
    const c3 = this.now(); // stamp first thing
    const c0 = this.pending.get(m.id);
    if (c0 === undefined) return;
    this.pending.delete(m.id);
    const rtt = c3 - c0;
    if (rtt < 0 || rtt > 2000) return;
    const sample: Sample = { rtt, offset: m.s - (c0 + c3) / 2 };
    this._rttLast = rtt;

    // Held-out test: how wrong was our *current* offset for this fresh, trustworthy probe?
    if (this.locked && rtt <= 1.5 * this._rttMin + 2) {
      this.residuals.push(Math.abs(sample.offset - this._offset));
      if (this.residuals.length > 40) this.residuals.shift();
    }

    this.samples.push(sample);
    if (this.samples.length > WINDOW) this.samples.shift();
    this.recompute();
  }

  private recompute() {
    const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    this._rttMin = byRtt[0].rtt;
    const keep = byRtt.slice(0, Math.max(MIN_KEEP, Math.ceil(byRtt.length * KEEP_FRACTION)));
    const target = median(keep.map((s) => s.offset));
    // Robust spread: MAD scaled to a std-dev equivalent.
    this._jitter = 1.4826 * median(keep.map((s) => Math.abs(s.offset - target)));

    if (!this.locked) {
      if (this.samples.length >= 6) { this._offset = target; this.locked = true; } // first lock: jump
      return;
    }
    const delta = target - this._offset;
    if (Math.abs(delta) > 50) this._offset = target; // clock jumped (tab was frozen): don't crawl
    else this._offset += Math.max(-SLEW_MS, Math.min(SLEW_MS, delta));
  }

  stats(flashLate = 0): SyncStats {
    const res = [...this.residuals].sort((a, b) => a - b);
    return {
      offset: this._offset,
      jitter: this._jitter,
      rttMin: Number.isFinite(this._rttMin) ? this._rttMin : 0,
      rttLast: this._rttLast,
      err: res.length ? res[Math.min(res.length - 1, Math.floor(res.length * 0.9))] : 0,
      flashLate,
      samples: this.samples.length,
    };
  }
}
