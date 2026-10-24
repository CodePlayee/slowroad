import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const sourceRoot = new URL('../src/', import.meta.url).href;
const populationUrl = new URL('../src/vegetation/population.js', import.meta.url).href;
registerHooks({ load(url, context, next) {
  if (!url.startsWith(sourceRoot) || !url.endsWith('.js')) return next(url, context);
  let source = readFileSync(fileURLToPath(url), 'utf8');
  // Expose the exact private placement equations only inside this audit process.
  if (url === populationUrl) source += '\nexport { forestCover as auditForestCover, density as auditDensity, roadsideTreeCover as auditRoadsideTreeCover };\n';
  return { format: 'module', source, shortCircuit: true };
} });

const { World } = await import('../src/world/world.js');
const { POPULATION, generatePopulation, treeRoadDistance, auditForestCover, auditDensity, auditRoadsideTreeCover } = await import('../src/vegetation/population.js');
const { VEG } = await import('../src/vegetation/params.js');
const { clamp, hash2i, makeRng, smoothstep } = await import('../src/core/rng.js');
const { PopulationPool } = await import('../src/vegetation/populationPool.js');
const { VegetationSystem } = await import('../src/vegetation/system.js');

function finish(iterator) {
  let step;
  do { step = iterator.next(); } while (!step.done);
  return step.value;
}

function summary(values) {
  if (!values.length) return { mean: null, min: null, p50: null, p90: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    min: sorted[0], p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
    p90: sorted[Math.floor((sorted.length - 1) * 0.9)], max: sorted.at(-1) };
}

