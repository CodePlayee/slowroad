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
const { ForestField, warmupFoliagePrograms } = await import('../src/vegetation/forestField.js');
const { impostorBounds } = await import('../src/vegetation/foliageAssets.js');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function assetsFixture() {
  const resources = [], counts = new Map(), templates = new Map();
  const own = resource => {
    resources.push(resource); counts.set(resource, 0);
    resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource) + 1));
    return resource;
  };
  for (const name of ['pine', 'oak', 'birch', 'aspen', 'maple', 'spruce', 'shrub-0', 'shrub-1']) {
    const bark = own(new THREE.BoxGeometry(0.08, 1, 0.08).translate(0, 0.5, 0));
    const leaf = own(new THREE.BoxGeometry(0.7, 0.6, 0.5).translate(0, 0.7, 0));
    const fern = name === 'shrub-1';
    const template = { name, kind: name.startsWith('shrub-') ? 'shrub' : 'tree',
      species: name.startsWith('shrub-') ? 'oak' : name, growthForm: fern ? 'fern' : 'woody',
      parts: { bark, leaf }, maps: { bark: fern ? null : own(new THREE.Texture()), leaf: fern ? null : own(new THREE.Texture()) },
      impostor: { shape: impostorBounds({ bark, leaf }), texture: own(new THREE.Texture()), normalTexture: own(new THREE.Texture()) } };
    if (fern) { template.heightScale = 0.68; template.tints = { bark: [0.26, 0.2, 0.055], leaf: [0.15, 0.3, 0.055] }; }
    templates.set(name, template);
  }
  let disposed = 0;
  return { templates, resources, counts, get disposed() { return disposed; },
    dispose() { disposed++; resources.forEach(resource => resource.dispose()); } };
}

function atmosphere() {
  const scene = new THREE.Scene(), registered = [], materialDisposals = new Map();
  scene.fog = new THREE.Fog(0x99aabb, 10, 1000);
  scene.add(new THREE.DirectionalLight(0xffffff, 1), new THREE.HemisphereLight(0xaabbcc, 0x334422, 0.8));
  return { scene, registered, materialDisposals,
    register(material) {
      registered.push(material); materialDisposals.set(material, 0);
      material.addEventListener('dispose', () => materialDisposals.set(material, materialDisposals.get(material) + 1));
    } };
}

function watchTemporaryMeshes(group) {
  const meshes = [...group.children], geometries = meshes.map(mesh => mesh.geometry);
  const disposals = new Map([...meshes, ...geometries].map(resource => [resource, 0]));
  for (const resource of disposals.keys()) resource.addEventListener('dispose', () => disposals.set(resource, disposals.get(resource) + 1));
  for (const geometry of geometries) geometry.addEventListener('dispose', () => {
    assert.deepEqual(Object.keys(geometry.attributes), ['iFoliage']);
    assert.equal(geometry.index, null, 'borrowed template indices must not be released');
  });
  return { meshes, geometries, disposals };
}

