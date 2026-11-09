import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true }
    : next(url, context);
} });
const { createRoadsideSurfaceSampler, terrainResolution, nearRoadCorridorIntersects, captureSurfaceConfig } = await import('../src/terrain/surfaceSampler.js');
const { buildTerrainData, serializeWorld, hydrateWorld } = await import('../src/terrain/mesh-data.js');
const { TERRAIN } = await import('../src/terrain/params.js');
const { World } = await import('../src/world/world.js');
const { generatePopulation } = await import('../src/vegetation/population.js');
const { GRASS_COVERAGE } = await import('../src/vegetation/grassCoverage.js');
const finish = iterator => { let step; do { step = iterator.next(); } while (!step.done); return step.value; };

function meshReference(world) {
  const config = captureSurfaceConfig(world), cache = new Map(), size = config.chunkSize;
  return (x, z) => {
    x = Math.fround(x); z = Math.fround(z);
    const i = Math.floor(x / size), j = Math.floor(z / size), key = `${i}:${j}`;
    const tile = { x0: i * size, z0: j * size, C: size, l: 0 };
    const resolution = terrainResolution(0, size, config.nearRoadLevels > 0 && nearRoadCorridorIntersects(world, tile, config), config);
    if (!cache.has(key)) cache.set(key, finish(buildTerrainData(world, tile, { resolution, skirtDepth: 60 })));
    const data = cache.get(key), cell = size / resolution;
    const column = Math.min(resolution - 1, Math.floor((x - tile.x0) / cell));
    const row = Math.min(resolution - 1, Math.floor((z - tile.z0) / cell));
    const start = (row * resolution + column) * 6;
    const vertex = index => ({ x: data.positions[index * 3] + tile.x0 + size / 2,
      y: data.positions[index * 3 + 1], z: data.positions[index * 3 + 2] + tile.z0 + size / 2 });
    for (let offset = start; offset < start + 6; offset += 3) {
      const [a, b, c] = [0, 1, 2].map(k => vertex(data.indices[offset + k]));
      const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      const wa = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / denominator;
      const wb = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / denominator;
      const wc = 1 - wa - wb;
      if (Math.min(wa, wb, wc) < -1e-10) continue;
      const ab = [b.x - a.x, b.y - a.y, b.z - a.z], ac = [c.x - a.x, c.y - a.y, c.z - a.z];
      const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const length = Math.hypot(...cross);
      return { y: wa * a.y + wb * b.y + wc * c.y, normal: cross.map(value => value / length) };
    }
    throw new Error('Reference point missed both terrain triangles');
  };
}

test('shared resolution retains the existing adaptive terrain contract', () => {
  for (let level = 0; level < TERRAIN.levels; level++) for (const nearRoad of [false, true]) {
    const size = TERRAIN.chunkSize * 2 ** level;
    let expected = TERRAIN.resByLevel[Math.min(level, TERRAIN.resByLevel.length - 1)];
    if (level < TERRAIN.nearRoadLevels && nearRoad) {
      const target = Math.ceil(size / TERRAIN.nearRoadCell);
      expected = Math.max(expected, level === 1 ? Math.min(target, 64) : target);
    }
    assert.equal(terrainResolution(level, size, nearRoad), expected);
  }
  assert.equal(TERRAIN.chunkSize / terrainResolution(0, TERRAIN.chunkSize, true), 2);
});

for (const seed of [7, 12, 31]) test(`seed ${seed} roadside contacts match actual settled terrain triangles`, () => {
  const world = new World(seed).build(), sampler = createRoadsideSurfaceSampler(world), reference = meshReference(world);
  for (const fraction of [0.1, 0.5, 0.9]) for (const offset of [-24, -8, 8, 24]) {
    const point = world.route.at(world.route.kmToS(world.route.maxKm * fraction));
    const record = { id: `${seed}:${fraction}:${offset}`, x: point.x - point.tz * offset, z: point.z + point.tx * offset };
    const expected = reference(record.x, record.z), actual = sampler.sample(record.x, record.z);
    const length = Math.hypot(actual.dx, 1, actual.dz);
    const normal = [-actual.dx / length, 1 / length, -actual.dz / length];
    assert.ok(Math.abs(actual.y - expected.y) < 1e-4, record.id);
    assert.ok(Math.abs(Math.fround(actual.y) - expected.y) < 1e-4, `${record.id}: instance Float32 height`);
    assert.ok(Math.hypot(...normal.map((value, i) => value - expected.normal[i])) < 1e-4, `${record.id}: triangle normal`);
  }
});

