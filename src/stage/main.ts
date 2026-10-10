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
import { toGameSong, toLoopSong } from './importsong';
import { SongPlayer } from './song';
import { GameConductor } from './gameconductor';
import { SONGS, getSong } from '../../shared/songs';
import { DIFF, DIFFICULTIES, INSTRUMENT, accuracy, grade, songSeconds, validateGameSong, type GameSong, type Difficulty } from '../../shared/game';
import { LIBRARY, buildSong } from '../songs/library';
import { Viz, type Lane } from './visuals';
import { AutoBand } from './auto';
import { Sampler, SLICES } from './sampler';

const net = new Net();
const clock = new ClockSync((m) => net.send(m));
const beats = new BeatTracker();
const engine = new Engine(clock, true);
const rec = new Recorder(engine);
const sampler = new Sampler();

let ts: TransportState | null = null;
let audioOn = false;
let wasFree = false;
let freeLog: RawEv[] = [];
let lastDraftLog: { log: RawEv[]; players: PlayerInfo[] } | null = null;
let roster: PlayerInfo[] = [];
let songLoadVersion = 0;
const importId = () => `import:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

const app = document.getElementById('app')!;
app.innerHTML = `
<div id="flash"></div>
<canvas id="viz"></canvas>
<div id="big"></div>
<div class="hud">
  <div class="brand">HUMAN ORCHESTRA<small id="keyline">8-BIT CHIPTUNE</small><span class="mode" id="mode">WAITING</span></div>
  <div class="chordbox"><span class="lbl">CHORD</span><b id="chord">–</b><small id="next">&nbsp;</small></div>
  <div class="stat"><span class="lbl">BPM</span><b id="bpm">–</b></div>
  <div class="stat"><span class="lbl">BAR · BEAT</span><b id="bar">–</b></div>
  <div class="stat sync"><span class="lbl">CLOCK SYNC</span><b id="sync">–</b><small id="syncsub">AWAITING PLAYERS</small></div>
</div>
<aside class="side">
  <div class="qrbox"><canvas id="qr"></canvas></div>
  <div class="scan">SCAN TO JOIN [1P-8P]</div><div class="join-guide">PHONES ARE 8-BIT CONTROLLERS.<br>ONE PLAYER STARTS THE BAND.</div><div id="url"></div><div id="warn"></div>
  <div id="roster"></div>
