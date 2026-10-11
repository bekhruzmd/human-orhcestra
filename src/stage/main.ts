/**
 * Stage (laptop / big screen).
 *  - same synced clock as the phones: it is just another client, so audio, visuals and flashes line up
 *  - plays everyone's notes (except phones that report speaker mode) + the AUTO band
 *  - conductor controls are commands to the server; only Stage sockets may send them
 */
import QRCode from 'qrcode';
import { newRoomCode, normalizeRoomCode, roomFromUrl } from '../common/room';
import { Net } from '../common/net';
import { ClockSync } from '../common/clock';
import { BeatTracker, flashEnv } from '../common/beat';
import { Engine } from '../common/engine';
import { Recorder } from '../common/recorder';
import { fmt, syncHeadline, esc } from '../common/util';
import {
  BPM_MAX, BPM_MIN, ROLES, ROLE_INFO, liveNotesAllowed, dropPhase, nextStepAfter, stepPos, stepTime,
  type NoteEvent, type PlayerInfo, type Role, type ScaleName, type TransportState,
} from '../../shared/protocol';
import { NOTE_NAMES, SCALE_LABEL, chordAt, freeMidi, freeZone, shakeVoice, type Resolved } from '../../shared/music';
import { analyze, arrange, toMidi, type RawEv, type Song } from './composer';
import { parseMidi } from './midi';
import { toGameSong, toLoopSong } from './importsong';
import { melodyBacking } from '../../shared/jam';
import { SongPlayer } from './song';
import { SEQ_ROWS, SEQ_STEPS, Sequencer } from './sequencer';
import { MIX_CHANNELS, MIX_LABEL } from '../common/engine';
import { GameConductor } from './gameconductor';
import { SONGS, getSong } from '../../shared/songs';
import { DIFF, DIFFICULTIES, INSTRUMENT, accuracy, freeRoles, grade, songSeconds, validateGameSong, type GameSong, type Difficulty } from '../../shared/game';
import { LIBRARY, buildSong } from '../songs/library';
import { Viz, type Lane } from './visuals';
import { AutoBand } from './auto';
import { Sampler, SLICES } from './sampler';
import { SessionPlayer, type DetailedRecording, type RecordedSessionItem } from './sessionplayer';

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
<div id="sync-proof" aria-hidden="true"><b id="sync-beat-number"></b><small>SYNC TEST · BEAT</small></div>
<canvas id="viz"></canvas>
<div id="big"></div>
<section id="demo-guide" aria-live="polite" hidden><b id="demo-title"></b><span id="demo-copy"></span><strong id="demo-sync"></strong></section>
<section id="how-it-works" hidden aria-labelledby="how-title">
  <header><div><small>HUMAN ORCHESTRA · UNDER THE HOOD</small><h1 id="how-title">One clock. Every instrument.</h1></div><button class="btn" id="how-close">CLOSE <kbd>W</kbd></button></header>
  <div class="architecture" aria-label="Phones send timing pings to the server transport clock, which schedules audio on the Stage">
    <div class="arch-node"><span>01 · INPUT</span><b>PHONES</b><small>Join · ping · play</small></div><i aria-hidden="true">→</i>
    <div class="arch-node server-node"><span>02 · SHARED TIME</span><b>SERVER CLOCK</b><small>One transport · one beat grid</small></div><i aria-hidden="true">→</i>
    <div class="arch-node"><span>03 · OUTPUT</span><b>STAGE AUDIO</b><small>Schedule ahead · play together</small></div>
  </div>
  <div class="clock-explain"><div><h2>How a phone finds the beat</h2><p class="formula">offset = server time − midpoint(phone send, phone receive)</p><p>Each ping/pong exchange gives a time-offset estimate. We keep the lowest-RTT 30% to reduce queue-delay noise, then take their median and gently slew the clock.</p></div><div class="clock-rule">LOWEST RTT<br><b>30%</b><br>MEDIAN OFFSET</div></div>
  <div class="how-metrics" aria-live="polite">
    <div><small>PHONES CONNECTED</small><b id="how-phones">–</b></div>
    <div><small>STAGE RTT · LAST</small><b id="how-rtt">–</b></div>
    <div><small>STAGE JITTER</small><b id="how-jitter">–</b></div>
    <div><small>WORST PHONE P90</small><b id="how-error">–</b></div>
  </div>
  <footer>Timing is estimated from each device’s own monotonic clock. No beat-by-beat network trigger is needed.</footer>
</section>
<div class="hud">
  <div class="brand">HUMAN ORCHESTRA<small id="keyline">–</small><span class="mode" id="mode">WAITING</span></div>
  <div class="chordbox"><span class="lbl">CHORD</span><b id="chord">–</b><small id="next">&nbsp;</small></div>
  <div class="stat"><span class="lbl">BPM</span><b id="bpm">–</b></div>
  <div class="stat"><span class="lbl">BAR · BEAT</span><b id="bar">–</b></div>
  <div class="stat sync"><span class="lbl">SYNC ERROR (WORST PHONE)</span><b id="sync">–</b><small id="syncsub" aria-live="polite">waiting for phones</small></div>
</div>
<aside class="side">
  <div class="qrbox"><canvas id="qr"></canvas></div>
  <div class="scan">SCAN TO JOIN</div><div id="roomcode" aria-label="Room code"></div><div id="url"></div><div id="warn" aria-live="polite"></div>
  <div id="roster"></div>
