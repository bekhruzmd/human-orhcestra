/**
 * Human Orchestra server.
 *
 *  - serves the built Vite clients (dist/) over plain HTTP (cloudflared adds TLS)
 *  - owns the ONE global transport (BPM / epoch / key / scale / drop)
 *  - answers clock-sync pings with a server timestamp
 *  - relays note events between players and the Stage, applying guardrails
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { WebSocketServer, WebSocket } from 'ws';
import { getSong } from '../shared/songs.js';
import { buildChart, freeRoles, DIFFICULTIES, songSteps, validateGameSong, type GameStats } from '../shared/game.js';
import { jamHarmony } from '../shared/jam.js';
import { resolveEvent } from '../shared/music.js';
import {
  BPM_MAX, BPM_MIN, COLORS, DROP_BUILD_STEPS, ROLES, STEPS_PER_BAR,
  type ClientMsg, type PlayerInfo, type Role, type ScaleName, type ServerMsg, type TransportState,
  stepPos, stepMs, liveNotesAllowed,
} from '../shared/protocol.js';

const PORT = Number(process.env.PORT ?? 3000);
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const GRACE_MS = 90_000; // keep a dropped player's seat this long so they can rejoin cleanly
const SILENCE_MS = 9_000; // no message for this long => treat the socket as dead (phone left Wi-Fi)

function readEnvLocal() {
  const out: Record<string, string> = {};
  const file = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(file)) return out;
  try {
    const src = fs.readFileSync(file, 'utf8');
    for (const line of src.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const raw = trimmed.slice(eq + 1).trim();
      const val = raw.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
      out[key] = val;
    }
  } catch { /* ignore local env parsing errors */ }
  return out;
}
const LOCAL_ENV = readEnvLocal();
const env = (key: string) => process.env[key] ?? LOCAL_ENV[key] ?? '';

// ------------------------------------------------------------------ clock
// Server time = ms on a monotonic clock, starting at 0 when the process starts.
// (Not Date.now(): that can jump if NTP adjusts the laptop's clock mid-demo.)
const T0 = process.hrtime.bigint();
const serverNow = () => Number(process.hrtime.bigint() - T0) / 1e6;
const WALL_T0 = Date.now();
const wallIso = (ms: number) => new Date(WALL_T0 + ms).toISOString();

// -------------------------------------------------------------- transport
const SCALES: ScaleName[] = ['minorPent', 'majorPent', 'dorian', 'blues'];
const transport: TransportState = {
  bpm: 100,
  epoch: serverNow() + 500, // first downbeat half a second from boot
  root: 0, // C
  scale: 'minorPent', // default: C minor pentatonic
  drop: null,
  autoBand: false,
  speakerMode: false,
  syncTest: false,
  freestyle: false,
  nowPlaying: null,
  game: null,
  sample: null,
  paused: null,
  recording: null,
};
let dropTimer: NodeJS.Timeout | null = null;
let gameTimer: NodeJS.Timeout | null = null;
const RESULTS_GRACE_MS = 45_000; // how long a finished game stays up so the results screens can be read
const MAX_RECORDING_EVENTS = 200_000;
const MAX_LOCAL_RECORDINGS = 80;
const DB_URL = env('DATABASE_URL') || env('POSTGRES_URL') || env('NEON_DATABASE_URL') || env('POSTGRES_URL_NON_POOLING');

const db = DB_URL ? new Pool({ connectionString: DB_URL, max: 4 }) : null;
if (db) db.on('error', (err) => console.warn('[recording-db] pool error:', err.message));

interface RecordingEvent {
  seq: number;
  at: number;
  step: number | null;
  type: 'note' | 'raw' | 'ghit' | 'gstats' | 'ctl' | 'cmd' | 'role' | 'speaker' | 'join' | 'game';
  pid: string;
  role: Role | null;
  payload: Record<string, unknown>;
}

interface RecordingSession {
  id: string;
  startedAt: number;
  startStep: number;
  mode: 'live' | 'game' | 'freestyle' | 'sample';
  songId: string | null;
  difficulty: string | null;
  transportStart: TransportState;
  players: PlayerInfo[];
  events: RecordingEvent[];
  seq: number;
}

interface FinishedRecording {
  id: string;
  startedAt: number;
  endedAt: number;
  endedReason: 'stage' | 'limit' | 'shutdown';
  mode: RecordingSession['mode'];
  songId: string | null;
  difficulty: string | null;
  transportStart: TransportState;
  transportEnd: TransportState;
  players: PlayerInfo[];
  summary: { total: number; byType: Record<string, number> };
  events: RecordingEvent[];
}

