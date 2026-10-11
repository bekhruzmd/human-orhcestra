import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { orchestra } from '../networking/orchestraAdapter';
import { ROLES, type PlayerInfo, type Role } from '../networking/protocol';
import { activity } from '../state/activity';
import { useStore } from '../state/store';
import { HolographicInstrument } from './HolographicInstrument';
import { ConductorPanel } from './InstrumentControls';
import { NoteParticles } from './NoteParticles';
import { FONT, DIM, glowMat } from './theme';

/** Everything that lives in the room: instruments on a semicircle, the conductor mark, status panel, particles. */
export function SpatialStage() {
  const roster = useStore((s) => s.roster);
  const mode = useStore((s) => s.mode);
  const byRole = useMemo(() => {
    const m = Object.fromEntries(ROLES.map((r) => [r, [] as PlayerInfo[]])) as Record<Role, PlayerInfo[]>;
    for (const p of roster) m[p.role]?.push(p);
    return m;
  }, [roster]);
  const markMat = useMemo(() => glowMat('#7fdcff', 0.5), []);

  // First in the frame: apply due notes so every visual below reads this frame's state.
  useFrame((_, dt) => orchestra.tick(Math.min(dt, 0.1)), -10);

  return (
    <>
      {ROLES.map((r) => (
        <HolographicInstrument key={r} role={r} players={byRole[r]} active={byRole[r].length > 0 || activity.counts[r] > 0} />
      ))}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} material={markMat}>
        <ringGeometry args={[0.16, 0.18, 40]} />
      </mesh>
      <Text font={FONT.regular} fontSize={0.045} color={DIM} position={[0, 0.03, 0.3]} rotation={[-Math.PI / 2, 0, 0]} anchorX="center" letterSpacing={0.2}>
        CONDUCTOR
      </Text>
      <ConductorPanel />
      {mode === 'simulation' && (
        <Text font={FONT.bold} fontSize={0.07} color="#ffb020" position={[0, 2.05, -RADIUS_BANNER]} anchorX="center" letterSpacing={0.12}>
          SIMULATION · NOT A LIVE CONNECTION
        </Text>
      )}
      <NoteParticles />
    </>
  );
}

const RADIUS_BANNER = 1.7;
