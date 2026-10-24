import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import test from 'node:test';

const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true }
    : next(url, context);
} });
const { POPULATION, generatePopulation, treeRoadDistance, treeRoadDensity } = await import('../src/vegetation/population.js');
const { PopulationPool } = await import('../src/vegetation/populationPool.js');
const { serializeWorld, hydrateWorld } = await import('../src/terrain/mesh-data.js');
const { World } = await import('../src/world/world.js');
const { VEG: V } = await import('../src/vegetation/params.js');
const { TREE_SPECIES, TREE_SPECIES_NAMES } = await import('../src/vegetation/treeSpecies.js');
const { GRASS_COVERAGE } = await import('../src/vegetation/grassCoverage.js');

function finish(iterator) {
  let step;
  do { step = iterator.next(); } while (!step.done);
  return step.value;
}

function baseLayer(records, kind) {
  const count = POPULATION[kind].candidatesPerLayer ?? POPULATION[kind].candidates;
  return records.filter(record => Number(record.id.split(':').at(-1)) < count);
}

function flatWorld(seed = 7, overrides = {}) {
  return {
    seed,
    sample(x, z, out) {
      Object.assign(out, { y: 40, moisture: 0.8, waterY: 0, roadDist: Infinity,
        riverDist: 1000, channelHalf: 10 }, typeof overrides === 'function' ? overrides(x, z) : overrides);
    },
    slopeAt(x, z, y, e, out) { out.dx = 0.03; out.dz = -0.02; return 0.01; },
  };
}

function grassWorld(seed = 7, overrides = {}) {
  return flatWorld(seed, { roadDist: GRASS_COVERAGE.roadEnd - 0.001, ...overrides });
}

function routedWorld(seed = 'population-test') {
  const world = new World(seed);
  world.route._finalise(Array.from({ length: 100 }, (_, i) => ({
    x: i * 8 - 400, z: 0, y: 40 + i * 0.015, bridge: 0,
  })));
  world.route._index();
  return world;
}

function originalTreeDensity(run) {
  const config = POPULATION.tree;
  const saved = { density: config.density, roadDensityNear: config.roadDensityNear, roadDensityFar: config.roadDensityFar };
  Object.assign(config, { density: 1, roadDensityNear: 1, roadDensityFar: 1 });
  try { return run(); } finally { Object.assign(config, saved); }
}

