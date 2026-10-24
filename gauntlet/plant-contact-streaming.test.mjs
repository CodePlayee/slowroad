import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as THREE from 'three';

const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true }
    : next(url, context);
} });
const { Terrain } = await import('../src/terrain/terrain.js');
const { World } = await import('../src/world/world.js');
const { Scheduler } = await import('../src/streaming/scheduler.js');
const { SEASONS } = await import('../src/atmosphere/params.js');
const { POPULATION, generatePopulation } = await import('../src/vegetation/population.js');
const world = new World(7).build();
const root = (id, x = 0.5, z = 0.5, kind = 'tree') => ({ id, kind, x, y: 20, z, width: 16 });
const entry = (key, records, bounds = [-32, -32, 32, 32], kind = 'tree', groundReady = true) => ({
  job: { key, kind, groundBounds: bounds }, records, groundReady, meshes: [],
});

async function fixture(t, sourceWorld = world) {
  t.mock.method(THREE.TextureLoader.prototype, 'loadAsync', async () => new THREE.Texture());
  const atmo = { palette: SEASONS.summer, seasonName: 'summer', register() {},
    renderer: { capabilities: { getMaxAnisotropy: () => 1 }, initTexture() {} } };
  const terrain = new Terrain(sourceWorld, atmo, new Scheduler(3));
  t.after(() => terrain.dispose());
  await terrain.assetPromise;
  const tiles = new Map();
  const advance = (x = 0, z = 0) => { terrain._frame++; terrain.updatePlantContact(tiles, x, z); };
  const finish = (x = 0, z = 0) => {
    let frames = 0;
    do {
      advance(x, z);
      const work = terrain.plantContactStats().lastWork;
      assert.ok(work.recordsVisited <= 2048);
      assert.ok(work.rasterChecks <= 16384);
      assert.ok(++frames < 10000);
    } while (!terrain.plantContactReady);
    return frames;
  };
  return { terrain, tiles, advance, finish };
}

test('only published, supported woody tiles are read and stationary/far changes do not rescan populations', async t => {
  const { terrain, tiles, finish, advance } = await fixture(t);
  tiles.set('tree', entry('tree', [root('a')]));
  tiles.set('shrub', entry('shrub', [root('b', 10.5, 0.5, 'shrub')], [0, -20, 20, 20], 'shrub'));
  const forbidden = () => { throw new Error('unrelated population array was read'); };
  const far = entry('far', [], [4000, 4000, 4300, 4300]);
  Object.defineProperty(far, 'records', { get: forbidden });
  const grass = entry('grass', [], [-32, -32, 32, 32], 'grass');
  Object.defineProperty(grass, 'records', { get: forbidden });
  const unsupported = entry('unsupported', [], [-32, -32, 32, 32], 'tree', false);
  Object.defineProperty(unsupported, 'records', { get: forbidden });
  tiles.set('far', far); tiles.set('grass', grass); tiles.set('unsupported', unsupported);
  finish();
  assert.equal(terrain.plantContact.activeCount, 2);
  assert.ok(terrain.plantContact.sampleWorld(0.5, 0.5) > 0);
  const version = terrain.plantContact.version;
  advance(7, 3);
  assert.deepEqual(terrain.plantContactStats().lastWork, { tilesVisited: 0, recordsVisited: 0, preparationRecords: 0, rasterChecks: 0 });
  terrain.plantContactChanged(far);
  advance(9, 1);
  assert.equal(terrain.plantContactStats().lastWork.tilesVisited, 0);
  assert.equal(terrain.plantContact.version, version);
});

test('selection and raster work are frame bounded and readiness waits beyond the ordinary scheduler', async t => {
  const { terrain, tiles, advance, finish } = await fixture(t);
  const records = Array.from({ length: 5000 }, (_, i) => root(`r${i}`, (i % 50) * 0.3 + 0.5, Math.floor(i / 50) * 0.3 + 0.5));
  tiles.set('dense', entry('dense', records, [0, 0, 32, 32]));
  advance();
  assert.equal(terrain.scheduler.pending, 0);
  assert.equal(terrain.plantContactReady, false);
  assert.equal(terrain.settled, false);
  assert.equal(terrain.plantContactStats().lastWork.recordsVisited, 2048);
  const state = structuredClone(terrain.plantContactStats());
  terrain.updatePlantContact(tiles, 0, 0);
  assert.deepEqual(terrain.plantContactStats(), state, 'second vegetation update cannot spend another frame budget');
  assert.ok(finish() > 1);
  assert.equal(terrain.settled, true);
  assert.equal(terrain.plantContact.activeCount, records.length);
});

