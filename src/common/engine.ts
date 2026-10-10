/**
 * Audio engine (Tone.js). Runs on the Stage (everybody's sound) and on a phone in "speaker" mode
 * (only that phone's own part).
 *
 * Scheduling rule: an event is addressed by its 16th-note step. We turn   step -> server time -> local
 * performance.now() time -> AudioContext time,  and hand that absolute time to the synth. We do NOT
 * use Tone.Transport: the one transport in this system lives on the server.
 */
import * as Tone from 'tone';
import { dropPhase, stepTime, STEPS_PER_BAR, type NoteEvent, type Role, type TransportState } from '../../shared/protocol';
import { mtof, resolveEvent, type Key, type Resolved } from '../../shared/music';
import type { ClockSync } from './clock';
import { clamp } from './util';

interface Voice {
  out: Tone.Gain;
  trigger(r: ReturnType<typeof resolveEvent>, time: number, durSec: number, vel: number): void;
  ctl(y: number, tilt: number): void;
  dispose(): void;
}

export class Engine {
  ready = false;
  /** user-tunable trim (ms) for known output-latency error, see debug drawer */
  trimMs = 0;
  lateCount = 0;
  lastLateMs = 0;

  private master!: Tone.Gain;
  private limiter!: Tone.Limiter;
  private revBus!: Tone.Reverb;
  private delBus!: Tone.FeedbackDelay;
  private voices = new Map<string, { voice: Voice; role: Role; used: number; lastT: number; sends: Tone.Gain[] }>();
  private fxKit: DrumKit | null = null;
  private lastDropStart = -1;
  private ts: TransportState | null = null;

  constructor(private clock: ClockSync, private isStage: boolean) {}

  /** Must be called from a user gesture (tap) - browsers keep audio suspended until then. */
  private starting: Promise<void> | null = null;
  async start() {
    if (this.ready) { await Tone.start(); return; }
    if (this.starting) return this.starting;
    this.starting = this.initialize();
    try { await this.starting; } finally { this.starting = null; }
  }

  private async initialize() {
    await Tone.start();
    const ctx = Tone.getContext();
    ctx.lookAhead = 0; // we schedule absolute times ourselves
    this.master = new Tone.Gain(0.9);
    this.limiter = new Tone.Limiter(-1);
    this.master.chain(new Tone.Compressor(-16, 3), this.limiter, Tone.getDestination());
    this.revBus = new Tone.Reverb({ decay: 2.6, preDelay: 0.01, wet: 1 });
    await this.revBus.generate();
    this.revBus.connect(this.master);
    this.delBus = new Tone.FeedbackDelay({ delayTime: 0.3, feedback: 0.32, wet: 1 });
    this.delBus.connect(this.master);
    this.delBus.connect(this.revBus);
    this.fxKit = new DrumKit(this.master, this.revBus);
    this.ready = true;
    if (this.ts) this.setTransport(this.ts);
  }

  /** The signal the recorder taps (post-limiter, i.e. what the room hears). */
  get tap(): Tone.ToneAudioNode { return this.limiter; }
  get context() { return Tone.getContext().rawContext as AudioContext; }

  // ---------------------------------------------------------------- uploaded audio
  private samples = new Set<Tone.ToneBufferSource>();
  /** Decode compressed audio (mp3/wav/m4a/ogg) with the browser's own decoder. */
  decode(data: ArrayBuffer): Promise<AudioBuffer> { return Tone.getContext().decodeAudioData(data); }

  /**
   * Play part of an uploaded file at a server time. `rate` re-times it to the transport tempo (transportBpm /
   * fileBpm), so a slice or a loop stays on the shared grid. Feeds the master bus, so the recorder hears it.
   */
  playSample(buf: Tone.ToneAudioBuffer, serverMs: number, offset: number, bufSeconds: number, rate: number, gain: number, loop?: { start: number; end: number }): boolean {
    if (!this.ready) return false;
    let t = this.ctxTime(serverMs);
    const now = this.context.currentTime;
    if (t < now) { if (now - t > 0.25 && !loop) return false; t = now + 0.005; } // late: play ASAP, unless hopelessly stale
    const src = new Tone.ToneBufferSource({ url: buf, playbackRate: rate, fadeIn: 0.004, fadeOut: 0.025 });
    const g = new Tone.Gain(gain);
    src.connect(g); g.connect(this.master);
    if (loop) { src.loop = true; src.loopStart = loop.start; src.loopEnd = loop.end; src.start(t, offset); }
    else { src.start(t, offset); src.stop(t + bufSeconds / rate); }
    this.samples.add(src);
    this.sampleStarts++;
    src.onended = () => { this.samples.delete(src); try { src.dispose(); g.dispose(); } catch { /* already gone */ } };
    return true;
  }
  sampleStarts = 0;
  stopSamples() {
    this.samples.forEach((s) => { try { s.stop(); } catch { /* not started */ } });
    this.samples.clear();
  }

