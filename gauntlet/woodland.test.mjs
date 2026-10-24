import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as THREE from 'three';
import { plantVariantQuery } from './plant-variant.mjs';

const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true }
    : next(url, context);
} });
const { decodeWoodland, selectWoodland, Woodland, resolveLodLevel } = await import('../src/vegetation/woodland.js');
const { buildTuftGeometry } = await import('../src/vegetation/tuftGrass.js');
const { Scheduler } = await import('../src/streaming/scheduler.js');
const { SEASON_HOOKS } = await import('../src/vegetation/params.js');
const manifest = JSON.parse(readFileSync(new URL('../public/models/woodland/trees.manifest.json', import.meta.url)));
const raw = readFileSync(new URL('../public/models/woodland/trees.bin', import.meta.url));
const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

// Exercise the production loader without a browser: geometry and manifest are real
// baked assets, while TextureLoader is replaced with a disposable in-memory texture.
async function loadedWoodland() {
  const previousFetch = globalThis.fetch;
  const previousLoadAsync = THREE.TextureLoader.prototype.loadAsync;
  globalThis.fetch = async (url) => {
    const file = String(url).replace('/models/woodland/', '');
    if (file === 'trees.manifest.json') return { ok: true, json: async () => manifest };
    if (file === manifest.buffer) return { ok: true, arrayBuffer: async () => buffer.slice(0) };
    throw new Error(`Unexpected woodland test fetch: ${url}`);
  };
  THREE.TextureLoader.prototype.loadAsync = async () => new THREE.Texture();
  const parent = new THREE.Group();
  try {
    const woodland = new Woodland(parent, { register() {} });
    await woodland.assetPromise;
    assert.equal(woodland.error, null);
    return { woodland, parent };
  } finally {
    globalThis.fetch = previousFetch;
    THREE.TextureLoader.prototype.loadAsync = previousLoadAsync;
  }
}

function sourceRecords(records, id = 'test') {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), records.length);
  records.forEach((record, index) => mesh.setMatrixAt(index, new THREE.Matrix4().makeTranslation(record.x, record.y, record.z)));
  mesh.userData.woodlandSource = { id, records, matrices: mesh.instanceMatrix.array.slice() };
  return mesh;
}

test('baked trees preserve the trunk origin, canopy volume, and valid indices', () => {
  const data = decodeWoodland(manifest, buffer);
  for (const [species, levels] of Object.entries(data)) for (const [level, parts] of Object.entries(levels)) {
    const { bark, leaf } = parts;
    assert.ok(Math.abs(bark.boundingBox.min.y) < 1e-5);
    assert.ok(bark.boundingBox.min.x < 0 && bark.boundingBox.max.x > 0);
    assert.ok(bark.boundingBox.min.z < 0 && bark.boundingBox.max.z > 0);
    assert.ok(Math.abs(Math.max(bark.boundingBox.max.y, leaf.boundingBox.max.y) - 1) < 1e-5);
    const count = (bark.index.count + leaf.index.count) / 3;
    assert.equal(count, manifest.trees[species][level].triangles);
    assert.ok(count >= (level === 'near' ? 8000 : 1500) && count <= (level === 'near' ? 20000 : 4000));
    assert.ok(leaf.boundingBox.max.x - leaf.boundingBox.min.x > 0.45);
    const position = bark.getAttribute('position');
    let x = 0, z = 0, n = 0;
    for (let i = 0; i < position.count; i++) if (position.getY(i) < 1e-5) { x += position.getX(i); z += position.getZ(i); n++; }
    assert.ok(n > 0 && Math.hypot(x / n, z / n) < 0.03, `${species}/${level} trunk moved away from root`);
  }
  assert.throws(() => decodeWoodland(manifest, buffer.slice(0, 32)), /Invalid woodland buffer/);
});

function source() {
  const records = [{ x: 1, y: 0, z: 0, kind: 'pine', v: 0.5 }, { x: 100, y: 0, z: 0, kind: 'oak', v: 0.5 }];
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), records.length);
  records.forEach((r, i) => mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(r.x, r.y, r.z)));
  mesh.userData.woodlandSource = { id: 'test', records, matrices: mesh.instanceMatrix.array.slice() };
  return mesh;
}

