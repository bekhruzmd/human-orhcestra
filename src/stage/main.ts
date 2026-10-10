/**
 * Stage (laptop / big screen).
 *  - same synced clock as the phones: it is just another client, so audio, visuals and flashes line up
 *  - plays everyone's notes (except phones that report speaker mode) + the AUTO band
 *  - conductor controls are commands to the server; only Stage sockets may send them
 */
import QRCode from 'qrcode';
import { Net } from '../common/net';
import { ClockSync } from '../common/clock';
import { BeatTracker, flashEnv } from '../common/beat';
import { Engine } from '../common/engine';
import { Recorder } from '../common/recorder';
import { fmt, syncHeadline } from '../common/util';
import {
  BPM_MAX, BPM_MIN, ROLES, ROLE_INFO, dropPhase, stepPos, stepTime,
  type NoteEvent, type PlayerInfo, type Role, type ScaleName, type TransportState,
} from '../../shared/protocol';
import { NOTE_NAMES, SCALE_LABEL, chordAt } from '../../shared/music';
import { Viz, type Lane } from './visuals';
import { AutoBand } from './auto';

const net = new Net();
const clock = new ClockSync((m) => net.send(m));
const beats = new BeatTracker();
const engine = new Engine(clock, true);
const rec = new Recorder(engine);

let ts: TransportState | null = null;
let roster: PlayerInfo[] = [];

