/**
 * Spatial UI primitives. They use plain R3F pointer events, which @react-three/xr drives from controller rays
 * AND from hand-tracking pinch rays, so one implementation serves mouse, controllers and hands.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { Color, MeshBasicMaterial, Plane, PlaneGeometry, Vector3, type Group, type Mesh } from 'three';
import { useXR } from '@react-three/xr';
import { isFocus, useStore } from '../state/store';
import { load, save } from '../utils/storage';
import { FONT, PAPER, inkMat, paperMat, shadowMat, solidMat } from './theme';

type V3 = [number, number, number];

/** Controls put their invisible hit planes this far in front of the card, above every visual and label. */
const HIT_Z = 0.008;
const T = 0.008; // outline thickness: one "pixel" of the Stage UI

const worldPoint = new Vector3();
const grabPoint = new Vector3();
const startPos = new Vector3();
const camPos = new Vector3();
const plane = new Plane();
const hit = new Vector3();
const slideN = new Vector3();
const slideP = new Vector3();
const slidePlane = new Plane();
const slideHit = new Vector3();

/**
 * Where the pointer ray crosses the plane of `obj`, in `obj`'s local space. Unlike `event.point` this keeps working
 * after the ray has left the control (a captured drag), where `event.point` freezes at the press position.
 */
function localOnPlane(obj: Mesh, e: ThreeEvent<PointerEvent>, out: Vector3): boolean {
  obj.updateWorldMatrix(true, false);
  slideN.set(0, 0, 1).transformDirection(obj.matrixWorld);
  slideP.setFromMatrixPosition(obj.matrixWorld);
  slidePlane.setFromNormalAndCoplanarPoint(slideN, slideP);
  if (!e.ray.intersectPlane(slidePlane, slideHit)) return false;
  obj.worldToLocal(out.copy(slideHit));
  return true;
}
const local = new Vector3();

type Pose = { pos: Vector3; yaw: number; pitch: number; scale: number };
const loadPose = (key: string): number[] | null => {
  try { const v = JSON.parse(load(key) ?? 'null'); return Array.isArray(v) && v.length >= 4 && v.every(Number.isFinite) ? v : null; } catch { return null; }
};
const poseFrom = (v: number[] | null, pos: V3, rot: V3 | undefined, scale = 1): Pose =>
  v ? { pos: new Vector3(v[0], v[1], v[2]), yaw: v[3], pitch: v[4] ?? rot?.[0] ?? 0, scale: v[5] ?? scale }
    : { pos: new Vector3(...pos), yaw: rot?.[1] ?? 0, pitch: rot?.[0] ?? 0, scale };
const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/**
 * Opaque paper card: ink outline, hard lilac offset shadow, pastel title strip. `accent` is a pastel from ROLE_PASTEL.
 * With `id` the card is movable anywhere: grab the title strip or the grip ledge under the card (mouse, controller
 * ray or pinch) and drag. The card rides the end of the ray, so it can go up to the ceiling or across the room;
 * while you hold it, the thumbstick (or mouse wheel) pushes it farther or pulls it closer. It grows with distance,
 * turns to face you and remembers where it was left.
 * With `dock`, the card glides to that spot while focus mode is on (a song is playing) and back again afterwards.
 * Only the two handles drag, so buttons, sliders and faders on the card never compete with the drag.
 */