test('density prefilter preserves frozen placement records under the original density profile', () => {
  // Visual dimensions/species may evolve; placement, acceptance and RNG stay fixed.
  const fixtures = [
    [7, 'grass', 0, 0, 2067, '9475a4b346818f7e4be26ed7f0da2505585e97157aa6db58243bfaaeb9ed7d80'],
    [7, 'grass', -3, 4, 1492, '6e84122577e65a3244e1f6ff541322600b0ed0476abe16401c0e9b0af0d411d9'],
    [7, 'shrub', 0, 0, 13, '7427f4f4daac4ac9c3dd16322e29fa3b68671245186937ef21d3e50b96e7d1df'],
    [7, 'shrub', -3, 4, 34, 'b5332b688fe8fd983fee69d30a4bee53b6d3705823fba6b7d4f5bcbe1f1bc28f'],
    [7, 'tree', 0, 0, 75, 'c8ef3ee32150c8c86bd189ab605291a67f6fa354f71025736ee929915c2d3eae'],
    [7, 'tree', -3, 4, 72, '9c3268671e3223c85db1e8d51a0240c0ee0d34180a6e9adfde4a0b15d967d195'],
    [12, 'grass', 0, 0, 1656, 'eac9998cc35defaf9b99f7d05ab6e22df0bed6520ad06b3923d1f9b1fd83745e'],
    [12, 'grass', -3, 4, 1540, '6030257fa822d7fdee9cc979fd006244281bafe028b350df5018245b5ae9ade8'],
    [12, 'shrub', 0, 0, 29, '3682cdb17a8026ea628973bbcd6cc09abea6eb55ffac700c42510df23cda0c5f'],
    [12, 'shrub', -3, 4, 28, 'c5fbfc35a1fa00631ec4af38c390ebccaf6233ec7561cdd3ea3c05e35432ec27'],
    [12, 'tree', 0, 0, 70, 'c290c526027a396dd6bd1e7b5681e754806b94bb9d36e2c292b70ed3dba8a678'],
    [12, 'tree', -3, 4, 17, '1678476cdeca6e055c185e20e0ffc014047e9f5ab246c76c0f8fcee04d802772'],
    [31, 'grass', 0, 0, 1673, '2414ff1fb9f7e1f294e593df09327e8f974711a775c0016fa79a4a52e7646a8f'],
    [31, 'grass', -3, 4, 1769, '800417594eaefe8fd9d9f2a73f9b883fd1870c86a72aee7708b04e9699298e01'],
    [31, 'shrub', 0, 0, 19, '1c4152b91c806b4d5c4bdd9d9a9613d063eede7fb0d31ee9693ef0cd27f40850'],
    [31, 'shrub', -3, 4, 20, '6afc3325533d221f0677e9e7729e2e8b1315149d1fc85337348c9d88b7bea81a'],
    [31, 'tree', 0, 0, 49, '8f870759ed60064abb01643d51dcdfb0515005a6fc4893467839258ad5772aff'],
    [31, 'tree', -3, 4, 68, 'f11b9c8c8e0689136da257ec355675c8e5ed78f4bf775fbaf21001437a48e6b7'],
  ];
  for (const [seed, kind, i, j, count, hash] of fixtures) {
    const world = kind === 'grass' ? grassWorld(seed) : flatWorld(seed);
    const generate = () => baseLayer(finish(generatePopulation(world, kind, i, j)), kind);
    const records = kind === 'tree' ? originalTreeDensity(generate) : generate();
    const serialized = JSON.stringify(records, (key, value) => ['height', 'width', 'species', 'roadDist', 'surfaceY', 'surfaceDx', 'surfaceDz'].includes(key) ? undefined
      : typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value);
    assert.equal(records.length, count);
    assert.equal(createHash('sha256').update(serialized).digest('hex'), hash, `${seed}/${kind}/${i}/${j}`);
  }
});

test('impossible density candidates never trigger expensive slope samples', () => {
  for (const kind of Object.keys(POPULATION)) {
    const world = kind === 'grass' ? grassWorld(12) : flatWorld(12), slope = world.slopeAt;
    let calls = 0;
    world.slopeAt = (...args) => { calls++; return slope(...args); };
    const records = finish(generatePopulation(world, kind, -3, 4));
    assert.ok(calls < POPULATION[kind].candidates);
    assert.equal(calls, records.length, 'flat ground has no subsequent slope rejection');
    const barren = flatWorld(12, { y: 10000 });
    barren.slopeAt = () => { throw new Error('Uninhabitable terrain needs no slope samples'); };
    assert.deepEqual(finish(generatePopulation(barren, kind, -3, 4)), []);
  }
});

test('population configuration has one world lattice per category and adequate streaming guards', () => {
  assert.deepEqual(Object.keys(POPULATION), ['grass', 'shrub', 'tree']);
  assert.deepEqual(Object.values(POPULATION).map(({ tile, candidates }) => [tile, candidates]),
    [[32, 9216], [64, 48], [256, 1280]]);
  assert.equal(POPULATION.grass.candidatesPerLayer, 2304);
  assert.equal(POPULATION.tree.candidatesPerLayer, 160);
  assert.equal(POPULATION.grass.columns, 48);
  assert.ok(POPULATION.grass.tile * POPULATION.grass.radius >= GRASS_COVERAGE.viewEnd + 64,
    'prefetch grass at least two tiles before it can enter the camera fade band');
  assert.ok(POPULATION.shrub.tile * POPULATION.shrub.radius >= 256);
  assert.ok(POPULATION.tree.tile * POPULATION.tree.radius >= 2304);
});

