/**
 * Spatial UI primitives. They use plain R3F pointer events, which @react-three/xr drives from controller rays
 * AND from hand-tracking pinch rays, so one implementation serves mouse, controllers and hands.
 */
import { useMemo, useRef, type ReactNode } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { Color, MeshBasicMaterial, PlaneGeometry, Vector3, type Group, type Mesh } from 'three';
import { FONT, PAPER, inkMat, paperMat, shadowMat, solidMat } from './theme';

type V3 = [number, number, number];

const T = 0.008; // outline thickness: one "pixel" of the Stage UI

/** Opaque paper card: ink outline, hard lilac offset shadow, pastel title strip. `accent` is a pastel from ROLE_PASTEL. */
export function GlassPanel({ width, height, position, rotation, accent = PAPER.lilac, children }:
  { width: number; height: number; position?: V3; rotation?: V3; accent?: string; children?: ReactNode }) {
  const bar = useMemo(() => solidMat(accent), [accent]);
  return (
    <group position={position} rotation={rotation}>
      <mesh material={shadowMat} position={[0.018, -0.018, -0.006]}><planeGeometry args={[width + 2 * T, height + 2 * T]} /></mesh>
      <mesh material={inkMat} position={[0, 0, -0.004]}><planeGeometry args={[width + 2 * T, height + 2 * T]} /></mesh>
      <mesh material={paperMat} position={[0, 0, -0.002]}><planeGeometry args={[width, height]} /></mesh>
      <mesh material={bar} position={[0, height / 2 - 0.045, -0.001]}><planeGeometry args={[width, 0.09]} /></mesh>
      <mesh material={inkMat} position={[0, height / 2 - 0.09, -0.0005]}><planeGeometry args={[width, T]} /></mesh>
      {children}
    </group>
  );
}

export function SpatialButton({ position, width = 0.36, height = 0.09, label, onPress, disabled, accent = PAPER.lilac, active }:
  { position: V3; width?: number; height?: number; label: string; onPress: () => void; disabled?: boolean; accent?: string; active?: boolean }) {
  const hover = useRef(false);
  const face = useRef<Mesh>(null);
  const grp = useRef<Group>(null);
  const fill = useMemo(() => solidMat(PAPER.paper), []);
  const tint = useMemo(() => new Color(accent), [accent]);
  const white = useMemo(() => new Color('#ffffff'), []);
  const geo = useMemo(() => new PlaneGeometry(width, height), [width, height]);
  useFrame(() => {
    fill.color.copy(disabled ? white : active || hover.current ? tint : white);
    if (grp.current) grp.current.position.set(hover.current && !disabled ? -0.004 : 0, hover.current && !disabled ? 0.004 : 0, 0);
    if (face.current) (face.current.material as MeshBasicMaterial).opacity = disabled ? 0.45 : 1;
  });
  return (
    <group position={position}>
      <mesh material={inkMat} position={[0.01, -0.01, -0.002]}><planeGeometry args={[width + 2 * T, height + 2 * T]} /></mesh>
      <group ref={grp}>
        <mesh material={inkMat} position={[0, 0, 0.0005]}><planeGeometry args={[width + 2 * T, height + 2 * T]} /></mesh>
        <mesh
          ref={face} geometry={geo} material={fill} position={[0, 0, 0.001]}
          onClick={(e) => { e.stopPropagation(); if (!disabled) onPress(); }}
          onPointerOver={() => { hover.current = true; }}
          onPointerOut={() => { hover.current = false; }}
        />
        <Text font={FONT.bold} fontSize={height * 0.36} color={disabled ? PAPER.soft : PAPER.ink} position={[0, 0, 0.004]} anchorX="center" anchorY="middle" letterSpacing={0.06}>
          {label}
        </Text>
      </group>
    </group>
  );
}

export function SpatialSlider({ position, width = 0.4, value, onChange, onCommit, disabled, accent = PAPER.lilac, label }:
  { position: V3; width?: number; value: number; onChange?: (v: number) => void; onCommit?: (v: number) => void; disabled?: boolean; accent?: string; label?: string }) {
  const track = useRef<Mesh>(null);
  const knob = useRef<Mesh>(null);
  const dragging = useRef(false);
  const local = useMemo(() => new Vector3(), []);
  const knobMat = useMemo(() => solidMat(accent), [accent]);
  const fillMat = useMemo(() => solidMat(accent), [accent]);
  const fill = useRef<Mesh>(null);
  const knobFace = useRef<Mesh>(null);
  const latest = useRef(value);
  latest.current = value;

  useFrame(() => {
    const v = Math.max(0, Math.min(1, latest.current));
    knob.current!.position.x = (v - 0.5) * width;
    knobFace.current!.position.x = (v - 0.5) * width;
    fill.current!.scale.x = Math.max(0.001, v);
    fill.current!.position.x = -width / 2 + (v * width) / 2;
  });

  const setFrom = (e: ThreeEvent<PointerEvent>) => {
    if (disabled || !track.current) return;
    track.current.worldToLocal(local.copy(e.point));
    const v = Math.max(0, Math.min(1, local.x / width + 0.5));
    latest.current = v;
    onChange?.(v);
  };

  return (
    <group position={position}>
      {label && <Text font={FONT.regular} fontSize={0.04} color={disabled ? PAPER.soft : PAPER.ink} position={[-width / 2, 0.06, 0]} anchorX="left">{label}</Text>}
      <mesh ref={track}
        onPointerDown={(e) => { e.stopPropagation(); dragging.current = true; (e.target as Element)?.setPointerCapture?.(e.pointerId); setFrom(e); }}
        onPointerMove={(e) => { if (dragging.current) setFrom(e); }}
        onPointerUp={() => { if (dragging.current) { dragging.current = false; if (!disabled) onCommit?.(latest.current); } }}
        onPointerMissed={() => { dragging.current = false; }}
      >
        <planeGeometry args={[width, 0.09]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh material={inkMat} position={[0, 0, 0.001]}><planeGeometry args={[width + 2 * T, 0.034 + 2 * T]} /></mesh>
      <mesh position={[0, 0, 0.0015]}><planeGeometry args={[width, 0.034]} /><meshBasicMaterial color={PAPER.paper2} toneMapped={false} /></mesh>
      <mesh ref={fill} material={fillMat} position={[0, 0, 0.002]}><planeGeometry args={[width, 0.034]} /></mesh>
      <mesh ref={knob} position={[0, 0, 0.004]}>
        <planeGeometry args={[0.03 + 2 * T, 0.07 + 2 * T]} /><primitive object={inkMat} attach="material" />
      </mesh>
      <mesh ref={knobFace} material={knobMat} position={[0, 0, 0.0045]}><planeGeometry args={[0.03, 0.07]} /></mesh>
    </group>
  );
}
