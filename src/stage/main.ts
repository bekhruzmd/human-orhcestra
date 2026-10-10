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
  BPM_MAX, BPM_MIN, ROLES, ROLE_INFO, dropPhase, nextStepAfter, stepPos, stepTime,
  type NoteEvent, type PlayerInfo, type Role, type ScaleName, type TransportState,
} from '../../shared/protocol';
import { NOTE_NAMES, SCALE_LABEL, chordAt, freeMidi, freeZone, shakeVoice, type Resolved } from '../../shared/music';
import { analyze, arrange, toMidi, type RawEv, type Song } from './composer';
import { parseMidi } from './midi';
import { SongPlayer } from './song';
import { Viz, type Lane } from './visuals';
import { AutoBand } from './auto';

const net = new Net();
const clock = new ClockSync((m) => net.send(m));
const beats = new BeatTracker();
const engine = new Engine(clock, true);
const rec = new Recorder(engine);

let ts: TransportState | null = null;
let audioOn = false;
let wasFree = false;
let freeLog: RawEv[] = [];
let lastDraftLog: { log: RawEv[]; players: PlayerInfo[] } | null = null;
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
  <button class="btn free" id="free">🎤 FREESTYLE</button>
  <button class="btn" id="midi">🎼 MIDI</button>
  <input id="midifile" type="file" accept=".mid,.midi" hidden />
  <button class="btn" id="auto">AUTO</button>
  <button class="btn" id="spk">📢 SPEAKERS</button>
  <button class="btn rec" id="rec">⏺ SAVE 30 s</button>
</footer>
<div id="card" hidden></div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flashEl = $('flash');
const viz = new Viz($<HTMLCanvasElement>('viz'));

// ------------------------------------------------------------------ network
net.onOpen(() => { net.send({ t: 'hello', kind: 'stage' }); clock.start(true); });
net.on('pong', (m) => clock.onPong(m));
net.on('welcome', (m) => { ts = m.state; wasFree = m.state.freestyle; engine.setTransport(m.state); syncControls(); });
net.on('state', (m) => { ts = m.state; engine.setTransport(m.state); syncControls(); onFreestyleChange(); });
net.on('raw', (r) => onRaw(r));
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
const autoRoles = (): Role[] => (ts?.autoBand && !songs.song ? ROLES.filter((r) => !humans().some((p) => p.role === r)) : []);
const songs = new SongPlayer(clock, () => ts, (ev: NoteEvent) => {
  if (!ts) return;
  engine.play(ev);
  viz.push(ev, stepTime(ts, ev.step));
});
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
  if (songs.song) {
    const seen = new Set(songs.song.events.map((e) => e.role));
    for (const r of ROLES) if (seen.has(r)) {
      const c = songs.song.credit[r];
      l.push({ id: `song:${r}`, name: c ? `♪ from ${c.name}` : '♪ SONG', role: r, color: c?.color ?? '#ffd23f', auto: false, connected: true, speaker: false });
    }
  }
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
const cmd = (c: 'bpm' | 'key' | 'scale' | 'drop' | 'auto' | 'speakers' | 'freestyle', value?: number | string | boolean) => net.send({ t: 'cmd', cmd: c, value });
let bpmTimer = 0;
$<HTMLInputElement>('bpmr').oninput = (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  $('bpmv').textContent = String(v);
  clearTimeout(bpmTimer); bpmTimer = window.setTimeout(() => cmd('bpm', v), 60);
};
$<HTMLSelectElement>('key').onchange = (e) => cmd('key', Number((e.target as HTMLSelectElement).value));
$<HTMLSelectElement>('scale').onchange = (e) => cmd('scale', (e.target as HTMLSelectElement).value);
$('drop').onclick = () => cmd('drop');
$('free').onclick = () => cmd('freestyle', !ts?.freestyle);
$('midi').onclick = () => $<HTMLInputElement>('midifile').click();
$<HTMLInputElement>('midifile').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try { await playSong(parseMidi(await f.arrayBuffer(), f.name.replace(/\.midi?$/i, ''))); }
  catch (err) { flashBig('Bad MIDI', 1500); console.warn(err); }
  (e.target as HTMLInputElement).value = '';
};
$('auto').onclick = () => cmd('auto', !ts?.autoBand);
$('spk').onclick = () => cmd('speakers', !ts?.speakerMode);
$('rec').onclick = () => { if (!rec.save()) alert('Nothing recorded yet: enable audio first and play something.'); };
$('audio').onclick = async () => {
  await engine.start(); rec.start().catch((e) => console.warn('recorder unavailable', e));
  $('audio').style.display = 'none'; audioOn = true; syncControls();
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
  $('free').classList.toggle('on', ts.freestyle);
  $('free').textContent = ts.freestyle ? '■ STOP · MAKE SONG' : '🎤 FREESTYLE';
  $('spk').classList.toggle('on', ts.speakerMode);
  $('keyline').textContent = `${NOTE_NAMES[ts.root]} ${SCALE_LABEL[ts.scale]}${audioOn ? ' · 🔊' : ''}`;
  $('bpm').textContent = String(ts.bpm);
}

