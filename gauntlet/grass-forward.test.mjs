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
const { GrassField, GRASS_RENDER_CELL, GRASS_DENSITY, grassDensityLimit } = await import('../src/vegetation/grassField.js');
const { InstanceCuller } = await import('../src/vegetation/instanceCulling.js');
const { VegetationSystem } = await import('../src/vegetation/system.js');
const { Scheduler } = await import('../src/streaming/scheduler.js');

function finish(iterator) {
  let step;
  do { step = iterator.next(); } while (!step.done);
  return step.value;
}
function records(n = 384) {
  return Array.from({ length: n }, (_, i) => ({ id: `grass:${i}`, x: i % 32 - 16, y: 0,
    z: -10 - Math.floor(i / 32) * 2, height: 0.6, width: 0.9, yaw: i * 0.01,
    surfaceY: 0.03, surfaceDx: 0.02, surfaceDz: -0.01,
    moisture: 0.6, cover: 0.2, clump: 0.9, phase: i * 0.3, rank: ((i * 37) % 997) / 997, roadDist: 9 }));
}

test('small render cells preserve every canonical root, identity and instance attribute', t => {
  const field = new GrassField(); t.after(() => field.dispose());
  const data = records(), [original] = field.build(data);
  const cells = finish(field.buildCellsSteps(data)), seen = new Set();
  assert.ok(cells.length > 1);
  for (const mesh of cells) {
    assert.equal(mesh.userData.batchCullOnly, true);
    const xs = [], zs = [];
    mesh.userData.population.ids.forEach((id, i) => {
      assert.ok(!seen.has(id)); seen.add(id);
      const index = data.findIndex(record => record.id === id);
      assert.deepEqual(mesh.instanceMatrix.array.slice(i * 16, (i + 1) * 16),
        original.instanceMatrix.array.slice(index * 16, (index + 1) * 16));
      for (const name of ['iGrassStyle', 'iGrassRoad', 'iGrassMaturity']) {
        const a = mesh.geometry.getAttribute(name), b = original.geometry.getAttribute(name), size = a.itemSize;
        assert.deepEqual(a.array.slice(i * size, (i + 1) * size), b.array.slice(index * size, (index + 1) * size));
      }
      xs.push(mesh.instanceMatrix.array[i * 16 + 12]); zs.push(mesh.instanceMatrix.array[i * 16 + 14]);
    });
    assert.ok(Math.max(...xs) - Math.min(...xs) < GRASS_RENDER_CELL);
    assert.ok(Math.max(...zs) - Math.min(...zs) < GRASS_RENDER_CELL);
  }
  assert.equal(seen.size, data.length);
});

test('cell culling reuses static buffers through driving and rejects cells behind the view', t => {
  const field = new GrassField(), culler = new InstanceCuller(), scene = new THREE.Scene();
  t.after(() => { culler.dispose(); field.dispose(); });
  const view = new THREE.PerspectiveCamera(54, 16 / 9, 0.1, 1000);
  const cells = finish(field.buildCellsSteps(records())); scene.add(...cells);
  const sources = cells.map(mesh => [mesh.geometry, mesh.instanceMatrix, mesh.instanceMatrix.version]);
  for (let frame = 0; frame < 30; frame++) {
    view.position.set(0, 1, -frame * 0.05); view.updateMatrixWorld();
    field.update(view, frame / 60, 'summer', 1080);
    culler.prepare(scene, view);
    assert.equal(culler._states.size, 0, 'static grass must not allocate packed instance copies');
    culler.restore();
    cells.forEach((mesh, i) => assert.deepEqual([mesh.geometry, mesh.instanceMatrix, mesh.instanceMatrix.version], sources[i]));
  }
  view.rotation.y = Math.PI; view.updateMatrixWorld();
  culler.prepare(scene, view);
  assert.ok(cells.every(mesh => !mesh.visible));
  culler.restore();
  assert.ok(cells.every(mesh => mesh.visible));
});

test('cancelling after a completed private cell releases both completed and partial meshes', t => {
  const field = new GrassField(); t.after(() => field.dispose());
  const iterator = field.buildCellsSteps(records());
  for (let i = 0; field.meshes.size < 2 && i < 1000; i++) assert.equal(iterator.next().done, false);
  assert.equal(field.meshes.size, 2);
  let disposed = 0;
  for (const mesh of field.meshes) mesh.addEventListener('dispose', () => disposed++);
  iterator.return(); iterator.return();
  assert.equal(disposed, 2);
  assert.equal(field.meshes.size, 0);
});

test('forward planning keeps all front cells and a rear turning guard without rerolling the grid', () => {
  const system = Object.assign(Object.create(VegetationSystem.prototype), {
    version: 0, world: {}, tiles: new Map(), cache: new Map(), cpuReady: new Map(), _builds: new Map(),
    scheduler: new Scheduler(), pool: { has: () => false, cancelExcept() {} },
    _signature: '', _grassView: { x: 0, z: 0, dx: 0, dz: -1 },
  });
  system._plan(0, 0);
  const grass = system._streamJobs.filter(job => job.kind === 'grass');
  assert.ok(grass.length < 225);
  for (let j = -7; j < 2; j++) for (let i = -7; i <= 7; i++) {
    assert.ok(system._streamWant.has(`veg:0:grass:${i}:${j}`));
  }
  assert.ok(!system._streamWant.has('veg:0:grass:0:7'));
  system._grassView.dz = 1;
  assert.equal(system._plan(0, 0), true, 'a camera-direction change replans even inside the same tile');
  assert.ok(system._streamWant.has('veg:0:grass:0:7'));
  assert.ok(!system._streamWant.has('veg:0:grass:0:-7'));
});

