/**
 * LOCAL SIMULATION. Not a connection to Human Orchestra: it fabricates a roster and a repeating groove so the
 * visuals can be developed without a server. The UI labels this mode everywhere it is active.
 * Events flow through the same activity pipeline, with pitches from the same resolver.
 */
import { activity } from '../state/activity';
import { useStore } from '../state/store';
import { resolveEvent } from './music';
import { stepTime, type PlayerInfo, type Role, type TransportState } from './protocol';

let timer: ReturnType<typeof setInterval> | null = null;

const ROSTER: PlayerInfo[] = [
  { id: 'sim-1', name: 'Sim Drummer', color: '#ff8fab', role: 'drums', connected: true, speaker: false },
  { id: 'sim-2', name: 'Sim Bassist', color: '#6cb8ff', role: 'bass', connected: true, speaker: false },
  { id: 'sim-3', name: 'Sim Soloist', color: '#5fd39a', role: 'melody', connected: true, speaker: false },
  { id: 'sim-4', name: 'Sim Pianist', color: '#ffb169', role: 'pads', connected: true, speaker: false },
];

export function startSimulation() {
  stopSimulation();
  activity.clear();
  const t0 = performance.now() + 300;
  const ts: TransportState = {
    bpm: 110, epoch: t0, root: 9, scale: 'minorPent', drop: null, autoBand: false, speakerMode: false, syncTest: false,
    freestyle: false, nowPlaying: null, game: null, sample: null, paused: null, recording: null,
  };
  useStore.getState().set({ log: [], mode: 'simulation', status: 'connected', error: null, url: 'local simulation', roster: ROSTER, transport: ts, rttMs: null, privilege: 'observer' });
  useStore.getState().pushLog('SIMULATION started (synthetic events)');
  let next = 0;
  const lead = 120;
  timer = setInterval(() => {
    const now = performance.now();
    while (stepTime(ts, next) < now + lead) {
      const s = next % 16, bar = Math.floor(next / 16);
      const ev = (role: Role, d: number, v = 0.8) => {
        const r = resolveEvent({ role, step: next, d }, ts);
        activity.schedule({
          type: 'instrument:note', instrumentId: role, source: 'phone', velocity: v, durSteps: 2, timestamp: stepTime(ts, next),
          ...(r.kind === 'drum' ? { drumVoice: r.voice } : { midi: r.midi }),
        }, stepTime(ts, next));
      };
      if (s === 0 || s === 10) ev('drums', 0, 1);
      if (s === 4 || s === 12) ev('drums', 1, 0.9);
      if (s % 2 === 0) ev('drums', 2, 0.5);
      if (s === 14) ev('drums', 3, 0.7);
      if ([0, 3, 6, 10, 12].includes(s)) ev('bass', [0, 1, 0, 2, 3][[0, 3, 6, 10, 12].indexOf(s)], 0.85);
      if (s === 0) ev('pads', bar % 4);
      if ([2, 5, 8, 11, 14].includes(s)) ev('melody', (bar * 3 + s) % 8, 0.7);
      next++;
    }
  }, 30);
}

export function stopSimulation() {
  if (timer) clearInterval(timer);
  timer = null;
  if (useStore.getState().mode === 'simulation') {
    activity.clear();
    useStore.getState().set({ mode: 'none', status: 'idle', roster: [], transport: null, url: '' });
  }
}