test('near-tree replacement is bounded and restores the exact old instances on movement/reset', () => {
  const mesh = source(), sources = [mesh];
  assert.equal(selectWoodland(sources, 0, 0, 1)[0].index, 0);
  assert.equal(selectWoodland(sources, 100, 0, 1)[0].index, 1);
  const overlap = selectWoodland(sources, 150, 0, 8, 170, 8, 500);
  assert.ok(overlap.some(item => item.level === 'near') && overlap.some(item => item.level === 'mid'));
  const woodland = Object.create(Woodland.prototype);
  woodland.maxCount = 1; woodland.maxMidCount = 0; woodland.selected = []; woodland.signature = ''; woodland.ready = true;
  woodland.lodLevels = new Map(); woodland._viewDir = new THREE.Vector3(); woodland.camera = null;
  woodland.meshes = {};
  for (const species of ['pine', 'oak']) {
    woodland.meshes[species] = {};
    for (const level of ['near', 'mid']) {
      woodland.meshes[species][level] = {};
      for (const part of ['bark', 'leaf']) {
      const material = new THREE.MeshStandardMaterial(); material.userData.snow = { value: 0 };
      const batch = new THREE.InstancedMesh(new THREE.BoxGeometry(), material, 1);
      batch.setColorAt(0, new THREE.Color());
      batch.userData.fade = new Float32Array(1);
      batch.geometry.setAttribute('iWoodlandFade', new THREE.InstancedBufferAttribute(batch.userData.fade, 1));
      woodland.meshes[species][level][part] = batch;
      }
    }
  }
  const tiles = new Map([['test', { meshes: [mesh] }]]);
  woodland.sync(tiles, 0, 0, 1, SEASON_HOOKS.summer);
  assert.equal(woodland.selected[0].index, 0);
  assert.equal(mesh.instanceMatrix.array[12], 1e8);
  woodland.sync(tiles, 100, 0, 1, SEASON_HOOKS.winter);
  assert.equal(mesh.instanceMatrix.array[12], 1);
  assert.equal(mesh.instanceMatrix.array[28], 1e8);
  assert.equal(woodland.meshes.oak.near.leaf.count, 0);
  woodland.clear();
  assert.deepEqual(mesh.instanceMatrix.array, mesh.userData.woodlandSource.matrices);
  assert.equal(woodland.selected.length, 0);
});

test('visible woodland levels retain identical crowns with independent instance attributes', async () => {
  const { woodland: w } = await loadedWoodland();
  try {
    for (const species of ['pine', 'oak']) for (const part of ['bark', 'leaf']) {
      const near = w.meshes[species].near[part], mid = w.meshes[species].mid[part];
      assert.deepEqual(mid.geometry.getAttribute('position').array, near.geometry.getAttribute('position').array);
      assert.deepEqual(mid.geometry.index.array, near.geometry.index.array);
      assert.notStrictEqual(mid.geometry, near.geometry);
      assert.notStrictEqual(mid.geometry.getAttribute('iWoodlandFade').array, near.geometry.getAttribute('iWoodlandFade').array);
    }
  } finally { w.dispose(); }
});

test('production woodland sync is idempotent across paused frames', async () => {
  const { woodland } = await loadedWoodland();
  const mesh = sourceRecords([{ x: 170, y: 0, z: 0, kind: 'pine', v: 0.5 }]);
  const tiles = new Map([['test', { meshes: [mesh] }]]);
  try {
    woodland.sync(tiles, 0, 0, 1, SEASON_HOOKS.summer);
    const first = woodland.selected[0];
    const firstFade = first.targets.leaf.userData.fade[first.slots.leaf];
    const firstLevel = first.level;
    woodland.sync(tiles, 0, 0, 1, SEASON_HOOKS.summer);
    const second = woodland.selected[0];
    assert.equal(second.level, firstLevel);
    assert.equal(second.targets.leaf.userData.fade[second.slots.leaf], firstFade);
    assert.equal(firstFade, 1);
  } finally {
    woodland.dispose();
  }
});

test('an in-view tree keeps its LOD and opaque fade while crossing distance bands', async () => {
  const { woodland } = await loadedWoodland();
  const mesh = sourceRecords([{ x: 100, y: 0, z: 0, kind: 'pine', v: 0.5 }]);
  const tiles = new Map([['test', { meshes: [mesh] }]]);
  woodland.setCamera({
    position: new THREE.Vector3(200, 0, 0),
    getWorldDirection(direction) { direction.set(-1, 0, 0); },
  });
  try {
    woodland.sync(tiles, 0, 0, 1, SEASON_HOOKS.summer);
    woodland.sync(tiles, 400, 0, 1, SEASON_HOOKS.summer);
    const crossed = woodland.selected[0];
    assert.equal(crossed.level, 'near');
    assert.equal(crossed.targets.leaf.userData.fade[crossed.slots.leaf], 1);
    woodland.sync(tiles, 400, 0, 1, SEASON_HOOKS.summer);
    const paused = woodland.selected[0];
    assert.equal(paused.level, 'near');
    assert.equal(paused.targets.leaf.userData.fade[paused.slots.leaf], 1);
  } finally {
    woodland.dispose();
  }
});

