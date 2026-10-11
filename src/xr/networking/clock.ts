/**
 * Server-clock estimation. The server timestamps everything in ms on its own monotonic clock; we keep the
 * offset (server - local performance.now) from the lowest-RTT ping/pong sample in a short window (NTP-style).
 */
export class ServerClock {
  private samples: { rtt: number; offset: number }[] = [];
  offset = 0;
  rtt = 0;
  locked = false;

  reset() { this.samples = []; this.offset = 0; this.rtt = 0; this.locked = false; }

  /** Coarse seed from the welcome message, replaced as soon as a real ping/pong lands. */
  seed(serverNow: number, localNow: number) { if (!this.locked) this.offset = serverNow - localNow; }

  /** c0/c1: local send/receive times; s: server receive time. */
  addPong(c0: number, c1: number, s: number) {
    const rtt = c1 - c0;
    if (!(rtt >= 0) || rtt > 2000) return;
    this.samples.push({ rtt, offset: s - (c0 + c1) / 2 });
    if (this.samples.length > 12) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset; this.rtt = best.rtt; this.locked = true;
  }

  /** Convert a server time to the local performance.now() timeline. */
  toLocal(serverMs: number) { return serverMs - this.offset; }
  serverNow(localNow: number) { return localNow + this.offset; }
}
