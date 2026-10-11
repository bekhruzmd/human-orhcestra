/**
 * Procedural, event-driven visuals, one per role. Every animation value comes from `activity`
 * (decaying energy set by real notes). Nothing animates on its own.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, DynamicDrawUsage, Matrix4, Quaternion, Vector3, type InstancedMesh, type Mesh, type MeshBasicMaterial, type Group } from 'three';
import { activity } from '../state/activity';
import { DRUM_POS, KEYS, PIANO_HI, PIANO_LO, PIANO_W, WHITE_W } from './layout';
import { ROLE_COLOR, glowMat } from './theme';

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

// ------------------------------------------------------------------ drums
const DRUM_COLORS = ['#ff4d8d', '#ff9d4d', '#ffe14d', '#4dffb8', '#4dc3ff'];

export function DrumKit() {
  const mats = useMemo(() => DRUM_COLORS.map((c) => glowMat(c, 0.25)), []);
  const meshes = useRef<(Mesh | null)[]>([]);
  useFrame(() => {
    for (let i = 0; i < 5; i++) {
      const p = clamp01(activity.drum[i]);
      mats[i].opacity = 0.18 + p * 0.8;
      meshes.current[i]?.scale.setScalar(1 + p * 0.28);
    }
  });
  const ref = (i: number) => (m: Mesh | null) => { meshes.current[i] = m; };
  const [kick, snare, hat, clap, open] = DRUM_POS;
  return (
    <group>
      <mesh ref={ref(0)} position={kick} rotation={[Math.PI / 2, 0, 0]} material={mats[0]}>
        <cylinderGeometry args={[0.24, 0.24, 0.16, 28]} />
      </mesh>
      <mesh ref={ref(1)} position={snare} rotation={[0.4, 0, 0]} material={mats[1]}>
        <cylinderGeometry args={[0.15, 0.15, 0.07, 24]} />
      </mesh>
      <mesh ref={ref(2)} position={hat} rotation={[0.2, 0, 0]} material={mats[2]}>
        <cylinderGeometry args={[0.14, 0.14, 0.025, 24]} />
      </mesh>
      <mesh ref={ref(3)} position={clap} rotation={[0.3, 0, 0]} material={mats[3]}>
        <torusGeometry args={[0.1, 0.025, 8, 24]} />
      </mesh>
      <mesh ref={ref(4)} position={open} rotation={[0.3, 0, 0]} material={mats[4]}>
        <torusGeometry args={[0.15, 0.02, 8, 28]} />
      </mesh>
    </group>
  );
}

// ------------------------------------------------------------------ piano
const WHITE_COUNT = 28, BLACK_COUNT = 20;
const WHITE_BASE = new Color('#cfeaff').multiplyScalar(0.28);
const BLACK_BASE = new Color('#0b1a26');
const LIT = new Color(ROLE_COLOR.pads);

export function PianoKeys() {
  const white = useRef<InstancedMesh>(null);
  const black = useRef<InstancedMesh>(null);
  const lit = useRef(new Uint8Array(128)); // keys drawn lit last frame, so they get reset once they fade
  const m4 = useMemo(() => new Matrix4(), []);
  const q = useMemo(() => new Quaternion(), []);
  const v = useMemo(() => new Vector3(), []);
  const s = useMemo(() => new Vector3(1, 1, 1), []);
  const tmp = useMemo(() => new Color(), []);

  useLayoutEffect(() => {
    const w = white.current!, b = black.current!;
    w.instanceMatrix.setUsage(DynamicDrawUsage); b.instanceMatrix.setUsage(DynamicDrawUsage);
    for (const k of KEYS) { // static layout, once
      if (k.instance >= (k.black ? BLACK_COUNT : WHITE_COUNT)) continue;
      v.set(k.x, k.black ? 0.012 : 0, k.black ? -0.03 : 0);
      m4.compose(v, q, s);
      (k.black ? b : w).setMatrixAt(k.instance, m4);
      (k.black ? b : w).setColorAt(k.instance, k.black ? BLACK_BASE : WHITE_BASE);
    }
    w.instanceMatrix.needsUpdate = b.instanceMatrix.needsUpdate = true;
    if (w.instanceColor) w.instanceColor.needsUpdate = true;
    if (b.instanceColor) b.instanceColor.needsUpdate = true;
  }, [m4, q, s, v]);

  useFrame(() => {
    const keys = activity.keys.pads;
    const w = white.current!, b = black.current!;
    let wDirty = false, bDirty = false;
    for (let midi = PIANO_LO; midi <= PIANO_HI; midi++) {
      const e = keys[midi];
      if (e <= 0.001 && !lit.current[midi]) continue;
      const info = KEYS[midi];
      const target = info.black ? b : w;
      const a = clamp01(e);
      tmp.copy(info.black ? BLACK_BASE : WHITE_BASE).lerp(LIT, a);
      target.setColorAt(info.instance, tmp);
      v.set(info.x, (info.black ? 0.012 : 0) - a * 0.012, info.black ? -0.03 : 0);
      m4.compose(v, q, s);
      target.setMatrixAt(info.instance, m4);
      lit.current[midi] = e > 0.001 ? 1 : 0;
      if (info.black) bDirty = true; else wDirty = true;
    }
    if (wDirty) { w.instanceMatrix.needsUpdate = true; w.instanceColor!.needsUpdate = true; }
    if (bDirty) { b.instanceMatrix.needsUpdate = true; b.instanceColor!.needsUpdate = true; }
  });

  return (
    <group position={[0, 0.62, 0.08]} rotation={[0.9, 0, 0]}>
      <instancedMesh ref={white} args={[undefined, undefined, WHITE_COUNT]} frustumCulled={false}>
        <boxGeometry args={[WHITE_W * 0.9, 0.02, 0.26]} />
        <meshBasicMaterial transparent opacity={0.92} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={black} args={[undefined, undefined, BLACK_COUNT]} frustumCulled={false}>
        <boxGeometry args={[WHITE_W * 0.55, 0.026, 0.16]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <mesh position={[0, -0.012, 0]}>
        <boxGeometry args={[PIANO_W + 0.04, 0.012, 0.29]} />
        <meshBasicMaterial color="#12303d" toneMapped={false} />
      </mesh>
    </group>
  );
}

// ------------------------------------------------------------------ bass
export function BassCore() {
  const core = useRef<Mesh>(null);
  const shell = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);
  const coreMat = useMemo(() => glowMat(ROLE_COLOR.bass, 0.3), []);
  const ringMat = useMemo(() => glowMat(ROLE_COLOR.bass, 0), []);
  useFrame((_, dt) => {
    const e = clamp01(activity.energy.bass);
    core.current!.scale.setScalar(0.8 + e * 0.5);
    shell.current!.scale.setScalar(1 + e * 0.9);
    shell.current!.rotation.y += dt * (0.3 + e * 2.5);
    coreMat.opacity = 0.2 + e * 0.7;
    ringMat.opacity = e * 0.7;
    ring.current!.scale.setScalar(1 + (1 - e) * 1.6);
  });
  return (
    <group position={[0, 0.72, 0]}>
      <mesh ref={core} material={coreMat}><sphereGeometry args={[0.2, 20, 14]} /></mesh>
      <mesh ref={shell}>
        <icosahedronGeometry args={[0.3, 1]} />
        <meshBasicMaterial color={ROLE_COLOR.bass} wireframe transparent opacity={0.55} toneMapped={false} />
      </mesh>
      <mesh ref={ring} rotation={[Math.PI / 2, 0, 0]} material={ringMat}><torusGeometry args={[0.32, 0.01, 6, 40]} /></mesh>
    </group>
  );
}

// ------------------------------------------------------------------ melody
const PCS = 12;
export const MELODY_BAR_W = 0.07;
export const melodyBarX = (pc: number) => (pc - (PCS - 1) / 2) * MELODY_BAR_W * 1.25;

export function MelodyLadder() {
  const bars = useRef<(Mesh | null)[]>([]);
  const pcEnergy = useMemo(() => new Float32Array(PCS), []);
  const mats = useMemo(() => Array.from({ length: PCS }, () => glowMat(ROLE_COLOR.melody, 0.2)), []);
  useFrame(() => {
    pcEnergy.fill(0);
    const k = activity.keys.melody;
    for (let m = 0; m < 128; m++) if (k[m] > 0.001) pcEnergy[m % 12] += k[m];
    for (let i = 0; i < PCS; i++) {
      const e = clamp01(pcEnergy[i]);
      const bar = bars.current[i];
      if (!bar) continue;
      bar.scale.y = 0.12 + e * 1.6;
      bar.position.y = 0.45 + (0.12 + e * 1.6) * 0.15;
      mats[i].opacity = 0.18 + e * 0.8;
    }
  });
  return (
    <group>
      {Array.from({ length: PCS }, (_, i) => (
        <mesh key={i} ref={(m) => { bars.current[i] = m; }} position={[melodyBarX(i), 0.5, 0]} material={mats[i]}>
          <boxGeometry args={[MELODY_BAR_W, 0.3, 0.03]} />
        </mesh>
      ))}
    </group>
  );
}

// ------------------------------------------------------------------ guitar
export const GUITAR_STRINGS = 6;
export const guitarStringX = (i: number) => (i - (GUITAR_STRINGS - 1) / 2) * 0.09;

export function GuitarStrings() {
  const strings = useRef<(Mesh | null)[]>([]);
  const amp = useMemo(() => new Float32Array(GUITAR_STRINGS), []);
  const mats = useMemo(() => Array.from({ length: GUITAR_STRINGS }, () => glowMat(ROLE_COLOR.guitar, 0.3)), []);
  const t = useRef(0);
  const body = useRef<Group>(null);
  useFrame((_, dt) => {
    t.current += dt;
    amp.fill(0);
    const k = activity.keys.guitar;
    for (let m = 0; m < 128; m++) if (k[m] > 0.001) amp[m % GUITAR_STRINGS] += k[m];
    for (let i = 0; i < GUITAR_STRINGS; i++) {
      const a = clamp01(amp[i]);
      const s = strings.current[i];
      if (!s) continue;
      s.position.x = guitarStringX(i) + Math.sin(t.current * 70 + i) * a * 0.018;
      s.scale.x = 1 + a * 3;
      mats[i].opacity = 0.25 + a * 0.75;
    }
    body.current!.scale.setScalar(1 + clamp01(activity.energy.guitar) * 0.12);
  });
  return (
    <group position={[0, 0.78, 0]}>
      {Array.from({ length: GUITAR_STRINGS }, (_, i) => (
        <mesh key={i} ref={(m) => { strings.current[i] = m; }} position={[guitarStringX(i), 0, 0]} material={mats[i]}>
          <boxGeometry args={[0.006, 0.7, 0.006]} />
        </mesh>
      ))}
      <group ref={body}>
        <mesh position={[0, -0.28, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.2, 0.008, 6, 36]} />
          <meshBasicMaterial color={ROLE_COLOR.guitar} transparent opacity={0.5} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

export type { MeshBasicMaterial };
