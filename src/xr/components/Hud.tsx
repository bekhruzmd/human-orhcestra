import { useEffect, useState } from 'react';
import { orchestra } from '../networking/orchestraAdapter';
import { ROLE_LABEL, ROLES } from '../networking/protocol';
import { activity } from '../state/activity';
import { useStore } from '../state/store';
import { ROLE_COLOR } from '../scene/theme';
import { xrStore } from '../scene/xrStore';

/** DOM overlay for the desktop preview. In the headset only the 3D panels exist (Quest has no DOM overlay). */
export function Hud({ onOpenConnection }: { onOpenConnection: () => void }) {
  const { mode, status, roster, transport, log, selected, rttMs, privilege, inXR, xrSupported } = useStore();
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
        <div className="ctl"><button disabled>Mute {selected ? ROLE_LABEL[selected] : 'instrument'}</button></div>
        <label className="vol">Volume<input type="range" disabled /></label>
        <p className="muted small">{conductor ? 'Conductor mode: pause, beat drop and tempo reach the real orchestra.' : 'Observer mode: read-only.'} Per-instrument mute and volume are unavailable: the server has no such command.</p>
      </div>

      <div className="panel log">{log.length === 0 ? <span className="muted">Waiting for events…</span> : log.slice(-5).map((l) => <div key={l.id}>{l.text}</div>)}</div>
    </div>
  );
}