let recordingSession: RecordingSession | null = null;
const localRecordings = new Map<string, FinishedRecording>();

const cloneTransport = (ts: TransportState): TransportState => structuredClone(ts);
const recordingMode = (ts: TransportState): RecordingSession['mode'] =>
  ts.game ? 'game' : ts.sample ? 'sample' : ts.freestyle ? 'freestyle' : 'live';

function summarizeEvents(events: RecordingEvent[]) {
  const byType: Record<string, number> = {};
  for (const ev of events) byType[ev.type] = (byType[ev.type] ?? 0) + 1;
  return { total: events.length, byType };
}

function archiveLocal(rec: FinishedRecording) {
  localRecordings.set(rec.id, rec);
  if (localRecordings.size <= MAX_LOCAL_RECORDINGS) return;
  const oldest = [...localRecordings.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
  if (oldest) localRecordings.delete(oldest.id);
}

async function persistRecordingStart(session: RecordingSession) {
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO recording_sessions (
         id, started_at, mode, stage_instance_id, song_id, difficulty,
         protocol_version, engine_version, transport_start, players
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        session.id,
        wallIso(session.startedAt),
        session.mode,
        `${os.hostname()}:${process.pid}`,
        session.songId,
        session.difficulty,
        'v1',
        'stage-local',
        JSON.stringify(session.transportStart),
        JSON.stringify(session.players),
      ],
    );
  } catch (err) {
    console.warn('[recording-db] start persist failed:', err);
  }
}

