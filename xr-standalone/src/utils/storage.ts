/** localStorage can throw (private windows, blocked storage, headset browsers); never let it break the app. */
export const load = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
export const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
export const KEY_LAST_URL = 'hoxr.lastServer';
