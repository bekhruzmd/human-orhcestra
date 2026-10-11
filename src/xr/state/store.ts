import { create } from 'zustand';
import type { PlayerInfo, Role, TransportState } from '../networking/protocol';

export type ConnStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
/** 'live' = real Human Orchestra server. 'simulation' = local synthetic events, always labelled as such. */
export type DataMode = 'none' | 'live' | 'simulation';
/** 'observer' only listens. 'conductor' additionally declares itself a Stage so it may send server commands. */
export type Privilege = 'observer' | 'conductor';

export interface LogLine { id: number; text: string; at: number }

interface State {
  status: ConnStatus;
  mode: DataMode;
  privilege: Privilege;
  url: string;
  error: string | null;
  rttMs: number | null;
  roster: PlayerInfo[];
  transport: TransportState | null;
  selected: Role | null;
  xrSupported: 'unknown' | 'yes' | 'no';
  inXR: boolean;
  /** bump to re-place the orchestra in front of the user */
  placeNonce: number;
  /** Stage audio over WebRTC: off, asking the Stage, or playing. */
  audio: 'off' | 'waiting' | 'live';
  audioMuted: boolean;
  /** bump to put every movable panel back where it started */
  panelResetNonce: number;
  /** baton conducting: on/off, last detected tempo, and a pulse counter for the beat flash */
  /** desktop preview only: the pointer is over a panel, so mouse drags must not orbit the camera */
  uiHover: boolean;
  /** panels move aside while a song plays: 'auto' follows the song, 'on' always, 'off' never */
  focusMode: 'auto' | 'on' | 'off';
  baton: { on: boolean; bpm: number | null; beats: number; dynamics: boolean };
  log: LogLine[];
  set: (p: Partial<State>) => void;
  pushLog: (text: string) => void;
}

let logId = 0;
export const useStore = create<State>((set) => ({
  status: 'idle', mode: 'none', privilege: 'observer', url: '', error: null, rttMs: null,
  roster: [], transport: null, selected: null, xrSupported: 'unknown', inXR: false, placeNonce: 0, audio: 'off', audioMuted: false, panelResetNonce: 0, uiHover: false, focusMode: 'auto', baton: { on: false, bpm: null, beats: 0, dynamics: false }, log: [],
  set: (p) => set(p),
  pushLog: (text) => set((s) => ({ log: [...s.log.slice(-11), { id: ++logId, text, at: Date.now() }] })),
}));

/** Is a song (full jam, band preview or rhythm game) playing? */
export const songPlaying = (t: TransportState | null) => !!t && (!!t.game || !!t.nowPlaying);
/** Focus mode: the panels dock to the sides so the instruments have the room. */
export const isFocus = (s: Pick<State, 'focusMode' | 'transport'>) => s.focusMode === 'on' || (s.focusMode === 'auto' && songPlaying(s.transport));