</aside>
<button id="audio">AUDIO OFF · CLICK TO START [INSERT COIN]</button>
<footer class="conductor" id="cond">
  <div class="ctl"><span class="lbl">TEMPO <b id="bpmv"></b></span><input id="bpmr" type="range" min="${BPM_MIN}" max="${BPM_MAX}" step="1" /></div>
  <div class="ctl"><span class="lbl">KEY</span><select id="key">${NOTE_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select></div>
  <div class="ctl"><span class="lbl">SCALE</span><select id="scale">${(Object.keys(SCALE_LABEL) as ScaleName[]).map((s) => `<option value="${s}">${SCALE_LABEL[s]}</option>`).join('')}</select></div>
  <button class="btn drop" id="drop">! DROP !</button>
  <span class="spacer"></span>
  <button class="btn play" id="play">PLAY SONG</button>
  <button class="btn free" id="free">FREESTYLE</button>
  <button class="btn" id="midi">SONGS</button>
  <button class="btn sample" id="sample">SAMPLER</button>
  <input id="midifile" type="file" accept=".mid,.midi" hidden />
  <button class="btn" id="auto">AUTO BAND</button>
  <button class="btn" id="spk">SPEAKERS</button>
  <button class="btn rec" id="rec">REC 30S</button>
</footer>
<div id="card" hidden></div>
<div id="gamehud" hidden><div class="gh-top"><span id="gh-title"></span><b id="gh-team">0</b><span id="gh-acc"></span></div><div class="gh-bar"><i id="gh-prog"></i></div><div id="gh-note"></div></div>
<div id="gamepick" hidden><div class="box">
  <h3>SELECT SONG</h3>
  <p id="gp-info"></p>
  <p class="hintp">The arrangement stays in time. Hits lift your part; misses soften your part while the band keeps going.</p>
  <div class="row"><button class="btn" id="gp-import">+ LOAD .MID FILE</button><button class="btn" id="gp-preview">PREVIEW SONG</button></div>
  <input id="gp-file" type="file" accept=".mid,.midi" hidden />
  <label class="hintp"><input id="gp-melody" type="checkbox" /> Import melody voice only (highest part)</label>
  <label class="hintp" id="gp-part-label" hidden>Melody voice <select id="gp-part"></select></label>
  <p class="hintp" id="gp-status" role="status">Load a MIDI arrangement to play. Imports are cached in this browser.</p>
  <div id="gp-songs"></div>
  <div class="diffs" id="gp-diffs"></div>
  <div class="row"><button class="btn drop" id="gp-start">START GAME</button><button class="btn" id="gp-close">CLOSE</button></div>
</div></div>
<div id="results" hidden></div>
<div id="sampleui" hidden><div class="box">
  <h3>8-BIT AUDIO SAMPLER</h3>
  <p class="hintp">Choose an MP3 / WAV from this computer. Kept in browser memory. Phones play 16 slices on the beat grid.</p>
  <label class="dropzone" id="sp-drop"><span id="sp-droptext">DROP AUDIO FILE HERE OR <u>CLICK TO BROWSE</u></span><input type="file" id="sp-file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.aac,.flac" hidden></label>
  <div id="sp-panel" hidden>
    <canvas id="sp-wave"></canvas>
    <div class="sp-line"><b id="sp-name"></b><span id="sp-info"></span></div>
    <div class="sp-ctl">
      <span>TEMPO</span><button class="btn" data-sp="half">1/2x</button><button class="btn" data-sp="bpm-1">-1</button><b id="sp-bpm"></b><button class="btn" data-sp="bpm+1">+1</button><button class="btn" data-sp="double">2x</button>
      <span>GRID</span><button class="btn" data-sp="off-beat">&lt; BEAT</button><button class="btn" data-sp="off+beat">BEAT &gt;</button><button class="btn" data-sp="off-bar">&lt; BAR</button><button class="btn" data-sp="off+bar">BAR &gt;</button>
      <span>SLICE</span><button class="btn" data-sp="slice.5">1/2 BEAT</button><button class="btn" data-sp="slice1">1 BEAT</button><button class="btn" data-sp="slice2">2 BEATS</button>
    </div>
    <div class="row"><button class="btn play" id="sp-chop">PLAY SLICES ON PADS</button><button class="btn" id="sp-back">BACKING LOOP</button><button class="btn" id="sp-stop">STOP</button><button class="btn" id="sp-close">CLOSE</button></div>
    <p class="hintp" id="sp-msg"></p>
  </div>
</div></div>
<div id="songs" hidden><div class="box">
  <h3>SONG LIBRARY</h3>
  <div class="modes"><button class="btn on" id="m-tap">TAP-ALONG MODE</button><button class="btn" id="m-band">LISTEN TO ARRANGEMENT</button></div>
  <div id="songlist"></div>
  <div class="row"><button class="btn" id="s-file">LOAD .MID FILE</button><button class="btn" id="s-stop">STOP SONG</button><button class="btn" id="s-close">CLOSE</button></div>
</div></div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flashEl = $('flash');
const viz = new Viz($<HTMLCanvasElement>('viz'));

// ------------------------------------------------------------------ network
net.onOpen(() => { net.send({ t: 'hello', kind: 'stage' }); clock.start(true); });
net.on('pong', (m) => clock.onPong(m));
net.onClose(() => { $('mode').textContent = 'RECONNECTING…'; });
net.on('welcome', (m) => { ts = m.state; wasFree = m.state.freestyle; engine.setTransport(m.state); syncControls(); onGameChange(); checkSampleState(); });
net.on('state', (m) => { ts = m.state; engine.setTransport(m.state); syncControls(); onFreestyleChange(); onGameChange(); checkSampleState(); });
net.on('raw', (r) => onRaw(r));
net.on('roster', (m) => { roster = m.players; engine.prune(new Set(roster.map((p) => p.id))); renderRoster(); });
net.on('ctl', (m) => engine.ctl(m.pid, m.y, m.tilt));
net.on('note', (ev) => {
  if (ts && !ts.game && ts.sample?.mode === 'chop' && sampler.buffer) {
    // Sample mode: the pad index is a SLICE number; the note's step is the quantised moment to play it.
    const i = sampler.trigger(engine, Math.max(0, Math.min(SLICES - 1, ev.d)), stepTime(ts, ev.step), ts.bpm, ev.v);
    viz.push({ ...ev, role: 'melody', midi: [52 + Math.round((Math.max(0, i) / (SLICES - 1)) * 30)], d: 0, dur: 2 }, stepTime(ts, ev.step));
    return;
  }
  if (!ts || ts.game || songs.song) return;
  const p = roster.find((x) => x.id === ev.pid);
  engine.play(ev, !p?.speaker); // a phone playing its own part is not doubled on the Stage
  viz.push(ev, stepTime(ts, ev.step));
});
net.on('songreq', (r) => {
  const now = performance.now();
  if (ts?.game || now - lastSongReq < 2500) return; // one request at a time
  lastSongReq = now;
  flashBig(`${r.name.toUpperCase()}: ${r.id ? 'NEW SONG' : 'STOP'}`, 1200);
  if (!r.id) stopSong(); else loadSongById(r.id, r.mode);
});

// ------------------------------------------------------------------ AUTO band
const humans = () => roster.filter((p) => p.connected);
const autoRoles = (): Role[] => ((ts?.autoBand || ts?.game) && !songs.song ? ROLES.filter((r) => (!ts?.game?.song || ts.game.song.tracks[r].length > 0) && !humans().some((p) => p.role === r)) : []);
const songs = new SongPlayer(clock, () => ts, (ev: NoteEvent) => {
  if (!ts) return;
  engine.play(ev);
  viz.push(ev, stepTime(ts, ev.step));
});
const gameConductor = new GameConductor(clock, () => ts, (role) => humans().find((p) => p.role === role)?.id, (ev: NoteEvent) => {
  if (!ts) return;
  engine.play(ev);
  const owners = humans().filter((p) => p.role === ev.role);
  for (const pid of owners.length ? owners.map((p) => p.id) : [`auto:${ev.role}`]) viz.push({ ...ev, pid }, stepTime(ts, ev.step));
});
net.on('ghit', (m) => { gameConductor.hit(m.startStep, m.step, m.role); viz.participate(m.pid); });
net.on('error', (m) => { $('gp-status').textContent = m.message; $('gamepick').hidden = false; });
new AutoBand(clock, () => ts, () => (ts?.game ? [] : autoRoles()), (ev: NoteEvent) => {
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
    if (ts?.game) {
      const g = p.game;
      return `<div class="pl ${p.connected ? '' : 'off'}" style="--c:${p.color}"><div class="n">${ROLE_INFO[p.role].icon} ${esc(p.name)}<small>${ROLE_INFO[p.role].label} · ${g ? accuracy(done(g)).toFixed(0) + '% · combo ' + g.combo : 'ready'}${p.connected ? '' : ' · reconnecting…'}</small></div>
        <div class="e">${g ? g.score.toLocaleString() : '–'}</div></div>`;
    }
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
const done = (g: { perfect: number; good: number; miss: number }) => ({ perfect: g.perfect, good: g.good, total: g.perfect + g.good + g.miss });
const cmd = (c: 'bpm' | 'key' | 'scale' | 'drop' | 'auto' | 'speakers' | 'freestyle' | 'nowplaying' | 'sample', value?: number | string | boolean) => net.send({ t: 'cmd', cmd: c, value });
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
$('play').onclick = () => openGamePicker();
$('midi').onclick = openSongs;
$('s-close').onclick = () => { $('songs').hidden = true; };
$('s-stop').onclick = () => { stopSong(); $('songs').hidden = true; };
$('s-file').onclick = () => $<HTMLInputElement>('midifile').click();
$('m-tap').onclick = () => setSongMode('tap');
$('m-band').onclick = () => setSongMode('band');
$<HTMLInputElement>('midifile').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try { $('songs').hidden = true; await playSong(parseMidi(await f.arrayBuffer(), f.name.replace(/\.midi?$/i, '')), songMode); }
  catch (err) { flashBig('Bad MIDI', 1500); console.warn(err); }
  (e.target as HTMLInputElement).value = '';
};
$('auto').onclick = () => cmd('auto', !ts?.autoBand);
$('spk').onclick = () => cmd('speakers', !ts?.speakerMode);
$('rec').onclick = () => { if (!rec.save()) alert('Nothing recorded yet: enable audio first and play something.'); };
async function enableAudio() {
  await engine.start(); rec.start().catch((e) => console.warn('recorder unavailable', e));
  $('audio').style.display = 'none'; audioOn = true; syncControls();
}
$('audio').onclick = () => { void enableAudio().catch(() => { $('audio').textContent = 'Audio unavailable · click to retry'; }); };
addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).matches('input, select, textarea')) return;
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
  for (const id of ['bpmr', 'key', 'scale', 'drop', 'free', 'midi', 'sample', 'spk']) ($<HTMLButtonElement>(id)).disabled = !!ts.game;
  $<HTMLInputElement>('bpmr').disabled = !!ts.game || !!ts.sample;
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
    songs.stop(); hideCard(); cmd('nowplaying', '');
    flashBig('FREESTYLE: PLAY ANYTHING', 1600);
  } else if (!ts.game && !ts.sample) {
    composeFromJam();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function playSong(song: Song, mode: 'tap' | 'band' = 'band') {
  if (mode === 'tap') { const imported = toGameSong(song, importId()); return startGame(imported, 'easy'); }
  const version = ++songLoadVersion;
  await enableAudio();
  if (version !== songLoadVersion) return;
  if (ts?.game) throw new Error('Finish the current game first');
  songs.stop(); engine.silence();
  // 1. put the shared transport in the song's tempo/key, wait until the server confirms it
  cmd('bpm', song.bpm); cmd('key', song.root); cmd('scale', song.scale);
  for (let i = 0; i < 30 && !(ts && ts.bpm === song.bpm && ts.root === song.root && ts.scale === song.scale); i++) await sleep(100);
  if (version !== songLoadVersion) return;
  if (!ts || ts.bpm !== song.bpm || ts.root !== song.root || ts.scale !== song.scale) throw new Error('Could not sync the song. Check the connection and try again.');
  // 2. start on a bar line ~1.2 s away, preferring the first chord of the 4-bar loop if that's not much later
  let start = Math.ceil(nextStepAfter(ts, clock.serverNow(), 1200) / 16) * 16;
  const aligned = Math.ceil(start / 64) * 64;
  if ((aligned - start) * (60000 / ts.bpm / 4) < 3500) start = aligned;
  return song.events.length ? startSong(song, start, mode) : undefined;
}
function startSong(song: Song, startStep: number, _mode: 'tap' | 'band' = 'band') {
  songs.start(song, startStep);
  showCard(song);
  cmd('nowplaying', `band|${song.title}`);
  flashBig('♪ NOW PLAYING', 1400);
}
function stopSong() {
  songLoadVersion++;
  songs.stop(); engine.silence(); hideCard(); cmd('auto', false); cmd('nowplaying', '');
}
let lastSongReq = 0;
let songMode: 'tap' | 'band' = 'tap';
function setSongMode(m: 'tap' | 'band') { songMode = m; $('m-tap').classList.toggle('on', m === 'tap'); $('m-band').classList.toggle('on', m === 'band'); }
interface Custom { name: string; file: string }
let custom: Custom[] = [];
async function refreshCustom() {
  try { custom = await (await fetch('/songs/index.json', { cache: 'no-store' })).json(); } catch { custom = []; }
}
async function openSongs() {
  await refreshCustom();
  const items = [
    ...LIBRARY.map((d) => ({ id: d.id, title: d.title, blurb: d.blurb, tag: d.melody ? 'melody' : 'backing' })),
    ...custom.map((c) => ({ id: `file:${c.file}`, title: c.name, blurb: 'your MIDI file', tag: 'yours' })),
  ];
  $('songlist').innerHTML = items.map((i) => `<button class="song" data-id="${esc(i.id)}"><b>${esc(i.title)}</b><small>${esc(i.blurb)}</small><i>${i.tag}</i></button>`).join('')
    + (custom.length ? '' : '<p class="hintp">Add your own songs: drop .mid files into <code>public/songs/</code> and rebuild, or use “Load .mid file…”.</p>');
  $('songlist').querySelectorAll<HTMLElement>('.song').forEach((b) => (b.onclick = () => { $('songs').hidden = true; loadSongById(b.dataset.id!, songMode); }));
  $('songs').hidden = false;
}
/** Resolve a song id (built-in or a file listed in public/songs/index.json; never an arbitrary path) and play it. */
async function loadSongById(id: string, mode: 'tap' | 'band') {
  try {
    const def = LIBRARY.find((d) => d.id === id);
    if (def) return void (await playSong(buildSong(def), mode));
    if (id.startsWith('file:')) {
      if (!custom.length) await refreshCustom();
      const c = custom.find((x) => `file:${x.file}` === id);
      if (!c) return;
      const buf = await (await fetch(`/songs/${encodeURIComponent(c.file)}`)).arrayBuffer();
      await playSong(parseMidi(buf, c.name), mode);
    }
  } catch (err) { flashBig('COULD NOT LOAD SONG', 1500); console.warn(err); }
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
  $('c-stop').onclick = () => stopSong();
  $('c-restart').onclick = () => { if (ts) { const st = Math.ceil(nextStepAfter(ts, clock.serverNow(), 800) / 16) * 16; engine.silence(); songs.start(song, st); } };
  $('c-mid').onclick = () => download(`${song.title.replace(/\W+/g, '-')}.mid`, toMidi(song).slice().buffer as ArrayBuffer, 'audio/midi');
  const j = document.getElementById('c-json');
  if (j && lastDraftLog) j.onclick = () => download('jam-raw.json', JSON.stringify({ players: lastDraftLog!.players.map((p) => ({ id: p.id, name: p.name, role: p.role })), events: lastDraftLog!.log, song }, null, 1), 'application/json');
  cmd('auto', false);
}
const hideCard = () => { $('card').hidden = true; };

// ------------------------------------------------------------ rhythm game
let pickSong = SONGS[0].id;
let pickDiff: Difficulty = 'easy';
let gameKey = '';
let resultsShown = false;
let lastCount = -9;
let gameLateBaseline = 0;

const importedSongs: GameSong[] = [];
try {
  const saved: unknown = JSON.parse(localStorage.getItem('ho.songs') ?? '[]');
  if (Array.isArray(saved)) for (const value of saved.slice(0, 20)) { const song = validateGameSong(value); if (song) importedSongs.push(song); }
} catch { /* browser storage may be unavailable */ }
if (importedSongs.length) pickSong = importedSongs[0].id;
const allGameSongs = () => [...importedSongs, ...SONGS];
let previewing = false;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
function endPreview() {
  if (!previewing) return;
  songLoadVersion++;
  clearTimeout(previewTimer); previewing = false;
  songs.stop(); engine.silence(); hideCard(); cmd('nowplaying', '');
  $('gp-preview').textContent = '♫ Preview selected';
}
function openGamePicker() {
  $('gp-info').textContent = 'Choose a tune, preview it, then play together. Audio comes from this Stage.';
  $('gp-songs').innerHTML = allGameSongs().map((s) => `<button class="song ${s.id === pickSong ? 'sel' : ''}" data-id="${esc(s.id)}"><b>${esc(s.title)}</b><small>${esc(s.artist)}</small>
    <small>${s.bpm} BPM · ${Math.round(songSeconds(s))} s · ${Object.entries(s.tracks).filter(([, notes]) => notes.length).map(([r]) => INSTRUMENT[r as Role].name).join(', ')}</small></button>`).join('');
  $('gp-songs').querySelectorAll<HTMLElement>('.song').forEach((b) => (b.onclick = () => { endPreview(); pickSong = b.dataset.id!; openGamePicker(); }));
  const desc: Record<Difficulty, string> = { easy: '2 lanes · forgiving', medium: '3 lanes · more notes', hard: '4 lanes · strict' };
  $('gp-diffs').innerHTML = DIFFICULTIES.map((d) => `<button class="btn ${d === pickDiff ? 'on' : ''}" data-d="${d}"><b>${d.toUpperCase()}</b><small>${desc[d]} (±${DIFF[d].perfect} ms perfect)</small></button>`).join('');
  $('gp-diffs').querySelectorAll<HTMLElement>('button').forEach((b) => (b.onclick = () => { pickDiff = b.dataset.d as Difficulty; openGamePicker(); }));
  $('gamepick').hidden = false;
}
async function startGame(song: GameSong, difficulty: Difficulty) {
  songLoadVersion++;
  await enableAudio();
  for (let i = 0; i < 40 && (!net.connected || !clock.isLocked); i++) await sleep(100);
  if (!net.connected || !clock.isLocked) throw new Error('Waiting for connection. Try Start again.');
  endPreview(); songs.stop(); engine.silence();
  net.send({ t: 'game', action: 'start', songId: song.id, ...(song.id.startsWith('import:') ? { song } : {}), difficulty });
  $('gamepick').hidden = true; $('results').hidden = true;
}
$('gp-close').onclick = () => { endPreview(); $('gamepick').hidden = true; };
$('gp-start').onclick = async () => {
  const song = allGameSongs().find((s) => s.id === pickSong);
  if (!song) return;
  try { await startGame(song, pickDiff); } catch (e) { $('gp-status').textContent = String(e); }
};
$('gp-import').onclick = () => $<HTMLInputElement>('gp-file').click();
let pendingMidi: { buffer: ArrayBuffer; title: string; id: string } | null = null;
function importPendingMidi() {
  if (!pendingMidi) return;
  const selectedPart = $<HTMLSelectElement>('gp-part').value;
  const source = parseMidi(pendingMidi.buffer, pendingMidi.title, { melodyPart: selectedPart, onParts(parts) {
    const select = $<HTMLSelectElement>('gp-part');
    select.replaceChildren(...parts.map((part) => new Option(part.label, part.id)));
    if (parts.some((p) => p.id === selectedPart)) select.value = selectedPart;
    $('gp-part-label').hidden = parts.length < 2;
  } });
  const song = toGameSong(source, pendingMidi.id, $<HTMLInputElement>('gp-melody').checked);
  const old = importedSongs.findIndex((s) => s.id === song.id);
  if (old >= 0) importedSongs.splice(old, 1);
  importedSongs.unshift(song); importedSongs.splice(20); pickSong = song.id;
  let saved = true;
  try { localStorage.setItem('ho.songs', JSON.stringify(importedSongs)); } catch { saved = false; }
  endPreview(); openGamePicker();
  $('gp-status').textContent = `${song.title} is ready. Preview to check the melody; choose another part if needed.${saved ? '' : ' Browser storage is full; this import lasts until reload.'}`;
}
$<HTMLInputElement>('gp-file').onchange = async (e) => {
  const input = e.target as HTMLInputElement, file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 5_000_000) throw new Error('Choose a MIDI file smaller than 5 MB.');
    pendingMidi = { buffer: await file.arrayBuffer(), title: file.name.replace(/\.midi?$/i, ''), id: importId() };
    $<HTMLSelectElement>('gp-part').replaceChildren();
    importPendingMidi();
  } catch (err) { $('gp-status').textContent = err instanceof Error ? err.message : 'Could not read this MIDI file.'; }
  input.value = '';
};
for (const id of ['gp-part', 'gp-melody']) $(id).onchange = () => {
  try { if (pendingMidi && pendingMidi.id === pickSong) importPendingMidi(); }
  catch (err) { $('gp-status').textContent = err instanceof Error ? err.message : 'Could not use this melody part.'; }
};
$('gp-preview').onclick = async () => {
  if (previewing) { endPreview(); return; }
  if (ts?.game) { $('gp-status').textContent = 'Finish the current performance before previewing another song.'; return; }
  const song = allGameSongs().find((s) => s.id === pickSong);
  if (!song) return;
  try {
    previewing = true; $('gp-preview').textContent = '■ Stop preview';
    await playSong(toLoopSong(song), 'band');
    if (!previewing) { songs.stop(); engine.silence(); return; }
    hideCard(); previewTimer = setTimeout(endPreview, 20000);
  } catch (err) { endPreview(); $('gp-status').textContent = String(err); }
};

