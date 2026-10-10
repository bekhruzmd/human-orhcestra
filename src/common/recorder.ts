/**
 * Rolling recorder: keeps the last 30 s of the Stage's final output and saves it as a WAV on demand.
 *
 * Why not MediaRecorder? It is the obvious tool, but a *rolling* window of its output isn't a valid
 * file: only the first chunk carries the container header, so dropping old chunks yields something many
 * players can't open. Tapping the Tone.js master (post-limiter) into a ring buffer of PCM and writing the
 * WAV at save time is deterministic and gives a file that always plays.
 */
import * as Tone from 'tone';
import type { Engine } from './engine';

const SECONDS = 30;
const BLOCK = 4096;

/** Runs on the audio thread: batches 128-sample render quanta into BLOCK-sized stereo blocks. */
const WORKLET = `
class HoTap extends AudioWorkletProcessor {
  constructor() { super(); this.n = 0; this.l = new Float32Array(${BLOCK}); this.r = new Float32Array(${BLOCK}); }
  process(inputs) {
    const i = inputs[0];
    if (i && i[0]) {
      const L = i[0], R = i[1] || i[0];
      this.l.set(L, this.n); this.r.set(R, this.n); this.n += L.length;
      if (this.n >= ${BLOCK}) { this.port.postMessage([this.l, this.r]); this.l = new Float32Array(${BLOCK}); this.r = new Float32Array(${BLOCK}); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('ho-tap', HoTap);`;

export class Recorder {
  private chunks: Float32Array[][] = []; // [block][channel]
  private maxBlocks = 0;
  private sr = 48000;
  private started = false;

  constructor(private engine: Engine) {}

  async start() {
    if (this.started || !this.engine.ready) return;
    this.started = true;
    const ctx = Tone.getContext();
    this.sr = ctx.sampleRate;
    this.maxBlocks = Math.ceil((SECONDS * this.sr) / BLOCK);
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.addAudioWorkletModule(url);
    const node = ctx.createAudioWorkletNode('ho-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    node.port.onmessage = (e) => {
      this.chunks.push(e.data as Float32Array[]);
      if (this.chunks.length > this.maxBlocks) this.chunks.shift();
    };
    Tone.connect(this.engine.tap, node); // listen to what the room hears (post-limiter)
    const mute = ctx.createGain(); // keep the node in the render graph; it outputs silence anyway
    mute.gain.value = 0;
    node.connect(mute); mute.connect(ctx.rawContext.destination);
  }

  get seconds() { return Math.min(SECONDS, (this.chunks.length * BLOCK) / this.sr); }

  /** Encode the buffered audio as 16-bit stereo WAV and trigger a download. */
  save() {
    if (!this.chunks.length) return false;
    const frames = this.chunks.length * BLOCK;
    const buf = new ArrayBuffer(44 + frames * 4);
    const v = new DataView(buf);
    const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + frames * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
    v.setUint32(24, this.sr, true); v.setUint32(28, this.sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, frames * 4, true);
    let o = 44;
    for (const [l, r] of this.chunks) {
      for (let i = 0; i < BLOCK; i++) {
        v.setInt16(o, Math.max(-1, Math.min(1, l[i])) * 0x7fff, true);
        v.setInt16(o + 2, Math.max(-1, Math.min(1, r[i])) * 0x7fff, true);
        o += 4;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    a.download = `human-orchestra-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return true;
  }
}