test('negative coordinates, L0 boundaries and both diagonal halves match mesh-buffer planes', () => {
  const world = new World(12).build(), sampler = createRoadsideSurfaceSampler(world), reference = meshReference(world);
  for (const [x, z] of [[-128, -128], [-128.001, -127.999], [-0.001, -0.001], [0, 0],
    [-2, -4], [-1.8, -3.7], [-0.2, -2.1], [-1, -3], [128, -128], [127.999, -128.001]]) {
    const actual = sampler.sample(x, z), expected = reference(x, z);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-4, `${x},${z}`);
    const length = Math.hypot(actual.dx, 1, actual.dz);
    assert.ok(Math.hypot(-actual.dx / length - expected.normal[0], 1 / length - expected.normal[1],
      -actual.dz / length - expected.normal[2]) < 1e-4);
  }
});

test('a default aligned 32m grass job over a near-road 2m grid uses only 17x17 corner samples', () => {
  let samples = 0;
  const world = { route: { nearest() { return {}; } },
    sample(x, z, out) { samples++; out.y = 40 + Math.sin(x * 0.41) * 2 + Math.cos(z * 0.37) * 3; } };
  const sampler = createRoadsideSurfaceSampler(world);
  for (let j = 0; j < 96; j++) for (let i = 0; i < 96; i++) sampler.sample(-96 + (i + 0.3) / 3, 128 + (j + 0.7) / 3);
  assert.equal(samples, sampler.cornerCount);
  assert.equal(samples, 17 * 17);
  assert.ok(samples <= 18 * 18, `${samples} corner samples`);
  assert.equal(sampler.tileCount, 1);
  const before = samples;
  for (let i = 0; i < 100; i++) sampler.sample(-80.25, 141.5);
  assert.equal(samples, before);
  const separate = createRoadsideSurfaceSampler(world);
  separate.sample(-80.25, 141.5);
  assert.equal(separate.cornerCount, 3, 'each job owns its own bounded cache');
});

test('the shared corridor helper preserves the renderer five-probe order and reach exactly', () => {
  const calls = [], tile = { x0: -32, z0: 16, C: 16 };
  const config = { ...captureSurfaceConfig(), nearRoadMargin: 0 };
  const world = { route: { nearest(...args) { calls.push(args); return null; } } };
  assert.equal(nearRoadCorridorIntersects(world, tile, config), false);
  const reach = Math.hypot(8, 8);
  assert.deepEqual(calls, [[-24, 24, reach], [-32, 16, reach], [-16, 16, reach], [-16, 32, reach], [-32, 32, reach]]);
});

test('a root 25m from the road uses its actual coarse 16m tile instead of a forced fine grid', () => {
  const config = { ...captureSurfaceConfig(), chunkSize: 16, resByLevel: [4], nearRoadCell: 2, nearRoadMargin: 0 };
  const ground = (x, z) => x * x * 0.02 + z * z * 0.01;
  const world = { seed: 7, surfaceConfig: config, ground,
    route: { nearest(x, z, radius) { const dist = Math.abs(z + 17); return dist <= radius * 1.35 ? { dist } : null; } },
    sample(x, z, out) { Object.assign(out, { y: ground(x, z), moisture: 0.5, rockiness: 0.2,
      waterY: -5, riverDist: 1000, channelHalf: 10, roadDist: Math.abs(z + 17) }); },
  };
  const tile = { x0: 0, z0: 0, C: 16, l: 0 };
  assert.equal(world.route.nearest(10, 8, 30).dist, 25);
  assert.equal(nearRoadCorridorIntersects(world, tile), false);
  assert.equal(terrainResolution(0, 16, false, config), 4);
  assert.equal(terrainResolution(0, 16, true, config), 8);
  const sampler = createRoadsideSurfaceSampler(world), reference = meshReference(world);
  for (const [x, z] of [[10, -8], [10, 8], [12.5, 9.25], [-10, -8], [-10, 8], [16, 8], [10, 8]]) {
    const expected = reference(x, z), actual = sampler.sample(x, z), length = Math.hypot(actual.dx, 1, actual.dz);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-6);
    assert.ok(Math.hypot(-actual.dx / length - expected.normal[0], 1 / length - expected.normal[1],
      -actual.dz / length - expected.normal[2]) < 1e-6);
  }
  const incorrectlyForcedFine = createRoadsideSurfaceSampler({ ...world, surfaceConfig: { ...config, nearRoadMargin: 100 } }).sample(10, 8);
  assert.ok(Math.abs(incorrectlyForcedFine.y - reference(10, 8).y) > 0.079, 'fixture must reproduce the old approximately 8cm error');
  assert.ok(sampler.tileCount >= 4, 'one job must keep distinct fine and coarse tile decisions');
});