  silence() {
    this.voices.forEach((e) => { e.voice.dispose(); e.sends.forEach((s) => s.dispose()); });
    this.voices.clear();
  }

  private gameMode = false;
  /** Rhythm-game mode: the pads/keys voice gets a fast attack so a tap speaks immediately (piano-like). */
  setGame(on: boolean) {
    if (on === this.gameMode) return;
    this.gameMode = on;
    this.silence();
  }

  private suspendedByPause = false;
  /** Pause freezes everything already scheduled (notes, sample slices, the backing loop); resume continues in place. */
  private applyPause(ts: TransportState) {
    if (!this.ready) return;
    const ctx = this.context;
    if (ts.paused != null && ctx.state === 'running') { this.suspendedByPause = true; void ctx.suspend(); }
    else if (ts.paused == null && this.suspendedByPause) { this.suspendedByPause = false; void ctx.resume(); }
  }

  setTransport(ts: TransportState) {
    this.ts = ts;
    this.applyPause(ts);
    this.setGame(!!ts.game || !!ts.nowPlaying);
    if (!this.ready) return;
    // dotted-eighth echo, locked to tempo
    this.delBus.delayTime.rampTo((60 / ts.bpm) * 0.75, 0.05);
    if (this.isStage && ts.drop && ts.drop.startStep !== this.lastDropStart) {
      this.lastDropStart = ts.drop.startStep;
      this.scheduleDrop(ts);
    }
  }

  /**
   * Server time (ms) -> AudioContext time (s) such that the sound is HEARD at that server time.
   * Uses getOutputTimestamp() (Chrome/Firefox) which pairs the audio clock with performance.now()
   * including output latency; otherwise falls back to currentTime minus the reported latency.
   */
  ctxTime(serverMs: number): number {
    const p = this.clock.toLocal(serverMs) + this.trimMs;
    const raw = this.context;
    // Tone wraps the context (standardized-audio-context) and hides the newer latency APIs; use the native one.
    const native = ((raw as any)._nativeContext ?? raw) as AudioContext;
    const o = native.getOutputTimestamp?.();
    if (o && o.performanceTime && o.contextTime) return o.contextTime + (p - o.performanceTime) / 1000;
    const lat = native.outputLatency || native.baseLatency || 0;
    return raw.currentTime + (p - performance.now()) / 1000 - lat;
  }

  /**
   * Schedule an event. Returns false if it was not audible (muted by the drop build-up, engine not ready).
   * `audible=false` lets the Stage keep drawing a phone-speaker player's notes without playing them.
   */
  play(ev: NoteEvent, audible = true): boolean {
    if (!this.ready || !this.ts || !audible) return false;
    const ts = this.ts;
    // Breakdown: drums + bass drop out while the build-up runs; the beat "returns" at dropStep.
    if (dropPhase(ts, ev.step) === 'build' && (ev.role === 'drums' || ev.role === 'bass')) return false;

    const at = stepTime(ts, ev.step);
    let t = this.ctxTime(at);
    const now = this.context.currentTime;
    if (t < now) { // message arrived after its step: play ASAP rather than dropping the note
      this.lastLateMs = (now - t) * 1000;
      this.lateCount++;
      if (this.lastLateMs > 250) return false; // too stale to be musical
      t = now + 0.005;
    }
    const key: Key = ts;
    const r = resolveEvent(ev, key);
    const stepSec = 60 / ts.bpm / 4;
    const entry = this.getVoice(ev.pid, ev.role);
    entry.used = performance.now();
    // Web Audio monophonic synths throw if two starts share a time. Late notes all clamp to "now", so
    // nudge any start that doesn't strictly follow this voice's previous one by 1.5 ms (inaudible).
    if (t <= entry.lastT) t = entry.lastT + 0.0015;
    entry.lastT = t;
    try {
      entry.voice.trigger(r, t, Math.max(0.05, ev.dur * stepSec * 0.95), clamp(ev.v, 0.05, 1));
    } catch (err) { console.warn('trigger failed', err); return false; }
    return true;
  }

