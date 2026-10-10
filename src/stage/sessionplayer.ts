/**
 * SessionPlayer: replays recorded sessions through the Stage's synthesizers and visualizer.
 */
import { stepPos, type NoteEvent, type Role, type TransportState } from '../../shared/protocol';
import type { Engine } from '../common/engine';
import type { Viz } from './visuals';
import type { ClockSync } from '../common/clock';

export interface RecordedSessionItem {
  id: string;
  startedAt: string;
  endedAt: string;
  endedReason: string;
  mode: string;
  songId: string | null;
  difficulty: string | null;
  players: number;
  summary?: { total: number; byType?: Record<string, number> };
}

export interface DetailedRecording extends RecordedSessionItem {
  transportStart: TransportState;
  events: Array<{
    seq: number;
    at: number;
    step: number | null;
    type: string;
    pid: string;
    role: Role | null;
    payload: {
      d?: number;
      v?: number;
      dur?: number;
      midi?: number[] | number;
      action?: string;
      cmd?: string;
    };
  }>;
}

export class SessionPlayer {
  private active = false;
  private timer: number | null = null;
  private startTime = 0;
  private currentRec: DetailedRecording | null = null;
  private notes: Array<{ relMs: number; ev: NoteEvent }> = [];
  private nextIndex = 0;
  private totalMs = 0;

  constructor(
    private engine: Engine,
    private viz: Viz,
    private clock: ClockSync,
    private getTransport: () => TransportState | null,
  ) {}

  get isPlaying() {
    return this.active;
  }

  get sessionTitle() {
    if (!this.currentRec) return '';
    try {
      const date = new Date(this.currentRec.startedAt);
      return `Session ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    } catch {
      return `Session ${this.currentRec.id.slice(0, 8)}`;
    }
  }

  play(
    rec: DetailedRecording,
    onProgress: (elapsedMs: number, totalMs: number) => void,
    onFinish: () => void,
  ): boolean {
    this.stop();
    const rawNotes = (rec.events || []).filter((e) => e.type === 'note' && e.payload);
    if (!rawNotes.length) return false;

    rawNotes.sort((a, b) => a.at - b.at);
    const t0 = rawNotes[0].at;
    this.notes = rawNotes.map((e) => {
      const p = e.payload;
      const midiArr = Array.isArray(p.midi) ? p.midi : typeof p.midi === 'number' ? [p.midi] : undefined;
      return {
        relMs: Math.max(0, e.at - t0),
        ev: {
          pid: e.pid || `replay:${e.role || 'melody'}`,
          role: e.role || 'melody',
          step: e.step ?? 0,
          d: p.d ?? 0,
          v: p.v ?? 0.7,
          dur: p.dur ?? 2,
          midi: midiArr,
        },
      };
    });

    this.totalMs = this.notes[this.notes.length - 1].relMs + 1600;
    this.currentRec = rec;
    this.active = true;
    this.nextIndex = 0;
    this.startTime = performance.now();

    const tick = () => {
      if (!this.active) return;
      const elapsed = performance.now() - this.startTime;
      const ts = this.getTransport();
      const serverNow = this.clock.serverNow();

      while (this.nextIndex < this.notes.length && this.notes[this.nextIndex].relMs <= elapsed) {
        const item = this.notes[this.nextIndex++];
        const evToPlay: NoteEvent = {
          ...item.ev,
          step: ts ? Math.round(stepPos(ts, serverNow)) : item.ev.step,
        };
        this.engine.play(evToPlay);
        this.viz.push(evToPlay, serverNow);
      }

      onProgress(elapsed, this.totalMs);

      if (elapsed >= this.totalMs) {
        this.stop();
        onFinish();
      } else {
        this.timer = window.setTimeout(tick, 20);
      }
    };

    tick();
    return true;
  }

  stop() {
    this.active = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.currentRec = null;
    this.notes = [];
    this.nextIndex = 0;
  }
}
