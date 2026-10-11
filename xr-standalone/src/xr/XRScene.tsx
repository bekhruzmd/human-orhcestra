import { useEffect, useRef, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { XR, useXR } from '@react-three/xr';
import { Vector3, type Group } from 'three';
import { useStore } from '../state/store';
import { SpatialStage } from './SpatialStage';
import { xrStore } from './xrStore';

const head = new Vector3();
const dir = new Vector3();

/**
 * Puts the orchestra in the room ONCE per session (centred on the user, facing where they look) and then leaves it
 * alone, so it stays fixed relative to the room instead of following the head. "Recenter" re-places it.
 */
function RoomAnchor({ children }: { children: ReactNode }) {
  const group = useRef<Group>(null);
  const session = useXR((s) => s.session);
  const nonce = useStore((s) => s.placeNonce);
  const placed = useRef(false);
  const frames = useRef(0);

  useEffect(() => {
    placed.current = false; frames.current = 0;
    if (!session) { group.current?.position.set(0, 0, 0); group.current?.rotation.set(0, 0, 0); }
  }, [session, nonce]);

  useFrame(({ camera }) => {
    if (!session || placed.current) return;
    frames.current++;
    camera.getWorldPosition(head);
    // Wait for a real head pose (local-floor: head ~1-2 m up). If the device only gives a 'local' space, fall back after ~1 s.
    if (head.y < 0.4 && frames.current < 60) return;
    camera.getWorldDirection(dir);
    const g = group.current!;
    g.position.set(head.x, head.y < 0.4 ? head.y - 1.4 : 0, head.z);
    g.rotation.set(0, Math.atan2(-dir.x, -dir.z), 0);
    placed.current = true;
  });

  return <group ref={group}>{children}</group>;
}

function DesktopControls() {
  const session = useXR((s) => s.session);
  return session ? null : <OrbitControls makeDefault target={[0, 0.8, -1.1]} maxPolarAngle={Math.PI * 0.52} minDistance={0.6} maxDistance={7} enableDamping />;
}

function SessionFlag() {
  const session = useXR((s) => s.session);
  useEffect(() => { useStore.getState().set({ inXR: !!session }); }, [session]);
  return null;
}

export function XRScene() {
  return (
    <Canvas
      camera={{ position: [0, 2.0, 3.4], fov: 52, near: 0.05, far: 60 }}
      dpr={[1, 1.75]}
      gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
      style={{ position: 'absolute', inset: 0 }}
    >
      <XR store={xrStore}>
        <SessionFlag />
        <DesktopControls />
        <RoomAnchor>
          <SpatialStage />
        </RoomAnchor>
      </XR>
    </Canvas>
  );
}
