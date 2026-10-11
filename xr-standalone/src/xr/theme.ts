import { AdditiveBlending, DoubleSide, MeshBasicMaterial } from 'three';
import type { Role } from '../networking/protocol';

export const FONT = { regular: '/fonts/inter-500.woff', bold: '/fonts/inter-700.woff' };

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
