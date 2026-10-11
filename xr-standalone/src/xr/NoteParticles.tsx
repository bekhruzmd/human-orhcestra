import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, Color, DynamicDrawUsage, Object3D, type InstancedMesh } from 'three';
import { activity, type XRNote } from '../state/activity';
import { DRUM_POS, KEYS, toStage } from './layout';
import { guitarStringX, melodyBarX } from './instrumentVisuals';
import { ROLE_COLOR } from './theme';

/**
 * One InstancedMesh ring buffer for every note burst: a single draw call, zero per-frame allocation.
 * Particles are spawned only by real notes (activity.onHit), never on a timer.
 */
const N = 192;
const LIFE = 1.15;

export function NoteParticles() {
  const mesh = useRef<InstancedMesh>(null);
  const st = useMemo(() => ({
    pos: new Float32Array(N * 3), vel: new Float32Array(N * 3), age: new Float32Array(N).fill(LIFE), head: 0, live: 0,
  }), []);
  const dummy = useMemo(() => new Object3D(), []);
  const colors = useMemo(() => Object.fromEntries(Object.entries(ROLE_COLOR).map(([k, v]) => [k, new Color(v)])) as Record<string, Color>, []);

  useLayoutEffect(() => {
    const m = mesh.current!;
    m.instanceMatrix.setUsage(DynamicDrawUsage);
    dummy.scale.setScalar(0); dummy.updateMatrix();
    for (let i = 0; i < N; i++) { m.setMatrixAt(i, dummy.matrix); m.setColorAt(i, colors.pads); }
  }, [dummy, colors]);

  useEffect(() => {
    const o: [number, number, number] = [0, 0, 0];
    const spawn = (role: XRNote['instrumentId'], lx: number, ly: number, lz: number, vx: number, vy: number, vz: number) => {
      const i = st.head; st.head = (st.head + 1) % N;
      toStage(role, lx, ly, lz, o);
      st.pos[i * 3] = o[0]; st.pos[i * 3 + 1] = o[1]; st.pos[i * 3 + 2] = o[2];
      // rotate local velocity into stage space (same Y rotation as toStage, no translation)
      const a = toStage(role, vx, 0, vz, [0, 0, 0]);
      const s = toStage(role, 0, 0, 0, [0, 0, 0]);
      st.vel[i * 3] = a[0] - s[0]; st.vel[i * 3 + 1] = vy; st.vel[i * 3 + 2] = a[2] - s[2];
      st.age[i] = 0;
      mesh.current!.setColorAt(i, colors[role]);
      if (mesh.current!.instanceColor) mesh.current!.instanceColor.needsUpdate = true;
    };
    return activity.onHit((n) => {
      const r = n.instrumentId;
      if (r === 'drums') {
        const [x, y, z] = DRUM_POS[Math.max(0, Math.min(4, n.drumVoice ?? 0))];
        const k = 3 + Math.round(n.velocity * 3);
        for (let j = 0; j < k; j++) {
          const a = (j / k) * Math.PI * 2 + Math.random();
          spawn(r, x, y, z + 0.1, Math.cos(a) * 0.5, 0.35 + Math.random() * 0.4, Math.sin(a) * 0.4);
        }
      } else if (r === 'bass') {
        spawn(r, 0, 0.72, 0.05, 0, 0.18, 0.1);
        spawn(r, 0, 0.72, 0.05, 0.1, 0.12, 0.15);
      } else if (n.midi) {
        const m = n.midi.slice(0, 3);
        for (const midi of m) {
          if (r === 'pads') spawn(r, KEYS[midi]?.x ?? 0, 0.74, 0.12, 0, 0.45, 0.1);
          else if (r === 'melody') spawn(r, melodyBarX(midi % 12), 0.8, 0.05, 0.05 * (6 - (midi % 12)) / 6, 0.5, -0.15);
          else spawn(r, guitarStringX(midi % 6), 0.8, 0.05, 0, 0.4, 0.1);
        }
      }
      st.live = N;
    });
  }, [st, colors]);

  useFrame((_, dt) => {
    if (!st.live) return;
    const m = mesh.current!;
    let alive = 0;
    for (let i = 0; i < N; i++) {
      const a = st.age[i];
      if (a >= LIFE) continue;
      st.age[i] = a + dt;
      const t = st.age[i] / LIFE;
      st.pos[i * 3] += st.vel[i * 3] * dt;
      st.pos[i * 3 + 1] += st.vel[i * 3 + 1] * dt;
      st.pos[i * 3 + 2] += st.vel[i * 3 + 2] * dt;
      st.vel[i * 3 + 1] -= 0.3 * dt;
      dummy.position.set(st.pos[i * 3], st.pos[i * 3 + 1], st.pos[i * 3 + 2]);
      dummy.scale.setScalar(t >= 1 ? 0 : 0.022 * (1 - t));
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      if (t < 1) alive++;
    }
    m.instanceMatrix.needsUpdate = true;
    if (!alive) st.live = 0;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, N]} frustumCulled={false}>
      <octahedronGeometry args={[1, 0]} />
      <meshBasicMaterial blending={AdditiveBlending} transparent depthWrite={false} toneMapped={false} />
    </instancedMesh>
  );
}