const app = document.getElementById('app')!;
app.innerHTML = `
<div id="flash"></div>
<canvas id="viz"></canvas>
<div id="big"></div>
<div class="hud">
  <div class="brand">HUMAN ORCHESTRA<small id="keyline">–</small><span class="mode" id="mode">WAITING</span></div>
  <div class="chordbox"><span class="lbl">CHORD</span><b id="chord">–</b><small id="next">&nbsp;</small></div>
  <div class="stat"><span class="lbl">BPM</span><b id="bpm">–</b></div>
  <div class="stat"><span class="lbl">BAR · BEAT</span><b id="bar">–</b></div>
  <div class="stat sync"><span class="lbl">SYNC ERROR (WORST PHONE)</span><b id="sync">–</b><small id="syncsub">waiting for phones</small></div>
</div>
<aside class="side">
  <div class="qrbox"><canvas id="qr"></canvas></div>
  <div class="scan">SCAN TO JOIN</div><div id="url"></div><div id="warn"></div>
  <div id="roster"></div>
</aside>
<button id="audio">🔇 SOUND OFF · click to enable audio</button>
<footer class="conductor" id="cond">
  <div class="ctl"><span class="lbl">TEMPO <b id="bpmv"></b></span><input id="bpmr" type="range" min="${BPM_MIN}" max="${BPM_MAX}" step="1" /></div>
  <div class="ctl"><span class="lbl">KEY</span><select id="key">${NOTE_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select></div>
  <div class="ctl"><span class="lbl">SCALE</span><select id="scale">${(Object.keys(SCALE_LABEL) as ScaleName[]).map((s) => `<option value="${s}">${SCALE_LABEL[s]}</option>`).join('')}</select></div>
  <button class="btn drop" id="drop">DROP</button>
  <span class="spacer"></span>
  <button class="btn" id="auto">AUTO BAND</button>
  <button class="btn" id="spk">PHONES AS SPEAKERS</button>
  <button class="btn rec" id="rec">⏺ SAVE LAST 30 s</button>
</footer>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flashEl = $('flash');
const viz = new Viz($<HTMLCanvasElement>('viz'));

// ------------------------------------------------------------------ network
net.onOpen(() => { net.send({ t: 'hello', kind: 'stage' }); clock.start(true); });
net.on('pong', (m) => clock.onPong(m));
net.on('welcome', (m) => { ts = m.state; engine.setTransport(m.state); syncControls(); });
net.on('state', (m) => { ts = m.state; engine.setTransport(m.state); syncControls(); });
net.on('roster', (m) => { roster = m.players; engine.prune(new Set(roster.map((p) => p.id))); renderRoster(); });
net.on('ctl', (m) => engine.ctl(m.pid, m.y, m.tilt));
net.on('note', (ev) => {
  if (!ts) return;
  const p = roster.find((x) => x.id === ev.pid);
  engine.play(ev, !p?.speaker); // a phone playing its own part is not doubled on the Stage
  viz.push(ev, stepTime(ts, ev.step));
});

// ------------------------------------------------------------------ AUTO band
const humans = () => roster.filter((p) => p.connected);
const autoRoles = (): Role[] => (ts?.autoBand ? ROLES.filter((r) => !humans().some((p) => p.role === r)) : []);
new AutoBand(clock, () => ts, autoRoles, (ev: NoteEvent) => {
  if (!ts) return;
  engine.play(ev);
  viz.push(ev, stepTime(ts, ev.step));
});

// -------------------------------------------------------------------- lanes
// AUTO lanes get a stable muted per-role colour so they never flicker as players come and go.
const AUTO_COLORS: Record<Role, string> = { drums: '#7b86a8', bass: '#6f8fb0', melody: '#8f86b8', pads: '#6fa3a0' };
function laneList(): Lane[] {
  const l: Lane[] = [...humans(), ...roster.filter((p) => !p.connected)].map((p) => ({
    id: p.id, name: p.name, role: p.role, color: p.color, auto: false, connected: p.connected, speaker: p.speaker,
  }));
  for (const r of autoRoles()) l.push({ id: `auto:${r}`, name: 'AUTO', role: r, color: AUTO_COLORS[r], auto: true, connected: true, speaker: false });
  return l;
}

// ------------------------------------------------------------------- roster
const errClass = (e: number) => (e < 15 ? 'ok' : e < 30 ? 'warn' : 'bad');
function renderRoster() {
  const el = $('roster');
  if (!roster.length) { el.innerHTML = `<div class="empty">No players yet.<br>Scan the code with your phone.</div>`; return; }
  el.innerHTML = roster.map((p) => {
    const h = syncHeadline(p.sync);
    return `<div class="pl ${p.connected ? '' : 'off'}" style="--c:${p.color}"><div class="n">${ROLE_INFO[p.role].icon} ${esc(p.name)}<small>${ROLE_INFO[p.role].label}${p.speaker ? ' · 📢 phone speaker' : ''}${p.connected ? '' : ' · reconnecting…'}</small></div>
      <div class="e ${Number.isNaN(h.err) ? '' : errClass(h.err)}">${Number.isNaN(h.err) ? '–' : '±' + fmt(h.err, 0) + ' ms'}</div></div>`;
  }).join('');
  // headline: the worst phone, because the room only sounds tight if every phone is
  const live = roster.filter((p) => p.connected && p.sync);
  const syncEl = $('sync');
  if (!live.length) { syncEl.textContent = '–'; syncEl.className = ''; $('syncsub').textContent = 'waiting for phones'; return; }
  const worst = Math.max(...live.map((p) => syncHeadline(p.sync).err));
  const bound = Math.max(...live.map((p) => syncHeadline(p.sync).bound));
  syncEl.textContent = `${fmt(worst, 0)} ms`;
  syncEl.className = errClass(worst);
  $('syncsub').textContent = `${live.length} phone${live.length > 1 ? 's' : ''} · path bound ±${fmt(bound, bound < 10 ? 1 : 0)} ms`;
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// -------------------------------------------------------------- conductor UI
const cmd = (c: 'bpm' | 'key' | 'scale' | 'drop' | 'auto' | 'speakers', value?: number | string | boolean) => net.send({ t: 'cmd', cmd: c, value });
let bpmTimer = 0;
$<HTMLInputElement>('bpmr').oninput = (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  $('bpmv').textContent = String(v);
  clearTimeout(bpmTimer); bpmTimer = window.setTimeout(() => cmd('bpm', v), 60);
};
$<HTMLSelectElement>('key').onchange = (e) => cmd('key', Number((e.target as HTMLSelectElement).value));
$<HTMLSelectElement>('scale').onchange = (e) => cmd('scale', (e.target as HTMLSelectElement).value);
$('drop').onclick = () => cmd('drop');
$('auto').onclick = () => cmd('auto', !ts?.autoBand);
$('spk').onclick = () => cmd('speakers', !ts?.speakerMode);
$('rec').onclick = () => { if (!rec.save()) alert('Nothing recorded yet: enable audio first and play something.'); };
$('audio').onclick = async () => {
  await engine.start(); rec.start().catch((e) => console.warn('recorder unavailable', e));
  const b = $('audio'); b.textContent = '🔊 audio on'; b.classList.add('on');
};
addEventListener('keydown', (e) => {
  if (e.key === 'h') $('cond').classList.toggle('hidden');
  if (e.key === 'f') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
});
function syncControls() {
  if (!ts) return;
  if (document.activeElement !== $('bpmr')) { $<HTMLInputElement>('bpmr').value = String(ts.bpm); $('bpmv').textContent = String(ts.bpm); }
  $<HTMLSelectElement>('key').value = String(ts.root);
  $<HTMLSelectElement>('scale').value = ts.scale;
  $('auto').classList.toggle('on', ts.autoBand);
  $('spk').classList.toggle('on', ts.speakerMode);
  $('keyline').textContent = `${NOTE_NAMES[ts.root]} ${SCALE_LABEL[ts.scale]}`;
  $('bpm').textContent = String(ts.bpm);
}

// --------------------------------------------------------------------- QR
let joinUrl = '';
async function refreshJoinUrl() {
  let url = location.origin;
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    try {
      const info = await (await fetch('/api/info', { cache: 'no-store' })).json();
      url = info.publicUrl ?? info.lanUrls?.[0] ?? location.origin;
    } catch { /* keep origin */ }
  }
  if (url !== joinUrl) {
    joinUrl = url;
    await QRCode.toCanvas($<HTMLCanvasElement>('qr'), url, { width: 560, margin: 0, errorCorrectionLevel: 'M', color: { dark: '#07070d', light: '#ffffff' } });
    $('url').textContent = url.replace(/^https?:\/\//, '');
    $('warn').textContent = url.startsWith('https') ? '' : '⚠ http only: phones can’t use shake/tilt. Run `npm run demo` for HTTPS.';
  }
}
refreshJoinUrl(); setInterval(refreshJoinUrl, 4000);

// -------------------------------------------------------------------- frame
const bigEl = $('big');
let lastImpact = -1, bigTimer = 0;
const flashBig = (text: string, ms: number) => { bigEl.textContent = text; bigEl.classList.add('show'); clearTimeout(bigTimer); bigTimer = window.setTimeout(() => bigEl.classList.remove('show'), ms); };

function frame(t: number) {
  requestAnimationFrame(frame);
  if (!ts || !clock.isLocked) return;
  const b = beats.frame(clock, ts, t);
  flashEl.style.opacity = String((b.downbeat ? 0.22 : 0.08) * flashEnv(b.since));
  const pos = stepPos(ts, b.serverMs), step = Math.floor(pos);

  // drop choreography for the room
  const phase = dropPhase(ts, step);
  if (ts.drop && phase === 'build' && step === ts.drop.startStep && bigEl.textContent !== 'BUILD…') flashBig('BUILD…', 900);
  if (ts.drop && step >= ts.drop.dropStep && lastImpact !== ts.drop.dropStep) { lastImpact = ts.drop.dropStep; viz.impact(); flashBig('DROP', 700); }

  viz.draw(b.serverMs, ts, laneList(), { beatPulse: flashEnv(b.since), downbeat: b.downbeat });

  if (b.newBeat) {
    const c = chordAt(ts, step), nx = chordAt(ts, step - (step % 16) + 16);
    $('chord').textContent = c.name;
    $('next').textContent = `next ${nx.name}`;
    $('bar').textContent = `${b.bar + 1} · ${b.beatInBar + 1}`;
    const n = humans().length, m = $('mode');
    if (n === 0) { m.textContent = 'DEMO · AUTO BAND'; m.className = 'mode auto'; }
    else if (n === 1 && ts.autoBand) { m.textContent = 'SOLO · AUTO BAND BACKING'; m.className = 'mode auto'; }
    else { m.textContent = `${n} PLAYERS${autoRoles().length ? ' + AUTO' : ''}`; m.className = 'mode'; }
    if (rec.seconds > 0) $('rec').textContent = `⏺ SAVE LAST ${Math.floor(rec.seconds)} s`;
  }
}
requestAnimationFrame(frame);

(window as any).ho = { engine, clock, rec }; // console debugging
net.connect();
