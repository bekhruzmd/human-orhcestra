/**
 * Stage visuals. Designed to be fully legible with the sound OFF:
 *   - one lane per player (colour + name + instrument); AUTO lanes are dashed and badged
 *   - a 2-bar piano roll per lane; every note fires a burst sized by velocity AT ITS STEP TIME
 *   - drums pulse the whole screen
 * Events are queued with their server-time stamp and released by the same synced clock that drives audio.
 */
import { ROLE_INFO, STEPS_PER_BAR, dropPhase, stepPos, type NoteEvent, type Role, type TransportState } from '../../shared/protocol';
import { resolveEvent } from '../../shared/music';
import { clamp } from '../common/util';

export interface Lane { id: string; name: string; role: Role; color: string; auto: boolean; connected: boolean; speaker: boolean }

interface Hit { step: number; dur: number; v: number; yN: number; muted: boolean; voice: number }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: string }
interface Ring { x: number; y: number; t: number; color: string; size: number }

const ROLL_STEPS = STEPS_PER_BAR * 2;
const INK = '#2b2540';
const INK_SOFT = '#5c5577';
const ink = (a: number) => `rgba(43,37,64,${a})`;
const PIXEL_FONT = '"Silkscreen", ui-monospace, monospace';

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

export class Viz {
  private ctx: CanvasRenderingContext2D;
  private w = 0; private h = 0;
  private pending: { at: number; ev: NoteEvent; muted: boolean }[] = [];
  private hits = new Map<string, Hit[]>();
  private glow = new Map<string, number>();
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private pulse = 0; private pulseColor = '#ffffff';
  private shock = 0; // drop impact
  private laneY = new Map<string, { y: number; h: number }>();
  private lastPlayhead = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.w = this.canvas.clientWidth; this.h = this.canvas.clientHeight;
    this.canvas.width = this.w * dpr; this.canvas.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  push(ev: NoteEvent, at: number, muted = false) { this.pending.push({ at, ev, muted }); }

  /** Pitch/voice -> vertical position inside the lane (0 bottom .. 1 top). */
  private yNorm(ev: NoteEvent, ts: TransportState): { yN: number; voice: number } {
    const r = resolveEvent(ev, ts);
    if (r.kind === 'drum') return { yN: (r.voice + 0.5) / 4, voice: r.voice };
    const top = Math.max(...r.midi);
    if (ev.role === 'bass') return { yN: (top - 28) / 16, voice: 0 };
    if (ev.role === 'pads') return { yN: 0.5, voice: 0 };
    return { yN: (top - 55) / 30, voice: 0 };
  }

  draw(serverMs: number, ts: TransportState, lanes: Lane[], opts: { beatPulse: number; downbeat: boolean }) {
    const { ctx, w, h } = this;
    const pos = stepPos(ts, serverMs);
    const step = Math.floor(pos);
    const phase = dropPhase(ts, step);
    const inBuild = phase === 'build';

    // ---- release due events (visual happens at the same server time the sound does)
    this.pending.sort((a, b) => a.at - b.at);
    while (this.pending.length && this.pending[0].at <= serverMs) {
      const { ev, at, muted } = this.pending.shift()!;
      if (serverMs - at > 400) continue; // stale (tab was hidden)
      const lane = lanes.find((l) => l.id === ev.pid);
      if (!lane) continue;
      const { yN, voice } = this.yNorm(ev, ts);
      const isMuted = muted || (inBuild && (ev.role === 'drums' || ev.role === 'bass'));
      const arr = this.hits.get(lane.id) ?? this.hits.set(lane.id, []).get(lane.id)!;
      arr.push({ step: ev.step, dur: ev.dur, v: ev.v, yN, voice, muted: isMuted });
      if (!isMuted) this.burst(lane, ev, yN, ts);
    }

    // ---- background + drum pulse
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    this.pulse *= 0.9; this.shock *= 0.93; this.glow.forEach((v, k) => this.glow.set(k, v * 0.9));
    const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    grad.addColorStop(0, rgba(this.pulseColor, 0.28 * this.pulse + (opts.downbeat ? 0.04 : 0)));
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);