  /** Freestyle: play a raw (unquantised) sound at the gesture's own server time. */
  playFree(pid: string, role: Role, r: Resolved, serverMs: number, durSec: number, vel: number) {
    if (!this.ready) return false;
    let t = this.ctxTime(serverMs);
    const now = this.context.currentTime;
    if (t < now) t = now + 0.005;
    const entry = this.getVoice(pid, role);
    if (t <= entry.lastT) t = entry.lastT + 0.0015;
    entry.lastT = t;
    try { entry.voice.trigger(r, t, durSec, clamp(vel, 0.05, 1)); } catch { return false; }
    return true;
  }

  ctl(pid: string, y: number, tilt: number) {
    for (const [k, e] of this.voices) if (k.startsWith(pid + '|')) e.voice.ctl(y, tilt);
  }

  /** Drop departed players' voices; retain the Stage-owned arrangement voices across roster refreshes. */
  prune(livePids: Set<string>) {
    for (const [k, e] of this.voices) {
      const pid = k.split('|')[0];
      if (!/^(auto|song|game):/.test(pid) && !livePids.has(pid)) { e.voice.dispose(); e.sends.forEach((s) => s.dispose()); this.voices.delete(k); }
    }
  }

  private getVoice(pid: string, role: Role) {
    const k = `${pid}|${role}`;
    let e = this.voices.get(k);
    if (!e) {
      const voice = makeVoice(role, pid.startsWith('auto:'), this.gameMode && !(this.ts?.nowPlaying?.mode === 'jam' && !pid.startsWith('song:')));
      voice.out.connect(this.master);
      // effect sends: pads/melody get a lot of space, bass/drums stay dry
      const rev = new Tone.Gain(this.gameMode ? (role === 'pads' ? 0.12 : role === 'melody' ? 0.08 : 0) : (role === 'pads' ? 0.55 : role === 'melody' ? 0.3 : role === 'drums' ? 0.12 : 0)).connect(this.revBus);
      voice.out.connect(rev);
      const sends = [rev];
      if (role === 'melody' && !this.gameMode) { const delay = new Tone.Gain(0.22).connect(this.delBus); voice.out.connect(delay); sends.push(delay); }
      e = { voice, role, used: performance.now(), lastT: 0, sends };
      this.voices.set(k, e);
    }
    return e;
  }

  // ------------------------------------------------------------------ the drop (Stage only)
  private scheduleDrop(ts: TransportState) {
    const d = ts.drop!;
    const t0 = this.ctxTime(stepTime(ts, d.startStep));
    const tEnd = this.ctxTime(stepTime(ts, d.dropStep));
    const now = this.context.currentTime;
    if (tEnd < now) return;
    const start = Math.max(t0, now + 0.02);

    // riser: filtered noise sweeping up while getting louder, cut one step early for a beat of air
    const noise = new Tone.Noise('white');
    const hp = new Tone.Filter(250, 'highpass');
    const g = new Tone.Gain(0);
    noise.chain(hp, g, this.master);
    g.connect(this.revBus);
    hp.frequency.setValueAtTime(250, start);
    hp.frequency.exponentialRampToValueAtTime(9000, tEnd);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.5, tEnd - 0.03);
    const stepSec = (tEnd - t0) / (d.dropStep - d.startStep);
    g.gain.setValueAtTime(0.0001, tEnd - stepSec);
    noise.start(start).stop(tEnd + 0.1);
    setTimeout(() => { noise.dispose(); hp.dispose(); g.dispose(); }, (tEnd - now + 1) * 1000);

    // snare roll: 8ths -> 16ths -> 32nds across the last bar, velocity rising
    const kit = this.fxKit!;
    const hits: number[] = [];
    for (let s = d.dropStep - STEPS_PER_BAR; s < d.dropStep - 8; s += 2) hits.push(s);
    for (let s = d.dropStep - 8; s < d.dropStep - 4; s += 1) hits.push(s);
    for (let s = d.dropStep - 4; s < d.dropStep; s += 0.5) hits.push(s);
    hits.forEach((s, i) => {
      const tt = tEnd - (d.dropStep - s) * stepSec;
      if (tt > now) kit.hit(1, tt, 0.25 + 0.7 * (i / hits.length));
    });
    // the drop: kick + crash + sub boom on the downbeat where the groove comes back
    kit.hit(0, tEnd, 1);
    kit.crash(tEnd);
  }

  dispose() {
    this.voices.forEach((e) => { e.voice.dispose(); e.sends.forEach((s) => s.dispose()); });
    this.voices.clear();
  }
}