test('stable records are identical on revisit and ignore camera, LOD, and seasonal changes', () => {
  const world = grassWorld(), previousSeason = V.season;
  const baseline = Object.fromEntries(Object.keys(POPULATION).map(kind => [kind, finish(generatePopulation(world, kind, 0, 0))]));
  try {
    V.season = { snow: 1, bareness: 1, lushness: 0, flowerAmount: 0 };
    world.camera = { x: 2000, z: -4000 }; world.lod = 4; world.season = 'winter';
    for (const kind of Object.keys(POPULATION)) {
      assert.ok(baseline[kind].length > 0, `${kind} fixture produced no records`);
      finish(generatePopulation(world, kind, -3, 4));
      assert.deepEqual(finish(generatePopulation(world, kind, 0, 0)), baseline[kind]);
    }
  } finally {
    V.season = previousSeason;
  }
});

test('all fields are finite, dimensions are world-space, and IDs retain source candidate identity', () => {
  const world = grassWorld();
  for (const kind of Object.keys(POPULATION)) {
    const config = POPULATION[kind], records = finish(generatePopulation(world, kind, -1, 0));
    for (const record of records) {
      assert.equal(record.kind, kind);
      assert.match(record.id, new RegExp(`^${kind}:7:-1:0:[0-9]+$`));
      assert.ok(Number(record.id.split(':').at(-1)) < config.candidates);
      for (const key of ['x', 'y', 'z', 'yaw', 'height', 'width', 'rank', 'phase', 'moisture', 'cover', 'groundDx', 'groundDz']) {
        assert.ok(Number.isFinite(record[key]), key);
      }
      assert.ok(record.x > -config.tile && record.x < 0);
      assert.ok(record.z > 0 && record.z < config.tile);
      assert.ok(record.height > 0 && record.width > 0);
      assert.ok(record.rank >= 0 && record.rank < 1);
      assert.ok(record.phase >= 0 && record.phase < Math.PI * 2);
      assert.ok(record.variant === 0 || record.variant === 1);
      if (kind === 'tree') assert.ok(Object.hasOwn(TREE_SPECIES, record.species));
      if (kind === 'grass') {
        assert.ok(record.roadDist >= GRASS_COVERAGE.roadStart && record.roadDist < GRASS_COVERAGE.roadEnd);
        for (const key of ['surfaceY', 'surfaceDx', 'surfaceDz']) assert.ok(Number.isFinite(record[key]));
      } else for (const key of ['roadDist', 'surfaceY', 'surfaceDx', 'surfaceDz']) assert.equal(Object.hasOwn(record, key), false);
    }
  }
});

test('neighboring negative and positive tiles never duplicate IDs or overlap their candidate cells', () => {
  const world = grassWorld(), ids = new Set(), points = new Set();
  for (const kind of Object.keys(POPULATION)) {
    const C = POPULATION[kind].tile;
    for (const i of [-1, 0, 1]) for (const j of [-1, 0]) {
      const records = finish(generatePopulation(world, kind, i, j));
      for (const record of records) {
        assert.ok(record.x >= i * C && record.x < (i + 1) * C);
        assert.ok(record.z >= j * C && record.z < (j + 1) * C);
        assert.equal(ids.has(record.id), false);
        assert.equal(points.has(`${kind}:${record.x}:${record.z}`), false);
        ids.add(record.id); points.add(`${kind}:${record.x}:${record.z}`);
      }
    }
  }
});

test('changing the seed changes positions and identities while stable ranks select nested LOD subsets', () => {
  const a = finish(generatePopulation(grassWorld(7), 'grass', 0, 0));
  const b = finish(generatePopulation(grassWorld(8), 'grass', 0, 0));
  assert.notDeepEqual(a.map(record => [record.x, record.z]), b.map(record => [record.x, record.z]));
  const ids = new Set(a.map(record => record.id));
  assert.ok(b.every(record => !ids.has(record.id)));
  const coarse = a.filter(record => record.rank < 0.25), medium = new Map(a.filter(record => record.rank < 0.6).map(record => [record.id, record]));
  assert.ok(coarse.length > 0 && coarse.length < medium.size);
  for (const record of coarse) assert.strictEqual(medium.get(record.id), record);
});

