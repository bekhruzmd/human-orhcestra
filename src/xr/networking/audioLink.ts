/**
 * Hears the Stage. The Stage streams its final mix over WebRTC; the server only relays the handshake.
 * We ask ("listen"), the Stage offers, we answer, then the track plays through an <audio> element, which also
 * works inside a Quest immersive session. Until the Stage has started its audio it does not answer, so we ask again.
 */
import { useStore } from '../state/store';
import { load, save } from '../utils/storage';

const ICE: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const RETRY_MS = 4000;
const KEY_VOL = 'hoxr.volume';

type Send = (data: object) => void;

export class AudioLink {
  private pc: RTCPeerConnection | null = null;
  private el: HTMLAudioElement | null = null;
  private stageId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private send: Send = () => {};
  private pending: RTCIceCandidateInit[] = [];

  volume = Math.max(0, Math.min(1, Number(load(KEY_VOL) ?? 0.8)));
  muted = false;

  private status(audio: 'off' | 'waiting' | 'live') { useStore.getState().set({ audio }); }

  /** Begin (or restart) listening. Safe to call repeatedly. */
  start(send: Send) {
    this.stop();
    this.send = send;
    this.status('waiting');
    const ask = () => { if (!this.pc || this.pc.connectionState !== 'connected') this.send({ kind: 'listen' }); };
    ask();
    this.timer = setInterval(ask, RETRY_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stageId) this.send({ kind: 'bye' });
    this.teardown();
    this.status('off');
  }

  private teardown() {
    const pc = this.pc;
    this.pc = null; this.stageId = null; this.pending = [];
    if (pc) { pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null; try { pc.close(); } catch { /* closed */ } }
    if (this.el) { this.el.pause(); this.el.srcObject = null; this.el.remove(); this.el = null; }
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    save(KEY_VOL, String(this.volume));
    this.apply();
  }
  setMuted(m: boolean) { this.muted = m; this.apply(); useStore.getState().set({ audioMuted: m }); }
  private apply() { if (this.el) { this.el.volume = this.volume; this.el.muted = this.muted; } }

  async onSignal(from: string, data: any) {
    if (!data || typeof data !== 'object') return;
    try {
      if (data.kind === 'offer' && typeof data.sdp === 'string') await this.answer(from, data.sdp);
      else if (data.kind === 'ice' && data.cand && from === this.stageId) {
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(data.cand); else this.pending.push(data.cand);
      }
    } catch { /* the periodic "listen" starts a fresh handshake */ }
  }

  private async answer(from: string, sdp: string) {
    this.teardown();
    this.stageId = from;
    const pc = new RTCPeerConnection(ICE);
    this.pc = pc;
    pc.onicecandidate = (e) => { if (e.candidate) this.send({ kind: 'ice', cand: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === 'connected') this.status('live');
      else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) { this.teardown(); this.status('waiting'); }
    };
    pc.ontrack = (e) => {
      const el = new Audio();
      el.autoplay = true;
      el.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      el.style.display = 'none';
      document.body.appendChild(el);
      this.el = el;
      this.apply();
      void el.play().catch(() => useStore.getState().pushLog('Sound is blocked until you tap the page once'));
    };
    await pc.setRemoteDescription({ type: 'offer', sdp });
    for (const c of this.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    const a = await pc.createAnswer();
    await pc.setLocalDescription({ type: 'answer', sdp: a.sdp?.replace(/a=fmtp:(\d+) ([^\r\n]*useinbandfec=1[^\r\n]*)/g, 'a=fmtp:$1 $2;stereo=1;sprop-stereo=1') ?? a.sdp });
    this.send({ kind: 'answer', sdp: pc.localDescription!.sdp });
  }

  /** Retry playback after a user gesture (autoplay policy). */
  resume() { void this.el?.play().catch(() => {}); }
}
