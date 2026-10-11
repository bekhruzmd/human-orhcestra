/**
 * One WebSocket to one explicitly chosen Human Orchestra endpoint.
 *  - exactly one live socket at a time (a stale socket's callbacks are ignored via `gen`)
 *  - the endpoint is only trusted after it answers `hello` with a well-formed `welcome`
 *  - 2 s heartbeat ping: the server drops any socket silent for 9 s, and the pongs also feed clock sync
 *  - automatic reconnect with back-off, but only after a first successful handshake
 */
import type { ClientMsg, ServerMsg } from './protocol';

export interface ConnectionEvents {
  onOpen(): void;                       // socket open; hello already sent
  onMessage(m: ServerMsg): void;
  onReady(): void;                      // first valid welcome of this socket
  onDrop(willRetry: boolean, reason: string): void;
}

const HANDSHAKE_MS = 6000;
const HEARTBEAT_MS = 2000;
const BURST_PINGS = 5;

export function normalizeUrl(input: string, pageProtocol: string): { url: string } | { error: string } {
  let s = input.trim();
  if (!s) return { error: 'Enter the Orchestra server address.' };
  if (s.startsWith('/')) return { url: `${pageProtocol === 'https:' ? 'wss' : 'ws'}://${location.host}${s}` };
  if (!/^[a-z]+:\/\//i.test(s)) s = (/^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(s) ? 'ws://' : 'wss://') + s;
  let u: URL;
  try { u = new URL(s); } catch { return { error: 'That does not look like a valid address.' }; }
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return { error: 'Use a ws://, wss://, http:// or https:// address.' };
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (pageProtocol === 'https:' && u.protocol === 'ws:' && !local) {
    return { error: 'This page is HTTPS, so the browser blocks insecure ws:// servers. Use a wss:// address (e.g. the Orchestra tunnel URL) or the built-in /ws bridge.' };
  }
  return { url: u.toString() };
}

export class OrchestraConnection {
  private ws: WebSocket | null = null;
  private gen = 0;
  private retry = 0;
  private everReady = false;
  private timers: { handshake?: ReturnType<typeof setTimeout>; beat?: ReturnType<typeof setInterval>; retry?: ReturnType<typeof setTimeout> } = {};
  private pingId = 0;
  private url = '';
  private hello: ClientMsg = { t: 'hello', kind: 'player' };

  constructor(private ev: ConnectionEvents) {}

  get isOpen() { return this.ws?.readyState === WebSocket.OPEN; }

  connect(url: string, hello: ClientMsg) {
    this.close(); // never two sockets / two subscriptions
    this.url = url; this.hello = hello; this.everReady = false; this.retry = 0;
    this.open();
  }

  /** Intentional leave: stops reconnecting and releases the socket. */
  close() {
    this.gen++;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch { /* already closed */ } }
  }

  send(m: ClientMsg) { if (this.isOpen) this.ws!.send(JSON.stringify(m)); }

  private clearTimers() {
    clearTimeout(this.timers.handshake); clearInterval(this.timers.beat); clearTimeout(this.timers.retry);
    this.timers = {};
  }

  private open() {
    const gen = ++this.gen;
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch (e) { this.dropped(gen, `Could not open socket: ${(e as Error).message}`); return; }
    this.ws = ws;
    let ready = false;
    this.timers.handshake = setTimeout(() => {
      if (!ready && gen === this.gen) { this.dropped(gen, 'Connected, but the server did not answer like Human Orchestra (no welcome).'); }
    }, HANDSHAKE_MS);

    ws.onopen = () => {
      if (gen !== this.gen) return;
      this.send(this.hello);
      this.ev.onOpen();
      let burst = 0;
      const ping = () => this.send({ t: 'ping', id: ++this.pingId, c0: performance.now() });
      ping();
      this.timers.beat = setInterval(() => { ping(); if (burst < BURST_PINGS) { burst++; setTimeout(ping, 120); } }, HEARTBEAT_MS);
      for (let i = 1; i <= 3; i++) setTimeout(() => { if (gen === this.gen) ping(); }, i * 150);
    };
    ws.onmessage = (e) => {
      if (gen !== this.gen) return;
      let m: ServerMsg;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
      if (!ready) {
        if (m.t === 'error' && m.code) { this.dropped(gen, m.message); return; } // e.g. no such room: say so now, not after the timeout
        if (m.t !== 'welcome') return;
        const asked = this.hello.t === 'hello' ? this.hello.room : undefined;
        if (asked && m.room !== asked) {
          this.dropped(gen, 'This server does not support room codes (it ignored the code). Leave the room code empty, or use an Orchestra build with rooms.'); return;
        }
        if (!m.state || typeof m.state.bpm !== 'number' || typeof m.state.epoch !== 'number') {
          this.dropped(gen, 'Server replied with an unexpected welcome; refusing to trust it.'); return;
        }
        ready = true; this.everReady = true; this.retry = 0;
        clearTimeout(this.timers.handshake);
        this.ev.onReady();
      }
      this.ev.onMessage(m);
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => { if (gen === this.gen) this.dropped(gen, ready || this.everReady ? 'Connection lost.' : 'Could not reach the server.'); };
  }

  private dropped(gen: number, reason: string) {
    if (gen !== this.gen) return;
    this.gen++;                                   // invalidate this socket's callbacks
    this.clearTimers();
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch { /* noop */ } }
    const willRetry = this.everReady;
    this.ev.onDrop(willRetry, reason);
    if (willRetry) {
      const wait = Math.min(5000, 400 * 2 ** Math.min(this.retry++, 4));
      this.timers.retry = setTimeout(() => this.open(), wait);
    }
  }
}
