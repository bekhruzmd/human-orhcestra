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
import { GameConductor } from './gameconductor';
import { SONGS, getSong } from '../../shared/songs';
import { DIFF, DIFFICULTIES, INSTRUMENT, accuracy, grade, songSeconds, type Difficulty } from '../../shared/game';
import { LIBRARY, buildSong } from '../songs/library';
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
  <button class="btn play" id="play">🎮 PLAY A SONG</button>
  <button class="btn free" id="free">🎤 FREESTYLE</button>
  <button class="btn" id="midi">🎵 SONGS</button>
  <input id="midifile" type="file" accept=".mid,.midi" hidden />
  <button class="btn" id="auto">AUTO</button>
  <button class="btn" id="spk">📢 SPEAKERS</button>
  <button class="btn rec" id="rec">⏺ SAVE 30 s</button>
</footer>
<div id="card" hidden></div>
<div id="gamehud" hidden><div class="gh-top"><span id="gh-title"></span><b id="gh-team">0</b><span id="gh-acc"></span></div><div class="gh-bar"><i id="gh-prog"></i></div><div id="gh-note"></div></div>
<div id="gamepick" hidden><div class="box">
  <h3>🎮 Pick a song</h3>
  <p id="gp-info"></p>
  <div id="gp-songs"></div>
  <div class="diffs" id="gp-diffs"></div>
  <div class="row"><button class="btn drop" id="gp-start">▶ START</button><button class="btn" id="gp-close">Close</button></div>
</div></div>
<div id="results" hidden></div>
<div id="songs" hidden><div class="box">
  <h3>🎵 Pick a song</h3>
  <div class="modes"><button class="btn on" id="m-tap">👆 Judges tap it (every tap plays the next note)</button><button class="btn" id="m-band">🎸 Band plays it (jam over it)</button></div>
  <div id="songlist"></div>
  <div class="row"><button class="btn" id="s-file">📂 Load .mid file…</button><button class="btn" id="s-stop">■ Stop song</button><button class="btn" id="s-close">Close</button></div>
</div></div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flashEl = $('flash');
const viz = new Viz($<HTMLCanvasElement>('viz'));

// ------------------------------------------------------------------ network
net.onOpen(() => { net.send({ t: 'hello', kind: 'stage' }); clock.start(true); });
net.on('pong', (m) => clock.onPong(m));
net.on('welcome', (m) => { ts = m.state; wasFree = m.state.freestyle; engine.setTransport(m.state); syncControls(); onGameChange(); });
net.on('state', (m) => { ts = m.state; engine.setTransport(m.state); syncControls(); onFreestyleChange(); onGameChange(); });
net.on('raw', (r) => onRaw(r));
net.on('roster', (m) => { roster = m.players; engine.prune(new Set(roster.map((p) => p.id))); renderRoster(); });
net.on('ctl', (m) => engine.ctl(m.pid, m.y, m.tilt));
net.on('note', (ev) => {
  if (!ts) return;
  const p = roster.find((x) => x.id === ev.pid);
  if (tap.active && ev.role !== 'drums' && tap.notes.length) {
    // Tap-along: the player supplies the RHYTHM, the song supplies the PITCH.
    const n = tap.notes[tap.cursor++ % tap.notes.length];
    ev = { ...ev, role: 'melody', d: 0, midi: [n.midi], dur: n.dur };
    tapProgress();
  }
  engine.play(ev, !p?.speaker); // a phone playing its own part is not doubled on the Stage
  viz.push(ev, stepTime(ts, ev.step));
});
net.on('songreq', (r) => {
  const now = performance.now();
  if (now - lastSongReq < 2500) return; // one request at a time
  lastSongReq = now;
  flashBig(`${r.name.toUpperCase()}: ${r.id ? 'NEW SONG' : 'STOP'}`, 1200);
  if (!r.id) stopSong(); else loadSongById(r.id, r.mode);
});

