import { useState } from 'react';
import { orchestra } from '../networking/orchestraAdapter';
import { startSimulation } from '../networking/simulation';
import { useStore, type Privilege } from '../state/store';
import { xrStore } from '../xr/xrStore';
import { KEY_LAST_URL, load } from '../utils/storage';

// The same-origin /ws bridge only exists on the dev/preview server. A hosted build needs a real wss:// address.
const BRIDGE = import.meta.env.DEV ? '/ws' : '';
const DEFAULT_SERVER = (import.meta.env.VITE_ORCHESTRA_URL as string | undefined) ?? BRIDGE;

export function ConnectScreen({ onClose, canClose }: { onClose: () => void; canClose: boolean }) {
  const { status, error, mode, xrSupported } = useStore();
  const [addr, setAddr] = useState(() => load(KEY_LAST_URL) ?? DEFAULT_SERVER);
  const [priv, setPriv] = useState<Privilege>('observer');
  const [room, setRoom] = useState(() => new URLSearchParams(location.search).get('room')?.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) ?? '');
  const [localErr, setLocalErr] = useState<string | null>(null);
  const busy = status === 'connecting';
  const connected = status === 'connected';

  const connect = () => {
    setLocalErr(null);
    const code = room.trim();
    if (code && code.length < 3) { setLocalErr('Room codes are 3-8 letters or digits.'); return; }
    const err = orchestra.connect(addr, priv, code);
    if (err) setLocalErr(err);
  };
  const enterMR = async () => {
    try { await xrStore.enterAR(); } catch (e) { setLocalErr(`Could not start mixed reality: ${(e as Error).message}`); }
  };

  const shown = localErr ?? (status === 'error' || status === 'reconnecting' ? error : null);
  const chip = connected ? (mode === 'simulation' ? 'SIMULATION' : 'CONNECTED') : busy ? 'CONNECTING…' : status === 'reconnecting' ? 'RECONNECTING…' : status === 'error' ? 'FAILED' : 'NOT CONNECTED';

  return (
    <div className="connect">
      <div className="card">
        <div className="eyebrow">MIXED REALITY</div>
        <h1>HUMAN ORCHESTRA</h1>
        <h2>SPATIAL CONDUCTOR</h2>

        <label htmlFor="addr">Orchestra server address</label>
        <input id="addr" value={addr} spellCheck={false} autoCapitalize="off" autoCorrect="off"
          onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && connect()}
          placeholder="wss://your-tunnel.trycloudflare.com" />
        <div className="chips">
          {BRIDGE && <button className="chip" onClick={() => setAddr(BRIDGE)} title="Same-origin bridge to the Orchestra running on the computer that serves this page">This computer (bridge)</button>}
          {load(KEY_LAST_URL) && <button className="chip" onClick={() => setAddr(load(KEY_LAST_URL)!)}>Last used</button>}
        </div>

        <label htmlFor="room">Room code <small>(from the Stage screen; empty = the shared session)</small></label>
        <input id="room" value={room} maxLength={8} spellCheck={false} autoCapitalize="characters" autoCorrect="off"
          onChange={(e) => setRoom(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} onKeyDown={(e) => e.key === 'Enter' && connect()}
          placeholder="e.g. K7QM" />

        <div className="seg" role="radiogroup" aria-label="Access level">
          <button role="radio" aria-checked={priv === 'observer'} className={priv === 'observer' ? 'on' : ''} onClick={() => setPriv('observer')}>Observer<small>read-only, no seat</small></button>
          <button role="radio" aria-checked={priv === 'conductor'} className={priv === 'conductor' ? 'on warn' : 'warn'} onClick={() => setPriv('conductor')}>Conductor<small>can send commands</small></button>
        </div>
        {priv === 'conductor' && (
          <p className="note warn">Conductor declares this device a Stage so pause, beat drop and tempo reach the real orchestra. The server has no login, so use it only on your own session.</p>
        )}

        <div className="status"><span className={`dot ${connected ? 'ok' : status === 'error' ? 'bad' : busy || status === 'reconnecting' ? 'wait' : ''}`} />{chip}</div>
        {shown && <p className="error" role="alert">{shown}</p>}

        <div className="row">
          <button className="primary" onClick={connect} disabled={busy}>{connected && mode === 'live' ? 'Reconnect' : 'Connect'}</button>
          <button className="mr" onClick={enterMR} disabled={xrSupported !== 'yes'}>Enter Mixed Reality</button>
        </div>
        {xrSupported === 'no' && <p className="note">Mixed reality needs Meta Quest Browser over HTTPS. This browser can still show the desktop preview.</p>}

        <div className="row sub">
          <button className="ghost" onClick={() => { orchestra.disconnect(); startSimulation(); }}>Preview with simulation</button>
          {canClose && <button className="ghost" onClick={onClose}>Close</button>}
        </div>
        <p className="note">Connects only to the address above, and only when you press Connect.</p>
      </div>
    </div>
  );
}
