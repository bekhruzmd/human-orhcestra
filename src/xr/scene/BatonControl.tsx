/**
 * Conducting with your hands (immersive session only; it reads the raw WebXR input poses, so it works with
 * controllers and with tracked hands alike).
 *   right hand: a downward beat that stops (the "ictus") is a beat; steady beats set the tempo.
 *   left hand : hold grip (controller) or pinch (hand), then raise or lower the hand to raise or lower the master volume.
 * Both only run while BATON is on in the Transport panel, and only for a Conductor connection.
 */
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useXR } from '@react-three/xr';
import { orchestra } from '../networking/orchestraAdapter';
import { BeatDetector, TempoTracker } from '../networking/baton';
import { useStore } from '../state/store';

const DYNAMICS_GAIN = 1.6;   // master level change per metre of hand travel
const SEND_EVERY_MS = 100;

export function BatonControl() {
  const gl = useThree((s) => s.gl);
  const session = useXR((s) => s.session);
  const held = useRef(false);            // left squeeze / pinch is down
  const detector = useRef(new BeatDetector());
  const tracker = useRef(new TempoTracker());
  const dyn = useRef({ y0: 0, m0: 1, active: false, sentAt: 0, sent: -1 });
  const tempoSent = useRef({ at: 0 });

  useEffect(() => {
    if (!session) return;
    const down = (e: XRInputSourceEvent) => { if (e.inputSource.handedness === 'left') held.current = true; };
    const up = (e: XRInputSourceEvent) => { if (e.inputSource.handedness === 'left') held.current = false; };
    session.addEventListener('squeezestart', down);
    session.addEventListener('squeezeend', up);
    session.addEventListener('selectstart', down);
    session.addEventListener('selectend', up);
    return () => {
      session.removeEventListener('squeezestart', down);
      session.removeEventListener('squeezeend', up);
      session.removeEventListener('selectstart', down);
      session.removeEventListener('selectend', up);
      held.current = false;
    };
  }, [session]);

  useFrame((_, __, frame) => {
    const st = useStore.getState();
    const { baton } = st;
    if (!baton.on || st.privilege !== 'conductor' || st.mode !== 'live') {
      if (baton.dynamics) st.set({ baton: { ...baton, dynamics: false } });
      dyn.current.active = false; detector.current.reset();
      return;
    }
    const xrFrame = frame as XRFrame | undefined;
    const ref = gl.xr.getReferenceSpace();
    if (!xrFrame || !ref) return;
    const now = performance.now();
    for (const src of xrFrame.session.inputSources) {
      const space = src.gripSpace ?? src.targetRaySpace;
      const pose = space ? xrFrame.getPose(space, ref) : null;
      if (!pose) continue;
      const y = pose.transform.position.y;
      if (src.handedness === 'right') {
        if (detector.current.update(y, now / 1000)) {
          const bpm = tracker.current.beat(now / 1000);
          st.set({ baton: { ...useStore.getState().baton, beats: baton.beats + 1, bpm: bpm ?? baton.bpm } });
          const cur = st.transport?.bpm ?? 0;
          if (bpm && Math.abs(bpm - cur) >= 3 && now - tempoSent.current.at > 1000) {
            tempoSent.current.at = now;
            orchestra.command('bpm', Math.round(bpm));
          }
        }
      } else if (src.handedness === 'left') {
        const d = dyn.current;
        if (held.current) {
          if (!d.active) { d.active = true; d.y0 = y; d.m0 = st.transport?.mix?.master ?? 1; d.sent = -1; st.set({ baton: { ...useStore.getState().baton, dynamics: true } }); }
          const level = Math.max(0, Math.min(1.2, d.m0 + (y - d.y0) * DYNAMICS_GAIN));
          if (now - d.sentAt > SEND_EVERY_MS && Math.abs(level - d.sent) >= 0.02) { d.sentAt = now; d.sent = level; orchestra.master(level); }
        } else if (d.active) {
          d.active = false; st.set({ baton: { ...useStore.getState().baton, dynamics: false } });
        }
      }
    }
  });
  return null;
}