</aside>
<button id="audio">SOUND OFF · click to enable audio</button>
<footer class="conductor" id="cond">
  <div class="demo-flow"><div><b id="demo-step">JUDGE DEMO</b><small id="demo-hint">Three quick moments · N to advance</small></div><button class="btn play" id="demo-next" aria-label="Advance judge demo">NEXT <kbd>N</kbd></button></div>
  <details id="more">
    <summary>MORE</summary>
    <div class="more-controls">
    <section class="mc-sec"><h4>Music</h4>
      <div class="cond-cluster transport-cluster mc-music">
        <div class="ctl"><span class="lbl">TEMPO <b id="bpmv"></b></span><input id="bpmr" type="range" min="${BPM_MIN}" max="${BPM_MAX}" step="1" aria-label="Tempo" /></div>
        <div class="ctl"><span class="lbl">KEY</span><select id="key" aria-label="Key">${NOTE_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select></div>
        <div class="ctl"><span class="lbl">SCALE</span><select id="scale" aria-label="Scale">${(Object.keys(SCALE_LABEL) as ScaleName[]).map((s) => `<option value="${s}">${SCALE_LABEL[s]}</option>`).join('')}</select></div>
        <button class="btn drop" id="drop">DROP</button>
      </div>
    </section>
    <section class="mc-sec"><h4>Play</h4>
      <div class="cond-cluster modes-cluster mc-grid mc-4">
        <button class="btn play" id="play">PLAY A SONG</button>
        <button class="btn free" id="free">FREESTYLE</button>
        <button class="btn" id="midi">SONGS</button>
        <button class="btn sample" id="sample">SAMPLE</button>
        <input id="midifile" type="file" accept=".mid,.midi" aria-label="Load MIDI file" hidden />
        <button class="btn" id="auto">AUTO</button>
        <button class="btn" id="pause" disabled>PAUSE</button>
        <button class="btn" id="spk">SPEAKERS</button>
      </div>
    </section>
    <section class="mc-sec"><h4>Recording</h4>
      <div class="cond-cluster record-cluster mc-grid mc-3">
        <button class="btn rec-btn rec" id="sessrec">RECORD</button>
        <button class="btn rec-btn rec" id="rec">SAVE 30s</button>
        <button class="btn rec-btn" id="viewrecs">SESSIONS</button>
      </div>
    </section>
    <section class="mc-sec"><h4>Demo tools</h4>
      <div class="mc-grid mc-3">
        <button class="btn" id="sync-test">SYNC TEST: OFF</button>
        <button class="btn" id="how-open">HOW IT WORKS <kbd>W</kbd></button>
        <button class="btn" id="local-fallback">OPEN PLAYER HERE</button>
      </div>
      <details class="pf-fold"><summary>Preflight checks</summary>
        <section class="preflight" aria-labelledby="preflight-title">
          <div class="preflight-head"><b id="preflight-title">DEMO PREFLIGHT</b></div>
          <p id="preflight-warning" role="status" aria-live="polite" hidden></p>
          <div class="preflight-grid">
            <div><small>TUNNEL / URL</small><b id="pf-tunnel">CHECKING…</b></div>
            <div><small>STAGE AUDIO</small><b id="pf-audio">OFF</b></div>
            <div><small>PHONES</small><b id="pf-phones">0</b></div>
            <div><small>AVG PHONE RTT</small><b id="pf-rtt">–</b></div>
            <div><small>STAGE LATE NOTES</small><b id="pf-late">0</b></div>
          </div>
        </section>
      </details>
    </section>
    </div>
  </details>
</footer>
<div id="replaybar" class="replay-bar" hidden>
  <span class="replay-dot"></span>
  <span class="replay-label" id="replay-title">REPLAYING SESSION</span>
  <span class="replay-time" id="replay-time">00:00 / 00:00</span>
  <button class="btn btn-close" id="replay-stop" title="Stop replay">■</button>
</div>
<div id="landing" class="landing">
  <div class="landing-card">
    <h1 class="landing-title">HUMAN ORCHESTRA</h1>
    <p class="landing-sub">Phones become instruments. A shared server clock keeps everyone in time.</p>
    <ul class="landing-pills">
      <li class="l-pill l-pill-mint">ZERO INSTALL</li>
      <li class="l-pill l-pill-sky">SUB-MS CLOCK SYNC</li>
      <li class="l-pill l-pill-peach">16-BIT SOUND ENGINE</li>
    </ul>
    <button class="btn-play-now" id="playnow">PLAY NOW</button>
    <p class="landing-hint">CLICK TO UNLOCK AUDIO &amp; ENTER STAGE</p>
  </div>
</div>
<div id="card" hidden></div>
<div id="gamehud" hidden><div class="gh-top"><span id="gh-title"></span><b id="gh-team">0</b><span id="gh-acc"></span></div><div class="gh-bar"><i id="gh-prog"></i></div><div id="gh-note"></div></div>
<div id="gamepick" hidden><div class="box">
  <h3>Pick a song</h3>
  <p id="gp-info"></p>
  <div class="row"><button class="btn" id="gp-import">+ YOUR SONG (.mid)</button><button class="btn" id="gp-preview">Preview selected</button></div>
  <input id="gp-file" type="file" accept=".mid,.midi" aria-label="Import game MIDI file" hidden />
  <label class="hintp"><input id="gp-melody" type="checkbox" aria-label="Import melody only" /> Import melody only (highest part)</label>
  <label class="hintp" id="gp-part-label" hidden>Melody part <select id="gp-part" aria-label="Melody part"></select></label>
  <p class="hintp" id="gp-status" role="status" aria-live="polite">Load a MIDI arrangement of a song you want to play. Imports are saved in this browser.</p>
  <div id="gp-songs"></div>
  <p class="hintp"><b>Play with the band</b>: the song plays and anyone can add drums on top. Players who pick a part on their phone follow its notes and hear how well they are doing. Tap a part to mute it from the song and play it live.</p>
  <div class="parts" id="gp-parts" aria-label="Song parts"></div>
  <p class="capacity" id="gp-capacity" role="status" aria-live="polite"></p>
  <div class="diffs" id="gp-diffs"></div>
  <div class="row"><button class="btn drop" id="gp-start">Rhythm game</button><button class="btn" id="gp-band">Play with the band</button></div>
  <div class="row"><button class="btn" id="gp-close">Close</button></div>
</div></div>
<div id="results" hidden></div>
<div id="sampleui" hidden><div class="box">
  <div class="box-head">
    <h3>Make music with your own audio</h3>
    <button class="btn-close" id="sp-close-x" aria-label="Close sample modal"></button>
  </div>
  <p class="hintp">Choose an MP3 / WAV from this computer. It stays in this browser; nothing is uploaded. Phones then play slices of it on the beat.</p>
  <label class="dropzone" id="sp-drop"><span id="sp-droptext">Drop an audio file here, or <u>choose a file</u></span><input type="file" id="sp-file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.aac,.flac" aria-label="Load sample audio file" hidden></label>
  <div class="drop-cancel-row" id="sp-pre-actions"><button class="btn" id="sp-cancel">BACK / CLOSE</button></div>
  <div id="sp-panel" hidden>
    <canvas id="sp-wave"></canvas>
    <div class="sp-line"><b id="sp-name"></b><span id="sp-info"></span></div>
    <div class="sp-ctl">
      <span>TEMPO</span><button class="btn" data-sp="half">½×</button><button class="btn" data-sp="bpm-1">−1</button><b id="sp-bpm"></b><button class="btn" data-sp="bpm+1">+1</button><button class="btn" data-sp="double">2×</button>
      <span>GRID</span><button class="btn" data-sp="off-beat">◂ beat</button><button class="btn" data-sp="off+beat">beat ▸</button><button class="btn" data-sp="off-bar">◂ bar</button><button class="btn" data-sp="off+bar">bar ▸</button>
      <span>SLICE</span><button class="btn" data-sp="slice.5">½ beat</button><button class="btn" data-sp="slice1">1 beat</button><button class="btn" data-sp="slice2">2 beats</button>
    </div>
    <div class="row"><button class="btn play" id="sp-chop">PHONES PLAY SLICES</button><button class="btn" id="sp-back">BACKING LOOP</button><button class="btn" id="sp-stop">■ STOP</button><button class="btn" id="sp-close">Close</button></div>
    <p class="hintp" id="sp-msg"></p>
  </div>
</div></div>
<div id="recordingsui" hidden><div class="box">
  <div class="box-head">
    <h3>Recorded Sessions</h3>
    <button class="btn-close" id="rec-close-x" aria-label="Close recordings modal"></button>
  </div>
  <p class="hintp">Review live sessions captured by the conductor. Replay them through the synth engine or export their event logs.</p>
  <div class="rec-summary-bar">
    <span id="rec-count-lbl">Loading sessions…</span>
    <button class="btn" id="rec-refresh">↻ Refresh</button>
  </div>
  <div id="rec-list" class="rec-list"></div>
  <div class="row" style="margin-top:16px;">
    <button class="btn" id="rec-stop-all" hidden>■ Stop Playback</button>
    <button class="btn" id="rec-wav-save">⤓ Save Last 30s Audio (.wav)</button>
    <button class="btn" id="rec-close">Close</button>
  </div>
</div></div>
<div id="songs" hidden><div class="box">
  <h3>Pick a song</h3>
  <div class="modes"><button class="btn on" id="m-tap">Play along (guided song)</button><button class="btn" id="m-band">Listen to arrangement</button><button class="btn" id="m-jam">Jam over melody</button></div>
  <div id="songlist"></div>
  <div class="row"><button class="btn" id="s-file">Load .mid file…</button><button class="btn" id="s-stop">■ Stop song</button><button class="btn" id="s-close">Close</button></div>
</div></div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flashEl = $('flash');
const viz = new Viz($<HTMLCanvasElement>('viz'));

// ------------------------------------------------------------------ network
// This Stage owns a room. The code is in the URL (?room=ABCD) so a refresh keeps it; a fresh Stage makes a new one.
const roomCode = (() => {
  let code = roomFromUrl();
  try {
    if (!code) code = normalizeRoomCode(sessionStorage.getItem('ho.stageRoom'));
    if (!code) code = newRoomCode();
    sessionStorage.setItem('ho.stageRoom', code);
  } catch { if (!code) code = newRoomCode(); }
  history.replaceState(null, '', `${location.pathname}?room=${code}${location.hash}`);
  return code;
})();
net.onOpen(() => { net.send({ t: 'hello', kind: 'stage', room: roomCode, create: true }); clock.start(true); });
net.on('pong', (m) => clock.onPong(m));
net.on('welcome', (m) => { ts = m.state; wasFree = m.state.freestyle; engine.setTransport(m.state); syncControls(); onGameChange(); syncJam(); });
net.on('state', (m) => { ts = m.state; engine.setTransport(m.state); syncControls(); onFreestyleChange(); onGameChange(); syncJam(); checkSampleState(); });
net.on('raw', (r) => onRaw(r));
net.on('roster', (m) => { roster = m.players; engine.prune(new Set(roster.map((p) => p.id))); renderRoster(); updatePreflight(); if (!$('gamepick').hidden) renderParts(); });
net.on('ctl', (m) => engine.ctl(m.pid, m.y, m.tilt));
net.on('note', (ev) => {
  if (ts?.paused != null) return;
  if (ts && !ts.game && ts.sample?.mode === 'chop' && sampler.buffer) {
    // Sample mode: the pad index is a SLICE number; the note's step is the quantised moment to play it.
    const i = sampler.trigger(engine, Math.max(0, Math.min(SLICES - 1, ev.d)), stepTime(ts, ev.step), ts.bpm, ev.v);
    viz.push({ ...ev, role: 'melody', midi: [52 + Math.round((Math.max(0, i) / (SLICES - 1)) * 30)], d: 0, dur: 2 }, stepTime(ts, ev.step));
    return;
  }
  if (!ts || !liveNotesAllowed(ts)) return;
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
const autoRoles = (): Role[] => {
  if (!ts || songs.song) return [];
  const g = ts.game;
  if (g) return ROLES.filter((r) => (!g.song || g.song.tracks[r].length > 0) && !humans().some((p) => p.role === r));
  // When no players are connected, do not play default music! Only provide backing when humans are in the band.
  if (ts.autoBand && humans().length > 0) {
    return ROLES.filter((r) => !humans().some((p) => p.role === r));
  }
  return [];
};
const songs = new SongPlayer(clock, () => ts, (ev: NoteEvent) => {
  if (!ts) return;
  engine.play(ev);
  viz.push(ev, stepTime(ts, ev.step));
});
const seq = new Sequencer(clock, () => ts, (ev: NoteEvent) => {
  if (!ts) return;
  engine.play(ev);
  viz.push(ev, stepTime(ts, ev.step));
});
const gameConductor = new GameConductor(clock, () => ts, (role) => humans().filter((p) => p.role === role).map((p) => p.id), (ev: NoteEvent) => {
  if (!ts) return;
  engine.play(ev);
  const owners = humans().filter((p) => p.role === ev.role);
  for (const pid of owners.length ? owners.map((p) => p.id) : [`auto:${ev.role}`]) viz.push({ ...ev, pid }, stepTime(ts, ev.step));
});
net.on('ghit', (m) => gameConductor.hit(m.startStep, m.step, m.role, m.pid, m.noteId));
net.on('error', (m) => { $('gp-status').textContent = m.message; $('gamepick').hidden = false; });
new AutoBand(clock, () => ts, () => (ts?.game ? [] : autoRoles()), (ev: NoteEvent) => {
  if (!ts) return;
  engine.play(ev);
  viz.push(ev, stepTime(ts, ev.step));
});

// -------------------------------------------------------------------- lanes
// AUTO lanes get a stable muted per-role colour so they never flicker as players come and go.
const AUTO_COLORS: Record<Role, string> = { drums: '#c9c2e0', bass: '#b5cde6', melody: '#cdbff0', pads: '#b3dcd5', guitar: '#ffdcc2' };
const STANDBY_ROLES = ROLES;
function laneList(): Lane[] {
  const h = humans();
  const l: Lane[] = [...h, ...roster.filter((p) => !p.connected)].map((p) => ({
    id: p.id, name: p.name, role: p.role, color: p.color, auto: false, connected: p.connected, speaker: p.speaker,
  }));
  if (seq.running && !seq.empty) l.push({ id: 'seq:drums', name: 'BEAT', role: 'drums', color: '#ffd166', auto: false, connected: true, speaker: false });
  if (songs.song) {
    const seen = new Set(songs.song.events.map((e) => e.role));
    for (const r of ROLES) if (seen.has(r)) {
      const c = songs.song.credit[r];
      l.push({ id: `song:${r}`, name: c ? `from ${c.name}` : 'TRACK', role: r, color: c?.color ?? '#ffd166', auto: false, connected: true, speaker: false });
    }
  }
  for (const r of autoRoles()) l.push({ id: `auto:${r}`, name: 'AUTO', role: r, color: AUTO_COLORS[r], auto: true, connected: true, speaker: false });
  // If no players and no track is playing, show instruments ready on standby so user can pick a track
  if (l.length === 0 && !songs.song && !ts?.game) {
    for (const r of STANDBY_ROLES) {
      l.push({ id: `standby:${r}`, name: 'STANDBY · READY', role: r, color: AUTO_COLORS[r], auto: true, connected: false, speaker: false });
    }
  }
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
    return `<div class="pl ${p.connected ? '' : 'off'}" style="--c:${p.color}"><div class="n">${ROLE_INFO[p.role].icon} ${esc(p.name)}<small>${ROLE_INFO[p.role].label}${p.speaker ? ' · phone speaker' : ''}${p.connected ? '' : ' · reconnecting…'}</small></div>
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

// -------------------------------------------------------------- conductor UI
const done = (g: { perfect: number; good: number; miss: number }) => ({ perfect: g.perfect, good: g.good, total: g.perfect + g.good + g.miss });
const cmd = (c: 'bpm' | 'pause' | 'key' | 'scale' | 'drop' | 'auto' | 'speakers' | 'syncTest' | 'freestyle' | 'nowplaying' | 'sample' | 'recordingStart' | 'recordingStop', value?: number | string | boolean) => net.send({ t: 'cmd', cmd: c, value });
let demoStep = 0;
let publicJoinUrl = '';
let tunnelState: 'checking' | 'up' | 'down' | 'not-needed' = 'checking';
let fallbackUsed = false;
function updateDemoUI() {
  const guide = $('demo-guide');
  guide.hidden = demoStep === 0;
  $('demo-step').textContent = demoStep === 0 ? 'JUDGE DEMO' : `MOMENT ${demoStep} / 3`;
  $('demo-hint').textContent = demoStep === 0 ? 'Three quick moments · N to advance' : demoStep === 1 ? 'Scan the QR · play any pad · AUTO fills the band' : demoStep === 2 ? 'Every phone flashes from the shared beat clock' : 'NEXT starts the build · DROP lands on the downbeat';
  $('demo-title').textContent = demoStep === 1 ? 'SCAN + PLAY' : demoStep === 2 ? 'ONE SHARED BEAT' : 'THE DROP';
  $('demo-copy').textContent = demoStep === 1 ? 'A phone joins the song in key. Missing parts are backed by AUTO.' : demoStep === 2 ? `${humans().length} PHONE${humans().length === 1 ? '' : 'S'} · MEASURED SYNC ERROR` : 'Shared transport. Live players. One room-wide impact.';
  const live = humans().filter((p) => p.sync);
  const worst = live.length ? Math.max(...live.map((p) => syncHeadline(p.sync).err)) : NaN;
  $('demo-sync').textContent = Number.isFinite(worst) ? `±${fmt(worst, 0)} ms` : 'WAITING FOR PHONES';
  $('demo-next').innerHTML = demoStep === 0 ? 'NEXT <kbd>N</kbd>' : demoStep === 3 ? 'RESTART <kbd>N</kbd>' : 'NEXT <kbd>N</kbd>';
  $('sync').closest('.stat')?.classList.toggle('demo-sync-highlight', demoStep === 2);
  $('app').classList.toggle('demo-active', demoStep > 0);
}
async function advanceDemo() {
  if (demoStep === 0 || demoStep === 3) {
    if (!audioOn) await enableAudio();
    demoStep = 1;
    cmd('auto', true);
  } else if (demoStep === 1) demoStep = 2;
  else {
    demoStep = 3;
    cmd('drop');
  }
  updateDemoUI();
}
$('demo-next').onclick = () => { void advanceDemo().catch((err) => { console.warn('Could not start judge demo', err); flashBig('AUDIO UNAVAILABLE', 1200); }); };
let bpmTimer = 0;
$<HTMLInputElement>('bpmr').oninput = (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  $('bpmv').textContent = String(v);
  clearTimeout(bpmTimer); bpmTimer = window.setTimeout(() => cmd('bpm', v), 60);
};
$<HTMLSelectElement>('key').onchange = (e) => cmd('key', Number((e.target as HTMLSelectElement).value));
$<HTMLSelectElement>('scale').onchange = (e) => cmd('scale', (e.target as HTMLSelectElement).value);
$('drop').onclick = () => cmd('drop');
$('sync-test').onclick = () => cmd('syncTest', !ts?.syncTest);
$('how-open').onclick = () => toggleHow(true);
$('how-close').onclick = () => toggleHow(false);
$('local-fallback').onclick = () => {
  window.open(new URL('/', location.origin).toString(), '_blank', 'noopener,noreferrer');
  fallbackUsed = true;
  updatePreflight();
};
$('pause').onclick = () => cmd('pause', ts?.paused == null);
$('free').onclick = () => cmd('freestyle', !ts?.freestyle);
$('play').onclick = () => openGamePicker();
$('midi').onclick = openSongs;
$('s-close').onclick = () => { $('songs').hidden = true; };
$('s-stop').onclick = () => { stopSong(); $('songs').hidden = true; };
$('s-file').onclick = () => $<HTMLInputElement>('midifile').click();
$('m-tap').onclick = () => setSongMode('tap');
$('m-band').onclick = () => setSongMode('band');
$('m-jam').onclick = () => setSongMode('jam');
$<HTMLInputElement>('midifile').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try { $('songs').hidden = true; await playSong(parseMidi(await f.arrayBuffer(), f.name.replace(/\.midi?$/i, '')), songMode); }
  catch (err) { flashBig('Bad MIDI', 1500); console.warn(err); }
  (e.target as HTMLInputElement).value = '';
};
$('auto').onclick = () => cmd('auto', !ts?.autoBand);
$('spk').onclick = () => cmd('speakers', !ts?.speakerMode);
$('sessrec').onclick = () => cmd(ts?.recording ? 'recordingStop' : 'recordingStart');
$('rec').onclick = () => { if (!rec.save()) alert('Nothing recorded yet: enable audio first and play something.'); };
async function enableAudio() {
  await engine.start(); rec.start().catch((e) => console.warn('recorder unavailable', e));
  $('audio').style.display = 'none'; audioOn = true; syncControls();
}
$('audio').onclick = enableAudio;
$('playnow').onclick = async () => {
  await enableAudio();
  $('landing').classList.add('hide');
  setTimeout(() => {
    $('landing').style.display = 'none';
    viz.resize();
  }, 350);
};
const sessionPlayer = new SessionPlayer(engine, viz, clock, () => ts);

function stopSessionReplay() {
  sessionPlayer.stop();
  $('replaybar').hidden = true;
  if ($('rec-stop-all')) $('rec-stop-all').hidden = true;
  document.querySelectorAll('.rec-card').forEach((c) => c.classList.remove('playing'));
}

$('replay-stop').onclick = stopSessionReplay;
$('rec-stop-all').onclick = stopSessionReplay;

const closeRecordingsUI = () => { $('recordingsui').hidden = true; };
const closeSampleUI = () => { $('sampleui').hidden = true; document.body.classList.remove('insample'); };

$('viewrecs').onclick = () => { $('recordingsui').hidden = false; loadRecordingsList(); };
$('rec-close').onclick = closeRecordingsUI;
$('rec-close-x').onclick = closeRecordingsUI;
$('rec-refresh').onclick = () => loadRecordingsList();
$('rec-wav-save').onclick = () => {
  if (!rec.save()) alert('No recent audio buffer to save. Play some sound first.');
};

async function loadRecordingsList() {
  $('rec-count-lbl').textContent = 'Fetching sessions from server…';
  $('rec-list').innerHTML = '<div class="empty">Loading recorded sessions…</div>';
  try {
    const res = await fetch('/api/recordings?limit=50');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderRecordingsList(data.recordings || []);
  } catch (err) {
    console.warn('loadRecordingsList error', err);
    $('rec-count-lbl').textContent = 'Could not retrieve sessions';
    $('rec-list').innerHTML = '<div class="empty">Could not connect to /api/recordings. Check server.</div>';
  }
}

function fmtDuration(startedAt: string, endedAt: string) {
  try {
    const s = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m > 0 ? `${m}m ` : ''}${sec}s`;
  } catch {
    return '–';
  }
}

function fmtTime(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function renderRecordingsList(list: RecordedSessionItem[]) {
  if (!list.length) {
    $('rec-count-lbl').textContent = '0 recorded sessions';
    $('rec-list').innerHTML = `<div class="empty">No recorded sessions yet.<br>Click "START RECORDING" in the toolbar during performance, then click again to stop and save.</div>`;
    return;
  }
  $('rec-count-lbl').textContent = `${list.length} recorded session${list.length === 1 ? '' : 's'}`;
  $('rec-list').innerHTML = list.map((r) => {
    let dateStr = r.startedAt;
    try { dateStr = new Date(r.startedAt).toLocaleString(); } catch { /* keep */ }
    const durStr = fmtDuration(r.startedAt, r.endedAt);
    const notesCount = r.summary?.byType?.note ?? r.summary?.total ?? 0;
    return `
      <div class="rec-card" id="reccard-${r.id}" data-id="${r.id}">
        <div class="rec-meta">
          <div class="rec-title-row">
            <span class="rec-badge">${esc(r.mode || 'FREE')}</span>
            <span class="rec-date">${esc(dateStr)}</span>
          </div>
          <div class="rec-info-row">
            <span>${durStr}</span>
            <span>${r.players} player${r.players === 1 ? '' : 's'}</span>
            <span>${notesCount} note${notesCount === 1 ? '' : 's'}</span>
          </div>
        </div>
        <div class="rec-actions">
          <button class="btn rec-btn btn-listen" data-id="${r.id}">LISTEN</button>
          <button class="btn btn-export" data-id="${r.id}">⤓ JSON</button>
        </div>
      </div>
    `;
  }).join('');

  $('rec-list').querySelectorAll<HTMLElement>('.btn-listen').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id!;
      await startReplayingSession(id);
    };
  });

  $('rec-list').querySelectorAll<HTMLElement>('.btn-export').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id!;
      try {
        const res = await fetch(`/api/recordings/${encodeURIComponent(id)}`);
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `recording-${id.slice(0, 8)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      } catch (err) {
        alert('Could not export recording JSON.');
      }
    };
  });
}

async function startReplayingSession(id: string) {
  try {
    await enableAudio();
    const res = await fetch(`/api/recordings/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error('Session not found');
    const fullRec: DetailedRecording = await res.json();

    const started = sessionPlayer.play(
      fullRec,
      (elapsedMs, totalMs) => {
        $('replay-time').textContent = `${fmtTime(elapsedMs)} / ${fmtTime(totalMs)}`;
      },
      () => {
        stopSessionReplay();
        flashBig('Replay complete', 1200);
      },
    );

    if (started) {
      $('replay-title').textContent = `REPLAYING: ${sessionPlayer.sessionTitle.toUpperCase()}`;
      $('replaybar').hidden = false;
      if ($('rec-stop-all')) $('rec-stop-all').hidden = false;
      document.querySelectorAll('.rec-card').forEach((c) => c.classList.remove('playing'));
      const card = $(`reccard-${id}`);
      if (card) card.classList.add('playing');
      flashBig(`Replaying session`, 1000);
    } else {
      alert('This session has no recorded notes to replay.');
    }
  } catch (err) {
    console.warn('startReplayingSession error', err);
    alert('Could not retrieve or play this session.');
  }
}

addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable);
  if (!typing && $('how-it-works').hidden && !e.repeat && e.key.toLowerCase() === 'n') { e.preventDefault(); void advanceDemo(); }
  if (e.key === 'Escape') {
    if (!$('how-it-works').hidden) { toggleHow(false); return; }
    if (!$('sampleui').hidden) { closeSampleUI(); return; }
    if (!$('recordingsui').hidden) { closeRecordingsUI(); return; }
    if (!$('gamepick').hidden) { $('gamepick').hidden = true; return; }
    if (!$('songs').hidden) { $('songs').hidden = true; return; }
    if (!$('results').hidden) { $('results').hidden = true; return; }
    if (sessionPlayer.isPlaying) { stopSessionReplay(); return; }
  }
  if (typing) return;
  if (e.key === ' ' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement)) { e.preventDefault(); if (!$<HTMLButtonElement>('pause').disabled) $('pause').click(); }
  if (e.key.toLowerCase() === 'w') toggleHow($('how-it-works').hidden === true);
  if (e.key === 'h') $('cond').classList.toggle('hidden');
  if (e.key === 'f') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
});

function toggleHow(open: boolean) {
  $('how-it-works').hidden = !open;
  if (open) refreshHow();
}
function refreshHow() {
  const s = clock.stats(beats.flashLate);
  const live = humans().filter((p) => p.sync);
  const worst = live.length ? Math.max(...live.map((p) => syncHeadline(p.sync).err)) : NaN;
  $('how-phones').textContent = String(humans().length);
  $('how-rtt').textContent = `${fmt(s.rttLast, 1)} ms`;
  $('how-jitter').textContent = `${fmt(s.jitter, 2)} ms`;
  $('how-error').textContent = Number.isFinite(worst) ? `±${fmt(worst, 1)} ms` : 'WAITING';
}
setInterval(() => { if (!$('how-it-works').hidden) refreshHow(); }, 500);

