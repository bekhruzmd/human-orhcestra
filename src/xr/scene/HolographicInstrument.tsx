import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { BufferGeometry, CylinderGeometry, Float32BufferAttribute, MeshBasicMaterial, PlaneGeometry, type Mesh } from 'three';
import { ROLE_LABEL, type PlayerInfo, type Role } from '../networking/protocol';
import { activity } from '../state/activity';
import { useStore } from '../state/store';
import { seat } from './layout';
import { BassCore, DrumKit, GuitarStrings, MelodyLadder, PianoKeys } from './instrumentVisuals';
import { DIM, FONT, INK, ROLE_COLOR, glassMat, glowMat } from './theme';
import { InstrumentControls } from './InstrumentControls';

const PANEL_W = 1.0, PANEL_H = 1.2;
const panelGeo = new PlaneGeometry(PANEL_W, PANEL_H);
/** Corner brackets instead of a full rectangle: reads as a frame without boxing the instrument in. */
const CORNER = 0.14;
const bracketGeo = (() => {
  const hw = PANEL_W / 2, hh = PANEL_H / 2, v: number[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    v.push(sx * hw, sy * hh, 0, sx * (hw - CORNER), sy * hh, 0, sx * hw, sy * hh, 0, sx * hw, sy * (hh - CORNER), 0);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(v, 3));
  return g;
})();
const baseGeo = new CylinderGeometry(0.58, 0.62, 0.02, 48);
const baseMat = new MeshBasicMaterial({ color: '#0a1620', transparent: true, opacity: 0.85, toneMapped: false });
const headerGeo = new PlaneGeometry(PANEL_W * 0.7, 0.004);

const Visual = ({ role }: { role: Role }) => {
  switch (role) {
    case 'drums': return <DrumKit />;
    case 'pads': return <PianoKeys />;
    case 'bass': return <BassCore />;
    case 'melody': return <MelodyLadder />;
    case 'guitar': return <GuitarStrings />;
  }
};

function seatCaption(players: PlayerInfo[]) {
  if (!players.length) return 'open seat';
  const names = players.map((p) => p.name + (p.connected ? '' : ' (away)'));
  return names.length > 2 ? `${names[0]}, ${names[1]} +${names.length - 2}` : names.join(', ');
}

export function HolographicInstrument({ role, players, active }: { role: Role; players: PlayerInfo[]; active: boolean }) {
  const s = seat(role);
  const color = ROLE_COLOR[role];
  const selected = useStore((st) => st.selected === role);
  const set = useStore((st) => st.set);
  const ringMat = useMemo(() => glowMat(color, 0.5), [color]);
  const lineMat = useMemo(() => glowMat(color, 0.35), [color]);
  const ring = useRef<Mesh>(null);
  const hover = useRef(false);

  useFrame(() => {
    const e = Math.min(1, activity.energy[role]);
    ringMat.opacity = (active ? 0.3 : 0.12) + e * 0.7 + (selected || hover.current ? 0.25 : 0);
    ring.current!.scale.setScalar(1 + e * 0.1);
    lineMat.opacity = (active ? 0.3 : 0.14) + e * 0.5 + (selected ? 0.3 : 0);
  });

  return (
    <group position={[s.x, 0, s.z]} rotation={[0, s.rotY, 0]}>
      <group
        onClick={(e) => { e.stopPropagation(); set({ selected: selected ? null : role }); }}
        onPointerOver={() => { hover.current = true; }}
        onPointerOut={() => { hover.current = false; }}
      >
        {/* pedestal disc */}
        <mesh geometry={baseGeo} material={baseMat} position={[0, -0.004, 0]} />
        {/* floor ring */}
        <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]} material={ringMat}>
          <ringGeometry args={[0.52, 0.56, 48]} />
        </mesh>
        {/* glass backdrop + neon frame */}
        <mesh geometry={panelGeo} material={glassMat} position={[0, 0.85, -0.18]} />
        <lineSegments geometry={bracketGeo} material={lineMat} position={[0, 0.85, -0.18]} />
        <mesh geometry={headerGeo} material={lineMat} position={[0, 1.4, -0.175]} />
        {/* generous invisible hit target so rays/pinches land easily */}
        <mesh position={[0, 0.8, 0]} visible={false}>
          <boxGeometry args={[1.0, 1.4, 0.5]} />
          <meshBasicMaterial />
        </mesh>
      </group>
      <Visual role={role} />
      <Text font={FONT.bold} position={[0, 1.58, -0.1]} fontSize={0.09} color={INK} anchorX="center" letterSpacing={0.08}>
        {ROLE_LABEL[role].toUpperCase()}
      </Text>
      <Text font={FONT.regular} position={[0, 1.47, -0.1]} fontSize={0.052} color={players.length ? color : DIM} anchorX="center">
        {seatCaption(players)}
      </Text>
      {selected && <InstrumentControls role={role} players={players} />}
    </group>
  );
}
