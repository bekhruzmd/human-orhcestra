/**
 * Bridge between the existing Human Orchestra protocol and XR state.
 *
 *   server frames --> normalise --> activity (per-frame visuals) + store (roster/transport/status)
 *
 * Real server -> XR mapping (nothing invented):
 *   welcome / state   TransportState  -> store.transport, song visualisation source
 *   roster            PlayerInfo[]    -> store.roster (instrument seats)
 *   note              phone note      -> XRNote scheduled at stepTime(step) on the server clock
 *   Jam / embedded-game song tracks   -> XRNote derived from broadcast track data (songPlayer)
 *   pong              clock sync + RTT
 * Observer mode sends only `hello(player, no id)` and `ping`, so XR takes no seat and cannot change the music.
 */
import { activity, type XRNote } from '../state/activity';
import { useStore, type Privilege } from '../state/store';
import { ServerClock } from './clock';
import { OrchestraConnection, normalizeUrl } from './connection';
import { resolveEvent } from './music';
import { SongPlayer } from './songPlayer';
import { AudioLink } from './audioLink';
import { stepTime, ROLE_LABEL, type PlayerInfo, type Role, type ServerMsg, type ConductorCmd } from './protocol';
import type { GameSong } from './protocol';
import { stopSimulation } from './simulation';

export const clock = new ServerClock();
export const songPlayer = new SongPlayer();
export const audioLink = new AudioLink();

const rosterSig = (ps: PlayerInfo[]) => ps.map((p) => `${p.id}|${p.name}|${p.role}|${p.color}|${p.connected}`).join(';');

const conn = new OrchestraConnection({
  onOpen() { useStore.getState().pushLog('Socket open, saying hello'); },
  onReady() {
    useStore.getState().set({ status: 'connected', error: null, mode: 'live' });
    useStore.getState().pushLog('Server verified (welcome received)');
    audioLink.start((data) => conn.send({ t: 'rtc', data }));
  },
  onDrop(willRetry, reason) {
    const s = useStore.getState();
    activity.clear(); audioLink.stop();
    if (willRetry) { s.set({ status: 'reconnecting', error: reason }); s.pushLog(`${reason} Reconnecting…`); }
    else { s.set({ status: 'error', mode: 'none', error: reason }); s.pushLog(reason); }
  },
  onMessage: handle,
});

function handle(m: ServerMsg) {
  const s = useStore.getState();
  switch (m.t) {
    case 'welcome':
      clock.seed(m.serverNow, performance.now());
      s.set({ transport: m.state });
      songPlayer.update(m.state);
      break;
    case 'state':
      s.set({ transport: m.state });
      songPlayer.update(m.state);
      break;
    case 'roster': {
      if (rosterSig(m.players) === rosterSig(s.roster)) break;
      const before = new Map(s.roster.map((p) => [p.id, p]));
      for (const p of m.players) {
        if (!before.has(p.id)) s.pushLog(`${p.name} joined as ${ROLE_LABEL[p.role]}`);
        else if (before.get(p.id)!.role !== p.role) s.pushLog(`${p.name} switched to ${ROLE_LABEL[p.role]}`);
      }
      for (const p of s.roster) if (!m.players.some((q) => q.id === p.id)) s.pushLog(`${p.name} left`);
      s.set({ roster: m.players });
      break;
    }
    case 'note': {
      const ts = s.transport;
      if (!ts) break;
      showNote(ts, m);
      break;
    }
    case 'rtc':
      void audioLink.onSignal(m.from, m.data);
      break;
    case 'pong':
      clock.addPong(m.c0, performance.now(), m.s);
      s.set({ rttMs: Math.round(clock.rtt) });
      break;
    case 'error':
      s.pushLog(`Server: ${m.message}`);
      break;
  }
}

/** Schedule the visual for a note at the moment it sounds. Shared by relayed phone notes and our own. */
function showNote(ts: NonNullable<ReturnType<typeof useStore.getState>['transport']>, m: { pid: string; role: Role; step: number; d: number; v: number; dur: number; midi?: number[] }) {
  const r = resolveEvent({ role: m.role, step: m.step, d: m.d, midi: m.midi }, ts);
  const when = stepTime(ts, m.step);
  const n: XRNote = {
    type: 'instrument:note', instrumentId: m.role, source: 'phone', playerId: m.pid,
    velocity: m.v, durSteps: m.dur, timestamp: when,
    ...(r.kind === 'drum' ? { drumVoice: r.voice } : { midi: r.midi }),
  };
  activity.schedule(n, clock.toLocal(when)); // best effort: due immediately if the moment already passed
}

export const orchestra = {
  /** Resolves to an error string, or null when the connection attempt has started. */
  connect(rawUrl: string, privilege: Privilege, room = ''): string | null {
    const norm = normalizeUrl(rawUrl, location.protocol);
    if ('error' in norm) return norm.error;
    stopSimulation();
    clock.reset(); activity.clear(); songPlayer.update(null);
    useStore.getState().set({ status: 'connecting', mode: 'none', privilege, url: norm.url, error: null, roster: [], transport: null, rttMs: null, log: [] });
    // A room code is joined, never created, from here: only a real Stage page makes rooms.
    conn.connect(norm.url, { t: 'hello', kind: privilege === 'conductor' ? 'stage' : 'player', ...(room ? { room } : {}) });
    return null;
  },
  disconnect() {
    audioLink.stop();
    conn.close();
    activity.clear(); clock.reset(); songPlayer.update(null);
    useStore.getState().set({ status: 'idle', mode: 'none', error: null, roster: [], transport: null, rttMs: null, selected: null });
  },
  /** Real server commands; only valid for a conductor (Stage-declared) connection. */
  command(cmd: ConductorCmd, value?: boolean | number | string) {
    if (useStore.getState().privilege !== 'conductor' || !conn.isOpen) return false;
    conn.send({ t: 'cmd', cmd, value });
    return true;
  },
  /** Section volume (0..1.5) and/or mute. Either may be left out. */
  section(role: Role, p: { vol?: number; mute?: boolean }) {
    const vol = p.vol === undefined ? '' : String(Math.round(p.vol * 100) / 100);
    const mute = p.mute === undefined ? '' : p.mute ? '1' : '0';
    return this.command('mix', `${role}|${vol}|${mute}`);
  },
  /** Hear one section alone; `null` clears the solo. */
  solo(role: Role | null) { return this.command('solo', role ?? ''); },
  master(level: number) { return this.command('master', Math.round(level * 100) / 100); },
  /** Start a whole library song: every track plays, so each section can be mixed. The server keeps key and band locked. */
  playSong(song: GameSong) {
    if (useStore.getState().privilege !== 'conductor' || !conn.isOpen) return false;
    conn.send({ t: 'jam', action: 'start', full: true, song: { ...song, id: `import:jam:${song.id}` } });
    return true;
  },
  stopSong() {
    if (useStore.getState().privilege !== 'conductor' || !conn.isOpen) return false;
    conn.send({ t: 'jam', action: 'stop' });
    return true;
  },
  /** Per-frame hook: applies due events and walks embedded song tracks. */
  tick(dt: number) {
    const now = performance.now();
    const st = useStore.getState();
    if (st.mode === 'live') songPlayer.tick(st.transport, clock.serverNow(now));
    activity.tick(now, dt);
  },
};
