/**
 * Player (phone) client.
 *
 *  - joins, gets a colour + role
 *  - flashes on every beat from the synced clock (no network message involved)
 *  - XY pad / shake / tilt -> note events addressed to the NEXT 16th-note step in server time
 *  - optional "phone speaker" mode: plays its own part locally, at the same step times as the Stage
 */
import { Net } from '../common/net';
import { ClockSync } from '../common/clock';
import { BeatTracker, flashEnv } from '../common/beat';
import { Engine } from '../common/engine';
import { stableId, fmt, clamp, esc } from '../common/util';
import { normalizeRoomCode, roomFromUrl } from '../common/room';
import {
  ROLES, ROLE_INFO, liveNotesAllowed, nextStepAfter, stepPos, stepTime,
  type NoteEvent, type PlayerInfo, type RawKind, type Role, type TransportState,
} from '../../shared/protocol';
import { LIBRARY } from '../songs/library';
import { GameUI } from './game';
import { OnboardingView, type GravitateProfile } from './onboarding/OnboardingView';
import { BumpDetector } from './bump/bumpDetector';
import { COLS, HOLD_REPEAT, NOTE_DUR, chordAt, grooveVoice, padLabels, SCALE_LABEL, NOTE_NAMES } from '../../shared/music';

const net = new Net();
const id = stableId();
const clock = new ClockSync((m) => net.send(m));
const beats = new BeatTracker();
const engine = new Engine(clock, false);
// Rhythm game overlay (mounts itself when the server starts a game; free play is untouched otherwise)
const game = new GameUI(document.getElementById('app')!, { clock, net, getTs: () => ts, getMe: () => me });
(window as any).hoGame = game; // test/debug hook
const syncGame = () => { if (joined) game.sync(ts, me); };

let ts: TransportState | null = null;
let me: PlayerInfo | null = null;
let joined = false;
let speakerOn = false;
/** Beat-flash intensity: soft (default, colour only), full (white downbeats), off. Remembered per phone. */
type FlashMode = 'soft' | 'full' | 'off';
let flashMode: FlashMode = 'soft';
try {
  const q = new URLSearchParams(location.search).get('flash');
  const saved = q === '0' ? 'off' : localStorage.getItem('ho.flash');
  if (saved === 'soft' || saved === 'full' || saved === 'off') flashMode = saved;
} catch { /* storage blocked: keep default */ }
const FLASH_LABEL: Record<FlashMode, string> = { soft: 'Flash: soft', full: 'Flash: full', off: 'Flash: off' };
let motion: 'unknown' | 'granted' | 'denied' | 'none' = 'unknown';

const app = document.getElementById('app')!;
app.innerHTML = `<div id="flash"></div><div id="sync-proof" aria-hidden="true"><b id="sync-beat-number"></b><small>SYNC TEST · BEAT</small></div><div id="root"></div><div class="banner" id="banner" role="status" aria-live="polite" hidden>Reconnecting…</div><div class="pausedbar" id="pausedbar" role="status" aria-live="polite" hidden>PAUSED</div>`;
const root = document.getElementById('root')!;
const flashEl = document.getElementById('flash')!;
const banner = document.getElementById('banner')!;

// --------------------------------------------------------------------- room
// The code comes from the QR link (?room=ABCD) or was typed on this phone before. Without one we ask for it.
let roomCode = roomFromUrl();
if (!roomCode) { try { roomCode = normalizeRoomCode(localStorage.getItem('ho.room')); } catch { /* storage blocked */ } }
const rememberRoom = (code: string) => { try { localStorage.setItem('ho.room', code); } catch { /* ignore */ } };
const forgetRoom = () => { try { localStorage.removeItem('ho.room'); } catch { /* ignore */ } };

function renderRoomScreen(error = '') {
  root.innerHTML = `<div class="screen join">
    <div class="swatch"></div><h1>Human Orchestra</h1>
    <p>Enter the room code shown on the Stage screen</p>
    <input id="room" name="roomCode" aria-label="Room code" maxlength="8" value="" placeholder="ABCD" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" inputmode="text" />
    <div class="hint" id="room-err" role="alert">${esc(error)}</div>
    <button class="big" id="room-go">JOIN ROOM</button></div>`;
  const input = document.getElementById('room') as HTMLInputElement;
  const go = () => {
    const code = normalizeRoomCode(input.value);
    if (!code) { document.getElementById('room-err')!.textContent = 'Codes are 3-8 letters or digits.'; return; }
    rememberRoom(code);
    location.href = `${location.pathname}?room=${code}`; // a socket belongs to one room: start clean
  };
  document.getElementById('room-go')!.onclick = go;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  input.focus();
}
net.on('error', (m) => {
  if (m.code === 'noroom' || m.code === 'badroom' || m.code === 'busy') { forgetRoom(); joined = false; renderRoomScreen(m.message); }
});

let userProfile: GravitateProfile | null = OnboardingView.getStoredProfile();
const onboarding = new OnboardingView(root);
onboarding.onApproved((p) => {
  userProfile = p;
  if (me) {
    me.name = p.name;
    net.send({ t: 'join', name: me.name });
  }
  render();
});

// Intercept on boot if no approved profile exists in localStorage
if (!userProfile?.approved) {
  onboarding.mount();
}

// ------------------------------------------------------------------ Web Bump Engine
let bumpActive = false;
let bumpOverlayEl: HTMLElement | null = null;
const bumpDetector = new BumpDetector({
  threshold: 25, // ~2.5G
  debounceMs: 1500,
});