test('window movement plus newly published roots keeps the old active world-space map until commit', async t => {
  const { terrain, tiles, finish, advance } = await fixture(t);
  const old = entry('old', [root('old')]);
  tiles.set('old', old); finish();
  terrain.plantContact.texelsPerStep = 1;
  const data = terrain.plantContact.data.slice(), origin = terrain.plantContact.origin.toArray();
  const added = entry('added', [root('new', 260.5, 0.5)], [250, -16, 280, 16]);
  tiles.set('added', added); terrain.plantContactChanged(added);
  advance(16, 0);
  assert.equal(terrain.plantContact.pending, true);
  assert.deepEqual(terrain.plantContact.origin.toArray(), origin);
  assert.deepEqual(terrain.plantContact.data, data);
  advance(32, 0);
  assert.deepEqual(terrain.plantContact.data, data, 'superseding a pending window must not clear the active map');
  finish(32, 0);
  assert.deepEqual(terrain.plantContact.origin.toArray(), [-224, -256]);
  assert.ok(terrain.plantContact.sampleWorld(0.5, 0.5) > 0);
  assert.ok(terrain.plantContact.sampleWorld(260.5, 0.5) > 0);
});

test('actual removal or lost support clears active roots immediately and cancelled builds cannot restore them', async t => {
  const { terrain, tiles, finish, advance } = await fixture(t);
  const published = entry('a', [root('a')]);
  tiles.set('a', published); finish();
  terrain.plantContact.texelsPerStep = 1;
  advance(16, 0);
  published.groundReady = false;
  terrain.plantContactChanged(published, true);
  assert.equal(terrain.plantContact.data.some(Boolean), false);
  assert.equal(terrain.plantContact.pending, false);
  assert.equal(terrain.plantContactReady, false);
  finish(16, 0);
  assert.equal(terrain.plantContact.activeCount, 0);
  published.groundReady = true;
  terrain.plantContactChanged(published); finish(16, 0);
  assert.ok(terrain.plantContact.activeCount > 0);
  tiles.delete('a'); terrain.plantContactChanged(published, true);
  assert.equal(terrain.plantContact.data.some(Boolean), false);
  finish(16, 0);
  assert.equal(terrain.plantContact.activeCount, 0);
});

test('the 917-root 64m shrub-ring eviction preserves retained contacts through every raster frame', async t => {
  const { terrain, tiles, finish, advance } = await fixture(t);
  const trees = entry('veg:0:tree:0:0', Array.from({ length: 1024 }, (_, i) => ({
    id: `t${i}`, kind: 'tree', x: 4 + (i % 32) * 8, z: 4 + Math.floor(i / 32) * 8, width: 16,
  })), [-30, -30, 286, 286]);
  const fringe = entry('veg:0:shrub:-4:0', [root('fringe', -195.5, 1, 'shrub')], [-259, -3, -189, 67], 'shrub');
  fringe.records[0].width = 1.5;
  tiles.set(trees.job.key, trees); tiles.set(fringe.job.key, fringe);
  assert.equal(finish(63.9, 0), 3);
  assert.equal(terrain.plantContact.activeCount, 917);
  const before = terrain.plantContact.sampleWorld(68, 4), pixels = terrain.plantContact.data.slice();
  const origin = terrain.plantContact.origin.toArray(), version = terrain.plantContact.version;
  assert.equal(before, 0.5411764705882353);
  tiles.delete(fringe.job.key);
  terrain.plantContactChanged(fringe, true, { reason: 'stream-eviction', focus: { x: 64.1, z: 0 } });
  assert.deepEqual(terrain.plantContact.data, pixels, 'range eviction is not a world deletion');
  assert.equal(terrain.plantContact.sampleWorld(68, 4), before);
  advance(64.1, 0);
  assert.equal(terrain.plantContact.pending, true);
  assert.equal(terrain.plantContactStats().lastWork.rasterChecks, 16384);
  assert.equal(terrain.plantContact.lastUpdate.clearedTexels, pixels.length, 'only the back buffer is cleared');
  assert.equal(terrain.plantContact.version, version, 'field.update may not invalidate the same retired edge again');
  assert.deepEqual(terrain.plantContact.origin.toArray(), origin);
  let frames = 1;
  while (!terrain.plantContactReady) {
    assert.equal(terrain.plantContact.sampleWorld(68, 4), before);
    advance(64.1, 0);
    assert.ok(++frames < 10);
  }
  assert.equal(terrain.plantContact.sampleWorld(68, 4), before);
  assert.equal(terrain.plantContact.sampleWorld(-195.5, 1), 0);
  assert.equal(terrain.plantContact.version, version + 1);
});