export function GlassPanel({ width, height, position, rotation, accent = PAPER.lilac, id, dock, children }:
  { width: number; height: number; position?: V3; rotation?: V3; accent?: string; id?: string; dock?: { position: V3; rotation?: V3; scale?: number }; children?: ReactNode }) {
  const bar = useMemo(() => solidMat(accent), [accent]);
  const group = useRef<Group>(null);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const session = useXR((s) => s.session);
  const reset = useStore((s) => s.panelResetNonce);
  const focus = useStore(isFocus);

  // Poses are created ONCE and mutated in place; the group's props never change identity, so a re-render of the
  // parent can never snap the card back to its starting spot.
  const poses = useRef<{ home: Pose; dock: Pose | null } | null>(null);
  if (!poses.current) {
    const def = position ?? [0, 0, 0];
    poses.current = {
      home: poseFrom(id ? loadPose(`hoxr.panel.${id}`) : null, def, rotation),
      dock: dock ? poseFrom(id ? loadPose(`hoxr.dock.${id}`) : null, dock.position, dock.rotation, dock.scale ?? 0.7) : null,
    };
  }
  const P = poses.current;
  const initial = useRef({ pos: P.home.pos.clone(), rot: [P.home.pitch, P.home.yaw, rotation?.[2] ?? 0, 'YXZ'] as [number, number, number, 'YXZ'], scale: P.home.scale });
  const target = () => (focus && P.dock ? P.dock : P.home);

  useEffect(() => {
    if (!id || reset === 0) return;
    P.home = poseFrom(null, position ?? [0, 0, 0], rotation);
    if (dock) P.dock = poseFrom(null, dock.position, dock.rotation, dock.scale ?? 0.7);
    save(`hoxr.panel.${id}`, 'null'); save(`hoxr.dock.${id}`, 'null');
  }, [reset]); // eslint-disable-line react-hooks/exhaustive-deps

  // drag state
  const d = useRef({ pending: false, active: false, dist: 1, dist0: 1, scale0: 1, rayO: new Vector3(), rayD: new Vector3(), grab: new Vector3(), off: new Vector3() });
  const offset = useRef(new Vector3());

  const place = () => {
    const g = group.current; const st = d.current;
    if (!g || !g.parent) return;
    g.scale.setScalar(Math.max(0.4, Math.min(5, st.scale0 * (st.dist / st.dist0))));
    // world position: the point on the ray at the current distance, plus the grab offset scaled with the card
    worldPoint.copy(st.rayO).addScaledVector(st.rayD, st.dist).addScaledVector(st.off, g.scale.x / st.scale0);
    const p = g.parent;
    p.updateWorldMatrix(true, false);
    g.position.copy(p.worldToLocal(worldPoint));
    // face the viewer: yaw and pitch, so a card on the ceiling tilts down at you
    camera.getWorldPosition(camPos);
    const w = g.getWorldPosition(offset.current);
    const dx = camPos.x - w.x, dy = camPos.y - w.y, dz = camPos.z - w.z;
    p.getWorldDirection(hit);
    g.rotation.set(Math.max(-1.2, Math.min(1.2, -Math.atan2(dy, Math.hypot(dx, dz)))), Math.atan2(dx, dz) - Math.atan2(hit.x, hit.z), 0, 'YXZ');
  };

  const end = () => {
    const st = d.current; const g = group.current;
    const moved = st.active;
    st.pending = false; st.active = false;
    if (!moved || !g || !id) return;
    const t = target();
    t.pos.copy(g.position); t.yaw = g.rotation.y; t.pitch = g.rotation.x; t.scale = g.scale.x;
    save(`${t === P.dock ? 'hoxr.dock' : 'hoxr.panel'}.${id}`, JSON.stringify([g.position.x, g.position.y, g.position.z, g.rotation.y, g.rotation.x, g.scale.x]));
  };
  const endRef = useRef(end); endRef.current = end;

  // A drag must ALWAYS end when the button or pinch is released, wherever the ray is: otherwise the card would keep
  // following the pointer and swallow every later press.
  useEffect(() => {
    const stop = () => endRef.current();
    window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop); window.addEventListener('blur', stop);
    session?.addEventListener('selectend', stop); session?.addEventListener('squeezeend', stop); session?.addEventListener('end', stop);
    return () => {
      window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); window.removeEventListener('blur', stop);
      session?.removeEventListener('selectend', stop); session?.removeEventListener('squeezeend', stop); session?.removeEventListener('end', stop);
    };
  }, [session]);

  useFrame((_, dt, frame) => {
    const g = group.current; const st = d.current;
    if (!g) return;
    if (st.active) {
      // depth control while holding: thumbstick on a controller
      const xrFrame = frame as XRFrame | undefined;
      let push = 0;
      if (xrFrame) for (const src of xrFrame.session.inputSources) { const a = src.gamepad?.axes; if (a && a.length >= 4 && Math.abs(a[3]) > 0.2) push = a[3]; }
      if (push) { st.dist = Math.max(0.3, Math.min(14, st.dist * Math.exp(-push * dt * 1.2))); place(); }
      return;
    }
    if (st.pending) return;
    // glide to wherever this card belongs right now: its own spot, or the dock while focus mode is on
    const t = target();
    const k = 1 - Math.exp(-dt * 5);
    g.position.lerp(t.pos, k);
    g.scale.setScalar(g.scale.x + (t.scale - g.scale.x) * k);
    g.rotation.set(g.rotation.x + (t.pitch - g.rotation.x) * k, g.rotation.y + angleDelta(g.rotation.y, t.yaw) * k, 0, 'YXZ');
  });

  useEffect(() => {
    const el = gl.domElement;
    const wheel = (e: WheelEvent) => {
      const st = d.current;
      if (!st.pending) return;
      e.preventDefault();
      st.dist = Math.max(0.3, Math.min(14, st.dist * Math.exp(-e.deltaY * 0.0015)));
      if (st.active) place();
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [gl]); // eslint-disable-line react-hooks/exhaustive-deps

  const begin = (e: ThreeEvent<PointerEvent>) => {
    const g = group.current;
    if (!id || !g) return;
    e.stopPropagation();
    (e.target as Element)?.setPointerCapture?.(e.pointerId);
    const st = d.current;
    st.pending = true; st.active = false;
    st.rayO.copy(e.ray.origin); st.rayD.copy(e.ray.direction);
    st.grab.copy(e.point);
    st.dist = st.dist0 = Math.max(0.2, st.grab.distanceTo(st.rayO));
    st.scale0 = g.scale.x;
    g.getWorldPosition(st.off).sub(st.grab);
  };
  const move = (e: ThreeEvent<PointerEvent>) => {
    const st = d.current;
    if (!st.pending || !group.current) return;
    st.rayO.copy(e.ray.origin); st.rayD.copy(e.ray.direction);
    if (!st.active) {
      worldPoint.copy(st.rayO).addScaledVector(st.rayD, st.dist0).sub(st.grab);
      if (worldPoint.length() < 0.03) return;
      st.active = true;
    }
    e.stopPropagation();
    place();
  };
  const handle = { onPointerDown: begin, onPointerMove: move, onPointerUp: end, onPointerMissed: end };
  const ledgeY = -height / 2 - 0.036;

  return (
    <group ref={group} position={initial.current.pos} rotation={initial.current.rot} scale={initial.current.scale}
      onPointerOver={() => useStore.getState().set({ uiHover: true })} onPointerOut={() => useStore.getState().set({ uiHover: false })}>
      <mesh material={shadowMat} position={[0.018, -0.018, -0.006]}><planeGeometry args={[width + 2 * T, height + 2 * T]} /></mesh>
      <mesh material={inkMat} position={[0, 0, -0.004]}><planeGeometry args={[width + 2 * T, height + 2 * T]} /></mesh>
      <mesh material={paperMat} position={[0, 0, -0.002]}><planeGeometry args={[width, height]} /></mesh>
      <mesh material={bar} position={[0, height / 2 - 0.045, -0.001]}><planeGeometry args={[width, 0.09]} /></mesh>
      <mesh material={inkMat} position={[0, height / 2 - 0.09, -0.0005]}><planeGeometry args={[width, T]} /></mesh>
      {id && (
        <>
          {/* window-bar grip: three ink squares at the left of the title strip */}
          {[0, 1, 2].map((i) => <mesh key={i} material={inkMat} position={[-width / 2 + 0.04 + i * 0.024, height / 2 - 0.045, 0.001]}><planeGeometry args={[0.012, 0.012]} /></mesh>)}
          {/* grip ledge under the card: a second, easy handle */}
          <mesh material={inkMat} position={[0, ledgeY, -0.003]}><planeGeometry args={[width * 0.5 + 2 * T, 0.05 + 2 * T]} /></mesh>
          <mesh material={bar} position={[0, ledgeY, -0.0025]}><planeGeometry args={[width * 0.5, 0.05]} /></mesh>
          {[-1, 0, 1].map((i) => <mesh key={i} material={inkMat} position={[i * 0.04, ledgeY, -0.002]}><planeGeometry args={[0.022, 0.012]} /></mesh>)}
          {/* invisible handles, in FRONT of every label and visual */}
          <mesh position={[0, height / 2 - 0.045, HIT_Z]} {...handle}><planeGeometry args={[width, 0.09]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /></mesh>
          <mesh position={[0, ledgeY, HIT_Z]} {...handle}><planeGeometry args={[width * 0.5 + 0.04, 0.09]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /></mesh>
        </>
      )}
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
      <mesh material={inkMat} position={[0.006, -0.006, -0.002]}><planeGeometry args={[width + 2 * T, height + 2 * T]} /></mesh>
      <group ref={grp}>
        <mesh material={inkMat} position={[0, 0, 0.0005]}><planeGeometry args={[width + 2 * T, height + 2 * T]} /></mesh>
        <mesh ref={face} geometry={geo} material={fill} position={[0, 0, 0.001]} />
        <Text font={FONT.bold} fontSize={height * 0.36} color={disabled ? PAPER.soft : PAPER.ink} position={[0, 0, 0.004]} anchorX="center" anchorY="middle" letterSpacing={0.06}>
          {label}
        </Text>
        {/* hit target in FRONT of the label so a press on the text still presses the button (and never starts a panel drag) */}
        <mesh
          position={[0, 0, HIT_Z]}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); if (!disabled) onPress(); }}
          onPointerOver={() => { hover.current = true; }}
          onPointerOut={() => { hover.current = false; }}
        >
          <planeGeometry args={[width, height]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
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
    if (disabled || !track.current || !localOnPlane(track.current, e, local)) return;
    const v = Math.max(0, Math.min(1, local.x / width + 0.5));
    latest.current = v;
    onChange?.(v);
  };

  return (
    <group position={position}>
      {label && <Text font={FONT.regular} fontSize={0.04} color={disabled ? PAPER.soft : PAPER.ink} position={[-width / 2, 0.06, 0]} anchorX="left">{label}</Text>}
      <mesh ref={track} position={[0, 0, HIT_Z]}
        onPointerDown={(e) => { e.stopPropagation(); dragging.current = true; (e.target as Element)?.setPointerCapture?.(e.pointerId); setFrom(e); }}
        onPointerMove={(e) => { if (dragging.current) { e.stopPropagation(); setFrom(e); } }}
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

/** Vertical fader for a mixer strip. `value` is 0..1 of the track; `mark` draws a tick (e.g. unity gain); `meter` is a live 0..1 level. */
export function SpatialFader({ position, height = 0.36, value, onChange, onCommit, disabled, accent = PAPER.lilac, mark, meter }:
  { position: V3; height?: number; value: number; onChange?: (v: number) => void; onCommit?: (v: number) => void; disabled?: boolean; accent?: string; mark?: number; meter?: () => number }) {
  const track = useRef<Mesh>(null);
  const knob = useRef<Group>(null);
  const fill = useRef<Mesh>(null);
  const level = useRef<Mesh>(null);
  const dragging = useRef(false);
  const local = useMemo(() => new Vector3(), []);
  const fillMat = useMemo(() => solidMat(accent), [accent]);
  const knobMat = useMemo(() => solidMat(accent), [accent]);
  const latest = useRef(value);
  if (!dragging.current) latest.current = value;
  const W = 0.034;

  useFrame(() => {
    const v = Math.max(0, Math.min(1, latest.current));
    knob.current!.position.y = (v - 0.5) * height;
    fill.current!.scale.y = Math.max(0.001, v);
    fill.current!.position.y = -height / 2 + (v * height) / 2;
    if (level.current) {
      const m = Math.max(0, Math.min(1, meter ? meter() : 0));
      level.current.scale.y = Math.max(0.001, m);
      level.current.position.y = -height / 2 + (m * height) / 2;
    }
  });
  const setFrom = (e: ThreeEvent<PointerEvent>) => {
    if (disabled || !track.current || !localOnPlane(track.current, e, local)) return;
    const v = Math.max(0, Math.min(1, local.y / height + 0.5));
    latest.current = v;
    onChange?.(v);
  };
  return (
    <group position={position}>
      <mesh ref={track} position={[0, 0, HIT_Z]}
        onPointerDown={(e) => { e.stopPropagation(); dragging.current = true; (e.target as Element)?.setPointerCapture?.(e.pointerId); setFrom(e); }}
        onPointerMove={(e) => { if (dragging.current) { e.stopPropagation(); setFrom(e); } }}
        onPointerUp={() => { if (dragging.current) { dragging.current = false; if (!disabled) onCommit?.(latest.current); } }}
        onPointerMissed={() => { dragging.current = false; }}
      >
        <planeGeometry args={[0.1, height + 0.06]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh material={inkMat} position={[0, 0, 0.001]}><planeGeometry args={[W + 2 * T, height + 2 * T]} /></mesh>
      <mesh position={[0, 0, 0.0015]}><planeGeometry args={[W, height]} /><meshBasicMaterial color={PAPER.paper2} toneMapped={false} /></mesh>
      <mesh ref={fill} material={fillMat} position={[0, 0, 0.002]}><planeGeometry args={[W, height]} /></mesh>
      {meter && <mesh ref={level} position={[W / 2 + 0.014, 0, 0.002]}><planeGeometry args={[0.012, height]} /><meshBasicMaterial color={PAPER.ink} toneMapped={false} /></mesh>}
      {mark !== undefined && <mesh material={inkMat} position={[0, (mark - 0.5) * height, 0.003]}><planeGeometry args={[W + 0.03, 0.006]} /></mesh>}
      <group ref={knob} position={[0, 0, 0.004]}>
        <mesh material={inkMat}><planeGeometry args={[0.07 + 2 * T, 0.03 + 2 * T]} /></mesh>
        <mesh material={knobMat} position={[0, 0, 0.0005]}><planeGeometry args={[0.07, 0.03]} /></mesh>
      </group>
    </group>
  );
}
