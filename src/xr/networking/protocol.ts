/**
 * Wire types for the EXISTING Human Orchestra server (raw WebSocket at /ws, JSON frames).
 * Hand-mirrored from the original `shared/protocol.ts` (read-only reference) and trimmed to what XR consumes.
 * Nothing here is invented: if the original changes, this file is the one place to update.
 */

export type Role = 'drums' | 'bass' | 'melody' | 'pads' | 'guitar';
export const ROLES: Role[] = ['drums', 'bass', 'melody', 'pads', 'guitar'];
export type ScaleName = 'minorPent' | 'majorPent' | 'dorian' | 'blues';

export const STEPS_PER_BEAT = 4;
export const STEPS_PER_BAR = 16;

/** Display names the original uses for each role. */
export const ROLE_LABEL: Record<Role, string> = {
  drums: 'Percussion', bass: 'Double Bass', melody: 'Solo Lead', guitar: 'Guitar', pads: 'Grand Piano',
};

export interface TrackNote { step: number; dur: number; v: number; midi?: number[]; d?: number }
export interface GameSong {
  id: string; title: string; artist: string; bpm: number; rating: 1 | 2 | 3; bars: number;
  root: number; scale: ScaleName; tracks: Record<Role, TrackNote[]>;
}

export interface JamState {
  mode: 'jam'; title: string; song: GameSong; startStep: number;
  chords: { root: number; minor: boolean }[]; full?: boolean;
}

export interface GameState {
  song?: GameSong; songId: string; difficulty: 'easy' | 'medium' | 'hard';
  startStep: number; endStep: number; live?: boolean; free?: Role[]; chords?: { root: number; minor: boolean }[];
}

export interface TransportState {
  bpm: number;
  /** server ms at which step 0 occurred */
  epoch: number;
  root: number;
  scale: ScaleName;
  drop: { startStep: number; dropStep: number } | null;
  autoBand: boolean;
  speakerMode: boolean;
  syncTest: boolean;
  freestyle: boolean;
  nowPlaying: { title: string; mode: 'band' | 'tap' } | JamState | null;
  game: GameState | null;
  sample: { title: string; mode: 'chop' | 'backing' } | null;
  /** server ms at which the Stage paused; null while running */
  paused: number | null;
  recording: { sessionId: string; startedAt: number; startStep: number; events: number } | null;
  /** Conductor mix. Absent on older servers: everything is then full volume. */
  mix?: MixState;
}

export interface MixState {
  master: number;
  solo: Role | null;
  roles: Record<Role, { vol: number; mute: boolean }>;
}
export const defaultMix = (): MixState => ({
  master: 1, solo: null,
  roles: { drums: { vol: 1, mute: false }, bass: { vol: 1, mute: false }, melody: { vol: 1, mute: false }, pads: { vol: 1, mute: false }, guitar: { vol: 1, mute: false } },
});

/** Commands the server accepts from a Stage-declared connection (mirrors `ClientMsg` cmd in shared/protocol). */
export type ConductorCmd = 'pause' | 'drop' | 'bpm' | 'key' | 'scale' | 'auto' | 'mix' | 'solo' | 'master';

export interface PlayerInfo {
  id: string; name: string; color: string; role: Role; connected: boolean; speaker: boolean;
}

export const stepMs = (bpm: number) => 60000 / bpm / STEPS_PER_BEAT;
/** Server time at which an integer step begins (identical to the original's `stepTime`). */
export const stepTime = (ts: TransportState, step: number) => ts.epoch + step * stepMs(ts.bpm);
/** Fractional step at a server time; frozen while paused (identical to `stepPos`). */
export const stepPos = (ts: TransportState, serverMs: number) =>
  (Math.min(serverMs, ts.paused ?? Infinity) - ts.epoch) / stepMs(ts.bpm);

/** Messages the server sends that XR understands. Other types (ghit, raw, songreq) are stage-only or unused. */
export type ServerMsg =
  | { t: 'welcome'; you: PlayerInfo | null; state: TransportState; serverNow: number; room?: string }
  | { t: 'pong'; id: number; c0: number; s: number }
  | { t: 'state'; state: TransportState }
  | { t: 'roster'; players: PlayerInfo[] }
  | { t: 'note'; pid: string; role: Role; step: number; d: number; v: number; dur: number; midi?: number[] }
  | { t: 'ctl'; pid: string; y: number; tilt: number }
  | { t: 'rtc'; from: string; data: unknown }
  | { t: 'error'; message: string; code?: 'noroom' | 'badroom' | 'busy' };

/** Messages XR may send. Observer mode sends only `hello` and `ping`; Conductor mode also sends the commands below. */
export type ClientMsg =
  | { t: 'hello'; kind: 'stage' | 'player'; room?: string }
  | { t: 'ping'; id: number; c0: number }
  | { t: 'cmd'; cmd: ConductorCmd; value?: boolean | number | string }
  | { t: 'jam'; action: 'start' | 'stop'; song?: GameSong; full?: boolean }
  | { t: 'rtc'; to?: string; data: unknown };