test('grass growth and width follow coherent world-space clumps instead of independent tuft noise', () => {
  const records = baseLayer(finish(generatePopulation(grassWorld(), 'grass', 0, 0)), 'grass');
  assert.ok(records.every(record => Number.isFinite(record.clump) && record.clump >= 0 && record.clump <= 1));
  const byClump = [...records].sort((a, b) => a.clump - b.clump);
  const quartile = Math.max(1, Math.floor(records.length / 4));
  const low = byClump.slice(0, quartile), high = byClump.slice(-quartile);
  const average = (items, field) => items.reduce((sum, record) => sum + record[field], 0) / items.length;
  assert.ok(average(high, 'height') > average(low, 'height') * 1.3);
  assert.ok(average(high, 'width') > average(low, 'width') * 1.2);
  const byIndex = new Map(records.map(record => [Number(record.id.split(':').at(-1)), record]));
  const near = [], distant = [];
  for (const [index, record] of byIndex) {
    if (index % 48 < 47 && byIndex.has(index + 1)) near.push(Math.abs(record.clump - byIndex.get(index + 1).clump));
    if (index % 48 < 32 && byIndex.has(index + 16)) distant.push(Math.abs(record.clump - byIndex.get(index + 16).clump));
  }
  assert.ok(near.length > 0 && distant.length > 0);
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(mean(near) < mean(distant) * 0.45, 'neighboring tufts should share their growth patch');
});

test('grass clump variation stays continuous across a negative-to-positive tile boundary', () => {
  const world = grassWorld();
  const left = baseLayer(finish(generatePopulation(world, 'grass', -1, 0)), 'grass');
  const right = baseLayer(finish(generatePopulation(world, 'grass', 0, 0)), 'grass');
  const edge = records => new Map(records.map(record => [Number(record.id.split(':').at(-1)), record]));
  const leftByIndex = edge(left), rightByIndex = edge(right), differences = [];
  for (let row = 0; row < 48; row++) {
    const a = leftByIndex.get(row * 48 + 47), b = rightByIndex.get(row * 48);
    if (a && b) differences.push(Math.abs(a.clump - b.clump));
  }
  assert.ok(differences.length > 0);
  assert.ok(differences.reduce((sum, value) => sum + value, 0) / differences.length < 0.2);
});

test('grass remains low varied meadow cover rather than a uniform waist-high field', () => {
  const records = finish(generatePopulation(grassWorld(), 'grass', 0, 0));
  const heights = records.map(record => record.height).sort((a, b) => a - b);
  assert.ok(heights[0] >= 0.10 && heights.at(-1) <= 0.87);
  assert.ok(heights[Math.floor(heights.length / 2)] < 0.60);
  assert.ok(heights[Math.floor(heights.length * 0.9)] > heights[Math.floor(heights.length * 0.1)] * 1.45);
  assert.ok(records.every(record => record.width >= 0.48 && record.width < 1.31));
});

test('four grass layers preserve every original record and add deterministic independently placed tufts', () => {
  const { candidates, candidatesPerLayer } = POPULATION.grass;
  assert.equal(candidates / candidatesPerLayer, 4);
  for (const [seed, i, j] of [[7, 0, 0], [12, -3, 4], [31, -1, -2]]) {
    const world = grassWorld(seed);
    let original;
    try {
      POPULATION.grass.candidates = candidatesPerLayer;
      original = finish(generatePopulation(world, 'grass', i, j));
    } finally { POPULATION.grass.candidates = candidates; }
    const records = finish(generatePopulation(world, 'grass', i, j));
    assert.deepEqual(baseLayer(records, 'grass'), original);
    assert.deepEqual(finish(generatePopulation(world, 'grass', i, j)), records);
    assert.equal(new Set(records.map(record => record.id)).size, records.length);
    assert.equal(new Set(records.map(record => `${record.x},${record.z}`)).size, records.length);
    const layers = Array.from({ length: 4 }, () => []);
    for (const record of records) layers[Math.floor(Number(record.id.split(':').at(-1)) / candidatesPerLayer)].push(record);
    assert.ok(layers.every(layer => layer.length > original.length * 0.8));
    assert.ok(layers.every(layer => layer.length < original.length * 1.2));
    for (const layer of layers.slice(1)) {
      assert.notDeepEqual(layer.map(record => [record.x, record.z]), original.map(record => [record.x, record.z]));
      assert.ok(layer.every(record => record.clump >= 0 && record.clump <= 1));
    }
  }
});

