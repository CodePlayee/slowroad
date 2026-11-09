// src/road/roadside.js — which roadside structure stands beside the road where.
// Shared by the ribbon builder (roadmesh.js draws it) and shrub/verge planting
// (vegetation/population.js and verge.js keep plants out), so all read one plan.
//
// The plan is a pure function of the route, the terrain and the seed, decided
// per 32 m cell of arc length and per side, so streamed segments and worker
// tiles agree everywhere. Sides use the ribbon's lateral sign: +1 lies along
// n = (-tz, tx), -1 opposite (route.nearest reports side = -sign(lateral)).
import { vnoise } from '../core/noise.js';

export const FURNITURE = Object.freeze({
  cell: 32,
  // Lateral offsets of each structure's centre line from the road centreline.
  lat: { fence: 5.08, rail: 4.62, wall: 6.45 },
  wallHalfWidth: 0.38,
  // A side falling away this far below the road (metres, sampled 10-16 m out)
  // carries a W-beam guardrail; runs reach one cell either side of the drop.
  railDrop: 3.0,
  // Bridge approaches are guarded too; the deck itself keeps its parapets.
  railBridge: 0.02,
  bridgeSkip: 0.45,
  // Along-road section field: open verge, post-and-rail fence, dry-stone wall.
  sectionScale: 430,
  noneBelow: 0.36,
  fenceBelow: 0.62,
});

const TYPES = ['none', 'fence', 'wall', 'rail'];
const caches = new WeakMap();

function cellCache(world) {
  let cache = caches.get(world);
  if (!cache) { cache = new Map(); caches.set(world, cache); }
  return cache;
}

function cellDrop(world, k, sgn, q) {
  const route = world.route;
  let drop = 0, bridge = 0;
  for (const f of [0.1, 0.5, 0.9]) {
    const p = route.at((k + f) * FURNITURE.cell, q);
    bridge = Math.max(bridge, p.bridge);
    const nx = -p.tz * sgn, nz = p.tx * sgn;
    for (const d of [10, 16]) drop = Math.max(drop, p.y - world.ground(p.x + nx * d, p.z + nz * d));
  }
  return { drop, bridge };
}

/** Structure type ('none' | 'fence' | 'wall' | 'rail') for cell k on lateral side sgn. */
export function furnitureCell(world, k, sgn) {
  const cache = cellCache(world);
  const key = k * 2 + (sgn > 0 ? 1 : 0);
  const hit = cache.get(key);
  if (hit !== undefined) return TYPES[hit];
  const route = world.route, q = {};
  const max = Math.floor(route.length / FURNITURE.cell);
  let rail = false;
  for (let o = -1; o <= 1 && !rail; o++) {
    const c = k + o;
    if (c < 0 || c > max) continue;
    const { drop, bridge } = cellDrop(world, c, sgn, q);
    rail = drop > FURNITURE.railDrop || bridge > FURNITURE.railBridge;
  }
  let type = 3;
  if (!rail) {
    const s = (k + 0.5) * FURNITURE.cell;
    const u = vnoise(s / FURNITURE.sectionScale, sgn * 3.7 + 11.3, (world.seed ^ 0x5e11a7) >>> 0);
    type = u < FURNITURE.noneBelow ? 0 : u < FURNITURE.fenceBelow ? 1 : 2;
  }
  if (cache.size > 20000) cache.clear();
  cache.set(key, type);
  return TYPES[type];
}

export function furnitureAt(world, s, sgn) {
  return furnitureCell(world, Math.floor(s / FURNITURE.cell), sgn);
}

/** True where a dry-stone wall intersects a plant's lateral radius `margin`. */
export function wallBlocks(world, s, sgn, dist, margin = 0.45) {
  return Math.abs(dist - FURNITURE.lat.wall) < FURNITURE.wallHalfWidth + margin
    && furnitureAt(world, s, sgn) === 'wall';
}