// ------------------------------------------------------------------ AUTO band
const humans = () => roster.filter((p) => p.connected);
const autoRoles = (): Role[] => ((ts?.autoBand || ts?.game) && !songs.song ? ROLES.filter((r) => !humans().some((p) => p.role === r)) : []);
const songs = new SongPlayer(clock, () => ts, (ev: NoteEvent) => {
  if (!ts) return;
  engine.play(ev);
  viz.push(ev, stepTime(ts, ev.step));
});
new GameConductor(clock, () => ts, () => new Set(autoRoles()), (ev: NoteEvent) => {
  if (!ts) return;
  engine.play(ev);
  viz.push(ev, stepTime(ts, ev.step));
});
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
const cmd = (c: 'bpm' | 'key' | 'scale' | 'drop' | 'auto' | 'speakers' | 'freestyle' | 'nowplaying', value?: number | string | boolean) => net.send({ t: 'cmd', cmd: c, value });
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
    songs.stop(); tap.active = false; hideCard(); cmd('nowplaying', '');
    flashBig('FREESTYLE: PLAY ANYTHING', 1600);
  } else {
    composeFromJam();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function playSong(song: Song, mode: 'tap' | 'band' = 'band') {
  // 1. put the shared transport in the song's tempo/key, wait until the server confirms it
  cmd('bpm', song.bpm); cmd('key', song.root); cmd('scale', song.scale);
  for (let i = 0; i < 30 && !(ts && ts.bpm === song.bpm && ts.root === song.root && ts.scale === song.scale); i++) await sleep(100);
  if (!ts) return;
  // 2. start on a bar line ~1.2 s away, preferring the first chord of the 4-bar loop if that's not much later
  let start = Math.ceil(nextStepAfter(ts, clock.serverNow(), 1200) / 16) * 16;
  const aligned = Math.ceil(start / 64) * 64;
  if ((aligned - start) * (60000 / ts.bpm / 4) < 3500) start = aligned;
  return song.events.length ? startSong(song, start, mode) : undefined;
}
function startSong(song: Song, startStep: number, mode: 'tap' | 'band' = 'band') {
  // Tap-along: pull the melody out of the band track; taps will play it note by note.
  const melody = song.events.filter((e) => e.role === 'melody' && e.midi?.length).sort((a, b) => a.rel - b.rel);
  tap.active = mode === 'tap' && melody.length > 0;
  tap.notes = tap.active ? melody.map((e) => ({ midi: Math.max(...e.midi!), dur: e.dur })) : [];
  tap.cursor = 0;
  const playable = tap.active ? { ...song, events: song.events.filter((e) => e.role !== 'melody') } : song;
  songs.start(playable, startStep);
  showCard(song);
  cmd('nowplaying', `${tap.active ? 'tap' : 'band'}|${song.title}`);
  flashBig(tap.active ? '👆 TAP TO PLAY' : '♪ NOW PLAYING', 1400);
}
function stopSong() {
  songs.stop(); tap.active = false; hideCard(); cmd('auto', true); cmd('nowplaying', '');
}
const tap = { active: false, notes: [] as { midi: number; dur: number }[], cursor: 0 };
let lastSongReq = 0;
let songMode: 'tap' | 'band' = 'tap';
function setSongMode(m: 'tap' | 'band') { songMode = m; $('m-tap').classList.toggle('on', m === 'tap'); $('m-band').classList.toggle('on', m === 'band'); }
let tapDom = 0;
function tapProgress() {
  const now = performance.now();
  if (now - tapDom < 150) return;
  tapDom = now;
  const el = document.getElementById('tapinfo');
  if (el) el.textContent = `👆 tap-along: note ${(tap.cursor % tap.notes.length) + 1}/${tap.notes.length}`;
}

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
  c.innerHTML = `<div class="txt"><h3>♪ ${esc(song.title)}</h3>${song.info.map((l) => `<p>${esc(l)}</p>`).join('')}${tap.active ? '<p id="tapinfo">👆 tap-along: tap any pad</p>' : ''}</div>
    <div class="row"><button class="btn" id="c-restart">↻ Restart</button><button class="btn" id="c-stop">■ Stop</button>
    <button class="btn" id="c-mid">⬇ MIDI</button>${lastDraftLog && song.title === 'Your jam' ? '<button class="btn" id="c-json">⬇ JSON</button>' : ''}</div>`;
  $('c-stop').onclick = () => stopSong();
  $('c-restart').onclick = () => { if (ts) { const st = Math.ceil(nextStepAfter(ts, clock.serverNow(), 800) / 16) * 16; songs.start(song, st); } };
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

function openGamePicker() {
  const n = humans().length;
  $('gp-info').textContent = n === 0
    ? 'No players yet: the band will play itself as a demo. Scan the QR to join.'
    : n === 1 ? 'Solo mode: you play one instrument on your phone, the rest of the band plays itself. Tap the instrument chip on the phone to switch.'
    : `${n} players: each plays their own instrument; instruments nobody holds are played by the band.`;
  $('gp-songs').innerHTML = SONGS.map((s) => `<button class="song ${s.id === pickSong ? 'sel' : ''}" data-id="${s.id}"><b>${esc(s.title)}</b><small>${esc(s.artist)}</small>
    <small>${s.bpm} BPM · ${Math.round(songSeconds(s))} s · ${'★'.repeat(s.rating)}${'☆'.repeat(3 - s.rating)} · drums, bass, piano, synth</small></button>`).join('');
  $('gp-songs').querySelectorAll<HTMLElement>('.song').forEach((b) => (b.onclick = () => { pickSong = b.dataset.id!; openGamePicker(); }));
  const desc: Record<Difficulty, string> = { easy: '2 lanes · few notes · forgiving', medium: '3 lanes · more notes', hard: '4 lanes · every note · strict' };
  $('gp-diffs').innerHTML = DIFFICULTIES.map((d) => `<button class="btn ${d === pickDiff ? 'on' : ''}" data-d="${d}"><b>${d.toUpperCase()}</b><small>${desc[d]} (±${DIFF[d].perfect} ms perfect)</small></button>`).join('');
  $('gp-diffs').querySelectorAll<HTMLElement>('button').forEach((b) => (b.onclick = () => { pickDiff = b.dataset.d as Difficulty; openGamePicker(); }));
  $('gamepick').hidden = false;
}
$('gp-close').onclick = () => { $('gamepick').hidden = true; };
$('gp-start').onclick = () => {
  $('gamepick').hidden = true; $('results').hidden = true;
  net.send({ t: 'game', action: 'start', songId: pickSong, difficulty: pickDiff });
};

/** A new game (or the end of one) arrived in the shared state. */
function onGameChange() {
  const g = ts?.game;
  const key = g ? `${g.songId}:${g.startStep}` : '';
  if (key === gameKey) return;
  gameKey = key; resultsShown = false; lastCount = -9;
  document.body.classList.toggle('ingame', !!g);
  requestAnimationFrame(() => viz.resize());
  if (g) {
    songs.stop(); tap.active = false; hideCard(); $('songs').hidden = true; $('results').hidden = true;
    const song = getSong(g.songId);
    $('gh-title').textContent = song ? `${song.title} · ${g.difficulty.toUpperCase()}` : '';
    $('gamehud').hidden = false;
  } else {
    $('gamehud').hidden = true;
  }
}

function gameTick(serverMs: number) {
  const g = ts?.game;
  if (!g || !ts) return;
  const song = getSong(g.songId);
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
  const total = sum((p) => p.game!.total);
  const weighted = sum((p) => p.game!.perfect + 0.6 * p.game!.good);
  return { rows, score: sum((p) => p.game!.score), acc: total ? (weighted / total) * 100 : 0, maxCombo: Math.max(0, ...rows.map((p) => p.game!.maxCombo)) };
}

function showResults() {
  const g = ts?.game, song = g && getSong(g.songId);
  if (!g || !song) return;
  const t = teamStats();
  const solo = t.rows.length <= 1;
  const rows = [...t.rows].sort((a, b) => b.game!.score - a.game!.score);
  $('results').innerHTML = `<div class="box"><h3>${esc(song.title)} · ${g.difficulty.toUpperCase()}</h3>
    <div class="big-team"><div class="grade g${grade(t.acc)}">${t.rows.length ? grade(t.acc) : '–'}</div><div><b>${t.score.toLocaleString()}</b><small>${solo ? 'SOLO SCORE' : 'TEAM SCORE'} · ${t.acc.toFixed(0)}% accuracy · best combo ${t.maxCombo}</small></div></div>
    <div class="rows">${rows.map((p) => `<div class="pl" style="--c:${p.color}"><div class="n">${ROLE_INFO[p.role].icon} ${esc(p.name)}<small>${INSTRUMENT[p.role].name} · ${p.game!.perfect} perfect · ${p.game!.good} good · ${p.game!.miss} missed</small></div><div class="e">${p.game!.score.toLocaleString()} <small>${accuracy(done(p.game!)).toFixed(0)}%</small></div></div>`).join('') || '<div class="empty">No scores were recorded.</div>'}</div>
    ${solo && t.rows.length ? '<p class="hintp">Solo mode: the rest of the band played itself.</p>' : ''}
    <div class="row"><button class="btn drop" id="r-again">↻ PLAY AGAIN</button><button class="btn" id="r-pick">🎮 PICK ANOTHER</button><button class="btn" id="r-free">■ FREE PLAY</button></div></div>`;
  $('results').hidden = false;
  $('r-again').onclick = () => { $('results').hidden = true; net.send({ t: 'game', action: 'start', songId: g.songId, difficulty: g.difficulty }); };
  $('r-pick').onclick = () => { $('results').hidden = true; net.send({ t: 'game', action: 'stop' }); openGamePicker(); };
  $('r-free').onclick = () => { $('results').hidden = true; net.send({ t: 'game', action: 'stop' }); };
}
setInterval(() => {
  if (!ts?.game) return;
  const t = teamStats();
  $('gh-team').textContent = t.score.toLocaleString();
  $('gh-acc').textContent = `${t.rows.length > 1 ? 'TEAM' : humans().length === 1 ? 'SOLO' : 'AUTO DEMO'} · ${t.acc.toFixed(0)}%`;
  $('gh-note').textContent = humans().length === 1 ? 'Solo mode: the rest of the band plays itself' : '';
}, 250);

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

  gameTick(b.serverMs);
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

(window as any).ho = { engine, clock, rec, tap }; // console debugging
net.connect();