test('density LOD keeps near grass intact and submits a stable subset without buffer uploads', t => {
  const field = new GrassField(); t.after(() => field.dispose());
  const data = records(100).map((r, i) => ({ ...r, x: 1 + i % 10 * 0.1, z: -129 - Math.floor(i / 10) * 0.1, rank: i / 100 }));
  const [mesh] = finish(field.buildCellsSteps(data)); mesh.updateMatrixWorld();
  const view = new THREE.PerspectiveCamera(54, 16 / 9, 0.1, 1000);
  const matrix = mesh.instanceMatrix, copy = matrix.array.slice(), version = matrix.version;
  const canonical = mesh.count, selected = [];
  for (const z of [0, -20, -50, -80, -110]) {
    view.position.set(1, 0, z); view.updateMatrixWorld(); field.update(view, 0, 'summer', 1080);
    mesh.onBeforeRender(null, null, view, mesh.geometry);
    selected.push(mesh.count);
    mesh.onAfterRender();
    assert.equal(mesh.count, canonical);
    assert.equal(matrix.version, version);
    assert.deepEqual(matrix.array, copy);
  }
  assert.ok(selected[0] < canonical / 2);
  assert.equal(selected.at(-1), canonical);
  assert.deepEqual(selected, [...selected].sort((a, b) => a - b));
  for (const pixels of [0, 1, 8, 20, 40]) assert.equal(grassDensityLimit(pixels, 28), 1 + GRASS_DENSITY.transition);
  assert.equal(grassDensityLimit(0), GRASS_DENSITY.minimum);
});

test('CPU density prefix only omits shader-zero roots, including tilted and sheared cells', t => {
  const field = new GrassField(); t.after(() => field.dispose());
  const data = records().map(r => ({ ...r, z: r.z - 45, height: 0.2 + r.rank * 0.5 }));
  const cells = finish(field.buildCellsSteps(data));
  const view = new THREE.PerspectiveCamera(54, 16 / 9, 0.1, 1000);
  const root = new THREE.Vector3(), up = new THREE.Vector3(), transform = new THREE.Matrix4();
  for (const mesh of cells) {
    mesh.matrixAutoUpdate = false;
    mesh.matrix.set(1, 0.3, 0, 0, 0, 1, 0, 0, 0.2, 0, 1, 0, 0, 0, 0, 1);
    mesh.updateMatrixWorld(true);
    for (const z of [0, -20, -40]) {
      view.position.set(0, 2, z); view.updateMatrixWorld(); field.update(view, 0, 'summer', 1080);
      const count = mesh.count;
      mesh.onBeforeRender(null, null, view, mesh.geometry);
      const ranks = mesh.geometry.getAttribute('iGrassRank');
      for (let i = mesh.count; i < count; i++) {
        mesh.getMatrixAt(i, transform); transform.premultiply(mesh.matrixWorld);
        root.setFromMatrixPosition(transform); up.setFromMatrixColumn(transform, 1);
        const distance = root.distanceTo(view.position), pixels = up.length() * field.uniforms.uGrassFocalPixels.value / Math.max(distance, 1);
        assert.ok(ranks.getX(i) >= grassDensityLimit(pixels, distance), 'a nonzero blade was omitted');
      }
      mesh.onAfterRender();
    }
  }
});

test('culler restores canonical cell counts even if a render exits before onAfterRender', t => {
  const field = new GrassField(), culler = new InstanceCuller(), scene = new THREE.Scene();
  t.after(() => { culler.dispose(); field.dispose(); });
  const cells = finish(field.buildCellsSteps(records())); scene.add(...cells);
  const view = new THREE.PerspectiveCamera(54, 16 / 9, 0.1, 1000);
  culler.prepare(scene, view);
  const counts = cells.map(mesh => mesh.count);
  assert.ok(cells.every(mesh => mesh.frustumCulled === false));
  for (const mesh of cells) mesh.count = 0;
  culler.restore();
  assert.deepEqual(cells.map(mesh => mesh.count), counts);
  assert.ok(cells.every(mesh => mesh.frustumCulled === true));
});

test('grass guard jobs run ahead of distant woodland before entering the visible band', () => {
  const system = Object.create(VegetationSystem.prototype); system.version = 0;
  const prefetch = system._job('grass', 6, 0, 0, 0);
  const tree = system._job('tree', 1, 0, 0, 0);
  assert.ok(prefetch.d > 160);
  assert.ok(prefetch.priority < tree.priority);
});

test('the generic field kind argument cannot enable density on an unsorted legacy batch', t => {
  const field = new GrassField(); t.after(() => field.dispose());
  const [mesh] = finish(field.buildSteps(records(), 'grass'));
  assert.ok(mesh.geometry.getAttribute('iGrassRank').array.every(rank => rank === -1));
});
