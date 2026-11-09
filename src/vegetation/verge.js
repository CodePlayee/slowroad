// src/vegetation/verge.js — the roadside planting layer: clustered bushes,
// ferns, flowering shrubs and dry tussocks stacked in the 5-15 m band beside
// the road, distinct from the grass sward. Records are ordinary 'shrub'
// population records (variant = form), so they share the forest field's LOD,
// seasonal shading, culling and terrain root contact.
//
// Everything is keyed to the road: an along-road section field switches each
// side between planted reaches and open verge, a palette field picks the
// planting style for a few hundred metres (fern bank, flowering scrub, dry
// tussock verge), and clumps elongated along the road leave gaps between
// groups. Front rows stay low, back rows rise, so the planting reads stacked.
import { vnoise } from '../core/noise.js';
import { clamp, hash2i, lerp, makeRng, smoothstep } from '../core/rng.js';
import { forestCover, roadsideTreeCover } from './biome.js';
import { wallBlocks } from '../road/roadside.js';

export const VERGE = Object.freeze({
  columns: 52,                 // candidates per tile edge (~1.23 m spacing on 64 m tiles)
  // Metres from the centreline: past the shrub layer's road clearance (the
  // grass sward starts at 4.55, fences stand at 5.08) and out to the outer verge.
  inner: 5.6, outer: 14.5,
  frontRow: 8.6,               // low front row inside this distance
  // Sparse reaches keep `sectionFloor` of the planting; full reaches are dense.
  sectionScale: 150, section: [0.30, 0.48], sectionFloor: 0.65,
  // Sharp clump edges: groups are closed thickets with open grass between them.
  clumpScale: 18, clumpDepth: 6, clump: [0.36, 0.50], core: [0.60, 0.74],
  paletteScale: 300,
  density: 0.95,
});
// Record variants (forestField foliageTemplateKey); the verge bush is the woody
// template under its own key so the snowpack can bury it.
export const VERGE_FORM = Object.freeze({ bush: 4, fern: 1, flowering: 2, tussock: 3 });
const FORMS = [VERGE_FORM.bush, VERGE_FORM.fern, VERGE_FORM.flowering, VERGE_FORM.tussock];

const SALT = 0x6b1d3f;
const TAU = Math.PI * 2;

// [front row, back row] form weights per palette: bush, fern, flowering, tussock.
const PALETTES = {
  fern: [[0.55, 0.25, 0, 0.20], [0.75, 0.10, 0, 0.15]],
  flower: [[0.40, 0, 0.35, 0.25], [0.50, 0, 0.50, 0]],
  dry: [[0.15, 0, 0, 0.85], [0.30, 0, 0.15, 0.55]],
};

function pick(weights, u) {
  let total = 0;
  for (const w of weights) total += w;
  let t = u * total;
  for (let k = 0; k < weights.length; k++) { t -= weights[k]; if (t < 0) return k; }
  return weights.length - 1;
}

function dimensions(form, size, spread, depth) {
  if (form === VERGE_FORM.fern) {
    const h = lerp(1.5, 2.1, size);            // template heightScale 0.68: 1.0-1.4 m fronds above the sward
    return [h, h * lerp(0.95, 1.30, spread)];
  }
  if (form === VERGE_FORM.tussock) {
    const h = lerp(0.9, 1.35, size) * lerp(1, 1.15, depth);
    return [h, h * lerp(1.0, 1.4, spread)];
  }
  const h = (form === VERGE_FORM.flowering ? lerp(1.0, 1.5, size) : lerp(0.85, 1.35, size)) * lerp(1, 1.45, depth);
  return [h, h * lerp(1.3, 1.8, spread)];
}