export function auditStation(world, km, windowMetres = 300) {
  const config = POPULATION.tree, route = world.route;
  const center = route.at(route.kmToS(km));
  const start = Math.max(route.kmZero, center.s - windowMetres / 2);
  const end = Math.min(route.length - 0.001, center.s + windowMetres / 2);
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let s = start; s < end + 25; s += 25) {
    const point = route.at(Math.min(s, end));
    for (const offset of [-84, 84]) {
      const x = point.x - point.tz * offset, z = point.z + point.tx * offset;
      bounds.minX = Math.min(bounds.minX, x - 4); bounds.maxX = Math.max(bounds.maxX, x + 4);
      bounds.minZ = Math.min(bounds.minZ, z - 4); bounds.maxZ = Math.max(bounds.maxZ, z + 4);
    }
  }
  const observations = [];
  const accepted = new Map();
  const perLayer = config.candidatesPerLayer ?? config.candidates;
  const columns = Math.min(config.columns, perLayer), rows = Math.ceil(perLayer / columns);
  let tiles = 0;
  for (let j = Math.floor(bounds.minZ / config.tile); j <= Math.floor(bounds.maxZ / config.tile); j++) {
    for (let i = Math.floor(bounds.minX / config.tile); i <= Math.floor(bounds.maxX / config.tile); i++) {
      tiles++;
      let index = 0;
      const probe = Object.create(world);
      probe.sample = (x, z, out) => {
        world.sample(x, z, out);
        const candidateIndex = index++;
        const near = route.nearest(x, z, 81);
        if (!near || near.dist < 10 || near.dist > 80 || near.s < start || near.s > end) return out;
        const longitudinal = (x - near.x) * near.tx + (z - near.z) * near.tz;
        if (near.s <= start + 1e-6 && longitudinal < 0 || near.s >= end - 1e-6 && longitudinal > 0) return out;
        observations.push({ x, z, i, j, index: candidateIndex, side: near.side < 0 ? 'left' : 'right',
          lateral: near.dist, sample: { ...out } });
        return out;
      };
      for (const record of finish(generatePopulation(probe, 'tree', i, j))) accepted.set(record.id, record);
      assert.equal(index, config.candidates, 'candidate sampling order changed; update the audit mapping');
    }
  }
  const reasons = {}, zeroFactors = { cover: 0, supplementalCover: 0, altitude: 0, slope: 0 };
  const bySide = { left: { candidates: 0, accepted: 0 }, right: { candidates: 0, accepted: 0 } };
  const byLayer = Array.from({ length: config.candidates / perLayer }, () => ({ candidates: 0, accepted: 0 }));
  const byDistance = { '10-30m': { candidates: 0, accepted: 0 }, '30-80m': { candidates: 0, accepted: 0 } };
  const coverValues = [], ambientCoverValues = [], elevations = [], slopes = [], altitudeWeights = [], heights = [];
  for (const record of observations) {
    const { x, z, i, j, index, sample } = record;
    const layer = Math.floor(index / perLayer), candidate = index % perLayer;
    const cellX = i * columns + candidate % columns, cellZ = j * rows + Math.floor(candidate / columns);
    const rng = makeRng(hash2i(cellX, cellZ, world.seed ^ 0x72a50d ^ Math.imul(layer, 0x9e3779b1)));
    rng(); rng(); const acceptance = rng();
    const ambientCover = auditForestCover(x, z, world.seed ^ 0x2b7c1f03);
    const cover = auditRoadsideTreeCover(world, x, z, sample.roadDist, ambientCover, world.seed ^ 0x2b7c1f03);
    const plantingCover = layer > 0 ? smoothstep(0.14, 0.54, cover) : cover;
    const altitude = smoothstep(VEG.treeLine + VEG.treeLineFade, VEG.treeLine - VEG.treeLineFade, sample.y);
    const gradient = {};
    const slope = world.slopeAt(x, z, sample.y, 6, gradient);
    const slopeWeight = smoothstep(VEG.slopeLimitTree, VEG.slopeLimitTree - 0.34, slope);
    const fields = { ...sample, moisture: clamp(sample.moisture, 0, 1),
      roadDist: treeRoadDistance(world, x, z, sample.roadDist) };
    const upper = clamp(auditDensity('tree', fields, null, plantingCover, config) * config.density, 0, 1);
    const probability = clamp(auditDensity('tree', fields, slope, plantingCover, config) * config.density, 0, 1);
    let reason;
    if (!Number.isFinite(sample.y) || !Number.isFinite(sample.waterY) || !Number.isFinite(sample.moisture)
      || typeof sample.roadDist !== 'number' || Number.isNaN(sample.roadDist)) reason = 'invalid';
    else if (sample.roadDist < config.roadClear) reason = 'road';
    else if (sample.inWater || sample.riverDist < sample.channelHalf * 2.4 && sample.y < sample.waterY + config.waterClear) reason = 'water';
    else if (acceptance >= upper) reason = plantingCover === 0 ? 'coverZero' : altitude === 0 ? 'altitudeZero' : 'densityLottery';
    else if (!Number.isFinite(slope) || !Number.isFinite(gradient.dx) || !Number.isFinite(gradient.dz)) reason = 'invalidSlope';
    else if (acceptance >= probability) reason = slopeWeight === 0 ? 'slopeZero' : 'slopeLottery';
    else reason = 'accepted';
    const id = `tree:${world.seed >>> 0}:${i}:${j}:${index}`;
    assert.equal(reason === 'accepted', accepted.has(id), `audit differs from generatePopulation: ${id}`);
    reasons[reason] = (reasons[reason] || 0) + 1;
    zeroFactors.cover += cover === 0 ? 1 : 0;
    zeroFactors.supplementalCover += layer > 0 && plantingCover === 0 ? 1 : 0;
    zeroFactors.altitude += altitude === 0 ? 1 : 0;
    zeroFactors.slope += slopeWeight === 0 ? 1 : 0;
    for (const bucket of [bySide[record.side], byLayer[layer], byDistance[record.lateral < 30 ? '10-30m' : '30-80m']]) {
      bucket.candidates++;
      if (reason === 'accepted') bucket.accepted++;
    }
    coverValues.push(cover); ambientCoverValues.push(ambientCover); elevations.push(sample.y); slopes.push(slope); altitudeWeights.push(altitude);
    if (reason === 'accepted') heights.push(accepted.get(id).height);
  }
  return { km, roadElevation: center.y, segmentMetres: end - start, tilesSampled: tiles,
    candidates: observations.length, accepted: reasons.accepted || 0,
    acceptanceRate: (reasons.accepted || 0) / Math.max(1, observations.length),
    treesPer100m: (reasons.accepted || 0) / ((end - start) / 100),
    reasons, zeroFactors, bySide, byLayer, byDistance,
    cover: summary(coverValues), ambientCover: summary(ambientCoverValues), elevation: summary(elevations), slope: summary(slopes),
    altitudeWeight: summary(altitudeWeights), acceptedHeight: summary(heights),
    tallTreeFraction: heights.filter(height => height >= 15).length / Math.max(1, heights.length) };
}