    // ---- lanes
    const areaTop = 12, areaH = h - 24;
    const n = Math.max(1, lanes.length);
    const maxLaneH = n === 1 ? 180 : n === 2 ? 150 : n <= 4 ? 128 : 100;
    const laneH = Math.min(maxLaneH, Math.max(64, (areaH - (n - 1) * 8) / n));
    const labelW = Math.max(220, Math.min(300, Math.floor(w * 0.22)));
    const x0 = labelW + 16, rw = w - x0 - 16, cell = rw / ROLL_STEPS;
    const playX = x0 + ((pos % ROLL_STEPS) / ROLL_STEPS) * rw;
    this.laneY.clear();
    const totalH = n * laneH + (n - 1) * 8;
    const top0 = areaTop + Math.max(0, (areaH - totalH) / 2);

    lanes.forEach((lane, i) => {
      const y = top0 + i * (laneH + 8);
      this.laneY.set(lane.id, { y, h: laneH });
      const g = this.glow.get(lane.id) ?? 0;
      ctx.save();
      ctx.globalAlpha = lane.connected ? 1 : 0.4;
      // lane body
      ctx.fillStyle = rgba(lane.color, 0.12 + 0.25 * g);
      ctx.fillRect(0, y, w, laneH);
      ctx.lineWidth = 3;
      ctx.strokeStyle = lane.auto ? ink(0.45) : INK;
      if (lane.auto) ctx.setLineDash([8, 6]);
      ctx.strokeRect(1.5, y + 1.5, w - 3, laneH - 3);
      ctx.setLineDash([]);
      // colour tab
      ctx.fillStyle = lane.color; ctx.globalAlpha *= lane.auto ? 0.6 : 1;
      ctx.fillRect(0, y, 14, laneH);
      ctx.globalAlpha = lane.connected ? 1 : 0.4;
      ctx.fillStyle = INK; ctx.fillRect(14, y, 3, laneH);
      // label
      ctx.fillStyle = INK;
      const roleSize = Math.max(15, Math.min(24, Math.floor(laneH * 0.23)));
      ctx.font = `700 ${roleSize}px ${PIXEL_FONT}`;
      ctx.textBaseline = 'top';
      const roleY = y + Math.max(10, Math.floor(laneH * 0.16));
      ctx.fillText(`${ROLE_INFO[lane.role].icon} ${ROLE_INFO[lane.role].label.toUpperCase()}`, 26, roleY);

      const nameSize = Math.max(12, Math.min(17, Math.floor(laneH * 0.17)));
      ctx.font = `700 ${nameSize}px ${PIXEL_FONT}`;
      ctx.textBaseline = 'bottom';
      const nameY = y + laneH - Math.max(10, Math.floor(laneH * 0.16));
      ctx.fillStyle = INK_SOFT;
      const isStandby = lane.id.startsWith('standby:');
      const isReplay = lane.id.startsWith('replay:');
      let nameText = isStandby ? 'STANDBY · READY' : isReplay ? 'REPLAY' : lane.auto ? 'AUTO BAND' : lane.name;
      if (lane.speaker) nameText += ' (SPK)';
      if (!lane.connected && !lane.auto && !isStandby && !isReplay) nameText += ' · offline';
      const maxW = labelW - 32;
      let fit = nameSize; // shrink the font before cutting the text, so short labels stay whole
      while (fit > 11 && ctx.measureText(nameText).width > maxW) { fit--; ctx.font = `700 ${fit}px ${PIXEL_FONT}`; }
      while (nameText.length > 4 && ctx.measureText(nameText).width > maxW) {
        nameText = nameText.slice(0, -2) + '…';
      }
      ctx.fillText(nameText, 26, nameY);
      // roll grid
      ctx.lineWidth = 1;
      for (let k = 0; k <= ROLL_STEPS; k++) {
        const x = x0 + k * cell;
        ctx.strokeStyle = k % 16 === 0 ? ink(0.35) : k % 4 === 0 ? ink(0.16) : ink(0.06);
        ctx.beginPath(); ctx.moveTo(x, y + 8); ctx.lineTo(x, y + laneH - 8); ctx.stroke();
      }
      // hits
      const arr = this.hits.get(lane.id);
      if (arr) {
        for (let j = arr.length - 1; j >= 0; j--) {
          const hit = arr[j];
          const age = pos - hit.step;
          if (age > ROLL_STEPS) { arr.splice(j, 1); continue; }
          const a = Math.pow(Math.max(0, 1 - age / ROLL_STEPS), 0.8);
          const hx = x0 + ((hit.step % ROLL_STEPS) / ROLL_STEPS) * rw;
          const hh = lane.role === 'pads' ? laneH - 24 : Math.max(10, laneH * 0.2);
          const hy = lane.role === 'pads' ? y + 12 : y + 10 + (1 - clamp(hit.yN, 0, 1)) * (laneH - 20 - hh);
          const hw = Math.max(8, Math.min(hit.dur, ROLL_STEPS - (hit.step % ROLL_STEPS)) * cell - 3);
          if (hit.muted) { ctx.strokeStyle = ink(a * 0.5); ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.strokeRect(hx, hy, hw, hh); ctx.setLineDash([]); }
          else {
            ctx.fillStyle = rgba(lane.color, lane.role === 'pads' ? 0.55 * a : a * (0.7 + 0.3 * hit.v));
            ctx.fillRect(hx, hy, hw, hh);
            ctx.strokeStyle = ink(a); ctx.lineWidth = 2;
            ctx.strokeRect(hx + 1, hy + 1, hw - 2, hh - 2);
          }
        }
      }
      ctx.restore();
    });