function getActiveProfile(): GravitateProfile | null {
  return userProfile ?? OnboardingView.getStoredProfile();
}

async function toggleBumpMode() {
  const btn = document.getElementById('bumpbtn');
  if (bumpActive) {
    bumpActive = false;
    bumpDetector.stop();
    btn?.classList.remove('active');
    closeBumpOverlay();
    return;
  }

  // Request motion permission (iOS Safari requirement)
  const granted = await bumpDetector.requestPermission();
  if (!granted && (window as any).DeviceMotionEvent) {
    console.warn('[Bump] Motion permission denied or unavailable');
  }

  bumpActive = true;
  btn?.classList.add('active');
  showBumpOverlay('ready');

  bumpDetector.start((magnitude, timestamp) => {
    if (!bumpActive) return;
    const profile = getActiveProfile();
    console.log('[Bump] Spiking to server! Magnitude:', magnitude);
    net.send({ t: 'bump_spike', timestamp, profile });
    showBumpOverlay('detecting');
  });
}

function showBumpOverlay(state: 'ready' | 'detecting') {
  closeBumpOverlay();
  bumpOverlayEl = document.createElement('div');
  bumpOverlayEl.className = 'bump-overlay';

  if (state === 'ready') {
    bumpOverlayEl.innerHTML = `
      <div class="bump-modal">
        <div class="bump-status-tag">WEB BUMP MODE ACTIVE</div>
        <div class="bump-icon-pulse">📱💥📱</div>
        <h2 class="pixel-title" style="font-size: 15px;">READY TO BUMP</h2>
        <p class="hint-text">Gently tap or bump your phone with another player nearby on the same Wi-Fi!</p>
        <div class="action-grid" style="margin-top: 8px;">
          <button id="btn-cancel-bump" class="pixel-btn btn-butter">CANCEL</button>
          <button id="btn-sim-bump" class="pixel-btn btn-sky" style="font-size: 9px;">(TEST SPIKE)</button>
        </div>
      </div>
    `;
    bumpOverlayEl.querySelector('#btn-cancel-bump')?.addEventListener('click', () => {
      toggleBumpMode();
    });
    bumpOverlayEl.querySelector('#btn-sim-bump')?.addEventListener('click', () => {
      bumpDetector.simulateSpike();
    });
  } else {
    bumpOverlayEl.innerHTML = `
      <div class="bump-modal">
        <div class="bump-status-tag" style="background: var(--pink);">IMPACT REGISTERED</div>
        <div class="bump-icon-pulse">⚡</div>
        <h2 class="pixel-title" style="font-size: 15px;">DETECTING IMPACT...</h2>
        <div class="retro-progress"><div class="retro-progress-bar"></div></div>
        <p class="hint-text">Matching spatial spike with nearby device…</p>
        <div class="action-grid" style="margin-top: 8px;">
          <button id="btn-cancel-bump" class="pixel-btn btn-butter">CANCEL</button>
        </div>
      </div>
    `;
    bumpOverlayEl.querySelector('#btn-cancel-bump')?.addEventListener('click', () => {
      toggleBumpMode();
    });
  }

  app.appendChild(bumpOverlayEl);
}

function showBumpMatchedModal(roomId: string, peer: any) {
  closeBumpOverlay();
  bumpActive = false;
  bumpDetector.stop();
  document.getElementById('bumpbtn')?.classList.remove('active');

  const peerName = esc(peer?.name || 'Anonymous Player');
  const peerTagline = esc(peer?.tagline || 'Ready to jam in the Human Orchestra');
  const peerVibe = esc(peer?.vibe || 'Retro Jammer');

  bumpOverlayEl = document.createElement('div');
  bumpOverlayEl.className = 'bump-overlay';
  bumpOverlayEl.innerHTML = `
    <div class="bump-modal">
      <div class="bump-status-tag" style="background: var(--mint);">BUMP DETECTED!</div>
      <div class="bump-icon-pulse">🤝</div>
      <h2 class="pixel-title" style="font-size: 15px;">CONNECTION FOUND!</h2>
      <p class="hint-text">Confirm connection with:</p>

      <div class="persona-card" style="text-align: left;">
        <div class="card-header">
          <b style="font-family: var(--display); font-size: 13px;">${peerName}</b>
          <span class="role-pill">${peerVibe}</span>
        </div>
        <p style="font-size: 11px; margin: 4px 0 0; color: var(--dim);">"${peerTagline}"</p>
      </div>

      <div class="action-grid" style="margin-top: 10px;">
        <button id="btn-bump-cancel" class="pixel-btn btn-butter">CANCEL</button>
        <button id="btn-bump-confirm" class="pixel-btn btn-mint approve-btn">★ CONFIRM</button>
      </div>
    </div>
  `;

  bumpOverlayEl.querySelector('#btn-bump-cancel')?.addEventListener('click', () => {
    closeBumpOverlay();
  });

  bumpOverlayEl.querySelector('#btn-bump-confirm')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = '⏳ WAITING FOR PARTNER...';
    btn.classList.remove('btn-mint');
    btn.classList.add('btn-butter');
    const profile = getActiveProfile();
    console.log(`[Bump] Emitting bump_confirm for room ${roomId}...`);
    net.send({ t: 'bump_confirm', roomId, profile });
  });

  app.appendChild(bumpOverlayEl);
}