test('grass rejects the entire outer corridor before slope sampling and retains exact inner records', () => {
  for (const roadDist of [GRASS_COVERAGE.roadEnd, GRASS_COVERAGE.roadEnd + 0.001, Infinity]) {
    const world = grassWorld(7, { roadDist });
    world.slopeAt = () => { throw new Error('Outer grass must not sample slope'); };
    assert.deepEqual(finish(generatePopulation(world, 'grass', 0, 0)), []);
  }
  const baseline = finish(generatePopulation(grassWorld(7, { roadDist: 20 }), 'grass', 0, 0));
  const world = flatWorld(7, x => ({ roadDist: x < 16 ? 20 : GRASS_COVERAGE.roadEnd }));
  const slope = world.slopeAt;
  let slopeCalls = 0;
  world.slopeAt = (...args) => {
    assert.ok(args[0] < 16, 'rejected outer-corridor points must not reach slope sampling');
    slopeCalls++;
    return slope(...args);
  };
  const records = finish(generatePopulation(world, 'grass', 0, 0));
  assert.deepEqual(records, baseline.filter(record => record.x < 16));
  assert.ok(records.every(record => record.roadDist < GRASS_COVERAGE.roadEnd));
  assert.equal(slopeCalls, records.length);
  assert.ok(slopeCalls < baseline.length * 0.65);
});

test('mixed woodland contains all six deterministic species with species-specific proportions', () => {
  const counts = Object.fromEntries(TREE_SPECIES_NAMES.map(name => [name, 0]));
  const world = flatWorld();
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const records = finish(generatePopulation(world, 'tree', i, j));
    for (const record of records) {
      counts[record.species]++;
      const settings = TREE_SPECIES[record.species];
      assert.ok(record.height >= settings.heightRange[0] && record.height <= settings.heightRange[1]);
      const ratio = record.width / record.height;
      assert.ok(ratio >= settings.widthRatio[0] - 1e-8 && ratio <= settings.widthRatio[1] + 1e-8);
    }
  }
  assert.ok(Object.values(counts).every(count => count > 10), JSON.stringify(counts));
});

test('reduced forest layers retain a deterministic subset without rerolling surviving trees', () => {
  const original = originalTreeDensity(() => finish(generatePopulation(flatWorld(7), 'tree', 0, 0)));
  const records = finish(generatePopulation(flatWorld(7), 'tree', 0, 0));
  const base = original.filter(record => Number(record.id.split(':').at(-1)) < 160);
  assert.equal(base.length, 75);
  assert.ok(records.length > original.length * 0.35 && records.length < original.length * 0.55);
  const byId = new Map(original.map(record => [record.id, record]));
  for (const record of records) assert.deepEqual(record, byId.get(record.id));
  const layers = new Set(records.map(record => Math.floor(Number(record.id.split(':').at(-1)) / 160)));
  assert.equal(layers.size, 8);
  assert.equal(new Set(records.map(record => record.id)).size, records.length);
  assert.equal(new Set(records.map(record => `${record.x},${record.z}`)).size, records.length);
  const supplemental = records.filter(record => Number(record.id.split(':').at(-1)) >= 160);
  assert.ok(supplemental.every(record => record.cover > 0.14), 'extra layers must preserve open clearings');
  assert.deepEqual(finish(generatePopulation(flatWorld(7), 'tree', 0, 0)), records);
});

test('half-density trees favor the roadside and taper smoothly without a distant cutoff', () => {
  assert.equal(POPULATION.tree.density, 0.5);
  assert.equal(treeRoadDensity(32), 1.35);
  assert.equal(treeRoadDensity(320), 0.9);
  assert.equal(treeRoadDensity(Infinity), 0.9);
  let previous = Infinity;
  for (let distance = 10; distance <= 1000; distance++) {
    const weight = treeRoadDensity(distance);
    assert.ok(weight <= previous && weight >= 0.9);
    previous = weight;
  }
  for (const distance of [32, 160, 320]) {
    assert.ok(Math.abs(treeRoadDensity(distance + 0.001) - treeRoadDensity(distance - 0.001)) < 0.00001);
  }
  let lastRatio = Infinity;
  for (const roadDist of [32, 160, 320, Infinity]) {
    let before = 0, after = 0;
    for (const seed of [7, 12, 31]) for (let i = -2; i <= 2; i++) {
      const world = flatWorld(seed, { roadDist });
      before += originalTreeDensity(() => finish(generatePopulation(world, 'tree', i, 0))).length;
      after += finish(generatePopulation(world, 'tree', i, 0)).length;
    }
    const ratio = after / before;
    assert.ok(ratio <= lastRatio + 0.01 && ratio >= 0.4 && ratio <= 0.75, `${roadDist}m retention ${ratio}`);
    lastRatio = ratio;
  }
});

