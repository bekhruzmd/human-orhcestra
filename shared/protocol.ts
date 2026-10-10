/**
 * Wire protocol + transport math shared by the server, Stage and Player.
 *
 * Time model (read this first):
 *   - "server time" is milliseconds on the server's monotonic clock (ms since
 *     the server process started). It is the ONLY clock musical events are
 *     expressed in.
 *   - Every musical event is addressed by an absolute integer 16th-note
 *     "step" counted from the transport epoch, never by a wall-clock time.
 *     step N sounds at   serverTime = epoch + N * stepMs(bpm).
 *   - Clients convert server time -> their own audio clock using the offset
 *     they estimated in clock.ts. Network latency therefore only decides
 *     whether a message arrives *before* its step (it does, by design, thanks
 *     to the scheduling lead) - never *when* the note sounds.
 */

export type Role = 'drums' | 'bass' | 'melody' | 'pads';
/** Assignment order for newly joined players (spec: Drums, Bass, Melody, Pads). */
export const ROLES: Role[] = ['drums', 'bass', 'melody', 'pads'];

export const ROLE_INFO: Record<Role, { label: string; icon: string }> = {
  drums: { label: 'Drums', icon: '🥁' },
  bass: { label: 'Bass', icon: '🎸' },
  melody: { label: 'Melody', icon: '🎹' },
  pads: { label: 'Pads', icon: '🌌' },
};

/** Auto-assigned player colours (distinct on a projector and under a colour-blind filter). */
export const COLORS = ['#ff4d6d', '#35d0ff', '#ffd23f', '#7cff6b', '#b388ff', '#ff9248', '#2dffc4', '#ff6bd6'];

export type ScaleName = 'minorPent' | 'majorPent' | 'dorian' | 'blues';

export const STEPS_PER_BEAT = 4;
export const BEATS_PER_BAR = 4;
export const STEPS_PER_BAR = STEPS_PER_BEAT * BEATS_PER_BAR; // 16
/** Length of the chord loop, in bars. */
export const PROGRESSION_BARS = 4;

/** Build-up length of a "drop", in steps (2 bars). */
export const DROP_BUILD_STEPS = STEPS_PER_BAR * 2;

export interface DropState {
  /** first step of the build-up (always a bar line) */
  startStep: number;
  /** step at which the beat comes back */
  dropStep: number;
}

/** Everything that defines "where we are" in the music. Broadcast on every change. */
export interface TransportState {
  bpm: number;
  /** Server time (ms) at which step 0 occurred. Re-anchored on BPM change so position is continuous. */
  epoch: number;
  /** Key root as a pitch class, 0 = C. */
  root: number;
  scale: ScaleName;
  drop: DropState | null;
  /** Generate AUTO parts for roles nobody is playing. */
  autoBand: boolean;
  /** Phones play their own part locally ("speaker array" mode). */
  speakerMode: boolean;
  /** Freestyle jam: no quantising, no scale lock. Phones stream raw gestures; the Stage records them. */
  freestyle: boolean;
}

export const stepMs = (bpm: number) => 60000 / bpm / STEPS_PER_BEAT;
export const beatMs = (bpm: number) => 60000 / bpm;

/** Fractional step position at a given server time. */
export const stepPos = (ts: TransportState, serverMs: number) => (serverMs - ts.epoch) / stepMs(ts.bpm);
/** Server time at which an (integer) step begins. */
export const stepTime = (ts: TransportState, step: number) => ts.epoch + step * stepMs(ts.bpm);
/** Smallest step whose start is at least `leadMs` after `serverMs`. */
export const nextStepAfter = (ts: TransportState, serverMs: number, leadMs: number) =>
  Math.ceil(stepPos(ts, serverMs + leadMs));

export type DropPhase = 'build' | 'drop' | null;
/** 'build' while the beat is suspended, 'drop' for the one bar after it returns. */
export function dropPhase(ts: TransportState, step: number): DropPhase {
  const d = ts.drop;
  if (!d) return null;
  if (step >= d.startStep && step < d.dropStep) return 'build';
  if (step >= d.dropStep && step < d.dropStep + STEPS_PER_BEAT * 2) return 'drop';
  return null;
}

// ---------------------------------------------------------------- messages

export interface PlayerInfo {
  id: string;
  name: string;
  color: string;
  role: Role;
  connected: boolean;
  /** Phone is playing its own audio (Stage mutes this player). */
  speaker: boolean;
  /** Latest sync statistics reported by that phone. */
  sync: SyncStats | null;
}

export interface SyncStats {
  /** server - local, ms */
  offset: number;
  /** robust std-dev of the kept offset samples, ms */
  jitter: number;
  /** lowest RTT in the window, ms */
  rttMin: number;
  rttLast: number;
  /** p90 of |fresh probe - applied offset|, ms: our "sync error" */
  err: number;
  /** mean lateness of the beat-flash frame vs the true beat, ms (<= 1 frame) */
  flashLate: number;
  samples: number;
}

/** A musical note/drum event. Sent by players, relayed by the server, generated locally for AUTO. */
export interface NoteEvent {
  /** player id, or "auto:<role>" for generated parts */
  pid: string;
  role: Role;
  /** absolute 16th-note step the event sounds on */
  step: number;
  /** Role-specific index: melody ladder position / bass chord-tone / pad voicing / drum voice */
  d: number;
  /** velocity 0..1 */
  v: number;
  /** length in steps (melody 2, bass 2, pads up to a bar) */
  dur: number;
  /** Explicit pitches (composed songs / imported MIDI). When present they replace the index->pitch mapping. */
  midi?: number[];
}

/** Raw gesture kinds: pointer down / move / up, shake, tilt. `at` is SERVER time (ms) at the gesture. */
export type RawKind = 'd' | 'm' | 'u' | 's' | 't';

export type ClientMsg =
  | { t: 'hello'; kind: 'stage' | 'player'; id?: string }
  | { t: 'join'; name: string }
  | { t: 'ping'; id: number; c0: number }
  | { t: 'stats'; stats: SyncStats }
  | { t: 'role'; role: Role }
  | { t: 'speaker'; on: boolean }
  | { t: 'note'; step: number; d: number; v: number; dur: number; role?: Role }
  | { t: 'ctl'; y: number; tilt: number }
  | { t: 'raw'; k: RawKind; at: number; x: number; y: number; v?: number }
  | { t: 'cmd'; cmd: 'bpm' | 'key' | 'scale' | 'drop' | 'auto' | 'speakers' | 'freestyle'; value?: number | string | boolean };

export type ServerMsg =
  | { t: 'welcome'; you: PlayerInfo | null; state: TransportState; serverNow: number }
  | { t: 'pong'; id: number; c0: number; s: number }
  | { t: 'state'; state: TransportState }
  | { t: 'roster'; players: PlayerInfo[] }
  | ({ t: 'note' } & NoteEvent)
  | { t: 'ctl'; pid: string; y: number; tilt: number }
  | { t: 'raw'; pid: string; role: Role; k: RawKind; at: number; x: number; y: number; v?: number }
  | { t: 'you'; you: PlayerInfo };

export const BPM_MIN = 60;
export const BPM_MAX = 180;