function showVibeMatchReveal(roomId: string, match: any) {
  closeBumpOverlay();

  const sharedVibe = esc(match?.sharedVibe || 'Cosmic Harmony');
  const overlap = esc(match?.overlap || 'You both share an incredible passion for music and retro games.');
  const icebreaker = esc(match?.icebreaker || 'What song got you into rhythm games?');
  const songId = esc(match?.song_id || 'neon');
  const songTitle = esc(match?.song_title || match?.song_id?.toUpperCase() || 'Neon Run');
  const score = Number(match?.compatibilityScore) || 90;

  bumpOverlayEl = document.createElement('div');
  bumpOverlayEl.className = 'bump-overlay';
  bumpOverlayEl.innerHTML = `
    <div class="bump-modal" style="max-width: 440px;">
      <div class="bump-status-tag" style="background: var(--pink);">★ VIBE MATCH ★ ${score}%</div>
      <div class="bump-icon-pulse">✨</div>
      <h2 class="pixel-title vibe-match-header">${sharedVibe}</h2>

      <p class="vibe-match-overlap">${overlap}</p>

      <div class="form-group" style="text-align: left;">
        <label class="form-label">ICEBREAKER PROMPT</label>
        <div class="icebreaker-bubble vibe-icebreaker">💬 "${icebreaker}"</div>
      </div>

      <div class="recommended-track-card">
        <div class="track-badge">RECOMMENDED TRACK</div>
        <div class="track-title">${songTitle}</div>
        <div class="track-id">[ID: ${songId}] · SYNCED MIDI</div>
      </div>

      <div class="action-grid" style="margin-top: 10px;">
        <button id="btn-enter-stage" class="pixel-btn btn-mint approve-btn" style="font-size: 11px;">
          ▶ ENTER STAGE TOGETHER
        </button>
      </div>
    </div>
  `;

  bumpOverlayEl.querySelector('#btn-enter-stage')?.addEventListener('click', () => {
    const rawSongId = String(match?.song_id || 'neon');
    console.log(`[Gravitate] Entering stage together with track ${rawSongId} in room ${roomId}`);
    showBumpToast(`Entering stage: ${songTitle}!`);

    // Ensure player is joined into the band and audio is unlocked
    if (!joined) {
      engine.start().catch(() => {});
      (navigator as any).audioSession && ((navigator as any).audioSession.type = 'playback');
      requestMotion();
      joined = true;
      const profile = getActiveProfile();
      const name = profile?.name || me?.name || 'Player';
      net.send({ t: 'join', name });
      if (me) me.name = name.trim().slice(0, 14) || me.name;
    }

    // Emit bump_start_jam to the server
    net.send({ t: 'bump_start_jam', roomId, song_id: rawSongId });

    // Hide bump overlay and reveal the main player UI
    closeBumpOverlay();
    buildJam();
    syncGame();
  });

  app.appendChild(bumpOverlayEl);
}

function closeBumpOverlay() {
  if (bumpOverlayEl) {
    bumpOverlayEl.remove();
    bumpOverlayEl = null;
  }
}

