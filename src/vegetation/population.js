import { fbm, vnoise } from '../core/noise.js';
import { clamp, hash2i, lerp, makeRng, smoothstep } from '../core/rng.js';
import { VEG as V } from './params.js';
import { TREE_SPECIES } from './treeSpecies.js';
import { GRASS_COVERAGE } from './grassCoverage.js';
import { grassClump, forestCover, roadsideTreeCover } from './biome.js';
import { createRoadsideSurfaceSampler } from '../terrain/surfaceSampler.js';
import { PASTURE, generatePasture } from './pasture.js';
import { generateVerge } from './verge.js';
import { FURNITURE, wallBlocks } from '../road/roadside.js';

export const POPULATION = {
  grass: { tile: 32, radius: 7, candidates: 9216, candidatesPerLayer: 2304, columns: 48,
    density: 1, roadClear: GRASS_COVERAGE.roadStart, waterClear: 0.4 },
  shrub: { tile: 64, radius: 4, candidates: 144, candidatesPerLayer: 48, columns: 8,
    density: 1, roadClear: 5.6, waterClear: 0.7 },
  tree: { tile: 256, radius: 9, candidates: 1280, candidatesPerLayer: 160, columns: 16,
    density: 0.5, roadClear: 10, roadFade: 6, waterClear: 2,
    roadDensityStart: 32, roadDensityEnd: 320, roadDensityNear: 1.3, roadDensityFar: 0.9,
    // Tall conifers never stand at the carriageway: inside coniferClear of the
    // centreline they drop, out to coniferSwap half drop and half become birch/aspen.
    coniferClear: 13, coniferSwap: 16 },
};

const SALT = { grass: 0x4b6719, shrub: 0x693fc1, tree: 0x72a50d };
const TAU = Math.PI * 2;

export function treeRoadDistance(world, x, z, distance, probeRoad = true) {
  if (Number.isFinite(distance)) return distance;
  return probeRoad ? world.route?.nearest(x, z, POPULATION.tree.roadDensityEnd)?.dist ?? Infinity : Infinity;
}

export function treeRoadDensity(distance, config = POPULATION.tree) {
  return lerp(config.roadDensityNear, config.roadDensityFar,
    smoothstep(config.roadDensityStart, config.roadDensityEnd, distance));
}

function density(kind, sample, slope, cover, config) {
  const { y, roadDist, moisture } = sample;
  if (kind === 'tree') {
    return cover * treeRoadDensity(roadDist, config) * (slope === null ? 1 : smoothstep(V.slopeLimitTree, V.slopeLimitTree - 0.34, slope)) *
      smoothstep(V.treeLine + V.treeLineFade, V.treeLine - V.treeLineFade, y) *
      (0.30 + 0.85 * moisture) * smoothstep(config.roadClear, config.roadClear + (config.roadFade ?? V.roadFade), roadDist);
  }
  if (kind === 'shrub') {
    const edge = 1 - Math.abs(cover * 2 - 1);
    const dryOpen = (1 - moisture) * (1 - cover * 0.7);
    const verge = smoothstep(config.roadClear, config.roadClear + 3, roadDist) *
      smoothstep(V.vergeShrubRange, V.vergeShrubRange * 0.45, roadDist);
    // Ferns and low bushes line the open verge just past the shoulder, in the
    // same world-space thickets as the clump field, even away from stand edges.
    const vergeBand = smoothstep(config.roadClear, config.roadClear + 1.5, roadDist) *
      (1 - smoothstep(11, 17, roadDist));
    return (0.02 + 0.72 * edge * edge + 0.12 * dryOpen + 0.20 * cover + 0.34 * vergeBand) *
      (1 + (V.vergeShrubBoost - 1) * verge) *
      (slope === null ? 1 : smoothstep(V.slopeLimitShrub, V.slopeLimitShrub - 0.45, slope)) *
      smoothstep(config.roadClear, config.roadClear + 1, roadDist) *
      smoothstep(V.treeLine + 300, V.treeLine - 40, y);
  }
  const verge = smoothstep(config.roadClear, GRASS_COVERAGE.roadFull, roadDist) * (1 - smoothstep(18, 35, roadDist));
  return Math.max(1 - 0.68 * cover, verge * 0.92) *
    (slope === null ? 1 : smoothstep(V.slopeLimitGrass, V.slopeLimitGrass - 0.45, slope)) *
    (0.42 + 0.72 * moisture) * smoothstep(config.roadClear, GRASS_COVERAGE.roadFull, roadDist) *
    smoothstep(V.treeLine + 220, V.treeLine - 60, y);
}

