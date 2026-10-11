import { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { ROLES, ROLE_LABEL, defaultMix, type MixState, type PlayerInfo, type Role, type ScaleName } from '../networking/protocol';
import { audioLink, orchestra } from '../networking/orchestraAdapter';
import { TempoTracker } from '../networking/baton';
import { activity } from '../state/activity';
import { useStore } from '../state/store';
import { SONGS } from '../../../shared/songs';
import { FONT, PAPER, ROLE_PASTEL } from './theme';
import { GlassPanel, SpatialButton, SpatialFader, SpatialSlider } from './XRInteractions';

const SHORT: Record<Role, string> = { drums: 'DRUMS', bass: 'BASS', melody: 'LEAD', pads: 'PIANO', guitar: 'GUITAR' };
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SCALES: { id: ScaleName; label: string }[] = [
  { id: 'minorPent', label: 'MINOR' }, { id: 'majorPent', label: 'MAJOR' }, { id: 'dorian', label: 'DORIAN' }, { id: 'blues', label: 'BLUES' },
];
const EMPTY_MIX = defaultMix();
const VOL_MAX = 1.5, MASTER_MAX = 1.2;

/** Live mix from the server's transport (every client sees the same one). */
const useMix = (): MixState => useStore((s) => s.transport?.mix) ?? EMPTY_MIX;
const useConductor = () => useStore((s) => s.privilege === 'conductor' && s.mode === 'live' && s.status === 'connected');

/** Send at most ~10 times a second while a fader is dragged; the final value always goes out on release. */
function useThrottle(ms = 100) {
  const last = useRef(0);
  return (fn: () => void, force = false) => {
    const now = performance.now();
    if (force || now - last.current >= ms) { last.current = now; fn(); }
  };
}

/** Per-instrument panel (opens when you point at an instrument): its real mute, solo and volume. */
export function InstrumentControls({ role, players }: { role: Role; players: PlayerInfo[] }) {
  const counter = useRef<any>(null);
  const last = useRef(-1);
  useFrame(() => {
    const n = activity.counts[role];
    if (n !== last.current && counter.current) { last.current = n; counter.current.text = `${n} notes seen`; counter.current.sync?.(); }
  });
  const color = ROLE_PASTEL[role];
  const mix = useMix();
  const conductor = useConductor();
  const throttle = useThrottle();
  const e = mix.roles[role];
  const soloed = mix.solo === role;
  return (
    <GlassPanel width={0.66} height={0.56} position={[0, 0.42, 0.62]} rotation={[-0.55, 0, 0]} accent={color} id={`inst-${role}`}>
      <Text font={FONT.bold} fontSize={0.05} color={PAPER.ink} position={[-0.29, 0.22, 0.004]} anchorX="left" letterSpacing={0.06}>{ROLE_LABEL[role].toUpperCase()}</Text>
      <Text font={FONT.regular} fontSize={0.036} color={PAPER.ink} position={[-0.29, 0.155, 0.004]} anchorX="left" maxWidth={0.58}>
        {players.length ? players.map((p) => p.name).join(', ') : 'Played by the AUTO band or the song'}
      </Text>
      <Text ref={counter} font={FONT.regular} fontSize={0.034} color={PAPER.soft} position={[-0.29, 0.105, 0.004]} anchorX="left">0 notes seen</Text>
      <SpatialButton position={[-0.15, 0.02, 0.004]} width={0.27} height={0.075} label={e.mute ? 'UNMUTE' : 'MUTE'} disabled={!conductor} active={e.mute} accent={PAPER.pink}
        onPress={() => orchestra.section(role, { mute: !e.mute })} />
      <SpatialButton position={[0.15, 0.02, 0.004]} width={0.27} height={0.075} label={soloed ? 'UNSOLO' : 'SOLO'} disabled={!conductor} active={soloed} accent={PAPER.butter}
        onPress={() => orchestra.solo(soloed ? null : role)} />
      <SpatialSlider position={[0, -0.1, 0.004]} width={0.52} label={`VOLUME ${Math.round(e.vol * 100)}%`} accent={color} disabled={!conductor}
        value={e.vol / VOL_MAX}
        onChange={(v) => throttle(() => orchestra.section(role, { vol: v * VOL_MAX }))}
        onCommit={(v) => orchestra.section(role, { vol: v * VOL_MAX })} />
      <Text font={FONT.regular} fontSize={0.028} color={PAPER.soft} position={[-0.29, -0.21, 0.004]} anchorX="left" maxWidth={0.58}>
        {conductor ? 'Changes the whole room: Stage speakers, headset and phones.' : 'Connect as Conductor to change the mix.'}
      </Text>
    </GlassPanel>
  );
}

/** The mixing desk: one strip per section (volume, mute, solo, live meter) and a master fader. */
export function MixerPanel() {
  const mix = useMix();
  const conductor = useConductor();
  const throttle = useThrottle();
  const cols = [...ROLES, 'master' as const];
  const x = (i: number) => (i - (cols.length - 1) / 2) * 0.17;
  const BTN_W = 0.125;
  const lastMaster = useRef(1);
  return (
    <GlassPanel width={1.12} height={0.9} position={[-0.62, 1.05, -0.7]} rotation={[0, 0.75, 0]} accent={PAPER.lilac} id="mixer" dock={{ position: [-1.3, 0.95, 0.35], rotation: [0, 1.85, 0], scale: 0.7 }}>
      <Text font={FONT.bold} fontSize={0.05} color={PAPER.ink} position={[-0.15, 0.39, 0.004]} anchorX="left" letterSpacing={0.1}>MIXER</Text>
      {cols.map((c, i) => {
        if (c === 'master') {
          return (
            <group key="master" position={[x(i), 0, 0]}>
              <Text font={FONT.bold} fontSize={0.032} color={PAPER.ink} position={[0, 0.3, 0.004]} anchorX="center" letterSpacing={0.04}>MASTER</Text>
              <SpatialFader position={[0, 0.07, 0.004]} height={0.34} accent={PAPER.mint} disabled={!conductor} mark={1 / MASTER_MAX}
                value={mix.master / MASTER_MAX}
                meter={() => Math.max(...ROLES.map((r) => activity.energy[r]))}
                onChange={(v) => throttle(() => orchestra.master(v * MASTER_MAX))}
                onCommit={(v) => orchestra.master(v * MASTER_MAX)} />
              <Text font={FONT.regular} fontSize={0.03} color={PAPER.soft} position={[0, -0.17, 0.004]} anchorX="center">{Math.round(mix.master * 100)}%</Text>
              <SpatialButton position={[0, -0.255, 0.004]} width={BTN_W} height={0.06} label={mix.master === 0 ? 'UNMUTE' : 'MUTE'} disabled={!conductor} active={mix.master === 0} accent={PAPER.pink}
                onPress={() => { if (mix.master === 0) orchestra.master(lastMaster.current || 1); else { lastMaster.current = mix.master; orchestra.master(0); } }} />
              <SpatialButton position={[0, -0.335, 0.004]} width={BTN_W} height={0.06} label="RESET" disabled={!conductor} accent={PAPER.sky}
                onPress={() => { orchestra.solo(null); orchestra.master(1); for (const r of ROLES) orchestra.section(r, { vol: 1, mute: false }); }} />
            </group>
          );
        }
        const e = mix.roles[c];
        const soloed = mix.solo === c;
        const dimmed = e.mute || (mix.solo !== null && !soloed);
        return (
          <group key={c} position={[x(i), 0, 0]}>
            <Text font={FONT.bold} fontSize={0.032} color={dimmed ? PAPER.soft : PAPER.ink} position={[0, 0.3, 0.004]} anchorX="center" letterSpacing={0.04}>{SHORT[c]}</Text>
            <SpatialFader position={[0, 0.07, 0.004]} height={0.34} accent={ROLE_PASTEL[c]} disabled={!conductor} mark={1 / VOL_MAX}
              value={e.vol / VOL_MAX}
              meter={() => (dimmed ? 0 : activity.energy[c])}
              onChange={(v) => throttle(() => orchestra.section(c, { vol: v * VOL_MAX }))}
              onCommit={(v) => orchestra.section(c, { vol: v * VOL_MAX })} />
            <Text font={FONT.regular} fontSize={0.03} color={PAPER.soft} position={[0, -0.17, 0.004]} anchorX="center">{Math.round(e.vol * 100)}%</Text>
            <SpatialButton position={[0, -0.255, 0.004]} width={BTN_W} height={0.06} label="MUTE" disabled={!conductor} active={e.mute} accent={PAPER.pink} onPress={() => orchestra.section(c, { mute: !e.mute })} />
            <SpatialButton position={[0, -0.335, 0.004]} width={BTN_W} height={0.06} label="SOLO" disabled={!conductor} active={soloed} accent={PAPER.butter} onPress={() => orchestra.solo(soloed ? null : c)} />
          </group>
        );
      })}
      <Text font={FONT.regular} fontSize={0.026} color={PAPER.soft} position={[-0.5, -0.425, 0.004]} anchorX="left" maxWidth={1.0}>
        {conductor ? 'Faders change what the whole room hears. The tick marks normal level.' : 'Connect as Conductor to use the mixer.'}
      </Text>
    </GlassPanel>
  );
}

/** Tempo, key, drop, pause, sound and the baton. */
export function TransportPanel() {
  const { mode, status, transport, roster, rttMs, baton, audio, audioMuted: muted, focusMode } = useStore();
  const conductor = useConductor();
  const paused = transport?.paused != null;
  const bpm = transport?.bpm ?? 0;
  const locked = !!(transport?.game || transport?.nowPlaying?.mode === 'jam');
  const live = mode === 'live' && status === 'connected';
  const headline = mode === 'simulation' ? 'SIMULATION' : live ? 'LIVE' : status === 'reconnecting' ? 'RECONNECTING' : 'OFFLINE';
  const tone = mode === 'simulation' ? PAPER.butter : live ? PAPER.mint : PAPER.pink;
  const bpmDrag = useRef(bpm);
  const tapper = useRef(new TempoTracker());
  const [volume, setVolume] = useState(() => audioLink.volume);
  const root = transport?.root ?? 0;
  const scaleIx = Math.max(0, SCALES.findIndex((s) => s.id === transport?.scale));
  const flash = useRef<any>(null);
  const lastBeat = useRef(0);
  useFrame(() => {
    if (!flash.current) return;
    if (baton.beats !== lastBeat.current) { lastBeat.current = baton.beats; flash.current.fillOpacity = 1; }
    flash.current.fillOpacity = Math.max(0.25, (flash.current.fillOpacity ?? 0.25) - 0.06);
  });
  const soundNote = audio === 'live' ? (muted ? 'Stage sound is muted.' : 'Hearing the Stage mix.')
    : audio === 'waiting' ? 'Waiting for the Stage sound. Start the Stage page first.' : 'Stage sound is off until connected.';
  const batonHint = !baton.on ? 'Baton off. Turn it on to conduct with your hands.'
    : `Right hand: beat down to set tempo${baton.bpm ? ` (${Math.round(baton.bpm)})` : ''}. Left grip or pinch, lift or lower: volume.`;

  return (
    <GlassPanel width={0.92} height={1.24} position={[0.62, 1.05, -0.7]} rotation={[0, -0.75, 0]} accent={tone} id="transport" dock={{ position: [1.3, 0.8, 0.35], rotation: [0, -1.85, 0], scale: 0.7 }}>
      <Text font={FONT.bold} fontSize={0.05} color={PAPER.ink} position={[-0.15, 0.56, 0.004]} anchorX="left" letterSpacing={0.1}>{headline}</Text>
      <Text font={FONT.regular} fontSize={0.032} color={PAPER.ink} position={[-0.42, 0.485, 0.004]} anchorX="left" maxWidth={0.84}>
        {`${roster.length} player${roster.length === 1 ? '' : 's'}  ·  ${bpm ? Math.round(bpm) + ' BPM' : '— BPM'}  ·  ${paused ? 'PAUSED' : transport ? 'RUNNING' : 'IDLE'}${rttMs != null ? `  ·  ${rttMs} ms` : ''}`}
      </Text>
      <Text font={FONT.regular} fontSize={0.03} color={PAPER.soft} position={[-0.42, 0.435, 0.004]} anchorX="left" maxWidth={0.84}>
        {transport?.game?.song?.title ?? transport?.nowPlaying?.title ?? 'No song playing'}
      </Text>

      <SpatialButton position={[-0.21, 0.335, 0.004]} width={0.4} height={0.085} label={paused ? 'RESUME' : 'PAUSE'} disabled={!conductor} accent={tone} onPress={() => orchestra.command('pause', !paused)} />
      <SpatialButton position={[0.21, 0.335, 0.004]} width={0.4} height={0.085} label="BEAT DROP" disabled={!conductor || paused} accent={PAPER.peach} onPress={() => orchestra.command('drop')} />

      <SpatialSlider position={[-0.08, 0.19, 0.004]} width={0.62} label={`TEMPO ${Math.round(bpm)} BPM`} accent={tone}
        value={(bpm - 60) / 120} disabled={!conductor || !!transport?.game}
        onChange={(v) => { bpmDrag.current = Math.round(60 + v * 120); }}
        onCommit={() => orchestra.command('bpm', bpmDrag.current)} />
      <SpatialButton position={[0.34, 0.19, 0.004]} width={0.2} height={0.07} label="TAP" disabled={!conductor || !!transport?.game} accent={PAPER.sky}
        onPress={() => { const b = tapper.current.beat(performance.now() / 1000); if (b) orchestra.command('bpm', Math.round(b)); }} />

      <Text font={FONT.bold} fontSize={0.034} color={PAPER.ink} position={[-0.42, 0.06, 0.004]} anchorX="left" letterSpacing={0.06}>KEY</Text>
      <SpatialButton position={[-0.18, 0.06, 0.004]} width={0.1} height={0.07} label="<" disabled={!conductor || locked} accent={PAPER.lilac} onPress={() => orchestra.command('key', (root + 11) % 12)} />
      <Text font={FONT.bold} fontSize={0.045} color={PAPER.ink} position={[-0.06, 0.06, 0.004]} anchorX="center" anchorY="middle">{NOTE[root]}</Text>
      <SpatialButton position={[0.06, 0.06, 0.004]} width={0.1} height={0.07} label=">" disabled={!conductor || locked} accent={PAPER.lilac} onPress={() => orchestra.command('key', (root + 1) % 12)} />
      <SpatialButton position={[0.29, 0.06, 0.004]} width={0.28} height={0.07} label={SCALES[scaleIx].label} disabled={!conductor || locked} accent={PAPER.lilac}
        onPress={() => orchestra.command('scale', SCALES[(scaleIx + 1) % SCALES.length].id)} />

      <SpatialButton position={[-0.21, -0.06, 0.004]} width={0.4} height={0.08} label={transport?.autoBand ? 'AUTO BAND ON' : 'AUTO BAND OFF'} disabled={!conductor || locked} active={!!transport?.autoBand} accent={PAPER.mint}
        onPress={() => orchestra.command('auto', !transport?.autoBand)} />
      <SpatialButton position={[0.21, -0.06, 0.004]} width={0.4} height={0.08} label={baton.on ? 'BATON ON' : 'BATON OFF'} disabled={!conductor} active={baton.on} accent={PAPER.butter}
        onPress={() => useStore.getState().set({ baton: { ...baton, on: !baton.on, bpm: null } })} />
      <Text ref={flash} font={FONT.bold} fontSize={0.05} color={PAPER.ink} fillOpacity={0.25} position={[-0.42, -0.165, 0.004]} anchorX="left" anchorY="middle">●</Text>
      <Text font={FONT.regular} fontSize={0.026} color={baton.dynamics ? PAPER.ink : PAPER.soft} position={[-0.36, -0.165, 0.004]} anchorX="left" anchorY="middle" maxWidth={0.78}>
        {baton.dynamics ? 'Volume hand held: lift to raise, lower to quiet.' : batonHint}
      </Text>

      <SpatialSlider position={[-0.1, -0.31, 0.004]} width={0.56} label={`SOUND ${Math.round(volume * 100)}%`} accent={PAPER.sky}
        value={volume} onChange={(v) => { setVolume(v); audioLink.setVolume(v); }} />
      <SpatialButton position={[0.3, -0.31, 0.004]} width={0.22} height={0.07} label={muted ? 'UNMUTE' : 'MUTE'} accent={PAPER.sky}
        onPress={() => { audioLink.resume(); audioLink.setMuted(!muted); }} />
      <Text font={FONT.regular} fontSize={0.026} color={PAPER.soft} position={[-0.42, -0.41, 0.004]} anchorX="left" maxWidth={0.84}>{soundNote}</Text>
      <Text font={FONT.regular} fontSize={0.026} color={PAPER.soft} position={[-0.42, -0.465, 0.004]} anchorX="left" maxWidth={0.84}>
        {conductor ? (locked ? 'Key and band are locked while a song plays.' : 'Conductor: everything here reaches the real orchestra.') : 'Observer: connect as Conductor to control.'}
      </Text>
      <SpatialButton position={[-0.2, -0.555, 0.004]} width={0.36} height={0.065} label={`FOCUS ${focusMode.toUpperCase()}`} active={focusMode !== 'off'} accent={PAPER.peach}
        onPress={() => useStore.getState().set({ focusMode: focusMode === 'auto' ? 'on' : focusMode === 'on' ? 'off' : 'auto' })} />
      <SpatialButton position={[0.2, -0.555, 0.004]} width={0.36} height={0.065} label="RECENTER" accent={PAPER.sky}
        onPress={() => { const st = useStore.getState(); st.set({ placeNonce: st.placeNonce + 1, panelResetNonce: st.panelResetNonce + 1 }); }} />
    </GlassPanel>
  );
}

/** Pick a song: the whole arrangement plays and every section can then be mixed. */
export function SongsPanel() {
  const conductor = useConductor();
  const np = useStore((s) => s.transport?.nowPlaying);
  const playing = np && 'mode' in np && np.mode === 'jam' ? np.title : null;
  const rowH = 0.085;
  return (
    <GlassPanel width={0.86} height={0.9} position={[1.15, 1.05, 0.05]} rotation={[0, -1.6, 0]} accent={PAPER.peach} id="songs" dock={{ position: [1.4, 1.5, 0.15], rotation: [0, -1.75, 0], scale: 0.6 }}>
      <Text font={FONT.bold} fontSize={0.05} color={PAPER.ink} position={[-0.15, 0.39, 0.004]} anchorX="left" letterSpacing={0.1}>SONGS</Text>
      <Text font={FONT.regular} fontSize={0.03} color={PAPER.soft} position={[-0.39, 0.31, 0.004]} anchorX="left" maxWidth={0.78}>
        {playing ? `Playing: ${playing}` : 'Choose a song. The whole band plays; mix it on the mixer.'}
      </Text>
      {SONGS.map((s, i) => (
        <SpatialButton key={s.id} position={[0, 0.21 - i * rowH, 0.004]} width={0.78} height={0.07}
          label={`${s.title}${s.artist ? '  ·  ' + s.artist : ''}`.slice(0, 40)} disabled={!conductor} active={playing === s.title} accent={PAPER.peach}
          onPress={() => orchestra.playSong(s)} />
      ))}
      <SpatialButton position={[0, 0.21 - SONGS.length * rowH - 0.03, 0.004]} width={0.78} height={0.075} label="STOP SONG" disabled={!conductor || !playing} accent={PAPER.pink}
        onPress={() => orchestra.stopSong()} />
      <Text font={FONT.regular} fontSize={0.026} color={PAPER.soft} position={[-0.39, -0.41, 0.004]} anchorX="left" maxWidth={0.78}>
        {conductor ? 'The Stage page must be open with sound started.' : 'Connect as Conductor to pick songs.'}
      </Text>
    </GlassPanel>
  );
}
