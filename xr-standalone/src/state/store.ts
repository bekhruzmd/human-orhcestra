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
  log: LogLine[];
  set: (p: Partial<State>) => void;
  pushLog: (text: string) => void;
}

let logId = 0;
export const useStore = create<State>((set) => ({
  status: 'idle', mode: 'none', privilege: 'observer', url: '', error: null, rttMs: null,
  roster: [], transport: null, selected: null, xrSupported: 'unknown', inXR: false, placeNonce: 0, log: [],
  set: (p) => set(p),
  pushLog: (text) => set((s) => ({ log: [...s.log.slice(-11), { id: ++logId, text, at: Date.now() }] })),
}));
