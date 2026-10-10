/**
 * Sampler: make music from an audio file the user uploads (nothing leaves this browser).
 *
 *   load(file)      decode -> detect tempo + beat grid (audioanalysis.ts)
 *   trigger(...)    play slice i: the file is cut on its OWN beat grid into slices of `sliceBeats` beats
 *   startBacking()  loop the file under the band, bar-aligned to the shared transport
 *
 * Both are re-timed with playbackRate = transportBpm / fileBpm, so the file's beats land on the transport's
 * beats whatever tempo the room is running at. Phones only ever send "slice number, on step N": the same
 * quantised, clock-synced path as every other instrument.
 */
import * as Tone from 'tone';
import type { Engine } from '../common/engine';
import { analyzeAudio, type Analysis } from './audioanalysis';

export const SLICES = 16;

export class Sampler {
  buffer: Tone.ToneAudioBuffer | null = null;
  name = '';
  analysis: Analysis | null = null;
  duration = 0;
  /** user-adjustable copies of the detected grid */
  bpm = 100;
  offset = 0;
  sliceBeats = 1;

  async load(file: File, engine: Engine) {
    const audio = await engine.decode(await file.arrayBuffer());
    const mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / audio.numberOfChannels;
    }
    this.analysis = analyzeAudio(mono, audio.sampleRate);
    this.bpm = this.analysis.bpm;
    this.offset = this.analysis.offset;
    this.buffer = new Tone.ToneAudioBuffer(audio);
    this.duration = audio.duration;
    this.name = file.name.replace(/\.[^.]+$/, '').slice(0, 60);
    this.sliceBeats = 1;
  }

  get beatSec() { return 60 / this.bpm; }
  get sliceSec() { return this.sliceBeats * this.beatSec; }
  /** how many slices actually fit in the file after the grid offset (<= 16) */
  get usable() { return Math.max(1, Math.min(SLICES, Math.floor((this.duration - this.offset) / this.sliceSec))); }

  /** Play slice `i` at a server time. Returns the slice index actually played (indices wrap if the file is short). */
  trigger(engine: Engine, i: number, serverMs: number, transportBpm: number, vel: number) {
    if (!this.buffer) return -1;
    const idx = ((i % this.usable) + this.usable) % this.usable;
    const rate = transportBpm / this.bpm;
    engine.playSample(this.buffer, serverMs, this.offset + idx * this.sliceSec, this.sliceSec, rate, 0.35 + 0.65 * vel);
    return idx;
  }

  /** Loop the file under the band, starting on a bar line (serverMs). Loops whole bars so the grid never drifts. */
  startBacking(engine: Engine, serverMs: number, transportBpm: number) {
    if (!this.buffer) return;
    const barSec = 4 * this.beatSec;
    const bars = Math.max(1, Math.floor((this.duration - this.offset) / barSec));
    engine.playSample(this.buffer, serverMs, this.offset, bars * barSec, transportBpm / this.bpm, 0.8, { start: this.offset, end: this.offset + bars * barSec });
  }

  stop(engine: Engine) { engine.stopSamples(); }
}