function treeSpecies(x, z, y, moisture, seed) {
  const field = 0.5 + 0.5 * fbm(x * V.speciesFreq, z * V.speciesFreq, seed ^ 0x7d31, 2);
  const bias = clamp(V.coniferShare + smoothstep(120, 400, y) * 0.44 - moisture * 0.26, 0.03, 0.97);
  const share = clamp(lerp(bias, field > 0.5 ? 0.94 : 0.08, V.speciesCoherence * 0.72) * 0.5 + bias * 0.5, 0, 1);
  const conifer = hash2i(Math.floor(x / 28), Math.floor(z / 28), seed ^ 0x53a91f) / 4294967296 < share;
  const grove = vnoise(x / 90, z / 90, seed ^ 0x3ad057);
  const choice = hash2i(Math.floor(x / 24), Math.floor(z / 24), seed ^ 0x641b7d) / 4294967296;
  if (conifer) return choice < 0.30 + moisture * 0.24 + grove * 0.16 ? 'spruce' : 'pine';
  const birchShare = 0.20 + moisture * 0.10;
  const aspenShare = 0.12 + grove * 0.16;
  if (choice < birchShare) return 'birch';
  if (choice < birchShare + aspenShare) return 'aspen';
  return choice < birchShare + aspenShare + 0.26 ? 'maple' : 'oak';
}