// ======================================================================= voices
function makeVoice(role: Role, auto: boolean, punchy = false): Voice {
  const level = auto ? 0.55 : 1; // AUTO parts sit under the humans
  switch (role) {
    case 'melody': return punchy ? padVoice(level, true) : melodyVoice(level);
    case 'bass': return punchy ? padVoice(level * 0.8, true, true) : bassVoice(level);
    case 'pads': return padVoice(level, punchy);
    case 'guitar': return guitarVoice(level);
    case 'drums': return drumVoice(level);
  }
}

/** Bright picked attack, decaying string body, and a short stagger across chord tones. */
function guitarVoice(level: number): Voice {
  const synth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 1,
    modulationIndex: 2.5,
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.002, decay: 0.65, sustain: 0.04, release: 0.2 },
    modulation: { type: 'sine' },
    modulationEnvelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.08 },
  });
  synth.maxPolyphony = 16;
  synth.volume.value = -14;
  const filter = new Tone.Filter(3400, 'lowpass', -12);
  const out = new Tone.Gain(level);
  synth.chain(filter, out);
  return {
    out,
    trigger(r, time, dur, vel) {
      if (r.kind !== 'notes') return;
      [...r.midi].sort((a, b) => a - b).forEach((note, i) =>
        synth.triggerAttackRelease(mtof(note), dur, time + i * 0.012, vel * (1 - i * 0.035)));
    },
    ctl(y, tilt) { filter.frequency.rampTo(Math.min(9000, 900 * 2 ** (y * 2.5 + tilt * 0.4)), 0.06); },
    dispose() { synth.dispose(); filter.dispose(); out.dispose(); },
  };
}

function melodyVoice(level: number): Voice {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsawtooth', count: 2, spread: 18 },
    envelope: { attack: 0.006, decay: 0.2, sustain: 0.25, release: 0.45 },
  });
  synth.maxPolyphony = 6;
  synth.volume.value = -13;
  const filter = new Tone.Filter(2600, 'lowpass', -12);
  const vib = new Tone.Vibrato({ frequency: 5.5, depth: 0 });
  const out = new Tone.Gain(level);
  synth.chain(filter, vib, out);
  let y = 0.6, tilt = 0;
  const apply = () => {
    filter.frequency.rampTo(Math.min(12000, 500 * 2 ** (y * 4.3) * 2 ** (tilt * 0.9)), 0.06);
    vib.depth.rampTo(Math.abs(tilt) * 0.7, 0.08);
  };
  apply();
  return {
    out,
    trigger(r, time, dur, vel) {
      if (r.kind !== 'notes') return;
      synth.triggerAttackRelease(r.midi.map(mtof), dur, time, vel);
    },
    ctl(ny, nt) { y = ny; tilt = nt; apply(); },
    dispose() { synth.dispose(); filter.dispose(); vib.dispose(); out.dispose(); },
  };
}

function bassVoice(level: number): Voice {
  const saw = new Tone.MonoSynth({
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.005, decay: 0.25, sustain: 0.45, release: 0.18 },
    filter: { Q: 3, type: 'lowpass', rolloff: -24 },
    filterEnvelope: { attack: 0.004, decay: 0.22, sustain: 0.15, release: 0.2, baseFrequency: 110, octaves: 3.2 },
  });
  saw.volume.value = -9;
  const sub = new Tone.Synth({ oscillator: { type: 'sine' }, envelope: { attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.15 } });
  sub.volume.value = -6;
  const out = new Tone.Gain(level);
  saw.connect(out); sub.connect(out);
  return {
    out,
    trigger(r, time, dur, vel) {
      if (r.kind !== 'notes') return;
      const f = mtof(r.midi[0]);
      saw.triggerAttackRelease(f, dur, time, vel);
      sub.triggerAttackRelease(f, dur, time, vel);
    },
    ctl(y, tilt) {
      saw.filterEnvelope.baseFrequency = 70 + 520 * y * 2 ** tilt;
    },
    dispose() { saw.dispose(); sub.dispose(); out.dispose(); },
  };
}