/** A new game (or the end of one) arrived in the shared state. */
function onGameChange() {
  const g = ts?.game;
  const key = g ? `${g.songId}:${g.startStep}` : '';
  if (key === gameKey) return;
  engine.silence();
  viz.reset();
  gameLateBaseline = engine.lateCount;
  gameKey = key; resultsShown = false; lastCount = -9;
  document.body.classList.toggle('ingame', !!g);
  requestAnimationFrame(() => viz.resize());
  if (g) {
    songs.stop(); hideCard(); $('songs').hidden = true; $('results').hidden = true;
    sampler.stop(engine); $('sampleui').hidden = true; document.body.classList.remove('insample');
    const song = g.song ?? getSong(g.songId);
    $('gh-title').textContent = song ? `${song.title} · ${g.difficulty.toUpperCase()}` : '';
    $('gamehud').hidden = false;
  } else {
    $('gamehud').hidden = true;
  }
}

function gameTick(serverMs: number) {
  const g = ts?.game;
  if (!g || !ts) return;
  const song = g.song ?? getSong(g.songId);
  if (!song) return;
  const pos = stepPos(ts, serverMs);
  // count-in on the big screen (one number per beat)
  const toStart = (g.startStep - pos) * (60000 / ts.bpm / 4);
  if (toStart > 0) {
    const n = Math.ceil(toStart / (60000 / ts.bpm));
    if (n <= 4 && n !== lastCount) { lastCount = n; flashBig(n <= 3 ? String(n) : 'READY', 600); }
  } else if (lastCount !== 0 && toStart > -800) { lastCount = 0; flashBig('GO!', 600); }
  $('gh-prog').style.width = `${Math.max(0, Math.min(100, ((pos - g.startStep) / (song.bars * 16)) * 100))}%`;
  if (!resultsShown && pos >= g.endStep + 5) { resultsShown = true; showResults(); }
}