function showBumpToast(message: string) {
  const toast = document.createElement('div');
  toast.className = 'bump-toast';
  toast.textContent = `★ ${message}`;
  app.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ------------------------------------------------------------------ network
net.onOpen(() => {
  banner.hidden = true;
  net.send({ t: 'hello', kind: 'player', id, room: roomCode });
  // After any drop the old offset may be stale (frozen tab, new Wi-Fi route): relock from scratch.
  clock.start(true);
  if (joined && me) net.send({ t: 'join', name: me.name });
  if (joined) net.send({ t: 'speaker', on: speakerOn });
});
net.onClose(() => { banner.hidden = false; });
net.on('pong', (m) => {
  clock.onPong(m);
  if (clock.isLocked && ts?.game && joined) syncGame();
});
net.on('welcome', (m) => {
  ts = m.state; engine.setTransport(m.state);
  if (m.you) { me = m.you; if (!joined) render(); }
  syncGame();
});
net.on('state', (m) => {
  const was = ts?.speakerMode;
  ts = m.state; engine.setTransport(m.state);
  if (joined && m.state.speakerMode !== was && was !== undefined) setSpeaker(m.state.speakerMode && engine.ready);
  document.getElementById('pausedbar')!.hidden = m.state.paused == null;
  // If game is started by server (e.g. from partner clicking Enter Stage Together), auto-transition
  if (ts.game && bumpOverlayEl) {
    closeBumpOverlay();
    if (!joined) {
      engine.start().catch(() => {});
      (navigator as any).audioSession && ((navigator as any).audioSession.type = 'playback');
      joined = true;
      const profile = getActiveProfile();
      const name = profile?.name || me?.name || 'Player';
      net.send({ t: 'join', name });
      if (me) me.name = name.trim().slice(0, 14) || me.name;
      buildJam();
    }
  }
  syncGame();
  refreshPadLabels();
});
net.on('you', (m) => {
  const roleChanged = me?.role !== m.you.role;
  me = m.you;
  document.documentElement.style.setProperty('--c', me.color);
  if (joined) { if (roleChanged) buildJam(); }
  else render();
  syncGame();
});
net.on('bump_matched', (m) => {
  console.log('[Bump] bump_matched received from server! Room:', m.roomId, 'Peer:', m.peer);
  showBumpMatchedModal(m.roomId, m.peer);
});
net.on('bump_reveal', (m) => {
  console.log('[Bump] bump_reveal received from server! Room:', m.roomId, 'Match:', m.match);
  showVibeMatchReveal(m.roomId, m.match);
});

// ------------------------------------------------------------------- screens
function render() {
  if (!userProfile?.approved) {
    onboarding.mount();
    return;
  }
  if (!me) return;
  document.documentElement.style.setProperty('--c', me.color);
  if (joined) return buildJam();

  if (userProfile.name && me.name.startsWith('P')) {
    me.name = userProfile.name;
  }

  root.innerHTML = `<div class="screen join">
    <div class="swatch"></div><h1>Human Orchestra</h1>
    <div class="pixel-badge" style="margin: 0 auto 6px; font-size: 9px;">${esc(userProfile.vibe)}</div>
    <p>You're <b class="you-c" style="background:${me.color}">this colour</b>. Pick a name.</p>
    <input id="name" name="displayName" aria-label="Display name" maxlength="14" value="${esc(me.name)}" autocomplete="off" autocapitalize="words" spellcheck="false" />
    <button class="big" id="go">JOIN THE BAND</button>
    <button class="pixel-btn btn-butter" id="btn-edit-persona" style="margin: 6px auto 0; font-size: 9px; padding: 6px 12px; width: fit-content;">EDIT 8-BIT PERSONA</button>
    <div class="hint">Your phone controls the music. Listen to the Stage.</div>
    <div class="hint">Room <b>${esc(roomCode)}</b> · <a href="${location.pathname}" id="change-room">change</a></div>
    <a href="/" class="stage-link">STAGE SCREEN (HOST / LAPTOP)</a></div>`;
  document.getElementById('change-room')!.onclick = (e) => { e.preventDefault(); forgetRoom(); renderRoomScreen(); };
  document.getElementById('go')!.onclick = onJoin;
  document.getElementById('btn-edit-persona')!.onclick = () => {
    OnboardingView.clearProfile();
    userProfile = null;
    onboarding.mount();
  };
}

async function onJoin() {
  // Everything that needs a user gesture happens right here, in the tap handler:
  engine.start().catch(() => { }); // unlock WebAudio
  (navigator as any).audioSession && ((navigator as any).audioSession.type = 'playback'); // iOS: play through the silent switch
  requestMotion(); // iOS shows its motion permission prompt only from a gesture
  joined = true;
  const name = (document.getElementById('name') as HTMLInputElement).value;
  net.send({ t: 'join', name });
  if (me) me.name = name.trim().slice(0, 14) || me.name;
  buildJam();
  syncGame();
}

// ---------------------------------------------------------------------- jam UI
let padCanvas: HTMLCanvasElement, padCtx: CanvasRenderingContext2D, padEl: HTMLElement;
let beatDots: HTMLElement[] = [];
let chordEl: HTMLElement, nameEl: HTMLElement;
let dbgEl: HTMLElement | null = null;

function buildJam() {
  if (!me) return;
  const role = me.role;
  root.innerHTML = `<div class="screen">
    <div class="top">
      <button class="chip" id="rolebtn">${ROLE_INFO[role].icon} ${ROLE_INFO[role].label} ▾</button>
      <div class="name" id="nm"></div>
      <div class="beats"><i></i><i></i><i></i><i></i></div>
      <button class="icon btn-bump ${bumpActive ? 'active' : ''}" id="bumpbtn" aria-label="Bump and Jam">BUMP</button>
      <button class="icon" id="songbtn" aria-label="Songs">SONG</button>
      <button class="icon" id="dbgbtn" aria-label="Sync details">SYNC</button>
    </div>
    <div class="chord" id="chord"></div>
    <div id="pad"><canvas></canvas><div class="ylabel">${role === 'drums' ? 'HARDER ↑' : 'BRIGHTER ↑'}</div><div class="padlabel"></div></div>
    <div class="bottom">
      <button class="tog" id="shk"><span>${motion === 'granted' || motion === 'none' ? 'Shake on' : 'Enable shake'}</span></button>
      <button class="tog ${speakerOn ? 'on' : ''}" id="spk">Speaker</button>
      <button class="tog" id="fls">${FLASH_LABEL[flashMode]}</button>
    </div></div>`;
  padEl = document.getElementById('pad')!;
  padCanvas = padEl.querySelector('canvas')!;
  padCtx = padCanvas.getContext('2d')!;
  beatDots = [...root.querySelectorAll<HTMLElement>('.beats i')];
  chordEl = document.getElementById('chord')!;
  nameEl = document.getElementById('nm')!;
  document.getElementById('bumpbtn')!.onclick = toggleBumpMode;
  document.getElementById('rolebtn')!.onclick = openRoleSheet;
  document.getElementById('dbgbtn')!.onclick = openDebug;
  document.getElementById('songbtn')!.onclick = openSongs;
  document.getElementById('spk')!.onclick = () => { engine.start().then(() => setSpeaker(!speakerOn)); };
  document.getElementById('shk')!.onclick = () => requestMotion();
  document.getElementById('fls')!.onclick = (e) => {
    flashMode = flashMode === 'soft' ? 'full' : flashMode === 'full' ? 'off' : 'soft';
    try { localStorage.setItem('ho.flash', flashMode); } catch { /* ignore */ }
    (e.currentTarget as HTMLElement).textContent = FLASH_LABEL[flashMode];
  };
  bindPad();
  resizePad();
  refreshPadLabels();
}
addEventListener('resize', () => { if (padCanvas) resizePad(); });
function resizePad() {
  const r = padEl.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  padCanvas.width = r.width * dpr; padCanvas.height = r.height * dpr;
  padCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function refreshPadLabels() {
  const el = padEl?.querySelector('.padlabel');
  if (!el || !me || !ts) return;
  const yl = padEl.querySelector<HTMLElement>('.ylabel');
  if (yl) yl.style.display = sampleMode() ? 'none' : '';
  if (sampleMode()) { el.innerHTML = '<span>EACH PAD = A SLICE OF THE TRACK</span>'; return; }
  if (ts.nowPlaying && ts.nowPlaying.mode !== 'jam') { el.innerHTML = '<span>SONG PREVIEW · LISTEN ON STAGE</span>'; return; }
  if (ts.freestyle && me.role !== 'drums') { el.innerHTML = '<span>LOW ◂</span><span>FREESTYLE</span><span>▸ HIGH</span>'; return; }
  el.innerHTML = padLabels(me.role, ts).map((l) => `<span>${l}</span>`).join('');
}

function setSpeaker(on: boolean) {
  speakerOn = on && engine.ready;
  document.getElementById('spk')?.classList.toggle('on', speakerOn);
  net.send({ t: 'speaker', on: speakerOn });
}

function openRoleSheet() {
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `<div class="card"><h3>Choose your instrument</h3>${ROLES.filter((r) => !(ts?.nowPlaying?.mode === 'jam' && r === 'melody')).map((r) =>
    `<button class="rolebtn ${r === me?.role ? 'cur' : ''}" data-r="${r}">${ROLE_INFO[r].icon} ${ROLE_INFO[r].label}</button>`).join('')}</div>`;
  sheet.onclick = (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>('[data-r]')?.dataset.r as Role | undefined;
    if (r) net.send({ t: 'role', role: r });
    sheet.remove();
  };
  app.appendChild(sheet);
}

let reqMode: 'tap' | 'band' | 'jam' = 'tap';
async function openSongs() {
  let custom: { name: string; file: string }[] = [];
  try { custom = await (await fetch('/songs/index.json', { cache: 'no-store' })).json(); } catch { /* none */ }
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  const items = [
    ...LIBRARY.map((d) => ({ id: d.id, title: d.title, sub: d.melody ? 'melody' : 'backing track' })),
    ...custom.map((c) => ({ id: `file:${c.file}`, title: c.name, sub: 'your file' })),
  ];
  sheet.innerHTML = `<div class="card"><h3>Pick a song</h3>
    <div class="song-modes"><button class="rolebtn ${reqMode === 'tap' ? 'on' : ''}" data-m="tap">Play along</button><button class="rolebtn ${reqMode === 'band' ? 'on' : ''}" data-m="band">Listen</button><button class="rolebtn ${reqMode === 'jam' ? 'on' : ''}" data-m="jam">Jam over melody</button></div>
    ${items.map((i) => `<button class="rolebtn" data-id="${esc(i.id)}" style="font-size:18px">${esc(i.title)}<small style="margin-left:auto;color:var(--dim);font-size:12px">${i.sub}</small></button>`).join('')}
    <button class="rolebtn" data-id="" style="font-size:18px">■ Stop song</button>
    <button class="rolebtn" data-x="1" style="font-size:18px">Close</button></div>`;
  sheet.onclick = (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return void (e.target === sheet && sheet.remove());
    if (t.dataset.m) {
      reqMode = t.dataset.m as 'tap' | 'band' | 'jam';
      sheet.querySelectorAll<HTMLElement>('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === reqMode));
      return;
    }
    if (t.dataset.id !== undefined) net.send({ t: 'songreq', id: t.dataset.id, mode: reqMode });
    sheet.remove();
  };
  app.appendChild(sheet);
}

function openDebug() {
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `<div class="card"><h3>Sync details</h3><pre class="dbg" id="dbg"></pre>
    <button class="rolebtn" id="resync">↻ Re-sync clock</button>
    <div style="display:flex;gap:10px"><button class="rolebtn" id="tm" style="flex:1">− 5 ms audio</button><button class="rolebtn" id="tp" style="flex:1">+ 5 ms audio</button></div>
    <button class="rolebtn" id="close">Close</button></div>`;
  dbgEl = sheet.querySelector('#dbg');
  sheet.querySelector<HTMLElement>('#resync')!.onclick = () => clock.start(true);
  sheet.querySelector<HTMLElement>('#tm')!.onclick = () => (engine.trimMs -= 5);
  sheet.querySelector<HTMLElement>('#tp')!.onclick = () => (engine.trimMs += 5);
  sheet.querySelector<HTMLElement>('#close')!.onclick = () => { sheet.remove(); dbgEl = null; };
  app.appendChild(sheet);
  updateDebug();
}
function updateDebug() {
  if (!dbgEl || !ts) return;
  const s = clock.stats(beats.flashLate);
  const raw = engine.ready ? engine.context : null;
  dbgEl.textContent = [
    `clock offset   ${fmt(s.offset, 2)} ms   (server − local)`,
    `jitter         ${fmt(s.jitter, 2)} ms   (MAD of kept samples)`,
    `RTT            ${fmt(s.rttMin)} ms best · ${fmt(s.rttLast)} ms last`,
    `samples        ${s.samples} (best 30% used, median)`,
    `sync error     ${fmt(s.err)} ms   p90 of held-out probes`,
    `  + flash      ${fmt(s.flashLate)} ms   frame quantisation`,
    `  path bound   ±${fmt(s.rttMin / 2)} ms   (RTT/2, worst case)`,
    `step / bpm     ${Math.floor(stepPos(ts, clock.serverNow()))} / ${ts.bpm}`,
    `audio          ${raw ? `${raw.state} base ${fmt((raw.baseLatency ?? 0) * 1000)} out ${fmt((raw.outputLatency ?? 0) * 1000)} ms` : 'off'}`,
    `audio trim     ${engine.trimMs} ms   late notes ${engine.lateCount}`,
    `motion         ${motion}`,
    `socket         ${net.connected ? 'connected' : 'DOWN'}`,
  ].join('\n');
}

// ------------------------------------------------------------------ note emit
/** Lead time: a note travels phone -> server -> listener, i.e. about one full RTT, so lead scales with it. */
function leadMs() {
  const s = clock.stats();
  return clamp(40 + s.rttMin * 1.1 + s.jitter * 3, 60, 260);
}
let lastStep = -1;
const fires: { at: number; col: number; v: number }[] = []; // visual "your note sounds now" events

/** Sampler mode: the pad is a 4x4 grid of slices of the file loaded on the Stage (index = row*4 + col, reading order). */
const sampleMode = () => !!ts && ts.sample?.mode === 'chop' && !ts.game && !ts.freestyle;
const sampleCell = (x: number, y: number) => Math.min(3, Math.floor((1 - y) * 4)) * 4 + Math.min(3, Math.floor(x * 4));

function emit(col: number, vel: number, opts: { role?: Role; dur?: number } = {}) {
  if (!ts || !me || !clock.isLocked || !liveNotesAllowed(ts)) return;
  // Beat-quantisation: the earliest 16th boundary far enough in the future, and never the same step twice.
  let step = nextStepAfter(ts, clock.serverNow(), leadMs());
  if (step <= lastStep) step = lastStep + 1;
  lastStep = step;
  const role = opts.role ?? me.role;
  const dur = opts.dur ?? NOTE_DUR[role];
  const v = clamp(vel, 0.1, 1);
  net.send({ t: 'note', step, d: col, v, dur, role: opts.role });
  if (role === me.role) fires.push({ at: stepTime(ts, step), col, v });
  if (speakerOn && !ts.sample) {
    const ev: NoteEvent = { pid: me.id, role, step, d: col, v, dur };
    engine.play(ev);
  }
}

// ------------------------------------------------------------------- the pad
let touch: { x: number; y: number; col: number; vel: number } | null = null;
let lastCtl = 0;
const ripples: { x: number; y: number; t: number }[] = [];

function bindPad() {
  const colsOf = () => (ts?.freestyle && me!.role !== 'drums' ? 24 : COLS[me!.role]);
  const read = (e: PointerEvent) => {
    const r = padEl.getBoundingClientRect();
    const x = clamp((e.clientX - r.left) / r.width, 0, 0.9999);
    const y = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
    return { x, y, col: Math.floor(x * colsOf()), r };
  };
  padEl.onpointerdown = (e) => {
    padEl.setPointerCapture(e.pointerId);
    const p = read(e);
    touch = { x: p.x, y: p.y, col: p.col, vel: 0.3 + 0.7 * p.y };
    if (ts?.freestyle) { rawSend('d', p.x, p.y); ripples.push({ x: p.x, y: p.y, t: performance.now() }); return; }
    if (sampleMode()) { // slice pad: position picks the slice, no velocity from height
      touch.col = sampleCell(p.x, p.y); touch.vel = 0.85;
      emit(touch.col, touch.vel); ripples.push({ x: p.x, y: p.y, t: performance.now() });
      return;
    }
    emit(p.col, touch.vel);
    ripples.push({ x: p.x, y: p.y, t: performance.now() });
    sendCtl(true);
  };
  padEl.onpointermove = (e) => {
    if (!touch) return;
    const p = read(e);
    touch.x = p.x; touch.y = p.y; touch.vel = 0.3 + 0.7 * p.y;
    if (ts?.freestyle) {
      const now = performance.now();
      if (now - lastRawMove > 40) { lastRawMove = now; rawSend('m', p.x, p.y); }
      touch.col = p.col;
      return;
    }
    if (sampleMode()) {
      const c = sampleCell(p.x, p.y);
      if (c !== touch.col) { touch.col = c; emit(c, 0.85); ripples.push({ x: p.x, y: p.y, t: performance.now() }); }
      return;
    }
    if (p.col !== touch.col) { touch.col = p.col; emit(p.col, touch.vel); ripples.push({ x: p.x, y: p.y, t: performance.now() }); }
    sendCtl(false);
  };
  const up = () => { if (touch && ts?.freestyle) rawSend('u', touch.x, touch.y); touch = null; };
  padEl.onpointerup = up; padEl.onpointercancel = up;
}

let lastRawMove = 0;
/** Freestyle: stream the gesture as-is, stamped with server time. No quantising, no scale: the Stage records it. */
function rawSend(k: RawKind, x: number, y: number, v?: number) {
  if (!clock.isLocked) return;
  net.send({ t: 'raw', k, at: clock.serverNow(), x, y, v });
}

let tilt = 0;
function sendCtl(force: boolean) {
  const now = performance.now();
  if (!force && now - lastCtl < 70) return;
  lastCtl = now;
  net.send({ t: 'ctl', y: touch?.y ?? 0.5, tilt });
  if (ts?.freestyle) rawSend('t', tilt, touch?.y ?? 0.5);
}

/** Held finger => repeat the note on the role's own rhythm (8ths for melody, quarters for bass, once a bar for pads). */
function tickHold() {
  if (!touch || !ts || !me || ts.freestyle) return;
  const period = ts.sample?.mode === 'chop' ? 4 : HOLD_REPEAT[me.role]; // holding a slice pad re-triggers it every beat
  if (!period) return;
  const target = nextStepAfter(ts, clock.serverNow(), leadMs());
  if (target > lastStep && target % period === 0) emit(touch.col, touch.vel);
}

// --------------------------------------------------------------- motion sensors
async function requestMotion() {
  const DM = (window as any).DeviceMotionEvent, DO = (window as any).DeviceOrientationEvent;
  try {
    if (DM && typeof DM.requestPermission === 'function') {
      // iOS: call both inside the same gesture; one prompt covers "Motion & Orientation".
      const [a, b] = await Promise.all([DM.requestPermission(), DO?.requestPermission?.() ?? 'granted']);
      motion = a === 'granted' && b === 'granted' ? 'granted' : 'denied';
    } else motion = DM ? 'none' : 'denied'; // other browsers need no permission
  } catch { motion = 'denied'; }
  const shkSpan = document.querySelector('#shk span');
  if (shkSpan) shkSpan.textContent = motion === 'granted' || motion === 'none' ? 'Shake on' : 'Shake denied';
  if (motion === 'granted' || motion === 'none') listenMotion();
}

let motionBound = false;
function listenMotion() {
  if (motionBound) return;
  motionBound = true;
  let prev = 0, lastHit = 0;
  addEventListener('devicemotion', (e) => {
    const a = e.accelerationIncludingGravity;
    if (!a || !joined) return;
    const mag = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0);
    const jerk = Math.abs(mag - prev); // change in total acceleration: a shake spikes it, slow tilting does not
    prev = mag;
    const now = performance.now();
    if (jerk > 10 && now - lastHit > 130) { lastHit = now; shake(clamp(jerk / 30, 0.45, 1)); }
  });
  addEventListener('deviceorientation', (e) => {
    // gamma: left/right tilt, -90..90. +-45 deg is the comfortable one-handed range.
    tilt = clamp((e.gamma ?? 0) / 45, -1, 1);
    sendCtl(false);
  });
}

/** Shake = drum hit, picked by the groove so it always lands in the pattern. Non-drummers add hats/claps. */
function shake(vel: number) {
  if (!ts || !me || game.active) return;
  if (ts.freestyle) { rawSend('s', 0.5, 0.5, vel); navigator.vibrate?.(20); ripples.push({ x: Math.random(), y: 0.2 + Math.random() * 0.6, t: performance.now() }); return; }
  const step = Math.max(lastStep + 1, nextStepAfter(ts, clock.serverNow(), leadMs()));
  const isDrummer = me.role === 'drums';
  const d = isDrummer ? grooveVoice(step, true) : grooveVoice(step, false);
  emit(d, vel, { role: 'drums', dur: 1 });
  navigator.vibrate?.(20);
  ripples.push({ x: Math.random(), y: 0.2 + Math.random() * 0.6, t: performance.now() });
}
addEventListener('keydown', (e) => { if (e.code === 'Space' && joined) { e.preventDefault(); shake(0.8); } }); // desktop testing

// ---------------------------------------------------------------------- frame
function frame(t: number) {
  requestAnimationFrame(frame);
  if (!ts || !clock.isLocked) return;
  const b = beats.frame(clock, ts, t);
  syncGame();
  game.frame(t);

  // The synchronised flash. Pure function of the synced clock.
  const e = flashEnv(b.since);
  const syncProof = document.getElementById('sync-proof')!;
  if (ts.syncTest) {
    syncProof.style.opacity = String(Math.max(0, 1 - b.since / 160));
    document.getElementById('sync-beat-number')!.textContent = String(b.beat + 1);
    flashEl.style.opacity = '0';
  } else if (flashMode === 'off' || game.active) { syncProof.style.opacity = '0'; flashEl.style.opacity = '0'; }
  else if (flashMode === 'soft') { // gentle colour pulse, never white
    syncProof.style.opacity = '0';
    flashEl.style.background = me?.color ?? '#d9ccff';
    flashEl.style.opacity = String((b.downbeat ? 0.45 : 0.25) * e);
  } else {
    syncProof.style.opacity = '0';
    flashEl.style.background = b.downbeat ? '#2b2540' : (me?.color ?? '#d9ccff');
    flashEl.style.opacity = String(0.55 * e);
  }

  if (b.newBeat) {
    navigator.vibrate?.(b.downbeat ? 28 : 10);
    beatDots.forEach((d, i) => { d.classList.toggle('on', i === b.beatInBar); d.classList.toggle('d', i === b.beatInBar && b.downbeat); });
    if (chordEl && sampleMode()) chordEl.innerHTML = `<b>${ts.sample!.title.replace(/[<>&]/g, '')}</b> · tap pads: each plays a slice · hold to repeat`;
    else if (chordEl && ts.sample?.mode === 'backing') chordEl.innerHTML = `<b>${ts.sample.title.replace(/[<>&]/g, '')}</b> · backing loop · play along`;
    else if (chordEl && ts.nowPlaying?.mode === 'jam') chordEl.textContent = `JAM · ${ts.nowPlaying.title} · ${chordAt(ts, Math.floor(stepPos(ts, b.serverMs))).name} · add your ${ROLE_INFO[me!.role].label.toLowerCase()}`;
    else if (chordEl && ts.nowPlaying) chordEl.innerHTML = `<b>${ts.nowPlaying.title.replace(/[<>&]/g, '')}</b> · listen on Stage`;
    else if (chordEl && ts.freestyle) chordEl.innerHTML = '<b>FREESTYLE</b> · play anything, it becomes a song';
    else if (chordEl) {
      const step = Math.floor(stepPos(ts, b.serverMs));
      const c = chordAt(ts, step), n = chordAt(ts, step + 16 - (((step % 16) + 16) % 16));
      const st = clock.stats(beats.flashLate);
      chordEl.innerHTML = `${NOTE_NAMES[ts.root]} ${SCALE_LABEL[ts.scale]} · <b>${c.name}</b> → ${n.name} · sync ±${fmt(st.err + st.flashLate, 0)} ms`;
    }
    if (nameEl && me) nameEl.textContent = me.name;
  }
  tickHold();
  if (padCtx) drawPad(t, b.serverMs);
}
requestAnimationFrame(frame);

function drawSamplePad(w: number, h: number, serverMs: number) {
  if (!me) return;
  let fireCell = -1;
  while (fires.length && fires[0].at <= serverMs) { fireCell = fires.shift()!.col; }
  const gap = 6, cw = (w - gap * 5) / 4, ch = (h - gap * 5) / 4;
  for (let i = 0; i < 16; i++) {
    const x = gap + (i % 4) * (cw + gap), y = gap + Math.floor(i / 4) * (ch + gap);
    const on = touch?.col === i, fire = fireCell === i;
    padCtx.fillStyle = hexA(me.color, fire ? 0.95 : on ? 0.7 : 0.25 + 0.08 * ((i + Math.floor(i / 4)) % 2));
    padCtx.fillRect(x, y, cw, ch);
    padCtx.strokeStyle = '#2b2540'; padCtx.lineWidth = 2; padCtx.strokeRect(x + 1, y + 1, cw - 2, ch - 2);
    padCtx.fillStyle = 'rgba(43,37,64,.6)'; padCtx.font = '700 16px "Silkscreen", monospace'; padCtx.textAlign = 'center'; padCtx.textBaseline = 'middle';
    padCtx.fillText(String(i + 1), x + cw / 2, y + ch / 2);
  }
  padCtx.textAlign = 'left';
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i], age = (performance.now() - r.t) / 600;
    if (age > 1) { ripples.splice(i, 1); continue; }
    const s = 20 + age * 70;
    padCtx.strokeStyle = hexA(me.color, 1 - age); padCtx.lineWidth = Math.round(4 * (1 - age)) + 1;
    padCtx.strokeRect(Math.round(r.x * w - s), Math.round((1 - r.y) * h - s), Math.round(s * 2), Math.round(s * 2));
  }
}

