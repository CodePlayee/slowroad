import { vnoise } from '../core/noise.js';
import { clamp, hash2i, lerp, makeRng, smoothstep } from '../core/rng.js';
import { VEG as V } from './params.js';
import { GRASS_COVERAGE } from './grassCoverage.js';
import { grassClump, forestCover, roadsideTreeCover } from './biome.js';
import { createRoadsideSurfaceSampler } from '../terrain/surfaceSampler.js';

// Open-pasture sward beyond the roadside grass band. The roadside population
// samples nine candidates per square metre but stops at GRASS_COVERAGE.roadEnd;
// hillsides past it carry this sparse, camera-range layer of low-triangle tufts
// instead. Ecology comes from a coarse world grid per tile (bilinear), so one
// 64 m tile costs a few hundred terrain samples, not one per candidate. Roots
// still sit on the actual L0 terrain triangles via the roadside surface sampler.
export const PASTURE = Object.freeze({
  kind: 'pasture', tile: 64, radius: 4, columns: 64, rows: 128, grid: 4,
  // Fades in while the roadside band is still full (end - fadeWidth to
  // end - fadeWidth * handoff), so the two layers never leave a gap.
  handoff: 0.3,
  // Open ground only: canopy, steep grades and genuinely rocky faces keep the
  // bare forest floor/rock shading of the terrain shader (its woodland floor
  // darkens from canopy ~0.24). Rockiness sits near 0.4-0.6 on ordinary
  // grassy hills, so only its upper tail excludes tufts.
  cover: [0.14, 0.34], slope: [0.34, 0.56], rock: [0.66, 0.84], shoreClear: 0.04,
  renderCell: 32,
});

const SALT = 0x2f8c53;
const TAU = Math.PI * 2;

/** Pasture weight that complements the roadside band's clump-driven outer fade. */
export function pastureCoverage(distance, clump = 0.5) {
  if (Number.isNaN(distance)) return 0;
  if (distance == null) return 1;
  const c = GRASS_COVERAGE, edge = smoothstep(c.roadEdgeClump[0], c.roadEdgeClump[1], Number.isFinite(clump) ? clump : 0.5);
  const end = c.roadEndNear + (c.roadEnd - c.roadEndNear) * edge;
  return smoothstep(end - c.roadFadeWidth, end - c.roadFadeWidth * PASTURE.handoff, distance);
}