// Close modals when clicking backdrop
$('sampleui').onclick = (e) => { if (e.target === $('sampleui')) closeSampleUI(); };
$('recordingsui').onclick = (e) => { if (e.target === $('recordingsui')) closeRecordingsUI(); };
$('gamepick').onclick = (e) => { if (e.target === $('gamepick')) $('gamepick').hidden = true; };
$('songs').onclick = (e) => { if (e.target === $('songs')) $('songs').hidden = true; };

// Click anywhere on viz canvas in standby mode to open song/track picker
$<HTMLCanvasElement>('viz').onclick = () => {
  if (humans().length === 0 && !songs.song && !ts?.game) {
    $('songs').hidden = false;
  }
};
function syncControls() {
  if (!ts) return;
  const live = !!(ts.game || ts.nowPlaying || ts.sample || ts.autoBand || ts.freestyle || ts.drop);
  const paused = ts.paused != null;
  if (paused && !live) cmd('pause', false); // nothing left to pause: don't leave the clock frozen
  $<HTMLButtonElement>('pause').disabled = !live && !paused;
  $('pause').textContent = paused ? 'RESUME' : 'PAUSE';
  $('pause').classList.toggle('on', paused);
  document.body.classList.toggle('paused', paused);
  if (document.activeElement !== $('bpmr')) { $<HTMLInputElement>('bpmr').value = String(ts.bpm); $('bpmv').textContent = String(ts.bpm); }
  $<HTMLSelectElement>('key').value = String(ts.root);
  $<HTMLSelectElement>('scale').value = ts.scale;
  $('auto').classList.toggle('on', ts.autoBand);
  $('free').classList.toggle('on', ts.freestyle);
  $('free').textContent = ts.freestyle ? '■ STOP · MAKE SONG' : 'FREESTYLE';
  const jam = ts.nowPlaying?.mode === 'jam';
  for (const id of ['bpmr', 'key', 'scale', 'drop', 'auto', 'free', 'sample']) ($<HTMLButtonElement>(id)).disabled = jam || !!ts.game;
  $('spk').classList.toggle('on', ts.speakerMode);
  $('sync-test').classList.toggle('on', ts.syncTest);
  $('sync-test').textContent = `SYNC TEST: ${ts.syncTest ? 'ON' : 'OFF'}`;
  $('sessrec').classList.toggle('on', !!ts.recording);
  $('sessrec').textContent = ts.recording ? `■ STOP (${ts.recording.events})` : 'RECORD';
  $('keyline').textContent = `${NOTE_NAMES[ts.root]} ${SCALE_LABEL[ts.scale]}${audioOn ? ' · SOUND ON' : ''}`;
  $('bpm').textContent = String(ts.bpm);
  updatePreflight();
}