test('road-density distance reaches beyond the carve and avoids point queries in distant tiles', () => {
  let queries = 0;
  const world = { route: { nearest(x, z, radius) { queries++; assert.equal(radius, 320); return { dist: 160 }; } } };
  assert.equal(treeRoadDistance(world, 0, 0, 20), 20);
  assert.equal(queries, 0);
  assert.equal(treeRoadDistance(world, 0, 0, Infinity), 160);
  assert.equal(queries, 1);
  assert.equal(treeRoadDistance(world, 0, 0, Infinity, false), Infinity);
  assert.equal(queries, 1);
  const distant = flatWorld();
  distant.route = { nearest() { queries++; return null; } };
  finish(generatePopulation(distant, 'tree', 50, -50));
  assert.equal(queries, 2, 'only the tile center needs probing when its whole footprint is distant');
});

test('population filtering never admits road, water, steep-slope, or malformed samples', () => {
  for (const kind of Object.keys(POPULATION)) {
    const config = POPULATION[kind];
    assert.deepEqual(finish(generatePopulation(flatWorld(7, { roadDist: config.roadClear - 0.001 }), kind, 0, 0)), []);
    assert.deepEqual(finish(generatePopulation(grassWorld(7, { y: config.waterClear - 0.001, riverDist: 0 }), kind, 0, 0)), []);
    assert.deepEqual(finish(generatePopulation(grassWorld(7, { y: NaN }), kind, 0, 0)), []);
    assert.deepEqual(finish(generatePopulation(flatWorld(7, { roadDist: undefined }), kind, 0, 0)), []);
    const cliff = grassWorld();
    cliff.slopeAt = (x, z, y, e, out) => { out.dx = 100; out.dz = 0; return 0.999; };
    assert.deepEqual(finish(generatePopulation(cliff, kind, 0, 0)), []);
  }
});

test('river height filtering preserves dry depressions outside the actual water corridor', () => {
  for (const kind of Object.keys(POPULATION)) {
    const dry = grassWorld(7, { y: -20, waterY: 0, riverDist: 25, channelHalf: 10, inWater: false });
    const records = finish(generatePopulation(dry, kind, 0, 0));
    assert.ok(records.length > 0, `${kind} incorrectly treats the river reference plane as global water`);
    assert.ok(records.every(record => record.y === -20));
    const wet = grassWorld(7, { y: -20, waterY: 0, riverDist: 23, channelHalf: 10, inWater: false });
    assert.deepEqual(finish(generatePopulation(wet, kind, 0, 0)), []);
    const explicitWater = grassWorld(7, { y: -20, waterY: 0, riverDist: 25, channelHalf: 10, inWater: true });
    assert.deepEqual(finish(generatePopulation(explicitWater, kind, 0, 0)), []);
  }
});

test('mixed road and water regions enforce their exact per-category clearance on every accepted point', () => {
  for (const kind of Object.keys(POPULATION)) {
    const config = POPULATION[kind];
    const world = flatWorld(7, (x, z) => ({ roadDist: Math.abs(x - config.tile * 0.5),
      waterY: z < config.tile * 0.5 ? 100 : 0,
      riverDist: z < config.tile * 0.5 ? 0 : 1000 }));
    for (const record of finish(generatePopulation(world, kind, 0, 0))) {
      assert.ok(Math.abs(record.x - config.tile * 0.5) >= config.roadClear);
      assert.ok(record.z >= config.tile * 0.5);
      assert.equal(record.y, 40);
    }
  }
});

