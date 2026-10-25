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

// Openness of one road side in [0, 1]. `s` is the nearest centreline arc length
// and `side` its sign. Each side has its own along-road field plus a shared swing
// that opens one side as it closes the other, so the woodland frames alternate
// rather than mirroring across the road.
export function roadsideOpening(s, side, x, z, distance, seed) {
  const lane = side < 0 ? 41.7 : 3.1, u = s / V.roadsideOpenScale;
  const swing = vnoise(u, 77.3, seed ^ 0x4d8b37);
  const field = lerp(vnoise(u, lane, seed ^ 0x5e11a7), side < 0 ? swing : 1 - swing, V.roadsideOpenSwing) * 0.78 +
    vnoise(s / V.roadsideOpenDetail, lane + 17.9, seed ^ 0x2c6f93) * 0.22 +
    (vnoise(x / V.roadsideOpenEdgeScale, z / V.roadsideOpenEdgeScale, seed ^ 0x7a40d5) - 0.5) * V.roadsideOpenEdgeAmp;
  const open = smoothstep(V.roadsideOpenLo, V.roadsideOpenHi, field);
  if (open === 0) return 0;
  const [near, far] = V.roadsideOpenDepth;
  const depth = lerp(near, far, vnoise(s / 330, lane - 9.4, seed ^ 0x13b8e9)) +
    (vnoise(x / 42, z / 42, seed ^ 0x6d02f1) - 0.5) * V.roadsideOpenDepthJitter;
  return open * (1 - smoothstep(depth - 30, depth + 10, distance)) * (1 - smoothstep(125, 150, distance));
}

export function roadsideTreeCover(world, x, z, roadDist, cover, seed, probeRoad = true) {
  let road = null, distance = roadDist;
  if (!Number.isFinite(distance)) {
    road = probeRoad ? world.route?.nearest(x, z, 150) ?? null : null;
    distance = road?.dist ?? Infinity;
  }
  if (distance >= 150) return cover;
  const gaps = smoothstep(0.08, 0.23, vnoise(x / 260, z / 260, seed ^ 0x61da87));
  const stand = (0.68 + 0.18 * vnoise(x / 82, z / 82, seed ^ 0x982cb1)) * gaps;
  const floor = Math.max(cover, stand * (1 - smoothstep(90, 150, distance)));
  // Known carve distances still need the side and arc length of the road point.
  road ??= world.route?.nearest?.(x, z, distance + 2) ?? null;
  if (!Number.isFinite(road?.s) || !road.side) return floor;
  const open = roadsideOpening(road.s, road.side, x, z, distance, seed);
  if (open === 0) return floor;
  const groves = V.roadsideGroveCover * smoothstep(V.roadsideGroveLo, V.roadsideGroveHi,
    vnoise(x / V.roadsideGroveScale, z / V.roadsideGroveScale, seed ^ 0x3f9c21));
  return lerp(floor, Math.min(floor, groves), open);
}
