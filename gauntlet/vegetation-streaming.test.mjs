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
const { Vegetation } = await import('../src/vegetation/vegetation.js');
const { Scheduler } = await import('../src/streaming/scheduler.js');
const { VEG: V } = await import('../src/vegetation/params.js');
const { SEASONS } = await import('../src/atmosphere/params.js');

function fixture(t, study = true, understory = true) {
  const geometry = new THREE.PlaneGeometry(1, 2, 2, 2).translate(0, 1, 0);
  geometry.computeBoundingSphere();
  const geo = Object.fromEntries([
    'grassNear', 'grassFar', 'bush', 'bushDry', 'fern', 'tussock', 'plume',
    'spruce', 'fir', 'pine', 'oak', 'birch', 'maple', 'impConifer', 'impBroad',
  ].map(key => [key, geometry]));
  const mat = Object.fromEntries([
    'card', 'imp', 'curveGrass', 'meadowNear', 'meadowFar', 'flowerStem', 'flowerBlossom',
  ].map(key => {
    const material = new THREE.MeshBasicMaterial();
    material.name = key;
    return [key, material];
  }));
  const ground = (x, z) => 40 + x * 0.03 - z * 0.02;
  let samples = 0;
  const world = {
    sample(x, z, out) {
      samples++;
      Object.assign(out, { y: ground(x, z), waterY: -10, moisture: 0.7,
        roadDist: 80, riverDist: 1000, channelHalf: 10 });
    },
    slopeAt(x, z, y, e, out) { out.dx = 0.03; out.dz = -0.02; return 0.01; },
    hf: {
      ground,
      full(x, z, out) {
        samples++;
        Object.assign(out, { ground: ground(x, z), waterY: -10, moisture: 0.7, dist: 1000, channelHalf: 10 });
        return out;
      },
    },
  };
  const vegetation = Object.assign(Object.create(Vegetation.prototype), {
    version: 0, seed: 7, study, world, atmo: { palette: SEASONS.summer },
    group: new THREE.Group(), tiles: new Map(), scheduler: new Scheduler(1),
    _treeRevision: 0, _coverageRevision: -1, _lastNow: 0, windT: 0,
    _streamSignature: '', _streamJobs: [], _streamWant: new Set(), _builds: new Map(),
    _retireQueue: [], _retireHead: 0, _retired: new Map(), _retireBudgetMs: 0.8,
    cover: () => 0.7, gust: () => 0.2, grassDensity: () => 1, shrubDensity: () => 1, treeDensity: () => 1,
    geo, mat, flower: { stem: geometry, blossom: geometry },
    understory: understory ? {
      templates: [{ bark: geometry, leaf: geometry }, { bark: geometry, leaf: geometry }],
      materials: { bark: mat.card, leaf: mat.card },
    } : null,
    impostor: { uv: Array.from({ length: 12 }, (_, i) => [i / 12, 0, 1 / 12, 1]) },
    impCell: { spruce: 0, fir: 2, pine: 4, oak: 6, birch: 8, maple: 10 },
    _buildGeometries() {},
  });
  t.after(() => {
    vegetation._cancelBuilds(() => true);
    for (const tile of vegetation.tiles.values()) vegetation._dispose(tile);
    for (const material of Object.values(mat)) material.dispose();
    geometry.dispose();
  });
  return { vegetation, geometry, get samples() { return samples; } };
}

function job(layer = 'grassNear', i = 0, j = 0, version = 0) {
  return { key: `veg:${version}:${layer}:${i}:${j}`, layer, i, j, d: 0 };
}

function enqueue(vegetation, request) {
  vegetation._streamWant.add(request.key);
  const advance = vegetation._buildTask(request);
  vegetation.scheduler.push(request.key, 0, advance);
  return advance;
}

function snapshot(vegetation, key) {
  return vegetation.tiles.get(key).meshes.map(mesh => ({
    count: mesh.count, matrix: mesh.instanceMatrix.array.slice(),
    color: mesh.instanceColor?.array.slice(),
    attributes: Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([name, attr]) => [name, attr.array.slice()])),
    indices: mesh.geometry.index.array.slice(),
    sphere: { center: mesh.boundingSphere.center.toArray(), radius: mesh.boundingSphere.radius },
    material: mesh.material.name, castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow,
    records: mesh.userData.woodlandSource?.records,
  }));
}