test('asset readiness waits for every real instanced foliage material compiled against live lights and fog', async (t) => {
  const assets = assetsFixture(), atmo = atmosphere(), started = deferred(), finish = deferred();
  let field, temporary, group;
  const children = [...atmo.scene.children], fog = atmo.scene.fog;
  const renderer = { compileAsync(object, camera, targetScene) {
    group = object; temporary = watchTemporaryMeshes(object);
    assert.equal(targetScene, atmo.scene); assert.equal(targetScene.fog, fog);
    assert.equal(object.parent, null); assert.equal(camera.isPerspectiveCamera, true);
    assert.equal(camera.layers.mask, 1);
    assert.equal(object.children.length, 24);
    assert.equal(field.assets, null); assert.equal(field.meshes.size, 0);
    assert.deepEqual(atmo.scene.children, children);
    const seen = new Set();
    for (const mesh of object.children) {
      const material = mesh.material, template = material.userData.foliageTemplate, part = material.userData.foliagePart;
      assert.equal(mesh.isInstancedMesh, true); assert.equal(mesh.count, 1);
      assert.equal(mesh.instanceColor, null); assert.equal(mesh.receiveShadow, false);
      assert.equal(mesh.castShadow, false);
      assert.equal(material, field.materials.get(template.name)[part]);
      assert.ok(atmo.registered.includes(material));
      assert.equal(mesh.geometry.getAttribute('iFoliage').isInstancedBufferAttribute, true);
      const source = part === 'impostor' ? field.billboards.get(template.name) : template.parts[part];
      assert.equal(mesh.geometry.getAttribute('position'), source.getAttribute('position'));
      assert.equal(mesh.geometry.index, source.index);
      seen.add(`${template.name}:${part}`);
    }
    assert.equal(seen.size, 24);
    started.resolve(); return finish.promise;
  } };
  field = new ForestField(atmo, renderer, { loadAssets: async () => assets });
  t.after(() => field.dispose());
  let ready = false; field.assetPromise.then(() => { ready = true; });
  await started.promise;
  assert.equal(ready, false);
  assert.deepEqual(field.build([{ species: 'pine', height: 10 }]), []);
  finish.resolve(); await field.assetPromise;
  assert.equal(ready, true); assert.equal(field.assets, assets); assert.equal(field.assetError, null);
  assert.equal(group.children.length, 0); assert.equal(field.meshes.size, 0);
  assert.ok([...temporary.disposals.values()].every(count => count === 1));
  assert.ok([...atmo.materialDisposals.values()].every(count => count === 0));
  assert.ok(assets.resources.every(resource => assets.counts.get(resource) === 0));
  assert.deepEqual(atmo.scene.children, children);
  field.dispose(); field.dispose();
  assert.equal(assets.disposed, 1);
  assert.ok([...atmo.materialDisposals.values()].every(count => count === 1));
  assert.ok(assets.resources.every(resource => assets.counts.get(resource) === 1));
});

test('dispose during compile keeps materials alive until the asynchronous program-readiness poll finishes', async () => {
  const assets = assetsFixture(), atmo = atmosphere(), started = deferred(), poll = deferred();
  let temporary, prematureDisposal = false;
  const renderer = { compileAsync(group) {
    temporary = watchTemporaryMeshes(group); started.resolve();
    return poll.promise.then(() => {
      prematureDisposal = [...atmo.materialDisposals.values()].some(count => count !== 0);
      if (prematureDisposal) throw new Error('currentProgram was deleted before isReady');
    });
  } };
  const field = new ForestField(atmo, renderer, { loadAssets: async () => assets });
  await started.promise;
  field.dispose(); field.dispose();
  assert.equal(field.disposed, true); assert.equal(field.assets, null);
  assert.equal(assets.disposed, 0);
  assert.ok([...temporary.disposals.values()].every(count => count === 0));
  assert.ok([...atmo.materialDisposals.values()].every(count => count === 0));
  poll.resolve(); await field.assetPromise;
  assert.equal(prematureDisposal, false);
  assert.equal(field.assets, null); assert.equal(field.assetError, null);
  assert.equal(field.materials.size, 0); assert.equal(field.billboards.size, 0); assert.equal(field.meshes.size, 0);
  assert.equal(assets.disposed, 1);
  assert.ok([...temporary.disposals.values()].every(count => count === 1));
  assert.ok([...atmo.materialDisposals.values()].every(count => count === 1));
});

for (const disposed of [false, true]) test(`compile rejection releases temporary and owned resources${disposed ? ' without reviving a disposed field' : ' and records the asset error'}`, async () => {
  const assets = assetsFixture(), atmo = atmosphere(), started = deferred(), compilation = deferred();
  let temporary;
  const renderer = { compileAsync(group) { temporary = watchTemporaryMeshes(group); started.resolve(); return compilation.promise; } };
  const field = new ForestField(atmo, renderer, { loadAssets: async () => assets });
  await started.promise;
  if (disposed) field.dispose();
  compilation.reject(new Error('synthetic shader compilation failure'));
  await field.assetPromise;
  assert.equal(field.assets, null); assert.equal(field.materials.size, 0); assert.equal(field.billboards.size, 0);
  if (disposed) assert.equal(field.assetError, null); else assert.match(field.assetError, /synthetic shader compilation failure/);
  assert.equal(assets.disposed, 1);
  assert.ok([...temporary.disposals.values()].every(count => count === 1));
  assert.ok([...atmo.materialDisposals.values()].every(count => count === 1));
  field.dispose(); assert.equal(assets.disposed, 1);
});

