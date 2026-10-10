import type { PlayerInfo } from '../../shared/protocol';

export const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '–');

export function stableId(): string {
  try {
    let id = sessionStorage.getItem('ho.id');
    if (!id) { id = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('ho.id', id); }
    return id;
  } catch { return Math.random().toString(36).slice(2, 10); }
}

/** One headline number: p90 of held-out residuals + flash quantisation, with the worst-case path bound. */
export function syncHeadline(s: PlayerInfo['sync']) {
  if (!s) return { err: NaN, bound: NaN };
  return { err: s.err + s.flashLate, bound: s.rttMin / 2 };
}