function teamStats() {
  const rows = roster.filter((p) => p.game);
  const sum = (f: (p: PlayerInfo) => number) => rows.reduce((a, p) => a + f(p), 0);
  const total = sum((p) => resultsShown ? p.game!.total : p.game!.perfect + p.game!.good + p.game!.miss);
  const weighted = sum((p) => p.game!.perfect + 0.6 * p.game!.good);
  return { rows, score: sum((p) => p.game!.score), acc: total ? (weighted / total) * 100 : 0, maxCombo: Math.max(0, ...rows.map((p) => p.game!.maxCombo)) };
}

function showResults() {
  const g = ts?.game, song = g && (g.song ?? getSong(g.songId));
  if (!g || !song) return;
  const t = teamStats();
  const solo = t.rows.length <= 1;
  const rows = [...t.rows].sort((a, b) => b.game!.score - a.game!.score);
  $('results').innerHTML = `<div class="box"><h3>${esc(song.title)} · ${g.difficulty.toUpperCase()}</h3>
    <div class="big-team"><div class="grade g${grade(t.acc)}">${t.rows.length ? grade(t.acc) : '–'}</div><div><b>${t.score.toLocaleString()}</b><small>${solo ? 'SOLO SCORE' : 'TEAM SCORE'} · ${t.acc.toFixed(0)}% accuracy · best combo ${t.maxCombo}</small></div></div>
    <div class="rows">${rows.map((p) => `<div class="pl" style="--c:${p.color}"><div class="n">${ROLE_INFO[p.role].icon} ${esc(p.name)}<small>${INSTRUMENT[p.role].name} · ${p.game!.perfect} perfect · ${p.game!.good} good · ${p.game!.miss} missed</small></div><div class="e">${p.game!.score.toLocaleString()} <small>${accuracy(p.game!).toFixed(0)}%</small></div></div>`).join('') || '<div class="empty">No scores were recorded.</div>'}</div>
    ${solo && t.rows.length ? '<p class="hintp">Assisted performance: the arrangement stayed in time while your hits shaped the dynamics.</p>' : ''}
    <div class="row"><button class="btn drop" id="r-again">REHEARSE AGAIN</button><button class="btn" id="r-pick">SELECT SCORE</button><button class="btn" id="r-free">FREE IMPROV</button></div></div>`;
  $('results').hidden = false;
  $('r-again').onclick = () => { $('results').hidden = true; void startGame(song, g.difficulty).catch((e) => { $('gp-status').textContent = String(e); openGamePicker(); }); };
  $('r-pick').onclick = () => { $('results').hidden = true; net.send({ t: 'game', action: 'stop' }); openGamePicker(); };
  $('r-free').onclick = () => { $('results').hidden = true; net.send({ t: 'game', action: 'stop' }); };
}
setInterval(() => {
  if (!ts?.game) return;
  const t = teamStats();
  $('gh-team').textContent = t.score.toLocaleString();
  $('gh-acc').textContent = `${t.rows.length > 1 ? 'TEAM' : humans().length === 1 ? 'SOLO' : 'AUTO DEMO'} · ${t.acc.toFixed(0)}%`;
  $('gh-note').textContent = `Tap with the beat · hits bring your instrument forward · best streak ${t.maxCombo}${engine.lateCount > gameLateBaseline ? ' · audio catching up' : ''}`;
}, 250);

