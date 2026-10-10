import { Net } from '../common/net';
import { ClockSync } from '../common/clock';
import { BeatTracker, flashEnv } from '../common/beat';
import { stableId, fmt } from '../common/util';
import type { PlayerInfo, TransportState } from '../../shared/protocol';

const app = document.getElementById('app')!;
const net = new Net();
const id = stableId();
const clock = new ClockSync((m) => net.send(m));
const beats = new BeatTracker();

let ts: TransportState | null = null;
let me: PlayerInfo | null = null;
let joined = false;

app.innerHTML = `<div id="flash"></div><div id="root"></div><div class="banner" id="banner" hidden>Reconnecting…</div>`;
const root = document.getElementById('root')!;
const flashEl = document.getElementById('flash')!;
const banner = document.getElementById('banner')!;

net.onOpen(() => {
  banner.hidden = true;
  net.send({ t: 'hello', kind: 'player', id });
  clock.start(true); // offsets can be stale after a drop (frozen tab, new route): relock from scratch
  if (joined && me) net.send({ t: 'join', name: me.name }); // rejoin keeps seat on the server
});
net.onClose(() => { banner.hidden = false; });
net.on('pong', (m) => clock.onPong(m));
net.on('welcome', (m) => { ts = m.state; me = m.you; render(); });
net.on('state', (m) => { ts = m.state; });
net.on('you', (m) => { me = m.you; render(); });

function render() {
  if (!me) return;
  document.documentElement.style.setProperty('--c', me.color);
  if (!joined) {
    root.innerHTML = `<div class="screen join">
      <div class="swatch"></div><h1>Human Orchestra</h1>
      <p>You're <b style="color:${me.color}">this colour</b>. Pick a name.</p>
      <input id="name" maxlength="14" value="${me.name}" autocomplete="off" />
      <button class="big" id="go">JOIN THE BAND</button>
      <div class="hint">Turn your volume up. Your phone is an instrument.</div></div>`;
    document.getElementById('go')!.onclick = () => {
      joined = true;
      net.send({ t: 'join', name: (document.getElementById('name') as HTMLInputElement).value });
      render();
    };
  } else {
    root.innerHTML = `<div class="screen"><div class="top"><div class="chip">${me.role}</div><div class="name">${me.name}</div></div>
      <pre class="dbg" id="dbg"></pre></div>`;
  }
}

function frame(t: number) {
  requestAnimationFrame(frame);
  if (!ts || !clock.isLocked) return;
  const b = beats.frame(clock, ts, t);
  flashEl.style.opacity = String((b.downbeat ? 0.95 : 0.6) * flashEnv(b.since));
  if (b.newBeat) navigator.vibrate?.(b.downbeat ? 30 : 12);
}
requestAnimationFrame(frame);

setInterval(() => {
  const s = clock.stats(beats.flashLate);
  net.send({ t: 'stats', stats: s });
  const d = document.getElementById('dbg');
  if (d) d.textContent = `offset ${fmt(s.offset, 2)} ms\njitter ${fmt(s.jitter, 2)} ms\nrtt   ${fmt(s.rttMin)} min / ${fmt(s.rttLast)} last\nerr   ${fmt(s.err)} ms  flash ${fmt(s.flashLate)} ms`;
}, 1000);

net.connect();
