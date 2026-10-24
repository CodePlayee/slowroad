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
const { Woodland } = await import('../src/vegetation/woodland.js');
const { Scheduler } = await import('../src/streaming/scheduler.js');
const { VEG: V } = await import('../src/vegetation/params.js');

function terrainFixture() {
  return {
    coverageRevision: 0, ready: false, calls: [],
    coversBounds(...bounds) { this.calls.push(bounds); return this.ready; },
    setReady(ready) { this.ready = ready; this.coverageRevision++; },
  };
}

function meshFor(job) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 1);
  const x = job.i * V.layers[job.layer].tile + 30;
  const z = job.j * V.layers[job.layer].tile + 30;
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(x, 0, z));
  if (job.layer === 'tree') mesh.userData.woodlandSource = {
    id: job.key, records: [{ x, y: 0, z, kind: 'pine', v: 0.5 }],
    matrices: mesh.instanceMatrix.array.slice(),
  };
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function vegetationFixture(terrain = null) {
  const vegetation = Object.assign(Object.create(Vegetation.prototype), {
    terrain, scheduler: new Scheduler(), group: new THREE.Group(), mat: {},
    tiles: new Map(), version: 0, study: true, windT: 0, _lastNow: 0,
    _treeRevision: 0, _coverageRevision: -1, _streamSignature: '',
    _streamJobs: [], _streamWant: new Set(),
    _retireQueue: [], _retireHead: 0, _retired: new Map(), _retireBudgetMs: 0.8,
    _buildGeometries() {},
    _buildTile(job) {
      const entry = { meshes: [meshFor(job)], job };
      this._setGroundReady(entry, this._groundReady(job));
      this.group.add(...entry.meshes);
      this.tiles.set(job.key, entry);
    },
  });
  return vegetation;
}

function woodlandFixture() {
  const woodland = Object.assign(Object.create(Woodland.prototype), {
    maxCount: 2, maxMidCount: 4, selected: [], signature: '', ready: true,
    lodLevels: new Map(), _viewDir: new THREE.Vector3(), camera: null, meshes: {},
  });
  for (const species of ['pine', 'oak']) {
    woodland.meshes[species] = {};
    for (const level of ['near', 'mid']) {
      woodland.meshes[species][level] = {};
      for (const part of ['bark', 'leaf']) {
        const material = new THREE.MeshStandardMaterial();
        material.userData.snow = { value: 0 };
        const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), material, 6);
        mesh.setColorAt(0, new THREE.Color());
        mesh.userData.fade = new Float32Array(6);
        mesh.geometry.setAttribute('iWoodlandFade', new THREE.InstancedBufferAttribute(mesh.userData.fade, 1));
        woodland.meshes[species][level][part] = mesh;
      }
    }
  }
  return woodland;
}

test('unsupported jobs wait outside the scheduler and retry at a stationary focus', () => {
  const terrain = terrainFixture(), vegetation = vegetationFixture(terrain);
  vegetation.update(0, 0);
  const signature = vegetation._streamSignature;
  assert.ok(vegetation.required > 0);
  assert.equal(vegetation.scheduler.pending, 0);
  const checks = terrain.calls.length;
  vegetation.update(0, 0);
  assert.equal(terrain.calls.length, checks, 'unchanged coverage should not be polled');
  assert.equal(vegetation.scheduler.pending, 0);
  terrain.setReady(true);
  vegetation.update(0, 0);
  assert.equal(vegetation._streamSignature, signature);
  assert.equal(vegetation.scheduler.pending, vegetation.required);
  assert.ok(vegetation.scheduler.tasks.every(job => job.priority >= 200000));
  assert.equal(vegetation.scheduler.drain(), true);
  assert.equal(vegetation.tiles.size, vegetation.required);
  assert.ok([...vegetation.tiles.values()].every(tile => tile.groundReady && tile.meshes.every(mesh => mesh.visible)));
});

test('every layer requires completed ground across its full padded footprint', () => {
  const terrain = terrainFixture(), vegetation = vegetationFixture(terrain);
  const expected = { grassNear: [8, 0], grassFar: [8, 1], shrub: [3, 1], tree: [30, 2], far: [30, 4] };
  for (const [layer, [pad, level]] of Object.entries(expected)) {
    const job = { layer, i: -2, j: 3 }, size = V.layers[layer].tile;
    assert.equal(vegetation._groundReady(job), false);
    assert.deepEqual(terrain.calls.at(-1), [-2 * size - pad, 3 * size - pad, -size + pad, 4 * size + pad, level]);
    assert.deepEqual(job.groundBounds, terrain.calls.at(-1).slice(0, 4));
  }
});