export function auditQueuedPriority() {
  class IdleWorker { postMessage() {} terminate() {} }
  const pool = new PopulationPool({ WorkerClass: IdleWorker });
  const system = Object.assign(Object.create(VegetationSystem.prototype), {
    version: 0, world: {}, tiles: new Map(), cache: new Map(), cpuReady: new Map(), _builds: new Map(),
    pool, scheduler: { has() { return false; }, drop() {}, reprioritise() {}, push() { throw new Error('unexpected fallback'); } },
    _streamJobs: [], _streamWant: new Set(), _signature: '', _coverageRevision: -1,
    _clock: performance.now(), time: 0, _publishFrame: -1, _published: 0, assetReady: false,
  });
  try {
    system.update(0, 0);
    const key = 'veg:0:tree:3:0', initial = pool._jobs.get(key).priority;
    system.update(3.5 * POPULATION.tree.tile, 0.5 * POPULATION.tree.tile);
    const desired = system._streamJobs.find(job => job.key === key).priority;
    const actual = pool._jobs.get(key).priority;
    return { key, initialPriority: initial, desiredPriorityAfterApproach: desired,
      actualQueuedPriorityAfterApproach: actual, stale: actual !== desired,
      method: 'Production update and queue code with one idle fake worker; no terrain, rendering, or live timing.' };
  } finally { pool.dispose(); }
}

export function auditRouteVegetation({ seeds = [7, 12, 31], stepKm = 2, otherStepKm = 4, windowMetres = 300 } = {}) {
  const started = performance.now();
  const routes = seeds.map((seed, index) => {
    const world = new World(seed).build(), step = index === 0 ? stepKm : otherStepKm;
    const stations = [];
    for (let km = 0; km <= world.route.maxKm; km += step) stations.push(auditStation(world, km, windowMetres));
    if (world.route.maxKm - stations.at(-1).km > 0.5) stations.push(auditStation(world, world.route.maxKm, windowMetres));
    return { seed, routeKm: world.route.maxKm, routeBuildMs: world.buildMs, stations };
  });
  return { elapsedMs: performance.now() - started, treeConfig: { ...POPULATION.tree },
    placement: { treeLine: VEG.treeLine, treeLineFade: VEG.treeLineFade, slopeLimitTree: VEG.slopeLimitTree },
    populationSha256: createHash('sha256').update(readFileSync(fileURLToPath(populationUrl))).digest('hex'),
    method: 'Exact seeded candidates and production acceptance; 10-80m from nearest road centerline, 300m station windows by default. zeroFactors overlap; reasons are exclusive. Does not measure runtime streaming.',
    queuedPriorityProbe: auditQueuedPriority(), routes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({ options: { seeds: { type: 'string', default: '7,12,31' },
    'step-km': { type: 'string', default: '2' }, 'other-step-km': { type: 'string', default: '4' },
    'window-m': { type: 'string', default: '300' }, out: { type: 'string' } } });
  const options = { seeds: values.seeds.split(',').map(Number), stepKm: Number(values['step-km']),
    otherStepKm: Number(values['other-step-km']), windowMetres: Number(values['window-m']) };
  assert.ok(options.seeds.length && options.seeds.every(Number.isFinite));
  assert.ok([options.stepKm, options.otherStepKm, options.windowMetres].every(value => Number.isFinite(value) && value > 0));
  const report = auditRouteVegetation(options);
  if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n');
  for (const route of report.routes) {
    console.log(`seed=${route.seed} route=${route.routeKm.toFixed(2)}km build=${route.routeBuildMs.toFixed(0)}ms`);
    for (const station of route.stations) console.log(JSON.stringify({ km: Number(station.km.toFixed(2)),
      candidates: station.candidates, accepted: station.accepted, rate: Number(station.acceptanceRate.toFixed(3)),
      treesPer100m: Number(station.treesPer100m.toFixed(1)), cover: Number(station.cover.mean?.toFixed(3) ?? 0),
      elevation: Math.round(station.elevation.mean), altitudeWeight: Number(station.altitudeWeight.mean?.toFixed(3) ?? 0),
      slope: Number(station.slope.mean?.toFixed(3) ?? 0), height: Number(station.acceptedHeight.mean?.toFixed(1) ?? 0),
      reasons: station.reasons, zeroFactors: station.zeroFactors }));
  }
  console.log(JSON.stringify({ queuedPriorityProbe: report.queuedPriorityProbe }));
  console.log(`elapsed=${report.elapsedMs.toFixed(0)}ms${values.out ? ` report=${values.out}` : ''}`);
}