// ------------------------------------------------------------ sampler (your own audio)
const spMsg = (t: string) => { $('sp-msg').textContent = t; };
function drawWave() {
  const c = $<HTMLCanvasElement>('sp-wave'), a = sampler.analysis;
  if (!a) return;
  const dpr = Math.min(2, devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const x = c.getContext('2d')!;
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, w, h);
  const mid = h / 2;
  x.fillStyle = 'rgba(255,255,255,.35)';
  a.peaks.forEach((p, i) => x.fillRect((i / a.peaks.length) * w, mid - p * mid * 0.95, Math.max(1, w / a.peaks.length), p * h * 0.95));
  // the 16 slices on the beat grid, then the beat lines
  const dur = sampler.duration, sl = sampler.sliceSec;
  for (let i = 0; i < sampler.usable; i++) {
    x.fillStyle = i % 2 ? 'rgba(124,255,107,.16)' : 'rgba(53,208,255,.16)';
    x.fillRect(((sampler.offset + i * sl) / dur) * w, 0, (sl / dur) * w, h);
  }
  for (let t = sampler.offset, k = 0; t < dur; t += sampler.beatSec, k++) {
    x.strokeStyle = k % 4 === 0 ? 'rgba(255,255,255,.7)' : 'rgba(255,255,255,.25)';
    x.beginPath(); x.moveTo((t / dur) * w, 0); x.lineTo((t / dur) * w, h); x.stroke();
  }
}
function refreshSampleUI() {
  $('sp-panel').hidden = !sampler.buffer;
  if (!sampler.buffer) return;
  $('sp-name').textContent = sampler.name;
  $('sp-bpm').textContent = sampler.bpm.toFixed(1);
  const conf = sampler.analysis?.confidence ?? 0;
  $('sp-info').textContent = `${sampler.duration.toFixed(0)} s · ${sampler.usable} slices of ${sampler.sliceBeats} beat · detection ${conf > 0.6 ? 'confident' : conf > 0.3 ? 'fairly sure' : 'unsure: adjust tempo/grid by ear'}`;
  drawWave();
}
async function loadSampleFile(f: File) {
  try {
    await enableAudio();
    $('sp-droptext').textContent = `Analysing ${f.name}…`;
    await sampler.load(f, engine);
    $('sp-droptext').innerHTML = `Loaded <b>${esc(sampler.name)}</b>. Drop another file, or <u>choose a file</u>`;
    spMsg(sampler.analysis!.confidence < 0.3 ? 'Tempo detection is unsure for this file: use ½× / 2× and the grid buttons until the white bar lines sit on the beats.' : '');
    refreshSampleUI();
  } catch (err) {
    console.warn(err);
    $('sp-droptext').innerHTML = 'Could not read that file. Try an MP3 or WAV. <u>choose a file</u>';
  }
}
$('sample').onclick = () => { $('sampleui').hidden = false; refreshSampleUI(); };
$('sp-close').onclick = () => { $('sampleui').hidden = true; };
$<HTMLInputElement>('sp-file').onchange = (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) loadSampleFile(f); (e.target as HTMLInputElement).value = ''; };
$('sp-drop').addEventListener('dragover', (e) => e.preventDefault());
$('sp-drop').addEventListener('drop', (e) => { e.preventDefault(); const f = (e as DragEvent).dataTransfer?.files?.[0]; if (f) loadSampleFile(f); });
$('sampleui').querySelectorAll<HTMLElement>('[data-sp]').forEach((b) => (b.onclick = () => {
  const k = b.dataset.sp!, beat = sampler.beatSec;
  if (k === 'half') sampler.bpm = Math.max(40, sampler.bpm / 2);
  else if (k === 'double') sampler.bpm = Math.min(240, sampler.bpm * 2);
  else if (k === 'bpm-1') sampler.bpm = Math.max(40, sampler.bpm - 1);
  else if (k === 'bpm+1') sampler.bpm = Math.min(240, sampler.bpm + 1);
  else if (k.startsWith('off')) {
    const step = k.endsWith('bar') ? beat * 4 : beat, dir = k.startsWith('off+') ? 1 : -1;
    sampler.offset = Math.max(0, Math.min(sampler.duration - sampler.sliceSec, sampler.offset + dir * step));
  } else if (k.startsWith('slice')) sampler.sliceBeats = Number(k.slice(5));
  refreshSampleUI();
}));