/** Appends verge planting records for population tile (i, j) to `records`. */
export function* generateVerge(world, i, j, tile, records) {
  const route = world.route;
  if (!route?.nearest) return;
  const seed = world.seed >>> 0, biomeSeed = seed ^ 0x2b7c1f03;
  const reach = VERGE.outer + tile * Math.SQRT1_2;
  if ((route.nearest((i + 0.5) * tile, (j + 0.5) * tile, reach)?.dist ?? Infinity) > reach) return;
  const n = VERGE.columns, step = tile / n, sample = {}, gradient = { dx: 0, dz: 0 };
  for (let index = 0; index < n * n; index++) {
    if (index > 0 && (index & 63) === 0) yield;
    const cellX = i * n + index % n, cellZ = j * n + Math.floor(index / n);
    const rng = makeRng(hash2i(cellX, cellZ, seed ^ SALT));
    const x = (cellX + rng()) * step, z = (cellZ + rng()) * step;
    const accept = rng();
    const near = route.nearest(x, z, VERGE.outer);
    if (!near || near.dist < VERGE.inner || near.dist > VERGE.outer || near.bridge > 0.02) continue;
    const dist = near.dist, sgn = -near.side, s = near.s;
    const reach = smoothstep(VERGE.section[0], VERGE.section[1],
      vnoise(s / VERGE.sectionScale, sgn * 17.3 + 3.1, (seed ^ (sgn > 0 ? 0x51c7e9 : 0x1e93a5)) >>> 0));
    const section = lerp(VERGE.sectionFloor, 1, reach);
    const clumpField = vnoise(s / VERGE.clumpScale, dist / VERGE.clumpDepth + sgn * 29.7, seed ^ 0x2ad3b5);
    const clump = smoothstep(VERGE.clump[0], VERGE.clump[1], clumpField);
    // Thicket cores carry woody plants even in sparse reaches, so bushes stand
    // together in groups rather than alone.
    const woody = Math.max(reach, smoothstep(VERGE.core[0], VERGE.core[1], clumpField));
    const lateral = smoothstep(VERGE.inner, VERGE.inner + 1.2, dist) * (1 - smoothstep(VERGE.outer - 3.5, VERGE.outer, dist));
    if (accept >= section * clump * lateral * VERGE.density) continue;
    world.sample(x, z, sample);
    if (!Number.isFinite(sample.y) || !Number.isFinite(sample.moisture) || sample.inWater
      || (sample.riverDist < sample.channelHalf * 2.4 && sample.y < sample.waterY + 0.7)) continue;
    const slope = world.slopeAt(x, z, sample.y, 2.5, gradient);
    if (!(slope < 0.75)) continue;
    const moisture = clamp(sample.moisture, 0, 1);
    const cover = roadsideTreeCover(world, x, z, dist, forestCover(x, z, biomeSeed), biomeSeed, true);
    // Shaded, moist reaches lean to fern banks; dry open ones to tussock verges.
    const q = clamp(vnoise(s / VERGE.paletteScale + 40.3, sgn * 5.7 + 9.2, seed ^ 0x7e2c41)
      - 0.16 * (cover - 0.5) - 0.20 * (moisture - 0.5), 0, 1);
    const palette = q < 0.36 ? PALETTES.fern : q < 0.68 ? PALETTES.flower : PALETTES.dry;
    let form = FORMS[pick(palette[dist < VERGE.frontRow ? 0 : 1], rng())];
    // Outside full reaches and thicket cores a would-be bush becomes a low
    // tussock, so no lone bush stands out on open grass.
    if ((form === VERGE_FORM.bush || form === VERGE_FORM.flowering) && rng() > woody) form = VERGE_FORM.tussock;
    // rank >= 0.4 keeps verge bushes out of the woody midstory promotion.
    const yaw = rng() * TAU, size = rng(), spread = rng(), rank = 0.4 + 0.6 * rng(), phase = rng() * TAU;
    const [height, width] = dimensions(form, size, spread, smoothstep(VERGE.inner, VERGE.outer, dist));
    if (wallBlocks(world, s, sgn, dist, width * 0.5)) continue;
    records.push({ id: `shrub:${seed}:${i}:${j}:v${index}`, kind: 'shrub', x, y: sample.y, z,
      yaw, height, width, rank, phase, moisture, cover, variant: form,
      groundDx: gradient.dx, groundDz: gradient.dz });
  }
}
