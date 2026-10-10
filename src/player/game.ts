/**
 * Phone-side rhythm game: note highway, hit detection, scoring.
 *
 * Everything is a pure function of the synced clock:
 *   noteTime  = stepTime(transport, game.startStep + note.step)        (server ms)
 *   now       = clock.toServer(requestAnimationFrame timestamp)
 *   y(note)   = hitLine - (noteTime - now) * pxPerMs                   (no CSS animation anywhere)
 *   tap time  = clock.toServer(pointer event timeStamp)                (so judging ignores frame jitter)
 * so every phone judges against the same timeline the Stage uses to schedule its audio.
 *
 * Hits report participation. The Stage schedules the arrangement ahead independently of packet arrival;
 * successful taps lift upcoming notes without replaying notes that are already in the past.
 */
import type { ClockSync } from '../common/clock';
import type { Net } from '../common/net';
import { stepTime, beatMs, type PlayerInfo, type TransportState } from '../../shared/protocol';
import {
  DIFF, INSTRUMENT, accuracy, applyHit, applyMiss, buildChart, emptyStats, grade, judge,
  type ChartNote, type GameStats, type Judgement,
} from '../../shared/game';
import { getSong } from '../../shared/songs';

const LOOKAHEAD_MS = 1900;
const HIT_Y = 0.8;
const LANE_COLORS: Record<number, string[]> = {
  2: ['#ff4d6d', '#35d0ff'],
  3: ['#ff4d6d', '#ffd23f', '#35d0ff'],
  4: ['#ff4d6d', '#ffd23f', '#35d0ff', '#7cff6b'],
};
const DRUM_NAMES: Record<number, string[]> = { 2: ['KICK', 'SNARE'], 3: ['KICK', 'SNARE', 'HATS'], 4: ['KICK', 'SNARE', 'HAT', 'CLAP'] };

interface Deps { clock: ClockSync; net: Net; getTs: () => TransportState | null; getMe: () => PlayerInfo | null }
type Status = 0 | 1 | 2 | 3; // pending, hit, missed, skipped (late joiner)

