import { useEffect, useState } from 'react';
import { XRScene } from '../scene/XRScene';
import { checkXRSupport } from '../scene/xrStore';
import { useStore } from '../state/store';
import { KEY_LAST_URL, save } from '../utils/storage';
import { ConnectScreen } from '../components/ConnectScreen';
import { Hud } from '../components/Hud';

export function App() {
  const [showConnect, setShowConnect] = useState(true);
  const status = useStore((s) => s.status);
  const mode = useStore((s) => s.mode);
  const url = useStore((s) => s.url);

  useEffect(() => {
    const probe = () => void checkXRSupport().then((ok) => useStore.getState().set({ xrSupported: ok ? 'yes' : 'no' }));
    probe();
    const retry = setTimeout(probe, 1200); // some browsers/emulators expose navigator.xr a moment after load
    navigator.xr?.addEventListener?.('devicechange', probe);
    return () => { clearTimeout(retry); navigator.xr?.removeEventListener?.('devicechange', probe); };
  }, []);

  // Remember an address only after the server has proven itself (valid welcome), and move on to the stage.
  useEffect(() => {
    if (status === 'connected' && mode === 'live') { save(KEY_LAST_URL, url); setShowConnect(false); }
    if (status === 'connected' && mode === 'simulation') setShowConnect(false);
  }, [status, mode, url]);

  return (
    <>
      <div className="backdrop" />
      <XRScene />
      <Hud onOpenConnection={() => setShowConnect(true)} />
      {showConnect && <ConnectScreen onClose={() => setShowConnect(false)} canClose={status === 'connected'} />}
    </>
  );
}
