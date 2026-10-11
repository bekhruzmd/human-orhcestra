/**
 * Procedural, event-driven visuals, one per role. Every animation value comes from `activity`
 * (decaying energy set by real notes). Nothing animates on its own.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, Color, DynamicDrawUsage, Matrix4, Quaternion, Vector3, type InstancedMesh, type Mesh, type MeshBasicMaterial, type Group } from 'three';
import { activity } from '../state/activity';
import { DRUM_POS, KEYS, PIANO_HI, PIANO_LO, PIANO_W, WHITE_W } from './layout';
import { Text } from '@react-three/drei';
import { DIM, FONT, ROLE_COLOR, glowMat } from './theme';

/** Dark, unlit body colour: gives each instrument a solid silhouette for the neon to sit on. */
const BODY = '#0a1620';
const BODY_LIGHT = '#16303f';

/** Thin vertical stand/pole from the floor (or `y0`) up to `y1`. */
const Pole = ({ x, z = 0, y0 = 0, y1, color = BODY_LIGHT, r = 0.008 }: { x: number; z?: number; y0?: number; y1: number; color?: string; r?: number }) => (
  <mesh position={[x, (y0 + y1) / 2, z]}>
    <cylinderGeometry args={[r, r, y1 - y0, 6]} />
    <meshBasicMaterial color={color} toneMapped={false} />
  </mesh>
);

/** Flat glowing outline ring, faces +z unless rotated. */
const Outline = ({ r, w = 0.006, color, opacity = 0.6, position, rotation, seg = 40 }:
  { r: number; w?: number; color: string; opacity?: number; position?: [number, number, number]; rotation?: [number, number, number]; seg?: number }) => (
  <mesh position={position} rotation={rotation}>
    <ringGeometry args={[r - w, r, seg]} />
    <meshBasicMaterial color={color} transparent opacity={opacity} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
  </mesh>
);

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
      {/* kick: dark shell behind the glowing head, rim and spurs */}
      <mesh position={[kick[0], kick[1], kick[2] - 0.1]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.235, 0.235, 0.2, 28]} />
        <meshBasicMaterial color={BODY} toneMapped={false} />
      </mesh>
      <Outline r={0.25} w={0.012} color={DRUM_COLORS[0]} opacity={0.7} position={[kick[0], kick[1], kick[2] + 0.085]} />
      <Pole x={-0.2} y1={0.2} z={0.02} />
      <Pole x={0.2} y1={0.2} z={0.02} />
      <mesh ref={ref(0)} position={kick} rotation={[Math.PI / 2, 0, 0]} material={mats[0]}>
        <cylinderGeometry args={[0.24, 0.24, 0.16, 28]} />
      </mesh>
      {/* snare on a stand */}
      <Pole x={snare[0]} z={snare[2]} y1={snare[1] - 0.04} />
      <mesh position={[snare[0], snare[1] - 0.02, snare[2]]} rotation={[0.4, 0, 0]}>
        <cylinderGeometry args={[0.145, 0.145, 0.06, 24]} />
        <meshBasicMaterial color={BODY} toneMapped={false} />
      </mesh>
      <mesh ref={ref(1)} position={snare} rotation={[0.4, 0, 0]} material={mats[1]}>
        <cylinderGeometry args={[0.15, 0.15, 0.07, 24]} />
      </mesh>
      {/* hi-hat: pole, lower cymbal, glowing top */}
      <Pole x={hat[0]} z={hat[2]} y1={hat[1] - 0.03} />
      <mesh position={[hat[0], hat[1] - 0.035, hat[2]]} rotation={[0.2, 0, 0]}>
        <cylinderGeometry args={[0.13, 0.13, 0.012, 24]} />
        <meshBasicMaterial color={BODY_LIGHT} toneMapped={false} />
      </mesh>
      <mesh ref={ref(2)} position={hat} rotation={[0.2, 0, 0]} material={mats[2]}>
        <cylinderGeometry args={[0.14, 0.14, 0.025, 24]} />
      </mesh>
      {/* clap pad */}
      <Pole x={clap[0]} z={clap[2]} y1={clap[1] - 0.03} />
      <mesh position={[clap[0], clap[1], clap[2]]} rotation={[0.3, 0, 0]}>
        <circleGeometry args={[0.1, 20]} />
        <meshBasicMaterial color={BODY} side={2} toneMapped={false} />
      </mesh>
      <mesh ref={ref(3)} position={clap} rotation={[0.3, 0, 0]} material={mats[3]}>
        <torusGeometry args={[0.1, 0.025, 8, 24]} />
      </mesh>
      {/* open cymbal / crash */}
      <Pole x={open[0]} z={open[2]} y1={open[1] - 0.01} />
      <mesh position={open} rotation={[0.3, 0, 0]}>
        <circleGeometry args={[0.15, 28]} />
        <meshBasicMaterial color={BODY_LIGHT} transparent opacity={0.55} side={2} toneMapped={false} />
      </mesh>
      <mesh ref={ref(4)} position={open} rotation={[0.3, 0, 0]} material={mats[4]}>
        <torusGeometry args={[0.15, 0.02, 8, 28]} />
      </mesh>
      <Outline r={0.5} w={0.004} color="#ff4d8d" opacity={0.18} position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]} seg={64} />
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
    <>
    <Pole x={-PIANO_W / 2 + 0.03} z={0.1} y1={0.6} r={0.012} />
    <Pole x={PIANO_W / 2 - 0.03} z={0.1} y1={0.6} r={0.012} />
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
      {/* cabinet end blocks and back rail, plus a neon strip along the front lip */}
      {[-1, 1].map((sd) => (
        <mesh key={sd} position={[sd * (PIANO_W / 2 + 0.035), 0.0, 0]}>
          <boxGeometry args={[0.05, 0.05, 0.31]} />
          <meshBasicMaterial color={BODY_LIGHT} toneMapped={false} />
        </mesh>
      ))}
      <mesh position={[0, 0.02, -0.15]}>
        <boxGeometry args={[PIANO_W + 0.1, 0.07, 0.03]} />
        <meshBasicMaterial color={BODY} toneMapped={false} />
      </mesh>
      <mesh position={[0, -0.008, 0.148]}>
        <boxGeometry args={[PIANO_W + 0.1, 0.006, 0.006]} />
        <meshBasicMaterial color={ROLE_COLOR.pads} transparent opacity={0.8} blending={AdditiveBlending} toneMapped={false} />
      </mesh>
    </group>
    </>
  );
}