function observeInstances(t) {
  const meshes = new Set();
  const original = THREE.InstancedMesh.prototype.setMatrixAt;
  t.mock.method(THREE.InstancedMesh.prototype, 'setMatrixAt', function (index, matrix) {
    meshes.add(this);
    return original.call(this, index, matrix);
  });
  return meshes;
}

function advanceUntilMesh(vegetation, meshes) {
  for (let i = 0; i < 1000 && meshes.size === 0; i++) vegetation.scheduler.run(0);
  assert.ok(meshes.size > 0, 'fixture never reached incremental instance population');
  assert.equal(vegetation.group.children.length, 0);
  assert.equal(vegetation.tiles.size, 0);
}

test('incremental and synchronous tiles preserve all buffers, colors, bounds, and RNG-dependent records', (t) => {
  for (const study of [true, false]) {
    for (const layer of ['grassNear', 'grassFar', 'shrub', 'tree', 'far']) {
      const a = fixture(t, study), b = fixture(t, study);
      const request = job(layer, -1, 2);
      a.vegetation._buildTile(request);
      const iterator = b.vegetation._buildTileSteps(request);
      let slices = 0;
      while (true) {
        const step = iterator.next();
        if (step.done) break;
        slices++;
        assert.equal(b.vegetation.group.children.length, 0, 'partial meshes leaked into the scene');
        assert.equal(b.vegetation.tiles.size, 0, 'partial tiles must not count as resident');
      }
      assert.ok(slices >= Math.floor((V.layers[layer].perTile - 1) / 16));
      assert.deepEqual(snapshot(a.vegetation, request.key), snapshot(b.vegetation, request.key), `${study}/${layer}`);
      for (const mesh of b.vegetation.tiles.get(request.key).meshes) {
        const actual = mesh.boundingSphere.clone();
        mesh.computeBoundingSphere();
        assert.deepEqual(mesh.boundingSphere, actual, 'sliced bounds differ from Three.js');
      }
    }
  }
});

test('sampler and instance construction yield separately while the scheduler retains the tile key', (t) => {
  const fx = fixture(t), { vegetation } = fx, meshes = observeInstances(t), request = job();
  enqueue(vegetation, request);
  let slices = 0, instanceSlices = 0;
  while (vegetation.scheduler.pending && slices++ < 1000) {
    const before = fx.samples;
    vegetation.scheduler.run(0);
    assert.ok(fx.samples - before <= 16, 'a sampling continuation exceeds its seed batch');
    assert.equal(vegetation.scheduler.error, null);
    if (vegetation.scheduler.pending) {
      assert.equal(vegetation.scheduler.has(request.key), true);
      assert.equal(vegetation.group.children.length, 0);
      assert.equal(vegetation.tiles.size, 0);
      if (meshes.size) instanceSlices++;
    }
  }
  assert.ok(slices > V.layers.grassNear.perTile / 16);
  assert.ok(instanceSlices > 5, 'instance matrices and bounds were not split across slices');
  assert.equal(vegetation.scheduler.pending, 0);
  assert.equal(vegetation._builds.size, 0);
  assert.equal(vegetation.tiles.size, 1);
});

test('fully rejected candidates still yield at the seed boundary', (t) => {
  const { vegetation } = fixture(t);
  vegetation.cover = () => 0;
  const request = job('far'), iterator = vegetation._buildTileSteps(request);
  let slices = 0;
  while (!iterator.next().done) slices++;
  assert.equal(slices, Math.floor((V.layers.far.perTile - 1) / 16));
  assert.deepEqual(vegetation.tiles.get(request.key).meshes, []);
});

test('interleaved build iterators do not change independent tile layouts', (t) => {
  const { vegetation: expected } = fixture(t), { vegetation: actual } = fixture(t);
  const requests = [job('grassNear', 0, 0), job('shrub', 1, -1), job('tree', -1, -1)];
  for (const request of requests) expected._buildTile(request);
  const iterators = requests.map(request => actual._buildTileSteps(request));
  for (let n = 0; n < 1000 && iterators.length; n++) {
    for (let i = iterators.length - 1; i >= 0; i--) if (iterators[i].next().done) iterators.splice(i, 1);
  }
  assert.equal(iterators.length, 0);
  for (const request of requests) assert.deepEqual(snapshot(actual, request.key), snapshot(expected, request.key));
});