    // playhead
    if (lanes.length) {
      ctx.fillStyle = INK;
      ctx.fillRect(Math.round(playX) - 2, top0 - 6, 4, totalH + 12);
    }
    this.lastPlayhead = playX;

    this.drawParticles();

    // ---- drop overlays
    if (inBuild && ts.drop) {
      const prog = (pos - ts.drop.startStep) / (ts.drop.dropStep - ts.drop.startStep);
      const flick = 0.35 + 0.35 * Math.sin(pos * Math.PI * (1 + prog * 3));
      ctx.strokeStyle = `rgba(255,143,171,${flick + 0.2})`; ctx.lineWidth = 10 + prog * 26;
      ctx.strokeRect(0, 0, w, h);
      ctx.fillStyle = ink(0.25 + 0.6 * prog * prog);
      ctx.fillRect(0, h - 10, w * prog, 10);
    }
    if (this.shock > 0.02) {
      ctx.fillStyle = `rgba(217,204,255,${this.shock * 0.8})`; ctx.fillRect(0, 0, w, h);
    }
  }

  private burst(lane: Lane, ev: NoteEvent, yN: number, ts: TransportState) {
    const p = this.laneY.get(lane.id);
    const y = p ? p.y + p.h * (1 - clamp(yN, 0, 1)) * 0.8 + p.h * 0.1 : this.h / 2;
    const x = this.lastPlayhead;
    const count = Math.round(6 + 26 * ev.v);
    for (let i = 0; i < count && this.particles.length < 700; i++) {
      const a = Math.random() * Math.PI * 2, s = (1 + Math.random() * 5) * (0.6 + ev.v);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 24 + Math.random() * 26, size: (2 + Math.random() * 5) * (0.5 + ev.v), color: lane.color });
    }
    this.rings.push({ x, y, t: 0, color: lane.color, size: 30 + 90 * ev.v });
    this.glow.set(lane.id, Math.min(1, (this.glow.get(lane.id) ?? 0) + 0.5 + 0.4 * ev.v));
    if (ev.role === 'drums') {
      const r = resolveEvent(ev, ts);
      const kick = r.kind === 'drum' && r.voice === 0, snare = r.kind === 'drum' && r.voice === 1;
      this.pulse = Math.max(this.pulse, (kick ? 1 : snare ? 0.8 : 0.35) * (0.5 + 0.5 * ev.v));
      this.pulseColor = lane.color;
    }
  }

  /** Called by main when a drop lands. */
  impact() { this.shock = 1; this.pulse = 1; this.pulseColor = '#d9ccff'; }

  /** Square pixel particles and outline rings: additive blending would vanish on the white ground. */
  private drawParticles() {
    const { ctx } = this;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]; r.t += 1;
      const k = r.t / 28;
      if (k >= 1) { this.rings.splice(i, 1); continue; }
      const s = r.size * (0.25 + k);
      ctx.strokeStyle = rgba(r.color, 0.9 * (1 - k)); ctx.lineWidth = Math.round(5 * (1 - k)) + 1;
      ctx.strokeRect(Math.round(r.x - s), Math.round(r.y - s), Math.round(s * 2), Math.round(s * 2));
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]; p.life++;
      if (p.life > p.max) { this.particles.splice(i, 1); continue; }
      p.x += p.vx; p.y += p.vy; p.vx *= 0.96; p.vy *= 0.96;
      const k = 1 - p.life / p.max, s = Math.max(2, Math.round(p.size * (0.6 + k)));
      ctx.fillStyle = rgba(p.color, k);
      ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), s, s);
    }
  }
}