/** Put the room at the file's tempo (the transport is integer BPM; playbackRate absorbs the remainder). */
async function matchTempo() {
  const target = Math.round(Math.max(60, Math.min(180, sampler.bpm)));
  cmd('bpm', target);
  for (let i = 0; i < 30 && ts?.bpm !== target; i++) await sleep(100);
}
function sampleCleanup() { songs.stop(); engine.silence(); hideCard(); cmd('nowplaying', ''); cmd('auto', false); }
$('sp-chop').onclick = async () => {
  if (!sampler.buffer) return;
  await enableAudio();
  sampleCleanup(); sampler.stop(engine);
  await matchTempo();
  cmd('sample', `chop|${sampler.name}`);
  document.body.classList.add('insample');
  $('sampleui').hidden = true;
  flashBig('PLAY SLICE PADS', 1500);
};
$('sp-back').onclick = async () => {
  if (!sampler.buffer) return;
  await enableAudio();
  sampleCleanup(); sampler.stop(engine);
  await matchTempo();
  if (!ts) return;
  const startStep = Math.ceil(nextStepAfter(ts, clock.serverNow(), 1200) / 16) * 16;
  sampler.startBacking(engine, stepTime(ts, startStep), ts.bpm);
  cmd('sample', `backing|${sampler.name}`);
  document.body.classList.add('insample');
  $('sampleui').hidden = true;
  flashBig('LOOP ENGAGED', 1200);
};
$('sp-stop').onclick = stopSample;
function stopSample() {
  sampler.stop(engine);
  cmd('sample', '');
  document.body.classList.remove('insample');
  $('sampleui').hidden = true;
}
/** Server state says a sample is active but we have none (Stage was reloaded): clear it so phones aren't stuck. */
function checkSampleState() {
  if (ts?.sample && !sampler.buffer) cmd('sample', '');
  document.body.classList.toggle('insample', !!ts?.sample);
}

