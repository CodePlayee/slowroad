import { fbm, vnoise } from '../core/noise.js';
import { clamp, lerp, smoothstep } from '../core/rng.js';
import { VEG as V } from './params.js';

export function grassClump(x, z, seed) {
  // Rotated 6-12 m patches share growth and density, not a new random tint per tuft.
  const u = (x * 0.8 + z * 0.6) / 12, v = (z * 0.8 - x * 0.6) / 12;
  const broad = vnoise(u + 17.3, v - 6.1, seed ^ 0x29f5a1);
  const detail = vnoise(u * 2 - 3.7, v * 2 + 11.4, seed ^ 0x681bd3);
  return smoothstep(0.12, 0.88, broad * 0.72 + detail * 0.28);
}

export function forestCover(x, z, seed) {
  const forest = smoothstep(V.forestThreshold - V.forestSharpness, V.forestThreshold + V.forestSharpness,
    0.5 + 0.5 * fbm(x * V.forestFreq, z * V.forestFreq, seed ^ 0x991a, 4));
  const grove = smoothstep(V.groveLo, V.groveHi,
    0.5 + 0.5 * fbm(x * V.groveFreq, z * V.groveFreq, seed ^ 0x4c17, 3));
  return clamp(forest * lerp(1 - V.groveDepth, 1, grove) +
    (1 - forest) * Math.max(0, grove - V.standaloneGrove) / (1 - V.standaloneGrove) * 0.55, 0, 1);
}

export function roadsideTreeCover(world, x, z, roadDist, cover, seed, probeRoad = true) {
  const distance = Number.isFinite(roadDist) ? roadDist
    : probeRoad ? world.route?.nearest(x, z, 150)?.dist ?? Infinity : Infinity;
  if (distance >= 150) return cover;
  const gaps = smoothstep(0.08, 0.23, vnoise(x / 260, z / 260, seed ^ 0x61da87));
  const stand = (0.68 + 0.18 * vnoise(x / 82, z / 82, seed ^ 0x982cb1)) * gaps;
  return Math.max(cover, stand * (1 - smoothstep(90, 150, distance)));
}
