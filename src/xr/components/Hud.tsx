import { useEffect, useState } from 'react';
import { audioLink, orchestra } from '../networking/orchestraAdapter';
import { ROLE_LABEL, ROLES, defaultMix, type Role } from '../networking/protocol';
import { activity } from '../state/activity';
import { useStore } from '../state/store';
import { ROLE_COLOR } from '../scene/theme';
import { xrStore } from '../scene/xrStore';

const EMPTY_MIX = defaultMix();
const SHORT: Record<Role, string> = { drums: 'Drums', bass: 'Bass', melody: 'Lead', pads: 'Piano', guitar: 'Guitar' };

/** DOM overlay for the desktop preview. In the headset only the 3D panels exist (Quest has no DOM overlay). */
export function Hud({ onOpenConnection }: { onOpenConnection: () => void }) {
  const { mode, status, roster, transport, log, selected, rttMs, privilege, inXR, xrSupported } = useStore();
  const { audio, audioMuted } = useStore();
  const mix = useStore((st) => st.transport?.mix) ?? EMPTY_MIX;
  const [vol, setVol] = useState(() => audioLink.volume);
  const [counts, setCounts] = useState<number[]>(() => ROLES.map(() => 0));
  useEffect(() => {
    const id = setInterval(() => setCounts(ROLES.map((r) => activity.counts[r])), 400);
    return () => clearInterval(id);
  }, []);
  if (inXR) return null;

  const live = mode === 'live' && status === 'connected';
  const label = mode === 'simulation' ? 'SIMULATION: synthetic events' : live ? 'LIVE' : status === 'reconnecting' ? 'RECONNECTING' : 'OFFLINE';
  const cls = mode === 'simulation' ? 'sim' : live ? 'live' : 'off';
  const np = transport?.game?.song?.title ?? transport?.nowPlaying?.title;
  const conductor = privilege === 'conductor' && live;
  const paused = transport?.paused != null;

  return (
    <div className="hud">
      <div className="panel top">
        <div className={`pill ${cls}`}>{label}</div>
        <span className="muted">{transport ? `${Math.round(transport.bpm)} BPM · ${paused ? 'paused' : 'running'}` : 'no transport'}{rttMs != null ? ` · ${rttMs} ms` : ''}</span>
        <span className="muted">{np ? `Song: ${np}` : transport ? 'No song loaded' : ''}</span>
        <span className="spacer" />
        <button className="ghost" onClick={onOpenConnection}>Connection</button>
        {live || mode === 'simulation' ? <button className="ghost" onClick={() => { orchestra.disconnect(); onOpenConnection(); }}>Disconnect</button> : null}
        <button className="mr" disabled={xrSupported !== 'yes'} onClick={() => void xrStore.enterAR()}>Enter Mixed Reality</button>
      </div>

      <div className="panel side">
        <h3>Players ({roster.length})</h3>
        {roster.length === 0 && <p className="muted">No phones joined yet.</p>}
        {roster.map((p) => (
          <div className="player" key={p.id}>
            <span className="sw" style={{ background: ROLE_COLOR[p.role] }} />
            <b>{p.name}</b><span className="muted">{ROLE_LABEL[p.role]}{p.connected ? '' : ' · away'}</span>
          </div>
        ))}
        <h3>Activity</h3>
        {ROLES.map((r, i) => (
          <div className="player" key={r}><span className="sw" style={{ background: ROLE_COLOR[r] }} /><b>{ROLE_LABEL[r]}</b><span className="muted">{counts[i]} notes</span></div>
        ))}
      </div>

      <div className="panel side right">
        <h3>Conductor controls</h3>
        <div className="ctl"><button disabled={!conductor} onClick={() => orchestra.command('pause', !paused)}>{paused ? 'Resume' : 'Pause'}</button>
          <button disabled={!conductor || paused} onClick={() => orchestra.command('drop')}>Beat drop</button></div>
        <h3>Mixer</h3>
        {ROLES.map((r) => {
          const e = mix.roles[r];
          return (
            <div className="mixrow" key={r}>
              <b>{SHORT[r]}</b>
              <input type="range" min={0} max={150} value={Math.round(e.vol * 100)} disabled={!conductor} aria-label={`${ROLE_LABEL[r]} volume`}
                onChange={(ev) => orchestra.section(r, { vol: Number(ev.target.value) / 100 })} />
              <button className={e.mute ? 'on' : ''} disabled={!conductor} onClick={() => orchestra.section(r, { mute: !e.mute })}>M</button>
              <button className={mix.solo === r ? 'on' : ''} disabled={!conductor} onClick={() => orchestra.solo(mix.solo === r ? null : r)}>S</button>
            </div>
          );
        })}
        <label className="vol">Master<input type="range" min={0} max={120} value={Math.round(mix.master * 100)} disabled={!conductor} onChange={(ev) => orchestra.master(Number(ev.target.value) / 100)} /></label>
        <h3>Stage sound</h3>
        <div className="ctl"><button disabled={!live} onClick={() => { audioLink.resume(); audioLink.setMuted(!audioMuted); }}>{audioMuted ? 'Unmute' : 'Mute'}</button></div>
        <label className="vol">Volume<input type="range" min={0} max={1} step={0.01} value={vol} onChange={(e) => { const v = Number(e.target.value); setVol(v); audioLink.setVolume(v); }} /></label>
        <p className="muted small">{audio === 'live' ? 'Hearing the Stage mix.' : audio === 'waiting' ? 'Waiting for the Stage to share sound. Open the Stage page and press start.' : 'Sound starts after you connect.'}</p>
        <p className="muted small">{conductor ? 'Conductor mode: mixer, tempo, songs and drop reach the real orchestra.' : 'Observer mode: read-only.'}</p>
      </div>

      <div className="panel log">{log.length === 0 ? <span className="muted">Waiting for events…</span> : log.slice(-5).map((l) => <div key={l.id}>{l.text}</div>)}</div>
    </div>
  );
}
