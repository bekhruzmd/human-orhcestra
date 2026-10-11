import { AdditiveBlending, DoubleSide, MeshBasicMaterial } from 'three';
import type { Role } from '../networking/protocol';

export const FONT = { regular: '/xr/fonts/inter-500.woff', bold: '/xr/fonts/inter-700.woff' };

export const ROLE_COLOR: Record<Role, string> = {
  drums: '#ff4d8d', bass: '#3d8bff', melody: '#2dffb0', pads: '#52e0ff', guitar: '#b567ff',
};
export const INK = '#e8faff';
export const DIM = '#6b8794';

/** Shared, never-per-frame-allocated materials. All unlit: cheap on Quest, and additive reads as light. */
export const glassMat = new MeshBasicMaterial({
  color: '#7fdcff', transparent: true, opacity: 0.07, depthWrite: false, side: DoubleSide, toneMapped: false,
});
export const glowMat = (color: string, opacity = 0.9) =>
  new MeshBasicMaterial({ color, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false, toneMapped: false });

/** Stage-UI paper palette for the spatial panels: opaque pastel cards, ink outlines, hard offset shadow. */
export const PAPER = { ink: '#2b2540', soft: '#5c5577', paper: '#fbf9ff', paper2: '#f3effc', lilac: '#d9ccff', pink: '#ffc8dd', peach: '#ffdcc2', mint: '#bdf2d5', sky: '#c9e4ff', butter: '#fff1b8' };
export const ROLE_PASTEL: Record<Role, string> = { drums: '#ffc8dd', bass: '#c9e4ff', melody: '#bdf2d5', pads: '#d9ccff', guitar: '#ffdcc2' };
const solid = (color: string) => new MeshBasicMaterial({ color, toneMapped: false });
export const paperMat = solid(PAPER.paper);
export const inkMat = solid(PAPER.ink);
export const shadowMat = solid(PAPER.lilac);
export const solidMat = solid;