test('surface configuration is snapshotted for hydrated population workers rather than reading receiver defaults', () => {
  const original = { ...TERRAIN }, world = new World(7).build();
  const point = world.route.at(world.route.kmToS(6)), i = Math.floor(point.x / 32), j = Math.floor(point.z / 32);
  let records, snapshot, background;
  try {
    Object.assign(TERRAIN, { chunkSize: 16, resByLevel: [4, 4], nearRoadCell: 2, nearRoadMargin: 0 });
    records = finish(generatePopulation(world, 'grass', i, j));
    snapshot = serializeWorld(world);
    assert.equal(snapshot.surfaceConfig.chunkSize, 16);
    assert.notEqual(snapshot.surfaceConfig.resByLevel, TERRAIN.resByLevel);
    TERRAIN.resByLevel[0] = 6;
    assert.equal(snapshot.surfaceConfig.resByLevel[0], 4);
    background = hydrateWorld(structuredClone(snapshot));
    assert.notEqual(background.surfaceConfig.resByLevel, snapshot.surfaceConfig.resByLevel);
    snapshot.surfaceConfig.resByLevel[0] = 99;
    assert.equal(background.surfaceConfig.resByLevel[0], 4);
  } finally { Object.assign(TERRAIN, original); }
  assert.ok(records.length > 0);
  assert.equal(background.surfaceConfig.chunkSize, 16);
  assert.equal(TERRAIN.chunkSize, original.chunkSize);
  assert.deepEqual(finish(generatePopulation(background, 'grass', i, j)), records);
  const legacy = serializeWorld(world);
  delete legacy.surfaceConfig;
  assert.equal(hydrateWorld(legacy).surfaceConfig, undefined);
});

test('camera-relative ridge displacement inside grass support is explicitly unsupported', () => {
  const config = captureSurfaceConfig();
  const support = GRASS_COVERAGE.viewEnd + Math.SQRT2 * config.chunkSize / terrainResolution(0, config.chunkSize, false, config);
  for (const farRidgeNear of [0, GRASS_COVERAGE.viewEnd, support]) {
    assert.throws(() => createRoadsideSurfaceSampler({ surfaceConfig: { ...config, farRidgeNear } }), /farRidgeNear.*supporting L0/);
  }
  assert.doesNotThrow(() => createRoadsideSurfaceSampler({ surfaceConfig: { ...config, farRidgeNear: support + 1 } }));
  assert.ok(config.farRidgeNear > support, 'default 680m ridge starts well beyond visible grass');
});

test('grass surface fields preserve analytic canonical values and do not leak corner samples into records', () => {
  const world = { seed: 7,
    sample(x, z, out) { Object.assign(out, { y: 40 + Math.sin(x * 1.3) * 0.7 + Math.cos(z * 1.7) * 0.2,
      moisture: 0.8, waterY: 0, roadDist: 20, riverDist: 1000, channelHalf: 10 }); },
    slopeAt(x, z, y, e, out) { out.dx = Math.cos(x * 1.3) * 0.91; out.dz = -Math.sin(z * 1.7) * 0.34; return 0.01; },
  };
  const records = finish(generatePopulation(world, 'grass', -3, 4)), sample = {};
  assert.ok(records.length > 100);
  assert.ok(records.some(record => Math.abs(record.surfaceY - record.y) > 0.1));
  for (const record of records) {
    world.sample(record.x, record.z, sample);
    assert.equal(record.y, sample.y);
    assert.equal(record.roadDist, sample.roadDist);
    assert.equal(record.groundDx, Math.cos(record.x * 1.3) * 0.91);
    assert.equal(record.groundDz, -Math.sin(record.z * 1.7) * 0.34);
    for (const key of ['surfaceY', 'surfaceDx', 'surfaceDz']) assert.ok(Number.isFinite(record[key]));
  }
});

test('worker-hydrated worlds and fallback generation agree on every grass surface field', () => {
  const world = new World(12).build(), background = hydrateWorld(structuredClone(serializeWorld(world)));
  const point = world.route.at(world.route.kmToS(5.5));
  const i = Math.floor(point.x / 32), j = Math.floor(point.z / 32);
  const records = finish(generatePopulation(world, 'grass', i, j));
  assert.ok(records.length > 0);
  assert.deepEqual(finish(generatePopulation(background, 'grass', i, j)), records);
});