async function persistRecordingStop(rec: FinishedRecording) {
  if (!db) return;
  try {
    await db.query(
      `UPDATE recording_sessions
          SET ended_at = $2,
              ended_reason = $3,
              transport_end = $4::jsonb,
              summary = $5::jsonb
        WHERE id = $1`,
      [
        rec.id,
        wallIso(rec.endedAt),
        rec.endedReason,
        JSON.stringify(rec.transportEnd),
        JSON.stringify(rec.summary),
      ],
    );
    for (let i = 0; i < rec.events.length; i += 500) {
      const batch = rec.events.slice(i, i + 500);
      const values: unknown[] = [];
      const rows: string[] = [];
      for (const ev of batch) {
        const base = values.length;
        rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::jsonb)`);
        values.push(rec.id, ev.seq, ev.at, ev.step, ev.type, ev.pid, ev.role, JSON.stringify(ev.payload));
      }
      await db.query(
        `INSERT INTO recording_events (recording_id, seq, server_ms, step, event_type, pid, role, payload)
         VALUES ${rows.join(',')}
         ON CONFLICT (recording_id, seq) DO NOTHING`,
        values,
      );
    }
  } catch (err) {
    console.warn('[recording-db] stop persist failed:', err);
  }
}

async function listRecordings(limit: number) {
  if (db) {
    try {
      const q = await db.query(
        `SELECT id, started_at, ended_at, ended_reason, mode, song_id, difficulty, summary,
                jsonb_array_length(players) AS players_count
           FROM recording_sessions
          ORDER BY started_at DESC
          LIMIT $1`,
        [Math.max(1, Math.min(100, limit))],
      );
      return q.rows.map((r) => ({
        id: String(r.id),
        startedAt: r.started_at,
        endedAt: r.ended_at,
        endedReason: r.ended_reason,
        mode: r.mode,
        songId: r.song_id,
        difficulty: r.difficulty,
        players: Number(r.players_count ?? 0),
        summary: r.summary ?? { total: 0, byType: {} },
      }));
    } catch (err) {
      console.warn('[recording-db] list failed:', err);
    }
  }
  return [...localRecordings.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map((r) => ({
      id: r.id,
      startedAt: wallIso(r.startedAt),
      endedAt: wallIso(r.endedAt),
      endedReason: r.endedReason,
      mode: r.mode,
      songId: r.songId,
      difficulty: r.difficulty,
      players: r.players.length,
      summary: r.summary,
    }));
}

async function getRecording(id: string) {
  if (db) {
    try {
      const head = await db.query(
        `SELECT id, started_at, ended_at, ended_reason, mode, song_id, difficulty,
                transport_start, transport_end, players, summary
           FROM recording_sessions
          WHERE id = $1`,
        [id],
      );
      if (!head.rowCount) return null;
      const evs = await db.query(
        `SELECT seq, server_ms AS at, step, event_type AS type, pid, role, payload
           FROM recording_events
          WHERE recording_id = $1
          ORDER BY seq ASC`,
        [id],
      );
      return {
        id: String(head.rows[0].id),
        startedAt: head.rows[0].started_at,
        endedAt: head.rows[0].ended_at,
        endedReason: head.rows[0].ended_reason,
        mode: head.rows[0].mode,
        songId: head.rows[0].song_id,
        difficulty: head.rows[0].difficulty,
        transportStart: head.rows[0].transport_start,
        transportEnd: head.rows[0].transport_end,
        players: head.rows[0].players,
        summary: head.rows[0].summary,
        events: evs.rows,
      };
    } catch (err) {
      console.warn('[recording-db] get failed:', err);
    }
  }
  const rec = localRecordings.get(id);
  if (!rec) return null;
  return {
    id: rec.id,
    startedAt: wallIso(rec.startedAt),
    endedAt: wallIso(rec.endedAt),
    endedReason: rec.endedReason,
    mode: rec.mode,
    songId: rec.songId,
    difficulty: rec.difficulty,
    transportStart: rec.transportStart,
    transportEnd: rec.transportEnd,
    players: rec.players,
    summary: rec.summary,
    events: rec.events,
  };
}

const writeJson = (res: http.ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

const recordingId = () =>
  globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function startRecording(now: number): boolean {
  if (recordingSession || transport.recording) return false;
  const id = recordingId();
  const startStep = Math.floor(stepPos(transport, now));
  recordingSession = {
    id,
    startedAt: now,
    startStep,
    mode: recordingMode(transport),
    songId: transport.game?.songId ?? null,
    difficulty: transport.game?.difficulty ?? null,
    transportStart: cloneTransport(transport),
    players: joinedPlayers().map(info),
    events: [],
    seq: 0,
  };
  transport.recording = { sessionId: id, startedAt: now, startStep, events: 0 };
  recordEvent(now, 'cmd', 'stage', null, { cmd: 'recordingStart' });
  void persistRecordingStart(recordingSession);
  return true;
}

function stopRecording(now: number, reason: 'stage' | 'limit' | 'shutdown' = 'stage'): RecordingSession | null {
  if (!recordingSession || !transport.recording) return null;
  recordEvent(now, 'cmd', 'stage', null, { cmd: 'recordingStop', reason });
  const done = recordingSession;
  recordingSession = null;
  transport.recording = null;
  const finished: FinishedRecording = {
    id: done.id,
    startedAt: done.startedAt,
    endedAt: now,
    endedReason: reason,
    mode: done.mode,
    songId: done.songId,
    difficulty: done.difficulty,
    transportStart: done.transportStart,
    transportEnd: cloneTransport(transport),
    players: done.players,
    summary: summarizeEvents(done.events),
    events: done.events,
  };
  archiveLocal(finished);
  void persistRecordingStop(finished);
  return done;
}

function recordEvent(
  at: number,
  type: RecordingEvent['type'],
  pid: string,
  role: Role | null,
  payload: Record<string, unknown>,
  step: number | null = null,
) {
  if (!recordingSession || !transport.recording) return;
  const ev: RecordingEvent = { seq: recordingSession.seq++, at, step, type, pid, role, payload };
  recordingSession.events.push(ev);
  transport.recording.events = recordingSession.events.length;
  if (recordingSession.events.length >= MAX_RECORDING_EVENTS) {
    stopRecording(at, 'limit');
    broadcastState();
  }
}

function setBpm(bpm: number) {
  if (!Number.isFinite(bpm)) return;
  bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm)));
  const now = transport.paused ?? serverNow();
  // Re-anchor the epoch so the *current step position stays identical* under the new tempo.
  // Without this, every client's notion of "which step is it" would jump on a BPM change.
  const pos = stepPos(transport, now);
  transport.bpm = bpm;
  transport.epoch = now - pos * stepMs(bpm);
}

function startDrop() {
  if (transport.drop) return;
  const now = serverNow();
  // Build-up starts on the next bar line at least 400 ms away (so every client hears the start).
  const bar = Math.ceil((stepPos(transport, now + 400)) / STEPS_PER_BAR);
  const startStep = bar * STEPS_PER_BAR;
  transport.drop = { startStep, dropStep: startStep + DROP_BUILD_STEPS };
  armDropTimer();
}

function armDropTimer() {
  if (dropTimer) clearTimeout(dropTimer);
  if (!transport.drop) return;
  const endMs = transport.epoch + (transport.drop.dropStep + STEPS_PER_BAR) * stepMs(transport.bpm);
  dropTimer = setTimeout(() => {
    transport.drop = null;
    broadcastState();
  }, Math.max(0, endMs - serverNow()) + 200);
}

/** A finished game must not linger: clear it after the results grace period (also covers a Stage that closed). */
function armGameTimer() {
  if (gameTimer) clearTimeout(gameTimer);
  if (!transport.game) return;
  const endMs = transport.epoch + transport.game.endStep * stepMs(transport.bpm);
  gameTimer = setTimeout(() => {
    transport.game = null;
    for (const pl of players.values()) pl.game = null;
    broadcastState(); broadcastRoster();
  }, Math.max(0, endMs - serverNow()) + RESULTS_GRACE_MS);
}

/** Pause freezes the shared transport clock; resume shifts the epoch by the pause length so every step lands where it left off. */
function setPaused(on: boolean) {
  if (on === (transport.paused !== null)) return;
  const now = serverNow();
  if (on) {
    transport.paused = now;
    if (dropTimer) clearTimeout(dropTimer);
    if (gameTimer) clearTimeout(gameTimer);
  } else {
    transport.epoch += now - transport.paused!;
    transport.paused = null;
    armDropTimer(); armGameTimer();
  }
}

// ------------------------------------------------------------------ state
interface Conn {
  ws: WebSocket;
  kind: 'stage' | 'player';
  playerId: string | null;
  lastSeen: number;
  noteTimes: number[]; // rate limiter
  rawTimes: number[];
}
interface Player extends PlayerInfo {
  /** Pressed "Join". Until then the seat is only a preview and is invisible on the Stage. */
  joined: boolean;
  conn: Conn | null;
  droppedAt: number | null;
  y: number;
  tilt: number;
}
const players = new Map<string, Player>();
const gameHits = new Map<string, Set<number>>();
let gameCharts = new Map<Role, ReturnType<typeof buildChart>>();
let lastGameStart = -Infinity;
let lastJamStart = -Infinity;
const conns = new Set<Conn>();
let publicUrl: string | null = null;

const info = (p: Player): PlayerInfo => ({
  id: p.id, name: p.name, color: p.color, role: p.role, connected: p.connected, speaker: p.speaker, sync: p.sync, game: p.game,
});

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg: ServerMsg, filter?: (c: Conn) => boolean) {
  const s = JSON.stringify(msg);
  for (const c of conns) if (c.ws.readyState === WebSocket.OPEN && (!filter || filter(c))) c.ws.send(s);
}
const broadcastState = () => broadcast({ t: 'state', state: transport });
const broadcastRoster = () => broadcast({ t: 'roster', players: joinedPlayers().map(info) });

/** First unused role in the configured order; when all are taken, reuse the least-used one. */
function pickRole(others: Player[]): Role {
  const np = transport.nowPlaying;
  const roles = np?.mode === 'jam' && !np.full ? ROLES.filter((r) => r !== 'melody') : ROLES;
  return roles.find((r) => !others.some((p) => p.role === r))
    ?? [...roles].sort((a, b) => others.filter((p) => p.role === a).length - others.filter((p) => p.role === b).length)[0];
}
const pickColor = (others: Player[]) =>
  COLORS.find((c) => !others.some((p) => p.color === c)) ?? COLORS[others.length % COLORS.length];
const joinedPlayers = () => [...players.values()].filter((p) => p.joined);

/** Create a preview seat (role + colour are shown on the join screen; committed on "Join"). */
function seat(id: string): Player {
  const others = joinedPlayers();
  const p: Player = {
    id, name: `Player ${others.length + 1}`, color: pickColor(others), role: pickRole(others), connected: true,
    speaker: false, sync: null, game: null, joined: false, conn: null, droppedAt: null, y: 0.5, tilt: 0,
  };
  players.set(id, p);
  return p;
}

// ------------------------------------------------------------------- HTTP
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.map': 'application/json',
};
const lanUrls = () =>
  Object.values(os.networkInterfaces()).flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api/info') {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    return void res.end(JSON.stringify({ publicUrl, lanUrls: lanUrls(), port: PORT }));
  }
  if (url.pathname === '/api/public-url' && req.method === 'POST') {
    // Only the tunnel helper on this machine may set it.
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return void res.writeHead(403).end();
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { publicUrl = JSON.parse(body).url ?? null; } catch { /* ignore */ }
      res.writeHead(204).end();
    });
    return;
  }
  if (url.pathname === '/api/recordings' && req.method === 'GET') {
    void (async () => {
      const limit = Number(url.searchParams.get('limit') ?? '20');
      writeJson(res, 200, { recordings: await listRecordings(limit) });
    })();
    return;
  }
  if (url.pathname.startsWith('/api/recordings/') && req.method === 'GET') {
    const id = decodeURIComponent(url.pathname.slice('/api/recordings/'.length));
    void (async () => {
      const data = await getRecording(id);
      if (!data) return void writeJson(res, 404, { error: 'Recording not found.' });
      writeJson(res, 200, data);
    })();
    return;
  }
  // Static files: / -> player (index.html), /stage -> stage.html
  let rel = url.pathname === '/stage' ? '/stage.html' : url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(DIST, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(DIST)) return void res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return void res.end(fs.existsSync(DIST) ? 'Not found' : 'dist/ missing: run `npm run build` (or use `npm run dev`).');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  });
});

// -------------------------------------------------------------- WebSocket
// On Vercel the function lives at /api/ws and the client's /ws is rewritten to it, so don't pin the path there.
const ON_VERCEL = !!process.env.VERCEL;
const wss = new WebSocketServer({ server, path: ON_VERCEL ? undefined : '/ws', perMessageDeflate: false });

wss.on('connection', (ws, req) => {
  // Disable Nagle: tiny JSON frames must leave immediately or ping RTTs get sticky/asymmetric.
  (req.socket as import('node:net').Socket).setNoDelay(true);
  const conn: Conn = { ws, kind: 'player', playerId: null, lastSeen: serverNow(), noteTimes: [], rawTimes: [] };
  conns.add(conn);

  ws.on('message', (raw) => {
    // Timestamp BEFORE parsing/dispatch: this is the t1 of the NTP exchange.
    const rx = serverNow();
    conn.lastSeen = rx;
    let m: ClientMsg;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return;
    if (m.t === 'ping') return void send(ws, { t: 'pong', id: m.id, c0: m.c0, s: rx });
    handle(conn, m, rx);
  });
  ws.on('close', () => {
    conns.delete(conn);
    const p = conn.playerId ? players.get(conn.playerId) : null;
    if (p && p.conn === conn) {
      p.conn = null; p.connected = false; p.droppedAt = serverNow();
      if (p.joined) broadcastRoster();
    }
  });
  ws.on('error', () => ws.terminate());
});

function handle(conn: Conn, m: ClientMsg, now: number) {
  if (m.t === 'hello') {
    conn.kind = m.kind;
    if (m.kind === 'player') {
      // Reconnect: same id => same seat, name, colour, role.
      let p = m.id ? players.get(m.id) : undefined;
      if (p) {
        if (p.conn && p.conn !== conn) p.conn.ws.terminate(); // stale half-open socket
      } else if (m.id) {
        p = seat(m.id);
      }
      if (p) {
        p.conn = conn; p.connected = true; p.droppedAt = null; conn.playerId = p.id;
        if (p.joined) broadcastRoster();
      }
      send(conn.ws, { t: 'welcome', you: p ? info(p) : null, state: transport, serverNow: now });
    } else {
      send(conn.ws, { t: 'welcome', you: null, state: transport, serverNow: now });
      send(conn.ws, { t: 'roster', players: joinedPlayers().map(info) });
    }
    return;
  }

  if (m.t === 'jam') {
    if (conn.kind !== 'stage') return;
    if (m.action === 'stop') {
      if (transport.nowPlaying?.mode === 'jam') { transport.nowPlaying = null; setPaused(false); broadcastState(); }
      return;
    }
    const song = validateGameSong(m.song);
    if (m.action !== 'start' || !song?.tracks.melody.length) {
      send(conn.ws, { t: 'error', message: 'Choose a MIDI melody before starting a jam. Use the melody-part selector if needed.' });
      return;
    }
    setPaused(false);
    if (gameTimer) clearTimeout(gameTimer);
    transport.game = null; transport.drop = null; transport.sample = null;
    transport.freestyle = false; transport.autoBand = false;
    transport.root = song.root; transport.scale = song.scale; setBpm(song.bpm);
    const startStep = Math.max(lastJamStart + STEPS_PER_BAR, Math.ceil(stepPos(transport, now + 1800) / STEPS_PER_BAR) * STEPS_PER_BAR);
    lastJamStart = startStep;
    transport.nowPlaying = { mode: 'jam', title: song.title, song, startStep, chords: jamHarmony(song), ...(m.full ? { full: true } : {}) };
    for (const pl of players.values()) {
      pl.game = null;
      if (pl.role === 'melody' && !m.full) {
        pl.role = 'guitar';
        if (pl.conn) send(pl.conn.ws, { t: 'you', you: info(pl) });
      }
    }
    broadcastState(); broadcastRoster();
    return;
  }

  if (m.t === 'game') {
    if (conn.kind !== 'stage') return; // the host starts and stops performances
    if (m.action === 'stop') {
      recordEvent(now, 'game', 'stage', null, { action: 'stop' });
      if (gameTimer) clearTimeout(gameTimer);
      transport.game = null;
      for (const pl of players.values()) pl.game = null;
      broadcastState(); broadcastRoster();
      return;
    }
    const song = m.song ? validateGameSong(m.song) : m.songId ? getSong(m.songId) : undefined;
    const difficulty = DIFFICULTIES.find((d) => d === m.difficulty);
    if (!song || !difficulty) { send(conn.ws, { t: 'error', message: 'Could not start: invalid song or difficulty.' }); return; }
    // One authoritative start: lock the tempo (position stays continuous), then begin on a bar line far enough
    // away for a 4-beat count-in plus network slack. Every phone derives every note time from these numbers.
    transport.drop = null; transport.freestyle = false; transport.nowPlaying = null; transport.sample = null;
    setPaused(false);
    transport.root = song.root; transport.scale = song.scale;
    setBpm(song.bpm);
    const lead = Math.max(4000, 4 * (60000 / song.bpm) + 1500);
    const startStep = Math.max(lastGameStart + STEPS_PER_BAR, Math.ceil(stepPos(transport, serverNow() + lead) / STEPS_PER_BAR) * STEPS_PER_BAR);
    lastGameStart = startStep;
    gameHits.clear();
    gameCharts = new Map(ROLES.map((role) => [role, buildChart(song, role, difficulty)]));
    const free = m.live ? [...new Set((Array.isArray(m.free) ? m.free : []).filter((r): r is Role => ROLES.includes(r) && song.tracks[r].length > 0))] : [];
    transport.game = { ...(m.song ? { song } : {}), songId: song.id, difficulty, startStep, endStep: startStep + songSteps(song) + STEPS_PER_BAR, ...(m.live ? { live: true, free, chords: jamHarmony(song) } : {}) };
    recordEvent(now, 'game', 'stage', null, {
      action: 'start',
      songId: song.id,
      difficulty,
      startStep,
      endStep: transport.game.endStep,
    }, startStep);
    for (const pl of players.values()) {
      pl.game = null;
      const keepSeat = m.live && freeRoles(transport.game, song).includes(pl.role); // a free part is played live, no chart needed
      if (m.song && !song.tracks[pl.role].length && !keepSeat) {
        const available = ROLES.filter((r) => song.tracks[r].length);
        pl.role = available.find((r) => !joinedPlayers().some((p) => p.id !== pl.id && p.role === r)) ?? available[0];
        if (pl.conn) send(pl.conn.ws, { t: 'you', you: info(pl) });
      }
    }
    armGameTimer();
    broadcastState(); broadcastRoster();
    return;
  }

  if (m.t === 'cmd') {
    if (conn.kind !== 'stage') return; // only the conductor may change the music
    if (m.cmd === 'recordingStart') {
      if (!startRecording(now)) send(conn.ws, { t: 'error', message: 'Recording is already active.' });
      broadcastState();
      return;
    }
    if (m.cmd === 'recordingStop') {
      if (!stopRecording(now, 'stage')) send(conn.ws, { t: 'error', message: 'No active recording to stop.' });
      broadcastState();
      return;
    }
    if (m.cmd === 'pause') {
      setPaused(!!m.value);
      recordEvent(now, 'cmd', 'stage', null, { cmd: m.cmd, value: !!m.value });
      broadcastState();
      return;
    }
    if (transport.paused !== null && m.cmd === 'drop') return;
    // While a rhythm game runs, tempo/key/mode are locked: every chart is addressed in steps of THIS tempo.
    if (transport.game && ['bpm', 'key', 'scale', 'drop', 'freestyle', 'nowplaying', 'sample'].includes(m.cmd)) return;
    if (transport.nowPlaying?.mode === 'jam' && ['bpm', 'key', 'scale', 'drop', 'auto', 'freestyle', 'sample'].includes(m.cmd)) return;
    switch (m.cmd) {
      case 'bpm': setBpm(Number(m.value)); break;
      case 'key': transport.root = ((Math.round(Number(m.value)) % 12) + 12) % 12; break;
      case 'scale': if (SCALES.includes(m.value as ScaleName)) transport.scale = m.value as ScaleName; break;
      case 'drop': startDrop(); break;
      case 'auto': transport.autoBand = !!m.value; break;
      case 'speakers': transport.speakerMode = !!m.value; break;
      case 'syncTest': transport.syncTest = !!m.value; break;
      case 'freestyle': transport.freestyle = !!m.value; break;
      case 'sample': { // value "chop|Title" / "backing|Title" / "" (clear). The audio itself never leaves the Stage.
        const [mode, ...rest] = String(m.value ?? '').split('|');
        transport.sample = rest.length && (mode === 'chop' || mode === 'backing') ? { mode, title: rest.join('|').slice(0, 60) } : null;
        if (transport.sample) { transport.nowPlaying = null; transport.freestyle = false; }
        break;
      }
      case 'nowplaying': { // value "tap|Title" / "band|Title" / "" (clear)
        const [mode, ...rest] = String(m.value ?? '').split('|');
        transport.nowPlaying = rest.length && (mode === 'tap' || mode === 'band') ? { mode, title: rest.join('|').slice(0, 60) } : null;
        break;
      }
    }
    recordEvent(now, 'cmd', 'stage', null, { cmd: m.cmd, value: m.value });
    broadcastState();
    return;
  }

  const p = conn.playerId ? players.get(conn.playerId) : undefined;
  if (!p || (!p.joined && m.t !== 'join')) return;

  switch (m.t) {
    case 'join':
      if (!p.joined) {
        const others = joinedPlayers();
        p.joined = true; p.role = pickRole(others); p.color = pickColor(others);
        const song = transport.game?.song;
        if (song && !song.tracks[p.role].length) {
          const available = ROLES.filter((r) => song.tracks[r].length);
          p.role = available.find((r) => !others.some((pl) => pl.connected && pl.role === r)) ?? available[0];
        }
      }
      p.name = String(m.name ?? '').trim().slice(0, 14) || p.name;
      recordEvent(now, 'join', p.id, p.role, { name: p.name, color: p.color });
      broadcastRoster();
      send(conn.ws, { t: 'you', you: info(p) });
      break;
    case 'role':
      if (!transport.game && ROLES.includes(m.role) && !(transport.nowPlaying?.mode === 'jam' && !transport.nowPlaying.full && m.role === 'melody')) { p.role = m.role; recordEvent(now, 'role', p.id, p.role, { role: p.role }); broadcastRoster(); send(conn.ws, { t: 'you', you: info(p) }); }
      break;
    case 'speaker':
      recordEvent(now, 'speaker', p.id, p.role, { on: !!m.on });
      p.speaker = !!m.on; broadcastRoster();
      break;
    case 'gstats': {
      // Each phone judges its own taps against the shared timeline and reports the totals; clamp to sane ranges.
      if (!transport.game || m.startStep !== transport.game.startStep || !m.s || typeof m.s !== 'object') return;
      const n = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
      const g: GameStats = { score: n(m.s.score, 1e7), combo: n(m.s.combo, 1e4), maxCombo: n(m.s.maxCombo, 1e4), perfect: n(m.s.perfect, 1e4), good: n(m.s.good, 1e4), miss: n(m.s.miss, 1e4), total: n(m.s.total, 1e4) };
      p.game = g;
      recordEvent(now, 'gstats', p.id, p.role, { stats: g });
      break;
    }
    case 'stats':
      if (!m.stats || !['offset', 'jitter', 'rttMin', 'rttLast', 'err', 'flashLate', 'samples'].every((key) => Number.isFinite((m.stats as unknown as Record<string, unknown>)[key]))) return;
      p.sync = m.stats; // roster is re-broadcast on a timer, not per report
      break;
    case 'ctl':
      p.y = clamp01(m.y); p.tilt = Math.max(-1, Math.min(1, m.tilt));
      recordEvent(now, 'ctl', p.id, p.role, { y: p.y, tilt: p.tilt });
      broadcast({ t: 'ctl', pid: p.id, y: p.y, tilt: p.tilt }, (c) => c !== conn);
      break;
    case 'songreq': {
      if (transport.game) return;
      // A phone asks the Stage to load a song (the Stage validates the id against its own list).
      if (typeof m.id !== 'string' || m.id.length > 120 || !['tap', 'band', 'jam'].includes(m.mode)) return;
      broadcast({ t: 'songreq', pid: p.id, name: p.name, id: m.id, mode: m.mode }, (c) => c.kind === 'stage');
      break;
    }
    case 'raw': {
      // Freestyle gestures go ONLY to the Stage (which records + sonifies them). Light validation + rate limit.
      conn.rawTimes = conn.rawTimes.filter((t) => now - t < 1000);
      if (conn.rawTimes.length >= 90 || !['d', 'm', 'u', 's', 't'].includes(m.k)) return;
      conn.rawTimes.push(now);
      const at = Number.isFinite(m.at) ? Math.min(now + 200, Math.max(now - 2000, m.at)) : now;
      recordEvent(now, 'raw', p.id, p.role, { k: m.k, at, x: Math.max(-1, Math.min(1, +m.x || 0)), y: clamp01(m.y), v: m.v === undefined ? undefined : clamp01(m.v) });
      broadcast({ t: 'raw', pid: p.id, role: p.role, k: m.k, at, x: Math.max(-1, Math.min(1, +m.x || 0)), y: clamp01(m.y), v: m.v === undefined ? undefined : clamp01(m.v) }, (c) => c.kind === 'stage');
      break;
    }
    case 'ghit': {
      const g = transport.game;
      if (!g || transport.paused !== null || m.startStep !== g.startStep || !Number.isInteger(m.step) || m.step < g.startStep || m.step >= g.endStep) return;
      const note = gameCharts.get(p.role)?.[m.noteId];
      const hitKey = `${p.id}:${p.role}`;
      if (!Number.isInteger(m.noteId) || !note || g.startStep + note.step !== m.step || gameHits.get(hitKey)?.has(m.noteId)) return;
      const age = now - (transport.epoch + m.step * stepMs(transport.bpm));
      if (age < -200 || age > 2000) return;
      conn.noteTimes = conn.noteTimes.filter((t) => now - t < 1000);
      if (conn.noteTimes.length >= 24) return;
      conn.noteTimes.push(now);
      const hits = gameHits.get(hitKey) ?? new Set<number>();
      hits.add(m.noteId); gameHits.set(hitKey, hits);
      recordEvent(now, 'ghit', p.id, p.role, { startStep: g.startStep, noteId: m.noteId }, m.step);
      broadcast({ t: 'ghit', startStep: g.startStep, step: m.step, pid: p.id, role: p.role, noteId: m.noteId }, (c) => c.kind === 'stage');
      break;
    }
    case 'note': {
      // Song playback is scheduled on Stage. Old clients must never inject off-grid game audio.
      if (!liveNotesAllowed(transport) || !Number.isFinite(m.d)) return;
      if (transport.game) { // band mode: only parts nobody is chart-guided on may be played live
        const gs = transport.game.song ?? getSong(transport.game.songId);
        const liveRole: Role = m.role === 'drums' ? 'drums' : p.role;
        if (!gs || !freeRoles(transport.game, gs).includes(liveRole)) return;
      }
      // Guardrail 1: rate limit (a spammy phone can't swamp the stage).
      conn.noteTimes = conn.noteTimes.filter((t) => now - t < 1000);
      if (conn.noteTimes.length >= 24) return;
      conn.noteTimes.push(now);
      // Guardrail 2: only integer steps in a sane window: the grid is the only place a note can live.
      const cur = stepPos(transport, now);
      let step = Math.round(m.step);
      if (!Number.isFinite(step) || step > cur + 48) return;
      if (step < cur - 1) step = Math.ceil(cur) + 1; // hopelessly late: land on the next grid line
      // Pitch/voice quantisation to the key+scale happens in shared/music.ts at playback, from the
      // *current* transport, so key changes are instant and nobody can send an out-of-key pitch.
      const role: Role = m.role === 'drums' ? 'drums' : p.role; // non-drummers may shake in a hit
      // Jam pitches come from the server-owned harmonic guide, never from arbitrary client MIDI.
      const resolved = transport.nowPlaying?.mode === 'jam' || transport.game?.live ? resolveEvent({ role, step, d: Math.max(0, Math.min(15, Math.round(m.d))) }, transport) : null;
      const midi = resolved?.kind === 'notes' ? resolved.midi : undefined;
      recordEvent(now, 'note', p.id, role, { d: Math.max(0, Math.min(15, Math.round(m.d))), v: clamp01(m.v), dur: Math.max(1, Math.min(STEPS_PER_BAR, Math.round(m.dur || 2))), midi }, step);
      broadcast(
        { t: 'note', pid: p.id, role, step, d: Math.max(0, Math.min(15, Math.round(m.d))), v: clamp01(m.v), dur: Math.max(1, Math.min(STEPS_PER_BAR, Math.round(m.dur || 2))), midi },
        (c) => c !== conn,
      );
      break;
    }
  }
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

// ----------------------------------------------------------------- timers
setInterval(() => {
  const now = serverNow();
  for (const c of conns) if (now - c.lastSeen > SILENCE_MS) c.ws.terminate(); // half-open sockets
  for (const [id, p] of players) if (p.droppedAt && now - p.droppedAt > (p.joined ? GRACE_MS : 5000)) { players.delete(id); broadcastRoster(); }
}, 2000);
// Sync stats change constantly; push them to everyone at 1 Hz instead of per report.
setInterval(broadcastRoster, 1000);

process.on('exit', () => { stopRecording(serverNow(), 'shutdown'); });

export default server; // Vercel Functions run an exported http.Server (api/ws.ts re-exports it)

if (!ON_VERCEL) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎼  Human Orchestra server on :${PORT}`);
    console.log(`    Stage:  http://localhost:${PORT}/stage`);
    for (const u of lanUrls()) console.log(`    LAN:    ${u}   (http: motion sensors need HTTPS, use \`npm run demo\`)`);
  });
}