test('an evicted root still inside the target window is not exempted from immediate invalidation', async t => {
  const { terrain, tiles, finish } = await fixture(t);
  const removed = entry('still-effective', [root('removed', 20.5, 0.5)], [0, -16, 64, 64]);
  const retained = entry('retained', [root('retained', 68.5, 0.5)], [64, -16, 96, 64]);
  tiles.set(removed.job.key, removed); tiles.set(retained.job.key, retained);
  finish(63.9, 0);
  tiles.delete(removed.job.key);
  terrain.plantContactChanged(removed, true, { reason: 'stream-eviction', focus: { x: 64.1, z: 0 } });
  assert.equal(terrain.plantContact.data.some(Boolean), false);
  finish(64.1, 0);
  assert.equal(terrain.plantContact.sampleWorld(20.5, 0.5), 0);
  assert.ok(terrain.plantContact.sampleWorld(68.5, 0.5) > 0);
});

test('seed reset cancels contact selection and raster work without touching geometry or population IDs', async t => {
  const { terrain, tiles, finish, advance } = await fixture(t);
  const records = [root('seed-7')], saved = structuredClone(records);
  tiles.set('old', entry('old', records)); finish();
  terrain.plantContact.texelsPerStep = 1;
  advance(16, 0);
  terrain.resetPlantContact();
  assert.equal(terrain.plantContact.data.some(Boolean), false);
  assert.equal(terrain.plantContact.pending, false);
  assert.equal(terrain.plantContact.activeCount, 0);
  assert.deepEqual(records, saved);
  tiles.clear(); tiles.set('new', entry('new', [root('seed-12', 30.5, 0.5)], [20, -16, 40, 16]));
  finish(32, 0);
  assert.equal(terrain.plantContact.sampleWorld(0.5, 0.5), 0);
  assert.ok(terrain.plantContact.sampleWorld(30.5, 0.5) > 0);
  assert.equal(terrain.chunks.size, 0);
});