// ------------------------------------------------------------------ bass
export const BASS_STRINGS = 4;
const BASS_GAUGE = [0.016, 0.012, 0.009, 0.006]; // E A D G, thickest first
export const bassStringX = (i: number) => (i - (BASS_STRINGS - 1) / 2) * 0.07;

/** Upright bass: four heavy strings over a fingerboard, with a big waisted body and f-holes. */
export function BassCore() {
  const strings = useRef<(Mesh | null)[]>([]);
  const amp = useMemo(() => new Float32Array(BASS_STRINGS), []);
  const mats = useMemo(() => Array.from({ length: BASS_STRINGS }, () => glowMat(ROLE_COLOR.bass, 0.35)), []);
  const t = useRef(0);
  const body = useRef<Group>(null);
  useFrame((_, dt) => {
    t.current += dt;
    amp.fill(0);
    const k = activity.keys.bass;
    for (let m = 0; m < 128; m++) if (k[m] > 0.001) amp[m % BASS_STRINGS] += k[m];
    for (let i = 0; i < BASS_STRINGS; i++) {
      const a = clamp01(amp[i]);
      const s = strings.current[i];
      if (!s) continue;
      s.position.x = bassStringX(i) + Math.sin(t.current * 45 + i * 1.7) * a * 0.024;
      s.scale.x = 1 + a * 2.2;
      mats[i].opacity = 0.35 + a * 0.65;
    }
    body.current!.scale.setScalar(1 + clamp01(activity.energy.bass) * 0.06);
  });
  return (
    <group position={[0, 0.9, 0]}>
      {/* strings run from the scroll down over the fingerboard to the bridge */}
      {Array.from({ length: BASS_STRINGS }, (_, i) => (
        <mesh key={i} ref={(m) => { strings.current[i] = m; }} position={[bassStringX(i), -0.02, 0]} material={mats[i]}>
          <boxGeometry args={[BASS_GAUGE[i], 1.2, BASS_GAUGE[i]]} />
        </mesh>
      ))}
      {/* neck, fingerboard, scroll and tuning pegs */}
      <mesh position={[0, 0.05, -0.02]}>
        <boxGeometry args={[0.27, 0.95, 0.012]} />
        <meshBasicMaterial color={BODY} toneMapped={false} />
      </mesh>
      {[0.0, 0.18, 0.34].map((y) => (
        <mesh key={y} position={[0, y, -0.012]}>
          <boxGeometry args={[0.27, 0.005, 0.004]} />
          <meshBasicMaterial color={ROLE_COLOR.bass} transparent opacity={0.4} blending={AdditiveBlending} toneMapped={false} />
        </mesh>
      ))}
      <mesh position={[0, 0.58, -0.02]}>
        <boxGeometry args={[0.2, 0.14, 0.012]} />
        <meshBasicMaterial color={BODY_LIGHT} toneMapped={false} />
      </mesh>
      {[-1, 1].flatMap((sd) => [0.55, 0.61].map((y) => (
        <mesh key={`${sd}${y}`} position={[sd * 0.115, y, -0.01]}>
          <circleGeometry args={[0.014, 10]} />
          <meshBasicMaterial color={ROLE_COLOR.bass} toneMapped={false} />
        </mesh>
      )))}
      <group ref={body}>
        {/* body: upper bout, waist, big lower bout, f-holes, bridge, tailpiece */}
        <mesh position={[0, -0.24, -0.03]}><circleGeometry args={[0.2, 36]} /><meshBasicMaterial color={BODY} toneMapped={false} /></mesh>
        <mesh position={[0, -0.6, -0.03]}><circleGeometry args={[0.3, 44]} /><meshBasicMaterial color={BODY} toneMapped={false} /></mesh>
        <mesh position={[0, -0.4, -0.031]}><planeGeometry args={[0.3, 0.3]} /><meshBasicMaterial color={BODY} toneMapped={false} /></mesh>
        <Outline r={0.2} w={0.008} color={ROLE_COLOR.bass} opacity={0.5} position={[0, -0.24, -0.02]} />
        <Outline r={0.3} w={0.008} color={ROLE_COLOR.bass} opacity={0.5} position={[0, -0.6, -0.02]} seg={52} />
        {[-1, 1].map((sd) => (
          <mesh key={sd} position={[sd * 0.1, -0.5, -0.012]} rotation={[0, 0, sd * 0.2]}>
            <planeGeometry args={[0.014, 0.16]} />
            <meshBasicMaterial color={ROLE_COLOR.bass} transparent opacity={0.7} blending={AdditiveBlending} toneMapped={false} />
          </mesh>
        ))}
        <mesh position={[0, -0.66, -0.005]}>
          <boxGeometry args={[0.24, 0.022, 0.008]} />
          <meshBasicMaterial color={ROLE_COLOR.bass} transparent opacity={0.75} blending={AdditiveBlending} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

// ------------------------------------------------------------------ melody
const PCS = 12;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SHARP = new Set([1, 3, 6, 8, 10]);
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
      {/* plinth, baseline and pitch-class labels */}
      <mesh position={[0, 0.4, -0.02]}>
        <boxGeometry args={[PCS * MELODY_BAR_W * 1.25 + 0.1, 0.03, 0.12]} />
        <meshBasicMaterial color={BODY_LIGHT} toneMapped={false} />
      </mesh>
      <Pole x={-0.4} z={-0.02} y1={0.4} r={0.01} />
      <Pole x={0.4} z={-0.02} y1={0.4} r={0.01} />
      <mesh position={[0, 0.418, 0.045]}>
        <boxGeometry args={[PCS * MELODY_BAR_W * 1.25 + 0.1, 0.004, 0.004]} />
        <meshBasicMaterial color={ROLE_COLOR.melody} transparent opacity={0.8} blending={AdditiveBlending} toneMapped={false} />
      </mesh>
      {NOTE_NAMES.map((n, i) => (
        <Text key={n} font={FONT.regular} fontSize={0.03} color={SHARP.has(i) ? DIM : ROLE_COLOR.melody} position={[melodyBarX(i), 0.375, 0.045]} anchorX="center" anchorY="top">
          {n}
        </Text>
      ))}
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
        <mesh key={i} ref={(m) => { strings.current[i] = m; }} position={[guitarStringX(i), -0.01, 0]} material={mats[i]}>
          <boxGeometry args={[0.006, 0.9, 0.006]} />
        </mesh>
      ))}
      {/* neck and headstock behind the strings */}
      <mesh position={[0, 0.05, -0.02]}>
        <boxGeometry args={[0.34, 0.8, 0.012]} />
        <meshBasicMaterial color={BODY} toneMapped={false} />
      </mesh>
      {[0.15, 0.3].map((y) => (
        <mesh key={y} position={[0, y, -0.012]}>
          <boxGeometry args={[0.34, 0.006, 0.004]} />
          <meshBasicMaterial color={ROLE_COLOR.guitar} transparent opacity={0.4} blending={AdditiveBlending} toneMapped={false} />
        </mesh>
      ))}
      <mesh position={[0, 0.5, -0.02]}>
        <boxGeometry args={[0.2, 0.2, 0.012]} />
        <meshBasicMaterial color={BODY_LIGHT} toneMapped={false} />
      </mesh>
      {[-1, 1].flatMap((sd) => [0.46, 0.54].map((y) => (
        <mesh key={`${sd}${y}`} position={[sd * 0.115, y, -0.01]}>
          <circleGeometry args={[0.014, 10]} />
          <meshBasicMaterial color={ROLE_COLOR.guitar} toneMapped={false} />
        </mesh>
      )))}
      <group ref={body}>
        {/* body: two bouts, soundhole, bridge */}
        <mesh position={[0, -0.12, -0.03]}><circleGeometry args={[0.21, 36]} /><meshBasicMaterial color={BODY} toneMapped={false} /></mesh>
        <mesh position={[0, -0.4, -0.03]}><circleGeometry args={[0.28, 40]} /><meshBasicMaterial color={BODY} toneMapped={false} /></mesh>
        <Outline r={0.21} w={0.008} color={ROLE_COLOR.guitar} opacity={0.5} position={[0, -0.12, -0.02]} />
        <Outline r={0.28} w={0.008} color={ROLE_COLOR.guitar} opacity={0.5} position={[0, -0.4, -0.02]} seg={48} />
        <Outline r={0.075} w={0.012} color={ROLE_COLOR.guitar} opacity={0.6} position={[0, -0.26, -0.01]} />
        <mesh position={[0, -0.46, -0.005]}>
          <boxGeometry args={[0.26, 0.022, 0.008]} />
          <meshBasicMaterial color={ROLE_COLOR.guitar} transparent opacity={0.7} blending={AdditiveBlending} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

export type { MeshBasicMaterial };
