/**
 * Spatial UI primitives. They use plain R3F pointer events, which @react-three/xr drives from controller rays
 * AND from hand-tracking pinch rays, so one implementation serves mouse, controllers and hands.
 */
import { useMemo, useRef, type ReactNode } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { EdgesGeometry, PlaneGeometry, Vector3, type Mesh } from 'three';
import { DIM, FONT, INK, glassMat, glowMat } from './theme';

type V3 = [number, number, number];

export function GlassPanel({ width, height, position, rotation, accent = '#52e0ff', children }:
  { width: number; height: number; position?: V3; rotation?: V3; accent?: string; children?: ReactNode }) {
  const geo = useMemo(() => new PlaneGeometry(width, height), [width, height]);
  const edges = useMemo(() => new EdgesGeometry(geo), [geo]);
  const line = useMemo(() => glowMat(accent, 0.45), [accent]);
  return (
    <group position={position} rotation={rotation}>
      <mesh geometry={geo} material={glassMat} />
      <lineSegments geometry={edges} material={line} />
      {children}
    </group>
  );
}

export function SpatialButton({ position, width = 0.36, height = 0.09, label, onPress, disabled, accent = '#52e0ff', active }:
  { position: V3; width?: number; height?: number; label: string; onPress: () => void; disabled?: boolean; accent?: string; active?: boolean }) {
  const hover = useRef(false);
  const mat = useMemo(() => glowMat(accent, 0.15), [accent]);
  const geo = useMemo(() => new PlaneGeometry(width, height), [width, height]);
  const edges = useMemo(() => new EdgesGeometry(geo), [geo]);
  const line = useMemo(() => glowMat(accent, 0.6), [accent]);
  useFrame(() => {
    mat.opacity = disabled ? 0.04 : active ? 0.4 : hover.current ? 0.32 : 0.14;
    line.opacity = disabled ? 0.15 : 0.7;
  });
  return (
    <group position={position}>
      <mesh
        geometry={geo} material={mat}
        onClick={(e) => { e.stopPropagation(); if (!disabled) onPress(); }}
        onPointerOver={() => { hover.current = true; }}
        onPointerOut={() => { hover.current = false; }}
      />
      <lineSegments geometry={edges} material={line} />
      <Text font={FONT.bold} fontSize={height * 0.4} color={disabled ? DIM : INK} position={[0, 0, 0.004]} anchorX="center" anchorY="middle" letterSpacing={0.06}>
        {label}
      </Text>
    </group>
  );
}

export function SpatialSlider({ position, width = 0.4, value, onChange, onCommit, disabled, accent = '#52e0ff', label }:
  { position: V3; width?: number; value: number; onChange?: (v: number) => void; onCommit?: (v: number) => void; disabled?: boolean; accent?: string; label?: string }) {
  const track = useRef<Mesh>(null);
  const knob = useRef<Mesh>(null);
  const dragging = useRef(false);
  const local = useMemo(() => new Vector3(), []);
  const knobMat = useMemo(() => glowMat(accent, 0.9), [accent]);
  const fillMat = useMemo(() => glowMat(accent, 0.5), [accent]);
  const fill = useRef<Mesh>(null);
  const latest = useRef(value);
  latest.current = value;

  useFrame(() => {
    const v = Math.max(0, Math.min(1, latest.current));
    knob.current!.position.x = (v - 0.5) * width;
    fill.current!.scale.x = Math.max(0.001, v);
    fill.current!.position.x = -width / 2 + (v * width) / 2;
    knobMat.opacity = disabled ? 0.2 : 0.9;
    fillMat.opacity = disabled ? 0.12 : 0.5;
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
      {label && <Text font={FONT.regular} fontSize={0.04} color={disabled ? DIM : INK} position={[-width / 2, 0.06, 0]} anchorX="left">{label}</Text>}
      <mesh ref={track}
        onPointerDown={(e) => { e.stopPropagation(); dragging.current = true; (e.target as Element)?.setPointerCapture?.(e.pointerId); setFrom(e); }}
        onPointerMove={(e) => { if (dragging.current) setFrom(e); }}
        onPointerUp={() => { if (dragging.current) { dragging.current = false; if (!disabled) onCommit?.(latest.current); } }}
        onPointerMissed={() => { dragging.current = false; }}
      >
        <planeGeometry args={[width, 0.09]} />
        <meshBasicMaterial transparent opacity={0.04} depthWrite={false} color="#7fdcff" toneMapped={false} />
      </mesh>
      <mesh ref={fill} material={fillMat} position={[0, 0, 0.002]}><planeGeometry args={[width, 0.012]} /></mesh>
      <mesh position={[0, 0, 0.001]}>
        <planeGeometry args={[width, 0.004]} />
        <meshBasicMaterial color={disabled ? DIM : '#7fdcff'} transparent opacity={0.5} toneMapped={false} />
      </mesh>
      <mesh ref={knob} material={knobMat} position={[0, 0, 0.004]}><circleGeometry args={[0.022, 20]} /></mesh>
    </group>
  );
}