test('late successful loads and late failures cannot resurrect disposed foliage fields', async () => {
  const assets = assetsFixture(), atmo = atmosphere(), load = deferred();
  let compilations = 0;
  const renderer = { compileAsync() { compilations++; return Promise.resolve(); } };
  const field = new ForestField(atmo, renderer, { loadAssets: () => load.promise });
  field.dispose(); load.resolve(assets); await field.assetPromise;
  assert.equal(assets.disposed, 1); assert.equal(compilations, 0); assert.equal(atmo.registered.length, 0);
  assert.equal(field.assets, null); assert.equal(field.assetError, null);
  const failed = deferred(), other = new ForestField(atmosphere(), renderer, { loadAssets: () => failed.promise });
  other.dispose(); failed.reject(new Error('late asset failure')); await other.assetPromise;
  assert.equal(other.assetError, null); assert.equal(other.assets, null); assert.equal(compilations, 0);
});

test('mock renderers without compileAsync preserve asset readiness without invoking render or synchronous compile', async () => {
  const assets = assetsFixture(), atmo = atmosphere();
  const renderer = { render() { throw new Error('warmup must not render'); }, compile() { throw new Error('no synchronous compile fallback'); } };
  const field = new ForestField(atmo, renderer, { loadAssets: async () => assets });
  await field.assetPromise;
  assert.equal(field.assets, assets); assert.equal(field.assetError, null); assert.equal(field.meshes.size, 0);
  await warmupFoliagePrograms(undefined, undefined, assets.templates, new Map(), new Map());
  field.dispose(); assert.equal(assets.disposed, 1);
});

test('synchronous load and partial material setup failures release ownership and expose errors', async () => {
  const failed = new ForestField(atmosphere(), {}, { loadAssets() { throw new Error('synchronous load failure'); } });
  await failed.assetPromise;
  assert.match(failed.assetError, /synchronous load failure/); failed.dispose();
  const assets = assetsFixture(), atmo = atmosphere(), register = atmo.register;
  atmo.register = function(material) {
    register.call(this, material);
    if (this.registered.length === 2) throw new Error('material registration failure');
  };
  const field = new ForestField(atmo, {}, { loadAssets: async () => assets });
  await field.assetPromise;
  assert.match(field.assetError, /material registration failure/);
  assert.equal(field.assets, null); assert.equal(field.materials.size, 0); assert.equal(field.billboards.size, 0);
  assert.equal(assets.disposed, 1);
  assert.ok([...atmo.materialDisposals.values()].every(count => count === 1));
  field.dispose(); assert.equal(assets.disposed, 1);
});

test('synchronous compile failures still release temporary wrappers and never publish an asset', async () => {
  const assets = assetsFixture(), atmo = atmosphere();
  let temporary;
  const renderer = { compileAsync(group) {
    temporary = watchTemporaryMeshes(group);
    throw new Error('synchronous compile failure');
  } };
  const field = new ForestField(atmo, renderer, { loadAssets: async () => assets });
  await field.assetPromise;
  assert.match(field.assetError, /synchronous compile failure/);
  assert.equal(field.assets, null); assert.equal(field.meshes.size, 0);
  assert.ok([...temporary.disposals.values()].every(count => count === 1));
  assert.ok([...atmo.materialDisposals.values()].every(count => count === 1));
  assert.equal(assets.disposed, 1);
  field.dispose(); assert.equal(assets.disposed, 1);
});
