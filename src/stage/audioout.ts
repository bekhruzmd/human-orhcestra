/**
 * Streams the Stage's final mix (post-limiter, what the room hears) to headsets over WebRTC.
 * The server only relays the handshake (`rtc` messages); the audio goes peer to peer.
 *
 *   headset --{listen}--> Stage --{offer}--> headset --{answer}--> Stage   (+ ICE both ways)
 */
import * as Tone from 'tone';
import type { Engine } from '../common/engine';

type Send = (to: string, data: object) => void;

const ICE: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

/** Opus defaults to speech-tuned mono; ask for stereo at music bitrate. */
const musicSdp = (sdp: string) => sdp.replace(/a=fmtp:(\d+) ([^\r\n]*useinbandfec=1[^\r\n]*)/g, (_m, pt, rest) =>
  `a=fmtp:${pt} ${rest};stereo=1;sprop-stereo=1;maxaveragebitrate=128000`);

export class StageAudioOut {
  private dest: MediaStreamAudioDestinationNode | null = null;
  private peers = new Map<string, RTCPeerConnection>();

  constructor(private engine: Engine, private send: Send) {}

  get listeners() { return this.peers.size; }

  private stream(): MediaStream | null {
    if (!this.engine.ready) return null;
    if (!this.dest) {
      this.dest = Tone.getContext().createMediaStreamDestination();
      Tone.connect(this.engine.tap, this.dest);
    }
    return this.dest.stream;
  }

  async onSignal(from: string, data: any) {
    if (!data || typeof data !== 'object') return;
    if (data.kind === 'listen') return this.offer(from);
    const pc = this.peers.get(from);
    if (!pc) return;
    try {
      if (data.kind === 'answer' && typeof data.sdp === 'string') await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      else if (data.kind === 'ice' && data.cand) await pc.addIceCandidate(data.cand);
      else if (data.kind === 'bye') this.drop(from);
    } catch { /* stale or out-of-order signalling: the headset retries */ }
  }

  private async offer(to: string) {
    const stream = this.stream();
    if (!stream) return; // audio not started yet (needs a click on the Stage); the headset asks again
    this.drop(to);
    const pc = new RTCPeerConnection(ICE);
    this.peers.set(to, pc);
    for (const t of stream.getAudioTracks()) pc.addTrack(t, stream);
    pc.onicecandidate = (e) => { if (e.candidate) this.send(to, { kind: 'ice', cand: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.drop(to, pc); };
    const o = await pc.createOffer();
    await pc.setLocalDescription({ type: 'offer', sdp: musicSdp(o.sdp ?? '') });
    this.send(to, { kind: 'offer', sdp: pc.localDescription!.sdp });
  }

  private drop(id: string, only?: RTCPeerConnection) {
    const pc = this.peers.get(id);
    if (!pc || (only && pc !== only)) return;
    this.peers.delete(id);
    pc.onicecandidate = pc.onconnectionstatechange = null;
    try { pc.close(); } catch { /* already closed */ }
  }
}