// --------------------------------------------------------------------- QR
let joinUrl = '';
async function refreshJoinUrl() {
  let url = location.origin;
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    try {
      const info = await (await fetch('/api/info', { cache: 'no-store' })).json();
      url = info.publicUrl ?? info.lanUrls?.[0] ?? location.origin;
      if (!info.publicUrl && location.port === '5173') { const lan = new URL(url); lan.port = location.port; url = lan.origin; }
    } catch { /* keep origin */ }
  }
  if (url !== joinUrl) {
    joinUrl = url;
    await QRCode.toCanvas($<HTMLCanvasElement>('qr'), url, { width: 560, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#07070d', light: '#ffffff' } });
    $('url').textContent = url.replace(/^https?:\/\//, '');
    $('warn').textContent = url.startsWith('https') ? '' : 'Use the same Wi-Fi. Touch controls are ready.';
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

  gameTick(b.serverMs);
  viz.draw(b.serverMs, ts, laneList(), { beatPulse: flashEnv(b.since), downbeat: b.downbeat });

  if (b.newBeat) {
    const c = chordAt(ts, step), nx = chordAt(ts, step - (step % 16) + 16);
    $('chord').textContent = c.name;
    $('next').textContent = `next ${nx.name}`;
    const songBar = ts.game ? Math.max(0, Math.floor((step - ts.game.startStep) / 16) + 1) : b.bar + 1;
    $('bar').textContent = `${songBar || 'READY'} · ${b.beatInBar + 1}`;
    const n = humans().length, m = $('mode');
    if (!net.connected) { m.textContent = 'RECONNECTING…'; m.className = 'mode'; }
    else if (n === 0) { m.textContent = ts.game || ts.autoBand ? 'DEMO · AUTO BAND' : 'SCAN TO START'; m.className = 'mode auto'; }
    else if (n === 1 && (ts.autoBand || ts.game)) { m.textContent = 'SOLO · AUTO BAND BACKING'; m.className = 'mode auto'; }
    else { m.textContent = `${n} PLAYER${n === 1 ? '' : 'S'}${autoRoles().length ? ' + AUTO' : ''}`; m.className = 'mode'; }
    if (rec.seconds > 0) $('rec').textContent = `⏺ SAVE LAST ${Math.floor(rec.seconds)} s`;
  }
}
requestAnimationFrame(frame);

(window as any).ho = { engine, clock, rec, gameConductor }; // console debugging
net.connect();