function updatePreflight() {
  const live = humans().filter((p) => p.connected && p.sync);
  const rtt = live.length ? live.reduce((sum, p) => sum + p.sync!.rttLast, 0) / live.length : NaN;
  $('pf-tunnel').textContent = tunnelState === 'up' ? 'REACHABLE' : tunnelState === 'not-needed' ? 'HTTPS READY' : tunnelState === 'down' ? 'NOT READY' : 'CHECKING…';
  $('pf-tunnel').className = tunnelState === 'up' || tunnelState === 'not-needed' ? 'ready' : tunnelState === 'down' ? 'not-ready' : '';
  $('pf-audio').textContent = audioOn && engine.ready ? 'ENABLED' : 'OFF · CLICK SOUND';
  $('pf-audio').className = audioOn && engine.ready ? 'ready' : 'not-ready';
  $('pf-phones').textContent = `${humans().length} CONNECTED`;
  $('pf-phones').className = humans().length ? 'ready' : 'not-ready';
  $('pf-rtt').textContent = Number.isFinite(rtt) ? `${fmt(rtt, 1)} ms` : 'WAITING';
  $('pf-late').textContent = String(engine.lateCount);
  const warning = $('preflight-warning');
  const httpOrigin = location.protocol === 'http:';
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  warning.hidden = tunnelState !== 'down' || !httpOrigin;
  warning.textContent = fallbackUsed
    ? 'Tunnel is still unavailable. Use the player tab opened on this laptop; if it did not appear, allow pop-ups and try again.'
    : localHost
      ? 'Tunnel is not reachable yet. Start `npm run demo` and wait for the HTTPS URL, or open the player on this laptop below.'
      : 'No HTTPS tunnel is reachable. The LAN QR may work on the same Wi-Fi, but phone motion controls require HTTPS; wait for the tunnel or use the local-player button.';
}