// ------------------------------------------------------- freestyle + songs
const lastFree = new Map<string, { midi: number; t: number }>();
/** Record every raw gesture and give instant, un-quantised feedback so people hear what they do. */
function onRaw(r: { pid: string; role: Role; k: RawEv['k']; at: number; x: number; y: number; v?: number }) {
  if (!ts?.freestyle) return;
  freeLog.push(r);
  if (r.k === 't' || r.k === 'u') return;
  let res: Resolved, role: Role = r.role, midi = -1;
  if (r.k === 's') { res = { kind: 'drum', voice: shakeVoice(r.v ?? 0.6, r.role === 'drums') }; role = 'drums'; }
  else if (r.role === 'drums') res = { kind: 'drum', voice: freeZone(r.x) };
  else {
    midi = freeMidi(r.role, r.x);
    const l = lastFree.get(r.pid);
    if (r.k === 'm' && l && (l.midi === midi || r.at - l.t < 90)) return;
    lastFree.set(r.pid, { midi, t: r.at });
    res = { kind: 'notes', midi: [midi] };
  }
  const vel = r.k === 's' ? r.v ?? 0.7 : 0.35 + 0.65 * r.y;
  engine.playFree(r.pid, role, res, r.at, 0.3, vel);
  viz.push({ pid: r.pid, role, step: Math.round(stepPos(ts, r.at)), d: res.kind === 'drum' ? res.voice : 0, v: vel, dur: 2, midi: midi >= 0 ? [midi] : undefined }, r.at);
}

function onFreestyleChange() {
  if (!ts || ts.freestyle === wasFree) return;
  wasFree = ts.freestyle;
  if (ts.freestyle) {
    freeLog = []; lastFree.clear();
    songs.stop(); hideCard();
    flashBig('FREESTYLE: PLAY ANYTHING', 1600);
  } else {
    composeFromJam();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function playSong(song: Song) {
  // 1. put the shared transport in the song's tempo/key, wait until the server confirms it
  cmd('bpm', song.bpm); cmd('key', song.root); cmd('scale', song.scale);
  for (let i = 0; i < 30 && !(ts && ts.bpm === song.bpm && ts.root === song.root && ts.scale === song.scale); i++) await sleep(100);
  if (!ts) return;
  // 2. start on a bar line ~1.2 s away, preferring the first chord of the 4-bar loop if that's not much later
  let start = Math.ceil(nextStepAfter(ts, clock.serverNow(), 1200) / 16) * 16;
  const aligned = Math.ceil(start / 64) * 64;
  if ((aligned - start) * (60000 / ts.bpm / 4) < 3500) start = aligned;
  return song.events.length ? startSong(song, start) : undefined;
}
function startSong(song: Song, startStep: number) {
  songs.start(song, startStep);
  showCard(song);
  flashBig('♪ NOW PLAYING', 1100);
}

function composeFromJam() {
  const players = roster.map((p) => ({ id: p.id, name: p.name, color: p.color, role: p.role }));
  lastDraftLog = { log: freeLog, players: roster };
  const draft = analyze(freeLog, players);
  if (!draft) { flashBig('PLAY A BIT MORE', 1800); return; }
  flashBig('COMPOSING…', 900);
  const bpm = draft.bpm;
  cmd('bpm', bpm); cmd('key', draft.root); cmd('scale', draft.scale);
  (async () => {
    for (let i = 0; i < 30 && !(ts && ts.bpm === bpm && ts.root === draft.root && ts.scale === draft.scale); i++) await sleep(100);
    if (!ts) return;
    let start = Math.ceil(nextStepAfter(ts, clock.serverNow(), 1200) / 16) * 16;
    const aligned = Math.ceil(start / 64) * 64;
    if ((aligned - start) * (60000 / ts.bpm / 4) < 3500) start = aligned;
    startSong(arrange(draft, start), start); // arrange() needs the real start step: chord-aware snapping is per-bar
  })();
}

const download = (name: string, data: BlobPart, type: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
function showCard(song: Song) {
  const c = $('card');
  c.hidden = false;
  c.innerHTML = `<div class="txt"><h3>♪ ${esc(song.title)}</h3>${song.info.map((l) => `<p>${esc(l)}</p>`).join('')}</div>
    <div class="row"><button class="btn" id="c-restart">↻ Restart</button><button class="btn" id="c-stop">■ Stop</button>
    <button class="btn" id="c-mid">⬇ MIDI</button>${lastDraftLog && song.title === 'Your jam' ? '<button class="btn" id="c-json">⬇ JSON</button>' : ''}</div>`;
  $('c-stop').onclick = () => { songs.stop(); hideCard(); cmd('auto', true); };
  $('c-restart').onclick = () => { if (ts) { const st = Math.ceil(nextStepAfter(ts, clock.serverNow(), 800) / 16) * 16; songs.start(song, st); } };
  $('c-mid').onclick = () => download(`${song.title.replace(/\W+/g, '-')}.mid`, toMidi(song).slice().buffer as ArrayBuffer, 'audio/midi');
  const j = document.getElementById('c-json');
  if (j && lastDraftLog) j.onclick = () => download('jam-raw.json', JSON.stringify({ players: lastDraftLog!.players.map((p) => ({ id: p.id, name: p.name, role: p.role })), events: lastDraftLog!.log, song }, null, 1), 'application/json');
  cmd('auto', false);
}
const hideCard = () => { $('card').hidden = true; };

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
