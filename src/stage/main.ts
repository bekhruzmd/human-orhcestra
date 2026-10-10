import { Net } from '../common/net';
import { ClockSync } from '../common/clock';
import { BeatTracker, flashEnv } from '../common/beat';
import { fmt, syncHeadline } from '../common/util';
import type { PlayerInfo, TransportState } from '../../shared/protocol';

const net = new Net();
const clock = new ClockSync((m) => net.send(m));
const beats = new BeatTracker();
let ts: TransportState | null = null;
let roster: PlayerInfo[] = [];

document.getElementById('app')!.innerHTML = `<div id="flash"></div><pre class="dbg" id="dbg"></pre>`;
const flashEl = document.getElementById('flash')!;
const dbg = document.getElementById('dbg')!;

net.onOpen(() => { net.send({ t: 'hello', kind: 'stage' }); clock.start(true); });
net.on('pong', (m) => clock.onPong(m));
net.on('welcome', (m) => { ts = m.state; });
net.on('state', (m) => { ts = m.state; });
net.on('roster', (m) => { roster = m.players; });

let bf = { bar: 0, beatInBar: 0 };
function frame(t: number) {
  requestAnimationFrame(frame);
  if (!ts || !clock.isLocked) return;
  const b = beats.frame(clock, ts, t);
  bf = b;
  flashEl.style.opacity = String((b.downbeat ? 0.5 : 0.25) * flashEnv(b.since));
}
requestAnimationFrame(frame);
setInterval(() => {
  const lines = roster.map((p) => { const h = syncHeadline(p.sync); return `${p.name.padEnd(14)} ${p.role.padEnd(7)} err ${fmt(h.err)} ms ±${fmt(h.bound)}  ${p.connected ? '' : '(offline)'}`; });
  dbg.textContent = `bar ${bf.bar + 1} beat ${bf.beatInBar + 1}  bpm ${ts?.bpm}\n\n` + lines.join('\n');
}, 250);
net.connect();