/** Deterministic tile population; candidates never depend on camera or LOD. */
export function* generatePasture(world, i, j) {
  if (!Number.isSafeInteger(i) || !Number.isSafeInteger(j)) throw new RangeError('Population tile coordinates must be integers');
  const { tile: T, columns, rows, grid: G } = PASTURE;
  const seed = world.seed >>> 0, biomeSeed = seed ^ 0x2b7c1f03;
  const x0 = i * T, z0 = j * T, N = Math.round(T / G) + 1;
  const probeDistance = 150 + T * Math.SQRT1_2;
  const probeRoad = Boolean(world.route?.nearest)
    && (world.route.nearest(x0 + T / 2, z0 + T / 2, probeDistance)?.dist ?? Infinity) <= probeDistance;
  // Coarse ecology grid: moisture, rockiness, road distance, canopy, wetness.
  const moisture = new Float32Array(N * N), rockiness = new Float32Array(N * N), road = new Float32Array(N * N);
  const cover = new Float32Array(N * N), wet = new Float32Array(N * N);
  const sample = {};
  let open = false;
  for (let gz = 0; gz < N; gz++) {
    for (let gx = 0; gx < N; gx++) {
      const x = x0 + gx * G, z = z0 + gz * G, k = gz * N + gx;
      world.sample(x, z, sample);
      const valid = Number.isFinite(sample.y) && Number.isFinite(sample.moisture);
      moisture[k] = valid ? clamp(sample.moisture, 0, 1) : 0;
      rockiness[k] = valid && Number.isFinite(sample.rockiness) ? sample.rockiness : 1;
      road[k] = Math.min(Number.isNaN(sample.roadDist) ? 0 : sample.roadDist, 255);
      cover[k] = valid ? roadsideTreeCover(world, x, z, sample.roadDist, forestCover(x, z, biomeSeed), biomeSeed, probeRoad) : 1;
      const shore = sample.riverDist < sample.channelHalf * 3.2
        ? smoothstep(sample.waterY + 2.2, sample.waterY - 0.4, sample.y)
          * smoothstep(sample.channelHalf * 3.2, sample.channelHalf * 0.8, sample.riverDist) : 0;
      wet[k] = !valid || sample.inWater ? 1 : shore;
      open ||= cover[k] < PASTURE.cover[1] && wet[k] < PASTURE.shoreClear;
    }
    if ((gz & 3) === 3) yield;
  }
  const records = [];
  if (!open) return records;
  const surfaceSampler = createRoadsideSurfaceSampler(world), surface = {};
  const dx = T / columns, dz = T / rows;
  for (let index = 0; index < columns * rows; index++) {
    if (index > 0 && (index & 63) === 0) yield;
    const cellX = i * columns + index % columns, cellZ = j * rows + Math.floor(index / columns);
    const rng = makeRng(hash2i(cellX, cellZ, seed ^ SALT));
    const x = (cellX + 0.02 + rng() * 0.96) * dx, z = (cellZ + 0.02 + rng() * 0.96) * dz;
    const accept = rng();
    const u = (x - x0) / G, v = (z - z0) / G;
    const gx = Math.min(N - 2, Math.floor(u)), gz = Math.min(N - 2, Math.floor(v)), fx = u - gx, fz = v - gz;
    const k = gz * N + gx;
    if (Math.max(wet[k], wet[k + 1], wet[k + N], wet[k + N + 1]) >= PASTURE.shoreClear) continue;
    const lerp2 = field => lerp(lerp(field[k], field[k + 1], fx), lerp(field[k + N], field[k + N + 1], fx), fz);
    const canopy = lerp2(cover);
    const openness = 1 - smoothstep(PASTURE.cover[0], PASTURE.cover[1], canopy);
    if (accept >= openness) continue;
    const roadDist = lerp2(road), clump = grassClump(x, z, seed);
    const coverage = pastureCoverage(roadDist, clump);
    if (coverage <= 0) continue;
    const moist = lerp2(moisture);
    const base = openness * (0.50 + 0.60 * moist) * lerp(0.62, 1.15, clump);
    if (accept >= clamp(base, 0, 1)) continue;
    surfaceSampler.sample(x, z, surface);
    if (!Number.isFinite(surface.y) || !Number.isFinite(surface.dx) || !Number.isFinite(surface.dz)) continue;
    const slope = 1 - 1 / Math.sqrt(1 + surface.dx * surface.dx + surface.dz * surface.dz);
    const ground = (1 - smoothstep(PASTURE.slope[0], PASTURE.slope[1], slope))
      * (1 - smoothstep(PASTURE.rock[0], PASTURE.rock[1], lerp2(rockiness) + slope * 0.18))
      * smoothstep(V.treeLine + 220, V.treeLine - 60, surface.y);
    if (accept >= clamp(base * ground, 0, 1)) continue;
    const yaw = rng() * TAU, size = rng(), spread = rng(), rank = rng(), phase = rng() * TAU;
    // Same ~5 m tall seeding patches as the roadside sward, without its verge boost.
    const tall = smoothstep(0.40, 0.80, vnoise(x / 5.5 + 3.1, z / 5.5 - 7.4, seed ^ 0x3d71c5));
    records.push({ id: `pasture:${seed}:${i}:${j}:${index}`, kind: 'pasture', x, y: surface.y, z,
      yaw, rank, phase, moisture: moist, cover: canopy, clump, roadDist,
      height: lerp(0.36, 0.72, clump) * lerp(0.72, 1.18, size) * (1 + tall * 0.24),
      width: lerp(1.10, 1.75, clump) * lerp(0.85, 1.20, spread) * (1 + tall * 0.12),
      groundDx: surface.dx, groundDz: surface.dz, surfaceY: surface.y, surfaceDx: surface.dx, surfaceDz: surface.dz });
  }
  return records;
}
