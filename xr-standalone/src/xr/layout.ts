import type { Role } from '../networking/protocol';

/** Semicircle around the listener, facing the middle: left to right. 0 deg = straight ahead. */
export const SEAT_ANGLE: Record<Role, number> = { guitar: -72, drums: -36, pads: 0, bass: 36, melody: 72 };
export const RADIUS = 1.7;

export const seat = (role: Role) => {
  const a = (SEAT_ANGLE[role] * Math.PI) / 180;
  return { x: Math.sin(a) * RADIUS, z: -Math.cos(a) * RADIUS, rotY: -a };
};

/** Instrument-local point -> orchestra-local point (rotate about Y by the seat's facing, then translate). */
export function toStage(role: Role, lx: number, ly: number, lz: number, out: [number, number, number] = [0, 0, 0]) {
  const s = seat(role);
  const c = Math.cos(s.rotY), si = Math.sin(s.rotY);
  out[0] = s.x + lx * c + lz * si;
  out[1] = ly;
  out[2] = s.z - lx * si + lz * c;
  return out;
}

/** Local drum-kit positions per voice (kick, snare, hat, clap, open). Shared by visuals and particle origins. */
export const DRUM_POS: [number, number, number][] = [
  [0, 0.42, 0], [-0.34, 0.68, 0.08], [0.38, 0.98, 0], [0.34, 0.56, 0.14], [-0.4, 1.0, -0.05],
];

export const PIANO_LO = 36;
export const PIANO_HI = 83;
const WHITE_IDX = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const BLACK_PCS = [1, 3, 6, 8, 10];
export const WHITE_W = 0.032;
export const PIANO_W = 28 * WHITE_W;

export interface KeyInfo { black: boolean; instance: number; x: number }
/** MIDI -> key slot, folding anything outside the 4-octave keyboard by whole octaves. */
export const KEYS: KeyInfo[] = (() => {
  const t: KeyInfo[] = [];
  for (let m = 0; m < 128; m++) {
    let k = m;
    while (k < PIANO_LO) k += 12;
    while (k > PIANO_HI) k -= 12;
    const oct = Math.floor((k - PIANO_LO) / 12), pc = k % 12;
    const black = BLACK_PCS.includes(pc);
    const wi = oct * 7 + WHITE_IDX[pc];
    t.push({
      black,
      instance: black ? oct * 5 + BLACK_PCS.indexOf(pc) : wi,
      x: (black ? wi + 1 : wi + 0.5) * WHITE_W - PIANO_W / 2,
    });
  }
  return t;
})();