for (const reason of ['version', 'seed', 'world', 'request']) {
  test(`${reason} invalidation closes a partial build without releasing shared template buffers`, (t) => {
    const { vegetation, geometry } = fixture(t), meshes = observeInstances(t), request = job();
    enqueue(vegetation, request);
    advanceUntilMesh(vegetation, meshes);
    const position = geometry.getAttribute('position'), index = geometry.index;
    let wrappersDisposed = 0, instancesDisposed = 0, templatesDisposed = 0;
    geometry.addEventListener('dispose', () => templatesDisposed++);
    for (const mesh of meshes) {
      mesh.geometry.addEventListener('dispose', () => wrappersDisposed++);
      mesh.addEventListener('dispose', () => instancesDisposed++);
    }
    if (reason === 'version') vegetation.version++;
    else if (reason === 'seed') vegetation.seed++;
    else if (reason === 'world') vegetation.world = { ...vegetation.world };
    else vegetation._streamWant.delete(request.key);
    vegetation.scheduler.run(0);
    assert.equal(wrappersDisposed, meshes.size);
    assert.equal(instancesDisposed, meshes.size);
    assert.equal(templatesDisposed, 0);
    assert.equal(geometry.getAttribute('position'), position);
    assert.equal(geometry.index, index);
    assert.equal(vegetation.tiles.size, 0);
    assert.equal(vegetation.group.children.length, 0);
    assert.equal(vegetation._builds.size, 0);
    assert.equal(vegetation.scheduler.pending, 0);
  });
}

test('moving away cancels partial resources immediately instead of waiting for a dropped callback', (t) => {
  const { vegetation } = fixture(t), meshes = observeInstances(t), request = job();
  const oldAdvance = enqueue(vegetation, request);
  advanceUntilMesh(vegetation, meshes);
  let disposed = 0;
  for (const mesh of meshes) mesh.addEventListener('dispose', () => disposed++);
  vegetation.update(1e6, -1e6);
  assert.equal(disposed, meshes.size);
  assert.equal(vegetation.scheduler.has(request.key), false);
  assert.equal(vegetation._builds.has(request.key), false);
  assert.equal(oldAdvance(), undefined);
  assert.equal(vegetation.tiles.has(request.key), false);
});

test('asset rebuild closes partial iterators before replacing templates and cannot revive stale work', (t) => {
  const { vegetation } = fixture(t), meshes = observeInstances(t), request = job();
  const oldAdvance = enqueue(vegetation, request);
  advanceUntilMesh(vegetation, meshes);
  let disposed = 0;
  for (const mesh of meshes) mesh.addEventListener('dispose', () => disposed++);
  vegetation._buildGeometries = () => assert.equal(disposed, meshes.size);
  vegetation.rebuildAll();
  assert.equal(vegetation.version, 1);
  assert.equal(vegetation.scheduler.pending, 0);
  assert.equal(vegetation._builds.size, 0);
  assert.equal(vegetation.tiles.size, 0);
  assert.equal(oldAdvance(), undefined);
  assert.equal(disposed, meshes.size);
});

test('returning a raw build iterator releases pending wrappers without publishing', (t) => {
  const { vegetation } = fixture(t), meshes = observeInstances(t);
  const iterator = vegetation._buildTileSteps(job());
  for (let n = 0; n < 1000 && meshes.size === 0; n++) assert.equal(iterator.next().done, false);
  let disposed = 0;
  for (const mesh of meshes) mesh.addEventListener('dispose', () => disposed++);
  iterator.return();
  assert.equal(disposed, meshes.size);
  assert.equal(vegetation.group.children.length, 0);
  assert.equal(vegetation.tiles.size, 0);
});

test('a failed matrix population disposes partial instances exactly once', (t) => {
  const { vegetation } = fixture(t), meshes = observeInstances(t), request = job();
  let tints = 0;
  const original = vegetation._foliageTint;
  vegetation._foliageTint = function (...args) {
    if (++tints > 128) throw new Error('synthetic tint failure');
    return original.apply(this, args);
  };
  let advance = enqueue(vegetation, request);
  while (meshes.size === 0) advance = advance();
  let disposed = 0;
  for (const mesh of meshes) mesh.addEventListener('dispose', () => disposed++);
  assert.throws(() => advance(), /synthetic tint failure/);
  assert.equal(disposed, meshes.size);
  assert.equal(vegetation._builds.size, 0);
  assert.equal(vegetation.group.children.length, 0);
  assert.equal(vegetation.tiles.size, 0);
});