test('contact shader adds exactly one sample, protects excluded surfaces, and confines snow effects to actual roots', async t => {
  const { terrain } = await fixture(t);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  terrain.material.onBeforeCompile(shader);
  assert.equal((shader.fragmentShader.match(/\b(?:texture2D|textureGrad)\(/g) || []).length, 5);
  assert.equal((shader.fragmentShader.match(/texture2D\(uPlantContact,/g) || []).length, 1);
  assert.equal(shader.uniforms.uPlantContact.value, terrain.plantContact.texture);
  assert.equal(shader.uniforms.uPlantContactOrigin.value, terrain.plantContact.origin);
  assert.equal(shader.uniforms.uPlantContactSpan.value, 512);
  assert.match(shader.fragmentShader, /plantContactUv = \(uv - uPlantContactOrigin\) \/ uPlantContactSpan/);
  assert.match(shader.fragmentShader, /plantContactBounds \* woodlandSurface/);
  const surface = shader.fragmentShader.match(/float woodlandSurface = [\s\S]*?;/)[0];
  assert.match(surface, /shore/); assert.match(surface, /rk/); assert.match(surface, /vRoadDist/);
  assert.match(shader.fragmentShader, /rootSnowBank \* 0\.012 - rootSnowPocket \* 0\.004\) \* winterAmount/);
  assert.match(shader.fragmentShader, /reflectedLight\.directDiffuse \*= 1\.0 - plantContact \* mix\(0\.22, 0\.10, winterAmount\)/);
  assert.match(shader.fragmentShader, /reflectedLight\.indirectDiffuse \*= 1\.0 - plantContact \* mix\(0\.30, 0\.14, winterAmount\)/);
  assert.equal(terrain.material.type, 'MeshStandardMaterial');
});

test('two-window input capacity exceeds the unrejected current candidate-lattice upper bound', async t => {
  const { terrain } = await fixture(t), radius = terrain.plantContact.radius - terrain.plantContact.texelSize;
  function bound(config, focusZ) {
    const perLayer = config.candidatesPerLayer ?? config.candidates;
    const dx = config.tile / config.columns, dz = config.tile / Math.ceil(perLayer / config.columns);
    let count = 0;
    for (let j = Math.floor((focusZ - radius) / dz); j <= Math.floor((focusZ + radius) / dz); j++) {
      for (let i = Math.floor(-radius / dx); i <= Math.floor(radius / dx); i++) {
        const x = Math.max(i * dx, Math.min(0, (i + 1) * dx));
        const z = Math.max(j * dz, Math.min(focusZ, (j + 1) * dz));
        if (x * x + (z - focusZ) ** 2 <= radius * radius) count += config.candidates / perLayer;
      }
    }
    return count;
  }
  const windows = Array.from({ length: 8 }, (_, i) => bound(POPULATION.tree, i * 16) + bound(POPULATION.shrub, i * 16));
  assert.equal(Math.max(...windows), 6908);
  assert.ok(terrain.plantContact.maxRecords >= 2 * Math.max(...windows));
});

test('terrain disposal releases the contact resource and pending updates cannot recreate it', async t => {
  const { terrain, tiles, advance } = await fixture(t);
  const records = Array.from({ length: 3000 }, (_, i) => root(`r${i}`, i % 30 + 0.5, Math.floor(i / 30) + 0.5));
  tiles.set('dense', entry('dense', records, [0, 0, 32, 120])); advance();
  let released = 0;
  terrain.plantContact.texture.addEventListener('dispose', () => released++);
  terrain.dispose(); terrain.dispose();
  assert.equal(released, 1);
  assert.equal(terrain.plantContact.pending, false);
  assert.equal(terrain.plantContact.texture.image.data, null);
  assert.equal(terrain._plantContactSelection, null);
  assert.equal(terrain._plantContactPendingTiles, null);
  advance();
  assert.equal(terrain.plantContact.texture.image.data, null);
});

test('three real seeded near-field populations fit the selection and raster contracts', async t => {
  const secondWorld = new World(12).build();
  for (const [sourceWorld, km] of [[world, 6], [world, 26], [secondWorld, 5.5]]) {
    const { terrain, tiles } = await fixture(t, sourceWorld);
    const focus = sourceWorld.route.at(sourceWorld.route.kmToS(km));
    const origin = terrain.plantContact.originForFocus(focus), radius = terrain.plantContact.radius;
    let inputRecords = 0;
    for (const kind of ['tree', 'shrub']) {
      const C = POPULATION[kind].tile;
      for (let j = Math.floor(origin.y / C); j <= Math.floor((origin.y + radius * 2) / C); j++) {
        for (let i = Math.floor(origin.x / C); i <= Math.floor((origin.x + radius * 2) / C); i++) {
          const iterator = generatePopulation(sourceWorld, kind, i, j);
          let result;
          do { result = iterator.next(); } while (!result.done);
          const key = `${kind}:${i}:${j}`, records = result.value;
          tiles.set(key, entry(key, records, [i * C, j * C, (i + 1) * C, (j + 1) * C], kind));
          inputRecords += records.length;
        }
      }
    }
    let frames = 0, maxSelection = 0, maxRaster = 0, maxPreparation = 0, maxCallMs = 0;
    do {
      const start = performance.now();
      terrain._frame++;
      terrain.updatePlantContact(tiles, focus.x, focus.z);
      maxCallMs = Math.max(maxCallMs, performance.now() - start);
      const work = terrain.plantContactStats().lastWork;
      maxSelection = Math.max(maxSelection, work.recordsVisited);
      maxRaster = Math.max(maxRaster, work.rasterChecks);
      maxPreparation = Math.max(maxPreparation, work.preparationRecords);
      assert.ok(++frames < 1000);
    } while (!terrain.plantContactReady);
    assert.ok(terrain.plantContact.activeCount > 0);
    assert.ok(terrain.plantContact.activeCount <= 6908);
    assert.ok(maxSelection <= 2048);
    assert.ok(maxRaster <= 16384);
    t.diagnostic(JSON.stringify({ seed: sourceWorld.seedInput, km, inputRecords,
      activeRoots: terrain.plantContact.activeCount, frames, maxSelection, maxRaster, maxPreparation,
      maxCpuCallMs: Math.round(maxCallMs * 100) / 100 }));
  }
});
