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
const { grassClump, forestCover, roadsideTreeCover } = await import('../src/vegetation/biome.js');
const { buildTerrainData } = await import('../src/terrain/mesh-data.js');
const { World } = await import('../src/world/world.js');
const finish = iterator => { let step; do { step = iterator.next(); } while (!step.done); return step.value; };


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
  const opposite = finish(buildTerrainData(world, { ...tile, z0: 0 }, options));
  const sample = {}, biomeSeed = world.seed ^ 0x2b7c1f03;
  let opened = 0;
  assert.ok(first.ecology instanceof Float32Array);
  assert.equal(first.ecology.length, first.positions.length / 3 * 2);
  // Road sides open independently, so check the exact fields on both sides of the road.
  for (const [origin, data] of [[tile, first], [{ ...tile, z0: 0 }, opposite]]) {
    for (let j = 0; j <= 8; j++) for (let i = 0; i <= 8; i++) {
      const x = origin.x0 + i * 16, z = origin.z0 + j * 16, vertex = j * 9 + i;
      world.sample(x, z, sample);
      const ambient = forestCover(x, z, biomeSeed);
      const cover = roadsideTreeCover(world, x, z, sample.roadDist, ambient, biomeSeed);
      assert.equal(data.ecology[vertex * 2], Math.fround(cover));
      assert.equal(data.ecology[vertex * 2 + 1], Math.fround(grassClump(x, z, world.seed)));
      if (cover < ambient) opened++;
    }
  }
  assert.ok(opened > 0, 'roadside openings must clear ambient woodland, not only the roadside floor');
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
