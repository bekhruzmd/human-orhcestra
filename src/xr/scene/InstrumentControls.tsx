import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { ROLE_LABEL, type PlayerInfo, type Role } from '../networking/protocol';
import { orchestra } from '../networking/orchestraAdapter';
import { activity } from '../state/activity';
import { useStore } from '../state/store';
import { FONT, PAPER, ROLE_PASTEL } from './theme';
import { GlassPanel, SpatialButton, SpatialSlider } from './XRInteractions';

/**
 * Per-instrument panel. The Human Orchestra server has no per-instrument mute/volume command (those controls
 * live inside the Stage's own audio engine), so they are shown DISABLED. Nothing here pretends to work.
 */
export function InstrumentControls({ role, players }: { role: Role; players: PlayerInfo[] }) {
  const counter = useRef<any>(null);
  const last = useRef(-1);
  useFrame(() => {
    const n = activity.counts[role];
    if (n !== last.current && counter.current) { last.current = n; counter.current.text = `${n} notes seen`; counter.current.sync?.(); }
  });
  const color = ROLE_PASTEL[role];
  return (
    <GlassPanel width={0.66} height={0.5} position={[0, 0.42, 0.62]} rotation={[-0.55, 0, 0]} accent={color}>
      <Text font={FONT.bold} fontSize={0.05} color={PAPER.ink} position={[-0.29, 0.2, 0.004]} anchorX="left" letterSpacing={0.06}>{ROLE_LABEL[role].toUpperCase()}</Text>
      <Text font={FONT.regular} fontSize={0.036} color={PAPER.ink} position={[-0.29, 0.14, 0.004]} anchorX="left" maxWidth={0.58}>
        {players.length ? players.map((p) => p.name).join(', ') : 'No player on this seat'}
      </Text>
      <Text ref={counter} font={FONT.regular} fontSize={0.036} color={PAPER.soft} position={[-0.29, 0.09, 0.004]} anchorX="left">0 notes seen</Text>
      <SpatialButton position={[-0.12, 0.0, 0.004]} width={0.28} height={0.075} label="MUTE" disabled onPress={() => {}} accent={color} />
      <SpatialSlider position={[0, -0.1, 0.004]} width={0.52} value={0.8} disabled label="VOLUME" accent={color} />
      <Text font={FONT.regular} fontSize={0.028} color={PAPER.soft} position={[-0.29, -0.19, 0.004]} anchorX="left" maxWidth={0.58}>
        Not available: this server has no remote mute or volume command.
      </Text>
    </GlassPanel>
  );
}

/** Session-level panel anchored in the room (never head-locked). Shows real status and the real commands. */
export function ConductorPanel() {
  const { mode, status, privilege, transport, roster, rttMs } = useStore();
  const conductor = privilege === 'conductor' && mode === 'live' && status === 'connected';
  const paused = transport?.paused != null;
  const bpm = transport?.bpm ?? 0;
  const lockedTempo = !!(transport?.game || transport?.nowPlaying?.mode === 'jam');
  const live = mode === 'live' && status === 'connected';
  const headline = mode === 'simulation' ? 'SIMULATION' : live ? 'LIVE' : status === 'reconnecting' ? 'RECONNECTING' : 'OFFLINE';
  const tone = mode === 'simulation' ? PAPER.butter : live ? PAPER.mint : PAPER.pink;
  const bpmDrag = useRef(bpm);

  const title = transport?.game?.song?.title ?? (transport?.nowPlaying ? transport.nowPlaying.title : null);

  return (
    <GlassPanel width={0.8} height={0.62} position={[-0.8, 0.95, 0.15]} rotation={[0, 1.18, 0]} accent={tone}>
      <Text font={FONT.bold} fontSize={0.05} color={PAPER.ink} position={[-0.36, 0.25, 0.004]} anchorX="left" letterSpacing={0.1}>{headline}</Text>
      <Text font={FONT.regular} fontSize={0.034} color={PAPER.ink} position={[-0.36, 0.19, 0.004]} anchorX="left" maxWidth={0.72}>
        {`${roster.length} player${roster.length === 1 ? '' : 's'}  ·  ${bpm ? Math.round(bpm) + ' BPM' : '— BPM'}  ·  ${paused ? 'PAUSED' : transport ? 'RUNNING' : 'IDLE'}${rttMs != null ? `  ·  ${rttMs} ms` : ''}`}
      </Text>
      <Text font={FONT.regular} fontSize={0.032} color={PAPER.soft} position={[-0.36, 0.14, 0.004]} anchorX="left" maxWidth={0.72}>
        {title ? `Song: ${title}` : 'No song loaded'}
      </Text>
      <SpatialButton position={[0.28, 0.25, 0.004]} width={0.2} height={0.06} label="RECENTER" accent={PAPER.sky}
        onPress={() => useStore.getState().set({ placeNonce: useStore.getState().placeNonce + 1 })} />
      <SpatialButton position={[-0.19, 0.04, 0.004]} width={0.34} height={0.08} label={paused ? 'RESUME' : 'PAUSE'} disabled={!conductor} accent={tone}
        onPress={() => orchestra.command('pause', !paused)} />
      <SpatialButton position={[0.19, 0.04, 0.004]} width={0.34} height={0.08} label="BEAT DROP" disabled={!conductor || paused} accent={PAPER.peach}
        onPress={() => orchestra.command('drop')} />
      <SpatialSlider position={[0, -0.09, 0.004]} width={0.66} label={`TEMPO ${Math.round(bpm)} BPM`} accent={tone}
        value={(bpm - 60) / 120} disabled={!conductor || lockedTempo}
        onChange={(v) => { bpmDrag.current = Math.round(60 + v * 120); }}
        onCommit={() => orchestra.command('bpm', bpmDrag.current)} />
      <Text font={FONT.regular} fontSize={0.028} color={PAPER.soft} position={[-0.36, -0.2, 0.004]} anchorX="left" maxWidth={0.72}>
        {conductor ? (lockedTempo ? 'Tempo is locked during a game or jam.' : 'Conductor mode: commands go to the real orchestra.')
          : 'Observer mode: read-only. Reconnect as Conductor to enable commands.'}
      </Text>
    </GlassPanel>
  );
}