async function checkJoinReachability() {
  if (location.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    tunnelState = 'not-needed'; updatePreflight(); return;
  }
  try {
    const response = await fetch('/api/info', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    const info: { publicUrl?: string | null; lanUrls?: string[] } = await response.json();
    publicJoinUrl = info.publicUrl ?? '';
    if (!publicJoinUrl) { tunnelState = 'down'; updatePreflight(); return; }
    try {
      const reachable = await fetch(publicJoinUrl, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(3500) });
      tunnelState = reachable.type === 'opaque' || reachable.ok ? 'up' : 'down';
    } catch { tunnelState = 'down'; }
    updatePreflight();
  } catch {
    tunnelState = 'down'; updatePreflight();
  }
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
  } else if (!ts.game && ts.nowPlaying?.mode !== 'jam') {
    composeFromJam();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function playSong(song: Song, mode: 'tap' | 'band' | 'jam' = 'band') {
  if (mode === 'jam') return startJam(toGameSong(song, importId()));
  if (mode === 'tap') { const imported = toGameSong(song, importId()); return startGame(imported, 'easy'); }
  const version = ++songLoadVersion;
  await enableAudio();
  if (version !== songLoadVersion) return;
  if (ts?.game) throw new Error('Finish the current game first');
  if (ts?.nowPlaying?.mode === 'jam') {
    net.send({ t: 'jam', action: 'stop' });
    for (let i = 0; i < 30 && ts?.nowPlaying?.mode === 'jam'; i++) await sleep(100);
    if (ts?.nowPlaying?.mode === 'jam') throw new Error('Could not stop the jam. Check the connection.');
  }
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
  flashBig('NOW PLAYING', 1400);
}
function stopSong() {
  songLoadVersion++;
  songs.stop(); seq.stop(); engine.silence(); hideCard();
  if (ts?.nowPlaying?.mode === 'jam') net.send({ t: 'jam', action: 'stop' });
  else { cmd('auto', false); cmd('nowplaying', ''); }
}
let lastSongReq = 0;
let songMode: 'tap' | 'band' | 'jam' = 'tap';
function setSongMode(m: 'tap' | 'band' | 'jam') { songMode = m; for (const mode of ['tap', 'band', 'jam']) $(`m-${mode}`).classList.toggle('on', m === mode); }
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
async function loadSongById(id: string, mode: 'tap' | 'band' | 'jam') {
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
  c.hidden = false; c.className = '';
  c.innerHTML = `<div class="txt"><h3>${esc(song.title)}</h3>${song.info.map((l) => `<p>${esc(l)}</p>`).join('')}</div>
    <div class="row"><button class="btn" id="c-restart">↻ Restart</button><button class="btn" id="c-stop">■ Stop</button>
    <button class="btn" id="c-mid">SAVE MIDI</button>${lastDraftLog && song.title === 'Your jam' ? '<button class="btn" id="c-json">SAVE JSON</button>' : ''}</div>`;
  $('c-stop').onclick = () => stopSong();
  $('c-restart').onclick = () => { if (ts) { const st = Math.ceil(nextStepAfter(ts, clock.serverNow(), 800) / 16) * 16; engine.silence(); songs.start(song, st); } };
  $('c-mid').onclick = () => download(`${song.title.replace(/\W+/g, '-')}.mid`, toMidi(song).slice().buffer as ArrayBuffer, 'audio/midi');
  const j = document.getElementById('c-json');
  if (j && lastDraftLog) j.onclick = () => download('jam-raw.json', JSON.stringify({ players: lastDraftLog!.players.map((p) => ({ id: p.id, name: p.name, role: p.role })), events: lastDraftLog!.log, song }, null, 1), 'application/json');
  cmd('auto', false);
}
const hideCard = () => { $('card').hidden = true; };

// ------------------------------------------------------------ melody + live band
let jamKey = '';
async function startJam(song: GameSong, full = false) {
  if (!full && !song.tracks.melody.length) throw new Error('This arrangement has no melody. Select a melody part from a MIDI file first.');
  const version = ++songLoadVersion;
  await enableAudio();
  for (let i = 0; i < 40 && (!net.connected || !clock.isLocked); i++) await sleep(100);
  if (version !== songLoadVersion) return;
  if (!net.connected || !clock.isLocked) throw new Error('Waiting for connection. Try Jam again.');
  endPreview(); songs.stop(); engine.silence();
  net.send({ t: 'jam', action: 'start', ...(full ? { full: true } : {}), song: { ...song, id: song.id.startsWith('import:') ? song.id : `import:jam:${song.id}` } });
  $('gamepick').hidden = true; $('songs').hidden = true; $('results').hidden = true;
}

/** Compact control card for a song with live players: part status, collapsed beat sequencer and mixer. */
function renderBandCard(heading: string, blurb: string, onStop: () => void, onRestart?: () => void) {
  const card = $('card'); card.hidden = false; card.className = 'band';
  const mixRow = (c: typeof MIX_CHANNELS[number]) => `<label class="jam-mix mix">${MIX_LABEL[c]} <input data-mix="${c}" aria-label="${MIX_LABEL[c]} volume" type="range" min="0" max="150" value="${Math.round(engine.mixLevel(c) * 100)}" /></label>`;
  card.innerHTML = `<div class="txt"><h3>${esc(heading)}</h3><p>${esc(blurb)}</p>
    <details class="fold"><summary>Beat</summary><div class="seq" aria-label="Beat sequencer">${SEQ_ROWS.map((r, i) => `<div class="seq-row"><b>${r.name}</b>${Array.from({ length: SEQ_STEPS }, (_, s) => `<button class="seq-cell ${s % 4 === 0 ? 'beat' : ''}" data-row="${i}" data-step="${s}" aria-label="${r.name} step ${s + 1}" aria-pressed="false"></button>`).join('')}</div>`).join('')}
      <div class="row"><button class="btn" id="seq-play">Start beat</button><button class="btn" id="seq-clear">Clear beat</button></div></div></details>
    <details class="fold"><summary>Mix</summary><div class="mixer">${MIX_CHANNELS.map(mixRow).join('')}</div></details></div>
    <div class="row">${onRestart ? '<button class="btn" id="jam-restart">Restart song</button>' : ''}<button class="btn" id="jam-stop">Stop</button></div>`;
  card.querySelectorAll<HTMLInputElement>('[data-mix]').forEach((el) => (el.oninput = () => engine.setMix(el.dataset.mix as typeof MIX_CHANNELS[number], Number(el.value) / 100)));
  const paintSeq = () => card.querySelectorAll<HTMLElement>('.seq-cell').forEach((b) => { const on = seq.cells[Number(b.dataset.row)][Number(b.dataset.step)]; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  card.querySelectorAll<HTMLElement>('.seq-cell').forEach((b) => (b.onclick = () => {
    seq.toggle(Number(b.dataset.row), Number(b.dataset.step)); paintSeq();
    if (!seq.running) { seq.start(); $('seq-play').textContent = 'Pause beat'; } // the first cell placed starts the pattern on the song's grid
  }));
  $('seq-play').onclick = () => { if (seq.running) seq.stop(); else seq.start(); $('seq-play').textContent = seq.running ? 'Pause beat' : 'Start beat'; };
  $('seq-clear').onclick = () => { seq.clear(); paintSeq(); };
  $('jam-stop').onclick = onStop;
  if (onRestart) $('jam-restart').onclick = onRestart;
  paintSeq();
}

function syncJam() {
  const jam = ts?.nowPlaying?.mode === 'jam' ? ts.nowPlaying : null;
  const key = jam ? `${jam.song.id}:${jam.startStep}:${jam.full ? 'f' : 'm'}` : '';
  if (key === jamKey) return;
  const wasJam = !!jamKey;
  jamKey = key;
  if (!jam) { if (wasJam) { songs.stop(); seq.stop(); engine.silence(); hideCard(); } return; }
  sampler.stop(engine); $('sampleui').hidden = true; document.body.classList.remove('insample');
  songs.stop(); engine.silence();
  songs.level = 1;
  seq.stop();
  songs.start(toLoopSong(jam.full ? jam.song : melodyBacking(jam.song)), jam.startStep);
  renderBandCard(`${jam.title} · ${jam.full ? 'Full song + live band' : 'Melody jam'}`, jam.full ? 'The whole MIDI plays. Choose a part on your phone and add it.' : 'The lead loops. Choose drums, bass, piano or guitar on your phone.', () => stopSong(), () => { void startJam(jam.song, !!jam.full).catch((e) => { $('gp-status').textContent = String(e); openGamePicker(); }); });
}

// ------------------------------------------------------------ rhythm game
let pickSong = SONGS[0].id;
let pickDiff: Difficulty = 'easy';
let gameKey = '';
let resultsShown = false;
let lastCount = -9;

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
  $('gp-preview').textContent = 'Preview selected';
}
/** Parts the player has muted from the song so people can play them live; reset when the song changes. */
let freeParts = new Set<Role>();
let freePartsFor = '';
function renderParts() {
  const song = allGameSongs().find((s) => s.id === pickSong);
  if (!song) { $('gp-parts').replaceChildren(); return; }
  if (freePartsFor !== song.id) { freePartsFor = song.id; freeParts = new Set(); }
  $('gp-parts').innerHTML = ROLES.filter((r) => r === 'drums' || song.tracks[r].length > 0).map((r) => {
    const has = song.tracks[r].length > 0;
    const free = freeParts.has(r);
    const label = !has ? 'add live' : free ? 'you play it' : 'song plays';
    return `<button class="part ${!has || free ? 'free' : ''}" data-role="${r}" ${has ? '' : 'disabled'} aria-pressed="${free}"><b>${INSTRUMENT[r].name}</b><small>${label}</small></button>`;
  }).join('');
  const charted = ROLES.filter((r) => song.tracks[r].length > 0);
  const guided = charted.filter((r) => !freeParts.has(r));
  const phones = humans().length;
  $('gp-capacity').innerHTML = charted.length
    ? `<b>${guided.length} ${guided.length === 1 ? 'phone follows' : 'phones follow'} the notes</b> (${guided.map((r) => INSTRUMENT[r].name).join(', ') || 'none'}). Anyone else plays percussion live. ${phones} ${phones === 1 ? 'phone' : 'phones'} connected${phones > guided.length ? `, so ${phones - guided.length} will play percussion or a muted part` : ''}.`
    : 'This file has no playable parts.';
  $('gp-parts').querySelectorAll<HTMLElement>('.part:not([disabled])').forEach((b) => (b.onclick = () => {
    const r = b.dataset.role as Role;
    if (freeParts.has(r)) freeParts.delete(r); else freeParts.add(r);
    renderParts();
  }));
}
function openGamePicker() {
  $('gp-info').textContent = 'Choose a tune, preview it, then play together. Audio comes from this Stage.';
  $('gp-songs').innerHTML = allGameSongs().map((s) => `<button class="song ${s.id === pickSong ? 'sel' : ''}" data-id="${esc(s.id)}"><b>${esc(s.title)}</b><small>${esc(s.artist)}</small>
    <small>${s.bpm} BPM · ${Math.round(songSeconds(s))} s · ${Object.values(s.tracks).filter((notes) => notes.length).length} playable parts: ${Object.entries(s.tracks).filter(([, notes]) => notes.length).map(([r]) => INSTRUMENT[r as Role].name).join(', ')}</small></button>`).join('');
  $('gp-songs').querySelectorAll<HTMLElement>('.song').forEach((b) => (b.onclick = () => { endPreview(); pickSong = b.dataset.id!; openGamePicker(); }));
  renderParts();
  const desc: Record<Difficulty, string> = { easy: '2 lanes · forgiving', medium: '3 lanes · more notes', hard: '4 lanes · strict' };
  $('gp-diffs').innerHTML = DIFFICULTIES.map((d) => `<button class="btn ${d === pickDiff ? 'on' : ''}" data-d="${d}"><b>${d.toUpperCase()}</b><small>${desc[d]} (±${DIFF[d].perfect} ms perfect)</small></button>`).join('');
  $('gp-diffs').querySelectorAll<HTMLElement>('button').forEach((b) => (b.onclick = () => { pickDiff = b.dataset.d as Difficulty; openGamePicker(); }));
  $('gamepick').hidden = false;
}
async function startGame(song: GameSong, difficulty: Difficulty, band?: { free: Role[] }) {
  songLoadVersion++;
  await enableAudio();
  for (let i = 0; i < 40 && (!net.connected || !clock.isLocked); i++) await sleep(100);
  if (!net.connected || !clock.isLocked) throw new Error('Waiting for connection. Try Start again.');
  endPreview(); songs.stop(); engine.silence();
  net.send({ t: 'game', action: 'start', songId: song.id, ...(song.id.startsWith('import:') ? { song } : {}), difficulty, ...(band ? { live: true, free: band.free } : {}) });
  $('gamepick').hidden = true; $('results').hidden = true;
}
$('gp-close').onclick = () => { endPreview(); $('gamepick').hidden = true; };
$('gp-start').onclick = async () => {
  const song = allGameSongs().find((s) => s.id === pickSong);
  if (!song) return;
  try { await startGame(song, pickDiff); } catch (e) { $('gp-status').textContent = String(e); }
};
$('gp-band').onclick = async () => {
  const song = allGameSongs().find((s) => s.id === pickSong);
  if (!song) return;
  try { await startGame(song, pickDiff, { free: [...freeParts] }); } catch (e) { $('gp-status').textContent = e instanceof Error ? e.message : String(e); }
};
$('gp-import').onclick = () => $<HTMLInputElement>('gp-file').click();
let pendingMidi: { buffer: ArrayBuffer; title: string; id: string } | null = null;
function importPendingMidi() {
  if (!pendingMidi) return;
  const selectedPart = $<HTMLSelectElement>('gp-part').value;
  const source = parseMidi(pendingMidi.buffer, pendingMidi.title, {
    melodyPart: selectedPart, onParts(parts) {
      const select = $<HTMLSelectElement>('gp-part');
      select.replaceChildren(...parts.map((part) => new Option(part.label, part.id)));
      if (parts.some((p) => p.id === selectedPart)) select.value = selectedPart;
      $('gp-part-label').hidden = parts.length < 2;
    }
  });
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
  gameKey = key; resultsShown = false; lastCount = -9;
  document.body.classList.toggle('ingame', !!g);
  requestAnimationFrame(() => viz.resize());
  if (g) {
    songs.stop(); hideCard(); $('songs').hidden = true; $('results').hidden = true;
    seq.stop();
    sampler.stop(engine); $('sampleui').hidden = true; document.body.classList.remove('insample');
    const song = g.song ?? getSong(g.songId);
    $('gh-title').textContent = song ? `${song.title} · ${g.difficulty.toUpperCase()}` : '';
    $('gamehud').hidden = false;
    if (g.live && song) {
      const free = freeRoles(g, song).map((r) => INSTRUMENT[r].name);
      renderBandCard(`${song.title} · with the band`, `Open to play live: ${free.length ? free.join(', ') : 'nothing muted'}. Percussion can always be added.`, () => net.send({ t: 'game', action: 'stop' }));
    }
  } else {
    $('gamehud').hidden = true;
    if (gameKey === '' && songs.song === null && ts?.nowPlaying == null) { seq.stop(); hideCard(); }
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
  const total = sum((p) => p.game!.total);
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
    <div class="rows">${rows.map((p) => `<div class="pl" style="--c:${p.color}"><div class="n">${ROLE_INFO[p.role].icon} ${esc(p.name)}<small>${INSTRUMENT[p.role].name} · ${p.game!.perfect} perfect · ${p.game!.good} good · ${p.game!.miss} missed</small></div><div class="e">${p.game!.score.toLocaleString()} <small>${accuracy(done(p.game!)).toFixed(0)}%</small></div></div>`).join('') || '<div class="empty">No scores were recorded.</div>'}</div>
    ${solo && t.rows.length ? '<p class="hintp">Your timing shaped the sound: misses weakened your part, and hits restored it.</p>' : ''}
    <div class="row"><button class="btn drop" id="r-again">↻ PLAY AGAIN</button><button class="btn" id="r-pick">PICK ANOTHER</button><button class="btn" id="r-free">■ FREE PLAY</button></div></div>`;
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
  $('gh-note').textContent = 'Keep the rhythm: misses weaken and detune your part · hits restore it';
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
  x.fillStyle = 'rgba(43,37,64,.4)';
  a.peaks.forEach((p, i) => x.fillRect((i / a.peaks.length) * w, mid - p * mid * 0.95, Math.max(1, w / a.peaks.length), p * h * 0.95));
  // the 16 slices on the beat grid, then the beat lines
  const dur = sampler.duration, sl = sampler.sliceSec;
  for (let i = 0; i < sampler.usable; i++) {
    x.fillStyle = i % 2 ? 'rgba(189,242,213,.6)' : 'rgba(201,228,255,.6)';
    x.fillRect(((sampler.offset + i * sl) / dur) * w, 0, (sl / dur) * w, h);
  }
  for (let t = sampler.offset, k = 0; t < dur; t += sampler.beatSec, k++) {
    x.strokeStyle = k % 4 === 0 ? 'rgba(43,37,64,.75)' : 'rgba(43,37,64,.25)';
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
$('sample').onclick = () => { $('sampleui').hidden = false; document.body.classList.add('insample'); refreshSampleUI(); };
$('sp-close').onclick = closeSampleUI;
$('sp-close-x').onclick = closeSampleUI;
$('sp-cancel').onclick = closeSampleUI;
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
  flashBig('TAP THE PADS', 1500);
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
  flashBig('BACKING LOOP', 1200);
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
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (location.protocol === 'http:') {
    try {
      const info = await (await fetch('/api/info', { cache: 'no-store' })).json();
      publicJoinUrl = info.publicUrl ?? '';
      url = publicJoinUrl || (localHost ? info.lanUrls?.[0] ?? location.origin : location.origin);
    } catch { /* keep origin */ }
  }
  const target = new URL(url);
  target.searchParams.set('room', roomCode);
  const withRoom = target.toString();
  if (withRoom !== joinUrl) {
    joinUrl = withRoom;
    $('roomcode').textContent = roomCode;
    await QRCode.toCanvas($<HTMLCanvasElement>('qr'), withRoom, { width: 560, margin: 0, errorCorrectionLevel: 'M', color: { dark: '#2b2540', light: '#ffffff' } });
    $('url').textContent = url.replace(/^https?:\/\//, '');
    $('warn').textContent = url.startsWith('https') ? '' : 'HTTP only: phones can’t use shake/tilt. Run `npm run demo` for HTTPS.';
  }
}
refreshJoinUrl(); checkJoinReachability();
setInterval(refreshJoinUrl, 4000);
setInterval(checkJoinReachability, 5000);

// -------------------------------------------------------------------- frame
const bigEl = $('big');
let lastImpact = -1, bigTimer = 0;
const flashBig = (text: string, ms: number) => { bigEl.textContent = text; bigEl.classList.add('show'); clearTimeout(bigTimer); bigTimer = window.setTimeout(() => bigEl.classList.remove('show'), ms); };

function frame(t: number) {
  requestAnimationFrame(frame);
  if (!ts || !clock.isLocked) return;
  const b = beats.frame(clock, ts, t);
  const syncProof = $('sync-proof');
  if (ts.syncTest) {
    syncProof.style.opacity = String(Math.max(0, 1 - b.since / 160));
    $('sync-beat-number').textContent = String(b.beat + 1);
    flashEl.style.opacity = '0';
  } else {
    syncProof.style.opacity = '0';
    flashEl.style.opacity = String((b.downbeat ? 0.5 : 0.2) * flashEnv(b.since));
  }
  const pos = stepPos(ts, b.serverMs), step = Math.floor(pos);

  // drop choreography for the room
  const phase = dropPhase(ts, step);
  if (ts.drop && phase === 'build' && step === ts.drop.startStep && bigEl.textContent !== 'BUILD…') flashBig('BUILD…', 900);
  if (ts.drop && step >= ts.drop.dropStep && lastImpact !== ts.drop.dropStep) { lastImpact = ts.drop.dropStep; viz.impact(); flashBig('DROP', 700); }

  gameTick(b.serverMs);
  viz.draw(b.serverMs, ts, laneList(), { beatPulse: flashEnv(b.since), downbeat: b.downbeat });

  if (b.newBeat) {
    updateDemoUI();
    const c = chordAt(ts, step), nx = chordAt(ts, step - (step % 16) + 16);
    $('chord').textContent = c.name;
    $('next').textContent = `next ${nx.name}`;
    $('bar').textContent = `${b.bar + 1} · ${b.beatInBar + 1}`;
    const n = humans().length, m = $('mode');
    const recTag = ts.recording ? ` · REC ${ts.recording.events}` : '';
    if (sessionPlayer.isPlaying) {
      m.textContent = `REPLAYING SESSION${recTag}`;
      m.className = 'mode auto';
    } else if (songs.song) {
      m.textContent = `${ts.nowPlaying?.mode === 'jam' ? 'MELODY JAM' : 'TRACK'}: ${songs.song.title.toUpperCase()}${recTag}`;
      m.className = 'mode auto';
    } else if (ts.game) {
      m.textContent = `GAME: ${$('gh-title').textContent || 'RHYTHM'}${recTag}`;
      m.className = 'mode auto';
    } else if (n === 0) {
      m.textContent = `STANDBY · READY FOR TRACK${recTag}`;
      m.className = 'mode';
    } else if (n === 1 && ts.autoBand) {
      m.textContent = `SOLO · AUTO BAND BACKING${recTag}`;
      m.className = 'mode auto';
    } else {
      m.textContent = `${n} ${n === 1 ? 'PLAYER' : 'PLAYERS'}${autoRoles().length ? ' + AUTO' : ''}${recTag}`;
      m.className = 'mode';
    }
    if (rec.seconds > 0) $('rec').textContent = `SAVE LAST ${Math.floor(rec.seconds)} s`;
  }
}
requestAnimationFrame(frame);

let syncLogAt = 0;
setInterval(() => {
  if (!ts?.syncTest) return;
  const readings = roster.filter((p) => p.connected && p.sync).map((p) => ({ phone: p.name, role: ROLE_INFO[p.role].label, p90SyncErrorMs: syncHeadline(p.sync).err, jitterMs: p.sync!.jitter, rttMs: p.sync!.rttMin }));
  console.info('[sync-test] per-phone p90 sync error (ms)', readings);
}, 3000);

(window as any).ho = { engine, clock, rec, gameConductor }; // console debugging
net.connect();