test('generation yields every sixteen candidates even when all candidates are rejected', () => {
  for (const kind of Object.keys(POPULATION)) {
    const iterator = generatePopulation(flatWorld(7, { roadDist: 0 }), kind, 0, 0);
    let slices = 0, step;
    do { step = iterator.next(); if (!step.done) slices++; } while (!step.done);
    assert.equal(slices, Math.floor((POPULATION[kind].candidates - 1) / 16));
    assert.deepEqual(step.value, []);
  }
  assert.throws(() => finish(generatePopulation(flatWorld(), 'constructor', 0, 0)), /kind/);
  assert.throws(() => finish(generatePopulation(flatWorld(), 'grass', 0.5, 0)), /coordinates/);
});

test('hydrated worker worlds reproduce the same road-aware population records', () => {
  const world = routedWorld(), clone = hydrateWorld(structuredClone(serializeWorld(world)));
  for (const kind of Object.keys(POPULATION)) {
    const records = finish(generatePopulation(world, kind, 0, 0));
    assert.deepEqual(finish(generatePopulation(clone, kind, 0, 0)), records);
    const sample = {};
    for (const record of records) {
      world.sample(record.x, record.z, sample);
      assert.ok(sample.roadDist >= POPULATION[kind].roadClear);
      assert.equal(sample.inWater, false);
      if (sample.riverDist < sample.channelHalf * 2.4) {
        assert.ok(record.y >= sample.waterY + POPULATION[kind].waterClear);
      }
      assert.equal(record.y, sample.y);
    }
  }
});

class FakeWorker {
  static instances = [];
  constructor(url, options) {
    this.url = String(url); this.options = options; this.messages = [];
    FakeWorker.instances.push(this);
  }
  postMessage(message) { this.messages.push(structuredClone(message)); }
  terminate() { this.terminated = true; }
  emit(message) { this.onmessage({ data: message }); }
  get builds() { return this.messages.filter(message => message.type === 'build'); }
}

const tile = { kind: 'grass', i: 0, j: 0 };

function poolFixture(t) {
  FakeWorker.instances.length = 0;
  const pool = new PopulationPool({ WorkerClass: FakeWorker, size: 8 });
  pool.reset(routedWorld());
  t.after(() => pool.dispose());
  assert.equal(FakeWorker.instances.length, 1);
  return { pool, worker: FakeWorker.instances[0] };
}

test('population pool clones the world once, uses one worker and dispatches queued priorities', (t) => {
  const { pool, worker } = poolFixture(t);
  assert.ok(worker.url.endsWith('/population.worker.js'));
  assert.equal(worker.options.type, 'module');
  pool.request('far', tile, 30);
  pool.request('near', tile, 1);
  pool.request('middle', tile, 10);
  worker.emit({ type: 'ready', epoch: pool.epoch });
  assert.equal(worker.builds.length, 1);
  assert.equal(worker.builds[0].id, 2);
  assert.equal(worker.messages.filter(message => message.type === 'init').length, 1);
  assert.ok(worker.builds.every(message => !Object.hasOwn(message, 'world')));
  const near = worker.builds[0];
  worker.emit({ type: 'built', epoch: near.epoch, id: near.id, records: [{ id: 'near' }] });
  assert.equal(worker.builds.length, 2);
  assert.equal(pool.pending, 3);
  assert.deepEqual(pool.poll('near'), { records: [{ id: 'near' }] });
  assert.equal(pool.poll('near'), null);
  assert.equal(pool.pending, 2);
});

test('pool cancellation rejects stale same-key results and frees completed and queued records', (t) => {
  const { pool, worker } = poolFixture(t);
  worker.emit({ type: 'ready', epoch: pool.epoch });
  pool.request('same', tile);
  pool.request('queued', tile);
  const stale = worker.builds[0];
  pool.cancelExcept(new Set());
  assert.equal(pool.pending, 0);
  assert.equal(worker.messages.at(-1).type, 'cancel');
  pool.request('same', tile);
  worker.emit({ type: 'built', epoch: stale.epoch, id: stale.id, records: ['stale'] });
  assert.equal(pool.poll('same'), null);
  const current = worker.builds[1];
  worker.emit({ type: 'built', epoch: current.epoch, id: current.id, records: ['fresh'] });
  assert.equal(pool.has('same'), true);
  pool.cancelExcept(new Set());
  assert.equal(pool.poll('same'), null);
});