function padVoice(level: number, punchy = false, bass = false): Voice {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: punchy ? { type: bass ? 'sine' : 'triangle' } : { type: 'fatsawtooth', count: 3, spread: 28 },
    envelope: punchy ? { attack: 0.005, decay: 0.35, sustain: bass ? 0.5 : 0.25, release: bass ? 0.16 : 0.5 } : { attack: 0.22, decay: 0.4, sustain: 0.7, release: 1.3 },
  });
  synth.maxPolyphony = 10;
  synth.volume.value = punchy ? -11 : -19;
  const filter = new Tone.Filter(bass ? 900 : 1400, 'lowpass', -12);
  const chorus = new Tone.Chorus(3.5, 2.5, 0.5).start();
  const out = new Tone.Gain(level);
  if (bass) synth.chain(filter, out); else synth.chain(filter, chorus, out);
  return {
    out,
    trigger(r, time, dur, vel) {
      if (r.kind !== 'notes') return;
      synth.triggerAttackRelease(r.midi.map(mtof), dur, time, vel * 0.85);
    },
    ctl(y, tilt) { filter.frequency.rampTo(Math.min(9000, 350 * 2 ** (y * 4.2) * 2 ** (tilt * 0.8)), 0.1); },
    dispose() { synth.dispose(); filter.dispose(); chorus.dispose(); out.dispose(); },
  };
}

function drumVoice(level: number): Voice {
  const out = new Tone.Gain(level);
  const kit = new DrumKit(out, null);
  return {
    out,
    trigger(r, time, _dur, vel) { if (r.kind === 'drum') kit.hit(r.voice, time, vel); },
    ctl() { /* drums ignore tilt/y: velocity carries intensity */ },
    dispose() { kit.dispose(); out.dispose(); },
  };
}

/** Synth drum kit: 0 kick, 1 snare, 2 hat, 3 clap. */
class DrumKit {
  private kick = new Tone.MembraneSynth({ pitchDecay: 0.045, octaves: 6, envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.1 } });
  private snareN = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.17, sustain: 0 } });
  private snareB = new Tone.Synth({ oscillator: { type: 'triangle' }, envelope: { attack: 0.001, decay: 0.09, sustain: 0 } });
  private hatN = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.045, sustain: 0 } });
  private clapN = new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.003, decay: 0.14, sustain: 0 } });
  private crashN = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.002, decay: 1.4, sustain: 0 } });
  private boom = new Tone.Synth({ oscillator: { type: 'sine' }, envelope: { attack: 0.002, decay: 1.1, sustain: 0, release: 0.2 } });
  private nodes: Tone.ToneAudioNode[] = [];

  constructor(out: Tone.ToneAudioNode, rev: Tone.ToneAudioNode | null) {
    const snareHp = new Tone.Filter(1700, 'highpass');
    const hatHp = new Tone.Filter(7500, 'highpass');
    const clapBp = new Tone.Filter(1300, 'bandpass');
    const crashHp = new Tone.Filter(5200, 'highpass');
    this.kick.volume.value = -3;
    this.snareN.chain(snareHp, out); this.snareN.volume.value = -9;
    this.snareB.connect(out); this.snareB.volume.value = -10;
    this.hatN.chain(hatHp, out); this.hatN.volume.value = -17;
    this.clapN.chain(clapBp, out); this.clapN.volume.value = -9;
    this.crashN.chain(crashHp, out); this.crashN.volume.value = -9;
    this.boom.connect(out); this.boom.volume.value = -2;
    this.kick.connect(out);
    if (rev) { this.snareN.connect(rev); this.crashN.connect(rev); }
    this.nodes = [snareHp, hatHp, clapBp, crashHp];
  }

  hit(voice: number, t: number, vel: number) {
    switch (voice) {
      case 0: this.kick.triggerAttackRelease('C1', 0.2, t, vel); break;
      case 1: this.snareN.triggerAttackRelease(0.15, t, vel); this.snareB.triggerAttackRelease(190, 0.08, t, vel * 0.8); break;
      case 2: this.hatN.triggerAttackRelease(0.04, t, vel * 0.9); break;
      default: this.clapN.triggerAttackRelease(0.12, t, vel);
        this.clapN.triggerAttackRelease(0.1, t + 0.012, vel * 0.7); break;
    }
  }
  crash(t: number) { this.crashN.triggerAttackRelease(1.3, t, 0.9); this.boom.triggerAttackRelease(42, 1.0, t, 1); }
  dispose() {
    [this.kick, this.snareN, this.snareB, this.hatN, this.clapN, this.crashN, this.boom, ...this.nodes].forEach((n) => n.dispose());
  }
}