test('production instance capacity covers 65 near-locked trees after a cross-layer move', async () => {
  const { woodland } = await loadedWoodland();
  const records = Array.from({ length: 64 }, () => ({ x: 0, y: 0, z: 0, kind: 'pine', v: 0.5 }));
  records.push({ x: 600, y: 0, z: 0, kind: 'pine', v: 0.5 });
  const mesh = sourceRecords(records, 'capacity');
  const tiles = new Map([['capacity', { meshes: [mesh] }]]);
  woodland.setCamera({
    position: new THREE.Vector3(0, 0, 0),
    getWorldDirection(direction) { direction.set(1, 0, 0); },
  });
  try {
    woodland.sync(tiles, 0, 0, 1, SEASON_HOOKS.summer);
    woodland.camera.position.set(300, 0, 0);
    woodland.camera.getWorldDirection = (direction) => direction.set(-1, 0, 0);
    woodland.sync(tiles, 500, 0, 1, SEASON_HOOKS.summer);
    const near = woodland.meshes.pine.near.bark;
    const selectedNear = woodland.selected.filter(item => item.level === 'near');
    assert.equal(selectedNear.length, 65);
    assert.equal(near.instanceMatrix.count, woodland.maxCount + woodland.maxMidCount);
    assert.ok(near.instanceMatrix.count >= near.count);
    assert.ok(selectedNear.every(item => item.slots.bark < near.instanceMatrix.count));
  } finally {
    woodland.dispose();
  }
});

test('tufts have independent roots and non-degenerate blades instead of co-located planes', () => {
  for (const [blades, segments] of [[8, 3], [4, 2]]) {
    const geometry = buildTuftGeometry(blades, segments);
    const p = geometry.getAttribute('position'), indices = geometry.index.array;
    assert.equal(indices.length / 3, blades * 2 * (2 * segments - 1));
    assert.ok(Math.abs(geometry.boundingBox.min.y) < 1e-6);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < indices.length; i += 3) {
      a.fromBufferAttribute(p, indices[i]); b.fromBufferAttribute(p, indices[i + 1]); c.fromBufferAttribute(p, indices[i + 2]);
      assert.ok(b.sub(a).cross(c.sub(a)).lengthSq() > 1e-12);
    }
    assert.ok(new Set(Array.from({ length: blades }, (_, b) => p.getX(b * (segments * 2 + 1)))).size > 3);
  }
});

test('experimental variants cannot change the frozen camera/time/season fixture', () => {
  const query = 'seed=7&t=12&season=summer&cam=chase&km=6.0';
  const result = new URLSearchParams(plantVariantQuery(query, 'study'));
  for (const [k, v] of new URLSearchParams(query)) assert.equal(result.get(k), v);
  assert.equal(result.get('plants'), 'study');
  assert.throws(() => plantVariantQuery(query, 'cinematic'), /Invalid GAUNTLET_PLANTS/);
});

test('LOD level cannot change while the tree is in the camera view', () => {
  assert.equal(resolveLodLevel(180, 'near', true), 'near');
  assert.equal(resolveLodLevel(260, 'near', true), 'near');
  assert.equal(resolveLodLevel(260, 'near', false), 'mid');
  assert.equal(resolveLodLevel(110, 'mid', true), 'mid');
  assert.equal(resolveLodLevel(110, 'mid', false), 'near');
  assert.equal(resolveLodLevel(170, undefined, false), 'mid');
});

test('a failed geometry task leaves an explicit error instead of a 150-second readiness hang', () => {
  const scheduler = new Scheduler();
  scheduler.push('veg:missing', 0, () => { throw new Error('Missing tree geometry'); });
  const previous = console.error; console.error = () => {};
  try { scheduler.run(); } finally { console.error = previous; }
  assert.match(scheduler.error, /veg:missing: Missing tree geometry/);
  scheduler.clear(); assert.equal(scheduler.error, null);
});

test('a failed woodland load releases all partially created assets', async () => {
  let disposed = 0;
  class FailedLoad extends Woodland {
    async load() {
      const geometry = new THREE.BoxGeometry();
      const texture = new THREE.Texture();
      for (const resource of [geometry, texture]) {
        resource.addEventListener('dispose', () => disposed++);
        this.resources.add(resource);
      }
      this.group.add(new THREE.Object3D());
      await Promise.resolve();
      throw new Error('texture unavailable');
    }
  }
  const parent = new THREE.Group();
  const woodland = new FailedLoad(parent, {});
  await woodland.assetPromise;
  assert.equal(disposed, 2);
  assert.equal(woodland.resources.size, 0);
  assert.equal(parent.children.length, 0);
  assert.equal(woodland.ready, false);
  assert.match(woodland.error, /texture unavailable/);
  woodland.dispose(); assert.equal(disposed, 2);
});