let padW = 0, padH = 0;
function drawPad(t: number, serverMs: number) {
  if (!me || !ts) return;
  // The text line above the pad can wrap onto two lines, which changes the pad's height: keep the bitmap in step.
  if (padEl.clientWidth !== padW || padEl.clientHeight !== padH) { padW = padEl.clientWidth; padH = padEl.clientHeight; resizePad(); }
  if (sampleMode()) { padCtx.clearRect(0, 0, padEl.clientWidth, padEl.clientHeight); drawSamplePad(padEl.clientWidth, padEl.clientHeight, serverMs); return; }
  const w = padEl.clientWidth, h = padEl.clientHeight, cols = ts.freestyle && me.role !== 'drums' ? 24 : COLS[me.role];
  padCtx.clearRect(0, 0, w, h);
  const cw = w / cols;
  // column fires scheduled for "now"
  let fireCol = -1, fireV = 0;
  while (fires.length && fires[0].at <= serverMs) { const f = fires.shift()!; fireCol = f.col; fireV = f.v; ripples.push({ x: (f.col + 0.5) / cols, y: 0.05 + 0.5 * f.v, t: performance.now() }); }
  for (let i = 0; i < cols; i++) {
    padCtx.fillStyle = i % 2 ? 'rgba(43,37,64,.05)' : 'rgba(255,255,255,0)';
    padCtx.fillRect(i * cw, 0, cw, h);
  }
  padCtx.fillStyle = me.color;
  if (touch) {
    const g = padCtx.createLinearGradient(0, h, 0, h * (1 - touch.y));
    g.addColorStop(0, hexA(me.color, 0.1)); g.addColorStop(1, hexA(me.color, 0.55));
    padCtx.fillStyle = g;
    padCtx.fillRect(touch.col * cw, h * (1 - touch.y), cw, h * touch.y);
  }
  if (fireCol >= 0) { padCtx.fillStyle = hexA(me.color, 0.35 + 0.4 * fireV); padCtx.fillRect(fireCol * cw, 0, cw, h); }
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i], age = (performance.now() - r.t) / 600;
    if (age > 1) { ripples.splice(i, 1); continue; }
    const s = 20 + age * 90;
    padCtx.strokeStyle = hexA(me.color, 1 - age); padCtx.lineWidth = Math.round(4 * (1 - age)) + 1;
    padCtx.strokeRect(Math.round(r.x * w - s), Math.round((1 - r.y) * h - s), Math.round(s * 2), Math.round(s * 2));
  }
  if (touch) {
    // square pixel cursor under the finger
    const cx = Math.round(touch.x * w), cy = Math.round((1 - touch.y) * h);
    padCtx.fillStyle = hexA(me.color, 0.9); padCtx.fillRect(cx - 22, cy - 22, 44, 44);
    padCtx.strokeStyle = '#2b2540'; padCtx.lineWidth = 3; padCtx.strokeRect(cx - 20.5, cy - 20.5, 41, 41);
  }
  void t;
}
const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

// ------------------------------------------------------------------ housekeeping
setInterval(() => {
  net.send({ t: 'stats', stats: clock.stats(beats.flashLate) });
  if (ts?.syncTest) {
    const s = clock.stats(beats.flashLate);
    console.info('[sync-test] p90 sync error (ms)', { phone: me?.name ?? id, err: s.err, jitter: s.jitter, rtt: s.rttMin });
  }
  updateDebug();
}, 1000);
setInterval(updateDebug, 250);

if (roomCode) { rememberRoom(roomCode); net.connect(); } else renderRoomScreen();
