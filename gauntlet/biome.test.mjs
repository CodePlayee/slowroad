import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const { grassClump, forestCover, roadsideTreeCover } = await import('../src/vegetation/biome.js');
const { POPULATION, generatePopulation } = await import('../src/vegetation/population.js');
const { buildTerrainData } = await import('../src/terrain/mesh-data.js');
const { World } = await import('../src/world/world.js');
const hash = value => createHash('sha256').update(value).digest('hex');
const finish = iterator => { let step; do { step = iterator.next(); } while (!step.done); return step.value; };

test('shared biome fields preserve frozen records under the original density profile', t => {
  const saved = { ...POPULATION.tree };
  t.after(() => Object.assign(POPULATION.tree, saved));
  Object.assign(POPULATION.tree, { density: 1, roadDensityNear: 1, roadDensityFar: 1 });
  const fixtures = [
    [7, 'grass', 7161, '030ac32781d8f0bc9c52a070160a07fb5baa201c81263ab524a212aa8fb73cda'],
    [7, 'shrub', 35, 'aa97782af4040d4c988e32595cabd871f494564cdebb0202a0b765743ee2052d'],
    [7, 'tree', 1220, 'aaee722c369fa5af6c48eb51a64dbf05dc0f4d8c870dd90cf950852d39cc63e2'],
    [12, 'grass', 7037, '2bcd841a27852a693bb310aa86d1ec034178e2df4fb50ec4592136dd1598dcdc'],
    [12, 'shrub', 34, 'b9d3ea9c58d38e4e6131591e3a9a76a2cfd5db0e993648464bc1a3bcf2600337'],
    [12, 'tree', 1139, 'cb9a7fbb2c4b4ecd26cc2fd8d9f4988e4caf06ad8e5a7325da62a78401d969df'],
    [31, 'grass', 7280, 'badfbb243852abc0011793f2348028c666d7cd0f2aafd1f0a02d17d1568b1665'],
    [31, 'shrub', 21, '71baae3ee0b936f680a56d521fcda1b3ebef1b709844dc0687ca1332f8fde9da'],
    [31, 'tree', 1234, 'cd74eeb42182b8c1aa17d3df56d4bea2fedf77e11c0c8da41a242d85dd82fd4a'],
  ];
  for (const [seed, kind, count, expected] of fixtures) {
    const world = { seed,
      sample(x, z, out) { Object.assign(out, { y: 40, moisture: 0.8, waterY: 0, roadDist: 20, riverDist: 1000, channelHalf: 10 }); },
      slopeAt(x, z, y, e, out) { out.dx = 0.03; out.dz = -0.02; return 0.01; },
    };
    const records = finish(generatePopulation(world, kind, -3, 4));
    assert.equal(records.length, count);
    assert.equal(hash(JSON.stringify(records, (key, value) => ['surfaceY', 'surfaceDx', 'surfaceDz'].includes(key) ? undefined : value)), expected, `${seed}/${kind}`);
  }
});

test('adding ecology leaves every original terrain buffer and bound byte-identical', () => {
  const world = new World(7).build();
  const data = finish(buildTerrainData(world, { x0: -128, z0: 0, C: 128, l: 0 }, { resolution: 8, skirtDepth: 20 }));
  const expected = {
    positions: 'a825ac7e652212a1898dbd9b40e698726d88dcce3f173b0d7f0ed7f7b2e5c233',
    normals: '38741dbc82bf62531c2f59d1faae94ea8bc9cb07130dd40a270bcc7836cf23cf',
    surface: '6c44c006ed9af8f6e3f202a893367afef0b7016a764f29bbfd2d95f35e0d7e81',
    roadDistances: 'e04f3ceeebdd8e6231b1cd50ed7e3da842611f93df2cd79a70ab53246c897a9b',
    indices: '4f8baad9913fb8a66ca07a00a06c69b74c9c3f2a4d0de4b4bb6e6938967baaca',
    heights: '95f480fb3acd3623e53deab061723c61749ea0e175e6da238c60dc5e89cc326c',
  };
  for (const [key, digest] of Object.entries(expected)) assert.equal(hash(new Uint8Array(data[key].buffer)), digest, key);
  assert.deepEqual([data.minY, data.maxY, data.resolution, data.gridSize, data.skirtDepth],
    [18.49519157409668, 33.61238098144531, 8, 11, 20]);
});

function routedWorld() {
  const world = new World(7);
  world.route._finalise(Array.from({ length: 401 }, (_, i) => ({ x: i * 5 - 1000, z: 0, y: 40, bridge: 0 })));
  world.route._index();
  return world;
}

test('terrain ecology uses the exact population fields and stays seamless at negative tile and LOD boundaries', () => {
  const world = routedWorld(), options = { resolution: 8, skirtDepth: 20 };
  const tile = { x0: -128, z0: -128, C: 128, l: 0 };
  const first = finish(buildTerrainData(world, tile, options));
  const second = finish(buildTerrainData(world, { ...tile, x0: 0 }, options));
  const coarse = finish(buildTerrainData(world, { x0: -1024, z0: -1024, C: 1024, l: 3 }, options));
  const sample = {}, biomeSeed = world.seed ^ 0x2b7c1f03;
  let beyondCarve = 0;
  assert.ok(first.ecology instanceof Float32Array);
  assert.equal(first.ecology.length, first.positions.length / 3 * 2);
  for (let j = 0; j <= 8; j++) for (let i = 0; i <= 8; i++) {
    const x = tile.x0 + i * 16, z = tile.z0 + j * 16, vertex = j * 9 + i;
    world.sample(x, z, sample);
    const ambient = forestCover(x, z, biomeSeed);
    const cover = roadsideTreeCover(world, x, z, sample.roadDist, ambient, biomeSeed);
    assert.equal(first.ecology[vertex * 2], Math.fround(cover));
    assert.equal(first.ecology[vertex * 2 + 1], Math.fround(grassClump(x, z, world.seed)));
    if (!Number.isFinite(sample.roadDist) && cover > ambient) beyondCarve++;
  }
  assert.ok(beyondCarve > 0, 'roadside forest floor must extend beyond the 62m terrain carving corridor');
  assert.ok(first.ecology.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  for (let j = 0; j <= 8; j++) {
    assert.deepEqual(first.ecology.slice((j * 9 + 8) * 2, (j * 9 + 9) * 2), second.ecology.slice(j * 18, j * 18 + 2));
  }
  assert.deepEqual(first.ecology.slice(0, 2), coarse.ecology.slice((7 * 9 + 7) * 2, (7 * 9 + 7) * 2 + 2));
});

test('coarse ecology never performs tile-sized road searches and distant fine tiles skip per-vertex queries', () => {
  const searches = [];
  const world = { seed: 7, ground() { return 0; },
    sample(x, z, out) { Object.assign(out, { y: 0, moisture: 0.5, rockiness: 0.2, riverDist: 1000,
      channelHalf: 10, waterY: -5, roadDist: Infinity }); },
    route: { nearest(x, z, radius) { searches.push(radius); return null; } },
  };
  finish(buildTerrainData(world, { x0: -8192, z0: -8192, C: 8192 }, { resolution: 2, skirtDepth: 20 }));
  assert.equal(searches.length, 9);
  assert.ok(searches.every(radius => radius === 150));
  searches.length = 0;
  finish(buildTerrainData(world, { x0: -8192, z0: -8192, C: 128 }, { resolution: 8, skirtDepth: 20 }));
  assert.deepEqual(searches, [150 + 128 * Math.SQRT1_2]);
});