export class GameUI {
  private el: HTMLElement | null = null;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private key = '';
  private chart: ChartNote[] = [];
  private status: Status[] = [];
  private cursor = 0;
  private stats: GameStats = emptyStats();
  private lastSent = '';
  private finished = false;
  private timingMs = readTiming();
  private lanes = 2;
  private feedback: { text: string; color: string; t: number } | null = null;
  private laneFlash: number[] = [];
  private bursts: { x: number; y: number; t: number; color: string }[] = [];
  private hud!: { score: HTMLElement; combo: HTMLElement; acc: HTMLElement };
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private app: HTMLElement, private d: Deps) { }

  get active() { return !!this.el; }

  /** Call whenever the transport state or our player info changes. */
  sync(ts: TransportState | null, me: PlayerInfo | null) {
    const g = ts?.game;
    if (!g || !me) { if (this.el) this.stop(); return; }
    if (!this.d.clock.isLocked) return;
    const key = `${g.songId}:${g.difficulty}:${g.startStep}:${me.role}`;
    if (key !== this.key || !this.el) this.start(ts!, me, key);
  }

  private start(ts: TransportState, me: PlayerInfo, key: string) {
    this.stop();
    const g = ts.game!;
    const song = g.song ?? getSong(g.songId);
    if (!song) return;
    this.key = key;
    this.chart = buildChart(song, me.role, g.difficulty);
    this.lanes = DIFF[g.difficulty].lanes;
    this.status = this.chart.map(() => 0 as Status);
    this.laneFlash = new Array(this.lanes).fill(0);
    this.finished = false;
    this.cursor = 0;
    this.feedback = null;
    this.bursts = [];
    // late joiner: notes already gone are skipped (not counted as misses)
    const now = this.d.clock.serverNow() - this.timingMs, good = DIFF[g.difficulty].good;
    this.chart.forEach((n, i) => { if (stepTime(ts, g.startStep + n.step) < now - good) this.status[i] = 3; });
    this.stats = emptyStats(this.status.filter((s) => s === 0).length);
    this.lastSent = '';

    const inst = INSTRUMENT[me.role];
    const el = document.createElement('div');
    el.className = 'game';
    el.innerHTML = `
      <div class="ghud">
        <div class="gs"><b>${inst.icon} ${inst.name}</b><small>${escapeHtml(song.title)} · ${g.difficulty.toUpperCase()}</small></div>
        <div class="gscore"><b id="g-score">0</b><small id="g-acc">accuracy –</small></div>
        <div class="gcombo"><b id="g-combo">0</b><small>COMBO</small></div>
      </div>
      <div class="ghelp">Follow the tune · hits lift your instrument · sound on Stage</div><canvas id="g-canvas"></canvas>
      <div class="glabels">${this.laneLabels(me)}</div>
      <div class="gtiming"><button id="g-earlier" aria-label="Move hit timing 10 milliseconds earlier">−</button><span id="g-timing"></span><button id="g-later" aria-label="Move hit timing 10 milliseconds later">+</button></div>`;
    this.app.appendChild(el);
    this.el = el;
    this.canvas = el.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.hud = { score: el.querySelector('#g-score')!, combo: el.querySelector('#g-combo')!, acc: el.querySelector('#g-acc')! };
    const timing = () => { el.querySelector('#g-timing')!.textContent = `Timing ${this.timingMs > 0 ? '+' : ''}${this.timingMs} ms · + if sound feels late`; };
    const adjust = (delta: number) => { this.timingMs = Math.max(-200, Math.min(200, this.timingMs + delta)); try { localStorage.setItem('ho.game.timing', String(this.timingMs)); } catch { } timing(); };
    el.querySelector<HTMLButtonElement>('#g-earlier')!.onclick = () => adjust(-10);
    el.querySelector<HTMLButtonElement>('#g-later')!.onclick = () => adjust(10);
    timing();
    this.resize();
    addEventListener('resize', this.onResize);
    this.canvas.onpointerdown = (e) => { e.preventDefault(); this.tap(e); };
    this.timer = setInterval(() => this.report(false), 400);
  }

  private laneLabels(me: PlayerInfo) {
    const cols = LANE_COLORS[this.lanes];
    const names = me.role === 'drums' ? DRUM_NAMES[this.lanes] : cols.map((_, i) => (this.lanes === 2 ? ['LOW', 'HIGH'][i] : this.lanes === 3 ? ['LOW', 'MID', 'HIGH'][i] : ['LOW', 'LOW-MID', 'HI-MID', 'HIGH'][i]));
    return names.map((n, i) => `<span style="--c:${cols[i]}">${n}</span>`).join('');
  }

  private onResize = () => this.resize();
  private resize() {
    if (!this.canvas) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    removeEventListener('resize', this.onResize);
    this.el?.remove();
    this.el = null;
    this.key = '';
  }

  // ---------------------------------------------------------------- input
  private tap(e: PointerEvent) {
    const ts = this.d.getTs(), me = this.d.getMe();
    if (!ts?.game || !me || this.finished || !this.d.clock.isLocked || !this.d.net.connected) return;
    const g = ts.game, rect = this.canvas.getBoundingClientRect();
    const lane = Math.max(0, Math.min(this.lanes - 1, Math.floor(((e.clientX - rect.left) / rect.width) * this.lanes)));
    this.laneFlash[lane] = 1;
    const local = e.timeStamp > 1e12 ? e.timeStamp - performance.timeOrigin : e.timeStamp || performance.now();
    const tTap = this.d.clock.toServer(local) - this.timingMs;
    const spec = DIFF[g.difficulty];

    // closest unresolved note in this lane within the GOOD window
    let best = -1, bestErr = Infinity;
    for (let i = this.cursor; i < this.chart.length; i++) {
      const t = stepTime(ts, g.startStep + this.chart[i].step);
      if (t > tTap + spec.good) break;
      if (this.status[i] !== 0 || this.chart[i].lane !== lane) continue;
      const err = tTap - t;
      if (Math.abs(err) <= spec.good && Math.abs(err) < Math.abs(bestErr)) { best = i; bestErr = err; }
    }
    if (best < 0) return; // a tap with no note nearby: no sound, no penalty (beginner-friendly)
    const j = judge(g.difficulty, bestErr) as Judgement;
    const n = this.chart[best];
    this.status[best] = 1;
    this.stats = applyHit(this.stats, j);
    this.say(j === 'perfect' ? 'PERFECT' : 'GOOD', j === 'perfect' ? '#7cff6b' : '#ffd23f');
    this.bursts.push({ x: (lane + 0.5) / this.lanes, y: HIT_Y, t: performance.now(), color: LANE_COLORS[this.lanes][lane] });
    navigator.vibrate?.(8);
    // Report participation; the Stage never retriggers a past note.
    this.d.net.send({ t: 'ghit', startStep: g.startStep, step: g.startStep + n.step });
    this.updateHud();
  }

  private say(text: string, color: string) { this.feedback = { text, color, t: performance.now() }; }

  private updateHud() {
    this.hud.score.textContent = this.stats.score.toLocaleString();
    this.hud.combo.textContent = String(this.stats.combo);
    this.hud.acc.textContent = `accuracy ${accuracy({ ...this.stats, total: this.stats.perfect + this.stats.good + this.stats.miss }).toFixed(0)}%`;
  }

  private report(force: boolean) {
    const s = JSON.stringify(this.stats);
    if (!force && s === this.lastSent) return;
    this.lastSent = s;
    this.d.net.send({ t: 'gstats', s: this.stats });
  }

  // ----------------------------------------------------------------- frame
  frame(rafTime: number) {
    const ts = this.d.getTs();
    if (!this.el || !ts?.game || !this.d.clock.isLocked) return;
    const g = ts.game, spec = DIFF[g.difficulty];
    const now = this.d.clock.toServer(rafTime) - this.timingMs;
    const noteT = (n: ChartNote) => stepTime(ts, g.startStep + n.step);

    // notes that slipped past the GOOD window become misses
    while (this.cursor < this.chart.length && this.status[this.cursor] !== 0 && this.status[this.cursor] !== undefined) this.cursor++;
    for (let i = this.cursor; i < this.chart.length; i++) {
      if (noteT(this.chart[i]) >= now - spec.good) break;
      if (this.status[i] === 0) {
        this.status[i] = 2;
        this.stats = applyMiss(this.stats);
        this.say('MISS', '#ff4d6d');
        this.updateHud();
      }
    }
    if (!this.finished && now > stepTime(ts, g.endStep)) {
      this.finished = true;
      this.report(true);
      this.showResults();
    }
    this.draw(ts, now, spec.good);
  }

  private draw(ts: TransportState, now: number, goodMs: number) {
    const g = ts.game!;
    const { ctx } = this;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const hitY = h * HIT_Y, pxPerMs = hitY / LOOKAHEAD_MS;
    const colors = LANE_COLORS[this.lanes], lw = w / this.lanes;
    ctx.clearRect(0, 0, w, h);

    // lanes
    for (let l = 0; l < this.lanes; l++) {
      ctx.fillStyle = l % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.015)';
      ctx.fillRect(l * lw, 0, lw, h);
      const f = this.laneFlash[l];
      if (f > 0.01) { ctx.fillStyle = colors[l] + Math.round(f * 70).toString(16).padStart(2, '0'); ctx.fillRect(l * lw, 0, lw, h); this.laneFlash[l] *= 0.88; }
      ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(l * lw, 0); ctx.lineTo(l * lw, h); ctx.stroke();
    }
    // beat lines: timeline-driven, so you can SEE the tempo
    const bm = beatMs(ts.bpm), t0 = stepTime(ts, g.startStep);
    const firstBeat = Math.ceil((now - 150 - t0) / bm);
    for (let b = firstBeat; ; b++) {
      const t = t0 + b * bm, y = hitY - (t - now) * pxPerMs;
      if (y < -4) break;
      if (y > h) continue;
      ctx.strokeStyle = b % 4 === 0 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.08)';
      ctx.lineWidth = b % 4 === 0 ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    // hit line
    for (let l = 0; l < this.lanes; l++) {
      ctx.fillStyle = colors[l];
      ctx.globalAlpha = 0.9;
      round(ctx, l * lw + 6, hitY - 6, lw - 12, 12, 6); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // notes
    const nh = Math.min(34, lw * 0.34);
    for (let i = this.cursor; i < this.chart.length; i++) {
      const n = this.chart[i], t = stepTime(ts, g.startStep + n.step);
      const y = hitY - (t - now) * pxPerMs;
      if (y < -nh) break;
      const st = this.status[i];
      if (st === 1 || st === 3 || y > h + nh) continue;
      ctx.globalAlpha = st === 2 ? 0.25 : 1;
      const c = st === 2 ? '#888' : colors[n.lane];
      const x = n.lane * lw + lw * 0.1, nw = lw * 0.8;
      ctx.fillStyle = c; round(ctx, x, y - nh / 2, nw, nh, 12); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.35)'; round(ctx, x + 6, y - nh / 2 + 4, nw - 12, nh * 0.28, 8); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // hit bursts
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i], k = (performance.now() - b.t) / 420;
      if (k >= 1) { this.bursts.splice(i, 1); continue; }
      ctx.strokeStyle = b.color; ctx.globalAlpha = 1 - k; ctx.lineWidth = 6 * (1 - k) + 1;
      ctx.beginPath(); ctx.arc(b.x * w, b.y * h, 18 + k * 60, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // feedback text
    if (this.feedback) {
      const k = (performance.now() - this.feedback.t) / 600;
      if (k < 1) {
        ctx.globalAlpha = 1 - k; ctx.fillStyle = this.feedback.color;
        ctx.font = `900 ${34 - 6 * k}px ui-rounded, system-ui, sans-serif`; ctx.textAlign = 'center';
        ctx.fillText(this.feedback.text, w / 2, hitY - 70 - 18 * k);
        ctx.globalAlpha = 1; ctx.textAlign = 'left';
      }
    }

    // count-in: beats until the song starts
    const toStart = t0 - now;
    if (toStart > -700) {
      const beatsLeft = Math.ceil(toStart / bm);
      const label = toStart <= 0 ? 'GO!' : beatsLeft <= 3 ? String(beatsLeft) : 'GET READY';
      ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
      ctx.font = `900 ${label.length > 2 ? 40 : 120}px ui-rounded, system-ui, sans-serif`;
      ctx.fillText(label, w / 2, h * 0.42);
      ctx.font = '700 16px ui-rounded, system-ui, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.7)';
      ctx.fillText('tap the notes as they hit the line', w / 2, h * 0.42 + 40);
      ctx.textAlign = 'left';
    }
    void goodMs;
  }

  private showResults() {
    if (!this.el) return;
    const s = this.stats, acc = accuracy(s), gr = grade(acc);
    const card = document.createElement('div');
    card.className = 'gresults';
    card.innerHTML = `<div class="grade g${gr}">${gr}</div>
      <div class="gbig">${s.score.toLocaleString()}</div>
      <div class="grid"><span>Accuracy</span><b>${acc.toFixed(0)}%</b><span>Max combo</span><b>${s.maxCombo}</b>
      <span>Perfect</span><b>${s.perfect}</b><span>Good</span><b>${s.good}</b><span>Missed</span><b>${s.miss}</b></div>
      <p>Team results are on the big screen…</p>`;
    this.el.appendChild(card);
  }

  /** Debug/testing hook: the next unresolved note's lane and how many ms away it is. */
  upcoming() {
    const ts = this.d.getTs();
    if (!ts?.game) return null;
    const now = this.d.clock.serverNow() - this.timingMs;
    for (let i = this.cursor; i < this.chart.length; i++) if (this.status[i] === 0) {
      return { lane: this.chart[i].lane, inMs: stepTime(ts, ts.game.startStep + this.chart[i].step) - now, lanes: this.lanes, id: i };
    }
    return null;
  }
  get currentStats() { return this.stats; }
}

function round(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function escapeHtml(s: string) { return s.replace(/[&<>"\']/g, (c) => `&#${c.charCodeAt(0)};`); }

function readTiming() { try { const n = Number(localStorage.getItem('ho.game.timing')); return Number.isFinite(n) ? Math.max(-200, Math.min(200, n)) : 0; } catch { return 0; } }
