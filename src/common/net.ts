/**
 * WebSocket wrapper that survives Wi-Fi drops:
 *   - exponential-ish back-off reconnect (250 ms .. 2 s: demos are short, be eager)
 *   - dead-socket detection: if nothing arrives for 6 s (phone silently left Wi-Fi) we force-close
 *   - fires 'open' on EVERY (re)connect so callers can re-hello and restart clock sync
 *   - reconnects immediately when the tab becomes visible / the network comes back
 */
import type { ClientMsg, ServerMsg } from '../../shared/protocol';

type Handler<T> = (m: T) => void;

export class Net {
  private ws: WebSocket | null = null;
  private retry = 0;
  private lastRx = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private handlers = new Map<string, Handler<any>[]>();
  private openHandlers: (() => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  connected = false;

  constructor(private path = '/ws') {
    addEventListener('online', () => this.kick());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.kick(); });
  }

  onOpen(h: () => void) { this.openHandlers.push(h); }
  onClose(h: () => void) { this.closeHandlers.push(h); }
  on<T extends ServerMsg['t']>(type: T, h: Handler<Extract<ServerMsg, { t: T }>>) {
    (this.handlers.get(type) ?? this.handlers.set(type, []).get(type)!).push(h);
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${this.path}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    const connectTimeout = setTimeout(() => { if (ws.readyState === WebSocket.CONNECTING) ws.close(); }, 6000);
    ws.onopen = () => {
      clearTimeout(connectTimeout);
      this.retry = 0; this.connected = true; this.lastRx = performance.now();
      this.openHandlers.forEach((h) => h());
    };
    ws.onmessage = (e) => {
      this.lastRx = performance.now();
      let m: ServerMsg;
      try { m = JSON.parse(e.data); } catch { return; }
      this.handlers.get(m.t)?.forEach((h) => h(m));
    };
    ws.onclose = () => {
      clearTimeout(connectTimeout);
      if (this.ws !== ws) return;
      const was = this.connected;
      this.connected = false;
      if (was) this.closeHandlers.forEach((h) => h());
      setTimeout(() => this.connect(), Math.min(2000, 250 * 2 ** Math.min(this.retry++, 3)));
    };
    ws.onerror = () => ws.close();

    if (!this.watchdog) {
      this.watchdog = setInterval(() => {
        if (this.connected && performance.now() - this.lastRx > 6000) this.ws?.close(); // half-open
      }, 1500);
    }
  }

  /** Called on 'online' / tab-visible: don't wait for the back-off timer. */
  private kick() {
    if (!this.connected) this.connect();
    else if (performance.now() - this.lastRx > 3000) this.ws?.close();
  }

  send(m: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
}