test('reset advances the world epoch and ignores stale initialization and completion', (t) => {
  const { pool, worker } = poolFixture(t);
  worker.emit({ type: 'ready', epoch: pool.epoch });
  pool.request('same', tile);
  const old = worker.builds[0];
  pool.reset(routedWorld('changed'));
  pool.request('same', tile);
  worker.emit({ type: 'ready', epoch: old.epoch });
  assert.equal(worker.builds.length, 1);
  worker.emit({ type: 'ready', epoch: pool.epoch });
  const current = worker.builds[1];
  worker.emit({ type: 'built', epoch: old.epoch, id: old.id, records: ['stale'] });
  assert.equal(pool.poll('same'), null);
  worker.emit({ type: 'built', epoch: current.epoch, id: current.id, records: ['fresh'] });
  assert.deepEqual(pool.poll('same'), { records: ['fresh'] });
  assert.equal(worker.messages.filter(message => message.type === 'init').length, 2);
});

test('worker failure makes queued jobs available for fallback without losing completed results', (t) => {
  const { pool, worker } = poolFixture(t);
  worker.emit({ type: 'ready', epoch: pool.epoch });
  pool.request('done', tile);
  const completed = worker.builds[0];
  worker.emit({ type: 'built', epoch: completed.epoch, id: completed.id, records: ['done'] });
  pool.request('active', tile);
  pool.request('queued', tile);
  worker.onerror({ message: 'synthetic worker failure' });
  assert.equal(pool.available, false);
  assert.ok(worker.terminated);
  assert.deepEqual(pool.poll('done'), { records: ['done'] });
  assert.match(pool.poll('active').error, /synthetic/);
  assert.match(pool.poll('queued').error, /synthetic/);
  assert.equal(pool.request('later', tile), false);
});

test('unavailable or disposed worker pools safely request cooperative fallback', () => {
  class BlockedWorker { constructor() { throw new Error('blocked'); } }
  const pool = new PopulationPool({ WorkerClass: BlockedWorker });
  pool.reset(routedWorld());
  assert.equal(pool.available, false);
  assert.equal(pool.request('tile', tile), false);
  pool.dispose();
  assert.equal(pool.pending, 0);
  const noWorker = new PopulationPool();
  assert.equal(noWorker.available, false);
  noWorker.dispose();
});

test('actual worker protocol reproduces records and cooperatively cancels stale work', async (t) => {
  const previous = globalThis.self, messages = [];
  globalThis.self = { postMessage(message) { messages.push(structuredClone(message)); } };
  let now = 0;
  t.mock.method(performance, 'now', () => (now += 5));
  try {
    await import('../src/vegetation/population.worker.js');
    const world = routedWorld();
    await self.onmessage({ data: { type: 'init', epoch: 3, world: serializeWorld(world) } });
    await self.onmessage({ data: { type: 'build', epoch: 3, id: 1, tile } });
    assert.deepEqual(messages.find(message => message.type === 'built').records,
      finish(generatePopulation(world, tile.kind, tile.i, tile.j)));
    await self.onmessage({ data: { type: 'build', epoch: 3, id: 2, tile: { ...tile, kind: 'invalid' } } });
    assert.equal(messages.at(-1).type, 'error');
    await self.onmessage({ data: { type: 'build', epoch: 2, id: 3, tile } });
    assert.equal(messages.at(-1).type, 'cancelled');
    const cancelled = self.onmessage({ data: { type: 'build', epoch: 3, id: 4, tile } });
    await self.onmessage({ data: { type: 'cancel', epoch: 3, id: 4 } });
    await cancelled;
    assert.deepEqual(messages.at(-1), { type: 'cancelled', id: 4, epoch: 3 });
    const replaced = self.onmessage({ data: { type: 'build', epoch: 3, id: 5, tile } });
    await self.onmessage({ data: { type: 'init', epoch: 4, world: serializeWorld(routedWorld('new')) } });
    await replaced;
    assert.deepEqual(messages.at(-1), { type: 'cancelled', id: 5, epoch: 3 });
  } finally {
    if (previous === undefined) delete globalThis.self;
    else globalThis.self = previous;
  }
});