// A candidate's cell and random stream never depend on camera, LOD, or season.
// Rendering can choose stable subsets with rank without rerolling placements.
// The open-pasture layer (pasture.js) shares the worker and fallback paths.
export function* generatePopulation(world, kind, i, j) {
  if (kind === PASTURE.kind) return yield* generatePasture(world, i, j);
  if (!Object.hasOwn(POPULATION, kind)) throw new RangeError('Unknown population kind');
  if (!Number.isSafeInteger(i) || !Number.isSafeInteger(j)) throw new RangeError('Population tile coordinates must be integers');
  const config = { ...POPULATION[kind] };
  if (!Number.isInteger(config.candidates) || config.candidates < 1 ||
      !Number.isInteger(config.columns) || config.columns < 1 || !Number.isFinite(config.tile) || config.tile <= 0) {
    throw new RangeError('Invalid population lattice');
  }
  const candidatesPerLayer = config.candidatesPerLayer ?? config.candidates;
  if (!Number.isInteger(candidatesPerLayer) || candidatesPerLayer < 1 ||
      config.candidates % candidatesPerLayer !== 0) throw new RangeError('Invalid population layer size');
  const columns = Math.min(config.columns, candidatesPerLayer), rows = Math.ceil(candidatesPerLayer / columns);
  const dx = config.tile / columns, dz = config.tile / rows;
  const seed = world.seed >>> 0, biomeSeed = seed ^ 0x2b7c1f03;
  const probeDistance = (kind === 'tree' ? config.roadDensityEnd : 150) + config.tile * Math.SQRT1_2;
  const roadsideKind = kind === 'tree' || kind === 'shrub';
  const probeRoad = roadsideKind && Boolean(world.route?.nearest)
    && (world.route.nearest((i + 0.5) * config.tile, (j + 0.5) * config.tile, probeDistance)?.dist ?? Infinity) <= probeDistance;
  const sample = {}, gradient = { dx: 0, dz: 0 }, records = [];
  const surfaceSampler = kind === 'grass' ? createRoadsideSurfaceSampler(world) : null, surface = {};
  for (let index = 0; index < config.candidates; index++) {
    if (index > 0 && (index & 15) === 0) yield;
    // Extra independently seeded layers keep the original plants in place.
    const layer = Math.floor(index / candidatesPerLayer), candidate = index % candidatesPerLayer;
    const cellX = i * columns + candidate % columns, cellZ = j * rows + Math.floor(candidate / columns);
    const rng = makeRng(hash2i(cellX, cellZ, seed ^ SALT[kind] ^ Math.imul(layer, 0x9e3779b1)));
    const margin = kind === 'grass' ? 0.015 : 0;
    const x = (cellX + margin + rng() * (1 - margin * 2)) * dx;
    const z = (cellZ + margin + rng() * (1 - margin * 2)) * dz;
    const accept = rng();
    world.sample(x, z, sample);
    if (kind === 'grass' && sample.roadDist >= GRASS_COVERAGE.roadEnd) continue;
    if (!Number.isFinite(sample.y) || !Number.isFinite(sample.waterY) ||
        !Number.isFinite(sample.moisture) || typeof sample.roadDist !== 'number' || Number.isNaN(sample.roadDist)) continue;
    if (sample.roadDist < config.roadClear) continue;
    // waterY is a river reference plane, not a world-wide water surface.
    if (sample.inWater || (sample.riverDist < sample.channelHalf * 2.4 &&
        sample.y < sample.waterY + config.waterClear)) continue;
    // The terrain carve only reports nearby roads. Resolve the full planting
    // corridor once; the tile bound skips these searches in distant woodland.
    if (kind === 'tree') sample.roadDist = treeRoadDistance(world, x, z, sample.roadDist, probeRoad);
    const ambientCover = forestCover(x, z, biomeSeed);
    // Trees and shrubs share the roadside stands and openings, so scrub gathers on
    // the ragged edges of a clearing instead of filling it like a forest interior.
    const cover = roadsideKind ? roadsideTreeCover(world, x, z, sample.roadDist, ambientCover, biomeSeed, probeRoad) : ambientCover;
    // Only grove interiors receive supplemental canopy; low cover stays a
    // genuine clearing rather than being amplified into a roadside tree row.
    const plantingCover = kind === 'tree' && layer > 0 ? smoothstep(0.20, 0.72, cover) : cover;
    const clump = kind === 'grass' ? grassClump(x, z, seed)
      : kind === 'shrub' ? smoothstep(0.52, 0.76, vnoise(x / 24, z / 24, biomeSeed ^ 0x57c2a9)) : 1;
    // More candidates inside shared thickets, none between them. The field is
    // world-space so neither tile borders nor camera movement break a patch.
    const clumpDensity = kind === 'grass' ? lerp(0.64, 1.16, clump) : kind === 'shrub' ? clump * 1.8 : 1;
    sample.moisture = clamp(sample.moisture, 0, 1);
    // Slope can only reduce density. Reject impossible candidates before its
    // two extra terrain samples, preserving the original final test and RNG.
    if (accept >= clamp(density(kind, sample, null, plantingCover, config) * config.density * clumpDensity, 0, 1)) continue;
    const slope = world.slopeAt(x, z, sample.y, kind === 'grass' ? 2.6 : 6, gradient);
    if (!Number.isFinite(slope) || !Number.isFinite(gradient.dx) || !Number.isFinite(gradient.dz)) continue;
    if (accept >= clamp(density(kind, sample, slope, plantingCover, config) * config.density * clumpDensity, 0, 1)) continue;
    const yaw = rng() * TAU, size = rng(), spread = rng(), rank = rng(), phase = rng() * TAU;
    const variant = rng() < 0.5 ? 0 : 1;
    let height, width, species;
    let bloom = 0;
    if (kind === 'grass') {
      // Uneven sward: ~5 m world-space patches of tall seeding grass rise out of
      // a shorter base, strongest on the uncut verge beside the shoulder.
      const tall = smoothstep(0.40, 0.80, vnoise(x / 5.5 + 3.1, z / 5.5 - 7.4, seed ^ 0x3d71c5));
      const vergeTall = 1 - smoothstep(9, 18, sample.roadDist);
      height = lerp(0.36, 0.72, clump) * lerp(0.70, 1.20, size) * (1 + tall * lerp(0.22, 0.48, vergeTall));
      // Wide, splaying clumps: arching leaves close the gaps between tufts.
      width = lerp(0.78, 1.42, clump) * lerp(0.80, 1.16, spread) * (1 + tall * 0.16);
      // Wildflowers gather in world-space clumps, mostly near the road edge;
      // each clump is one colour (white or yellow), a few strays elsewhere.
      const bloomPatch = smoothstep(0.62, 0.86, vnoise(x / 6.5 - 11.3, z / 6.5 + 5.9, seed ^ 0x5be1f9));
      const bloomNear = 1 - smoothstep(9, 20, sample.roadDist);
      if (rng() < 0.005 + 0.16 * bloomPatch * (0.30 + 0.70 * bloomNear)) {
        bloom = vnoise(x / 15 + 7.7, z / 15 - 2.2, seed ^ 0x19d4e3) > 0.55 ? 2 : 1;
      }
    } else if (kind === 'shrub') {
      height = lerp(0.65, 1.65, size);
      width = height * lerp(0.8, 1.3, spread);
      if (probeRoad) {
        const radius = width * 0.5;
        const near = world.route.nearest(x, z, FURNITURE.lat.wall + FURNITURE.wallHalfWidth + radius);
        if (near && wallBlocks(world, near.s, -near.side, near.dist, radius)) continue;
      }
    } else {
      species = treeSpecies(x, z, sample.y, sample.moisture, biomeSeed);
      if ((species === 'spruce' || species === 'pine') && sample.roadDist < config.coniferSwap) {
        const keep = hash2i(Math.floor(x * 4), Math.floor(z * 4), biomeSeed ^ 0x2e5b17) / 4294967296;
        if (sample.roadDist < config.coniferClear || keep < 0.5) continue;
        // Slender, light-crowned broadleaves keep the stand's edge without walling the frame.
        species = keep < 0.85 ? 'birch' : 'aspen';
      }
      const settings = TREE_SPECIES[species];
      const range = settings.heightRange;
      const vigor = clamp(0.35 + sample.moisture * 0.75 - slope * 0.55, 0.12, 1.2);
      height = lerp(range[0], range[1], clamp(size * vigor, 0, 1));
      width = height * lerp(settings.widthRatio[0], settings.widthRatio[1], spread);
    }
    if (surfaceSampler) surfaceSampler.sample(x, z, surface);
    records.push({ id: `${kind}:${seed}:${i}:${j}:${index}`, kind, x, y: sample.y, z,
      yaw, height, width, rank, phase, moisture: sample.moisture, cover, variant,
      groundDx: gradient.dx, groundDz: gradient.dz,
      ...(kind === 'grass' ? { clump, roadDist: sample.roadDist, bloom,
        surfaceY: surface.y, surfaceDx: surface.dx, surfaceDz: surface.dz } : {}), ...(species ? { species } : {}) });
  }
  if (kind === 'shrub' && probeRoad) yield* generateVerge(world, i, j, config.tile, records);
  return records;
}
