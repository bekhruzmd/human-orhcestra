import { createXRStore } from '@react-three/xr';

/**
 * Controllers and hand tracking are both on (library defaults); hands are an optional session feature, so
 * controller-only users are unaffected. We start sessions ourselves from a button, and keep the library's
 * on-localhost headset emulator off so the desktop preview is a clean orbit view.
 */
// `?emulate` (dev only, localhost) turns on the library's Meta Quest 3 emulator to exercise the immersive-AR path without a headset.
const emulate = import.meta.env.DEV && new URLSearchParams(location.search).has('emulate');
export const xrStore = createXRStore({ emulate: emulate ? { type: 'metaQuest3', inject: true } : false, offerSession: false });

export async function checkXRSupport(): Promise<boolean> {
  try { return !!(navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar'))); } catch { return false; }
}