test('coverage loss hides tile meshes and woodland replacements before the frame renders', () => {
  const terrain = terrainFixture(), vegetation = vegetationFixture(terrain);
  vegetation.woodland = woodlandFixture();
  terrain.setReady(true);
  vegetation.update(0, 0);
  vegetation.scheduler.drain();
  vegetation.update(0, 0);
  assert.ok(vegetation.woodland.selected.length > 0);
  const selected = vegetation.woodland.selected.slice();
  const revision = vegetation._treeRevision;
  terrain.setReady(false);
  vegetation.update(0, 0);
  assert.equal(vegetation.woodland.selected.length, 0);
  assert.ok(vegetation._treeRevision > revision);
  assert.ok([...vegetation.tiles.values()].every(tile => !tile.groundReady && tile.meshes.every(mesh => !mesh.visible)));
  for (const { mesh } of selected) assert.deepEqual(mesh.instanceMatrix.array, mesh.userData.woodlandSource.matrices);
  for (const species of Object.values(vegetation.woodland.meshes)) {
    for (const level of Object.values(species)) for (const mesh of Object.values(level)) assert.equal(mesh.count, 0);
  }
  terrain.setReady(true);
  vegetation.update(0, 0);
  assert.ok(vegetation.woodland.selected.length > 0);
  assert.ok([...vegetation.tiles.values()].every(tile => tile.groundReady && tile.meshes.every(mesh => mesh.visible)));
});

test('unchanged readiness never rebuilds woodland buffers or changes shadow flags', () => {
  const terrain = terrainFixture(), vegetation = vegetationFixture(terrain);
  vegetation.woodland = woodlandFixture();
  terrain.setReady(true);
  vegetation.update(0, 0);
  vegetation.scheduler.drain();
  vegetation.update(0, 0);
  const selected = vegetation.woodland.selected;
  const revision = vegetation._treeRevision;
  const mesh = vegetation.woodland.meshes.pine.near.bark;
  const uploadVersion = mesh.instanceMatrix.version;
  for (let frame = 0; frame < 10; frame++) {
    terrain.coverageRevision++;
    vegetation.update(0, 0);
  }
  assert.equal(vegetation._treeRevision, revision);
  assert.strictEqual(vegetation.woodland.selected, selected);
  assert.equal(mesh.instanceMatrix.version, uploadVersion);
  for (const tile of vegetation.tiles.values()) for (const source of tile.meshes) {
    assert.equal(source.castShadow, true);
    assert.equal(source.receiveShadow, true);
  }
});

test('retired tiles restore their residency but stay hidden without supported ground', () => {
  const terrain = terrainFixture(), vegetation = vegetationFixture(terrain);
  terrain.setReady(true);
  vegetation.update(0, 0);
  vegetation.scheduler.drain();
  const [key, tile] = vegetation.tiles.entries().next().value;
  vegetation.tiles.delete(key);
  vegetation._retire(key, tile);
  // Preserve the deferred-disposal window while exercising the restoration path.
  vegetation._drainRetireQueue = () => {};
  terrain.setReady(false);
  vegetation.update(0, 0);
  assert.strictEqual(vegetation.tiles.get(key), tile);
  assert.equal(vegetation._retired.has(key), false);
  assert.equal(tile.groundReady, false);
  assert.ok(tile.meshes.every(mesh => !mesh.visible));
  terrain.setReady(true);
  vegetation.update(0, 0);
  assert.ok(tile.meshes.every(mesh => mesh.visible));
});

test('legacy callers without a Terrain still schedule and display all planned jobs', () => {
  const vegetation = vegetationFixture();
  vegetation.update(0, 0);
  assert.equal(vegetation.scheduler.pending, vegetation.required);
  vegetation.scheduler.drain();
  vegetation.update(0, 0);
  assert.equal(vegetation.tiles.size, vegetation.required);
  assert.ok([...vegetation.tiles.values()].every(tile => tile.groundReady && tile.meshes.every(mesh => mesh.visible)));
});

test('asset-triggered rebuilds reschedule supported tiles without moving the focus', () => {
  const terrain = terrainFixture(), vegetation = vegetationFixture(terrain);
  terrain.setReady(true);
  vegetation.update(0, 0);
  vegetation.scheduler.drain();
  vegetation.rebuildAll();
  assert.equal(vegetation.tiles.size, 0);
  vegetation.update(0, 0);
  assert.equal(vegetation.scheduler.pending, vegetation.required);
  vegetation.scheduler.drain();
  assert.equal(vegetation.tiles.size, vegetation.required);
});

test('production tile publication retains the job and rechecks ground after scheduling', () => {
  const terrain = terrainFixture(), vegetation = vegetationFixture(terrain);
  const geometry = new THREE.PlaneGeometry(1, 1);
  Object.assign(vegetation, {
    study: false, seed: 7,
    world: {
      hf: {},
      sample(x, z, out) { Object.assign(out, { y: 0, waterY: -10, moisture: 0.7, roadDist: 30 }); },
      slopeAt(x, z, y, e, out) { out.dx = out.dz = 0; return 0; },
    },
    atmo: { palette: { grassDry: [0.2, 0.3, 0.1], grassLush: [0.3, 0.4, 0.2] } },
    cover: () => 0.1, gust: () => 0, grassDensity: () => 1,
    mat: { curveGrass: new THREE.MeshStandardMaterial() }, geo: { grassNear: geometry },
  });
  const job = { key: 'test', layer: 'grassNear', i: 0, j: 0 };
  Vegetation.prototype._buildTile.call(vegetation, job);
  const tile = vegetation.tiles.get('test');
  assert.strictEqual(tile.job, job);
  assert.equal(tile.groundReady, false);
  assert.ok(tile.meshes.length > 0 && tile.meshes.every(mesh => !mesh.visible));
  terrain.setReady(true);
  vegetation._setGroundReady(tile, vegetation._groundReady(job));
  assert.ok(tile.meshes.every(mesh => mesh.visible));
});
