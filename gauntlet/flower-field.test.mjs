import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true }
    : next(url, context);
} });
const { FlowerField } = await import('../src/vegetation/flowerField.js');
const { InstanceCuller } = await import('../src/vegetation/instanceCulling.js');

function sourceScene() {
  const scene = new THREE.Group();
  const texture = new THREE.Texture(), material = new THREE.MeshStandardMaterial({ map: texture });
  const stem = new THREE.BoxGeometry(0.1, 1, 0.1).translate(0, 0.5, 0);
  const blossom = new THREE.BoxGeometry(0.3, 0.2, 0.3).translate(0, 1, 0);
  for (const [name, geometry] of Object.entries({ Stem: stem, Blossom: blossom })) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    scene.add(mesh);
  }
  const resources = [texture, material, stem, blossom], counts = new Map();
  for (const resource of resources) {
    counts.set(resource, 0);
    resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource) + 1));
  }
  return { gltf: { scene, scenes: [scene] }, resources, counts };
}

function fixture(t) {
  let resolve, reject;
  t.mock.method(GLTFLoader.prototype, 'loadAsync', () => new Promise((yes, no) => { resolve = yes; reject = no; }));
  const field = new FlowerField({ register() {} });
  t.after(() => field.dispose());
  return { field, resolve, reject };
}

const records = [{ id: 'grass:flower', x: 2, y: 3, z: -10, height: 0.8, yaw: 0.4, rank: 0.01, cover: 0.2, variant: 0 }];

test('late flower assets are released without resurrecting a disposed field', async (t) => {
  const { field, resolve } = fixture(t), source = sourceScene();
  field.dispose();
  resolve(source.gltf);
  await field.assetPromise;
  assert.equal(field.geometry, null);
  assert.equal(field.meshes.size, 0);
  assert.deepEqual(field.build(records), []);
  assert.ok(source.resources.every(resource => source.counts.get(resource) === 1));
});

test('successful flower loads retain independent templates and dispose loader-owned resources once', async (t) => {
  const { field, resolve } = fixture(t), source = sourceScene();
  resolve(source.gltf);
  await field.assetPromise;
  assert.equal(field.assetError, null);
  assert.ok(source.resources.every(resource => source.counts.get(resource) === 1));
  assert.notStrictEqual(field.geometry.stem.getAttribute('position'), source.gltf.scene.children[0].geometry.getAttribute('position'));
  const meshes = field.build(records);
  assert.equal(meshes.length, 2);
  assert.ok(meshes.every(mesh => mesh.userData.population.ids[0] === 'grass:flower:flower'));
  assert.ok(meshes.every(mesh => Number.isFinite(mesh.boundingSphere.radius)));
});

test('flower surface placement changes only root height and preserves legacy transforms, colors and IDs', async t => {
  const { field, resolve } = fixture(t), source = sourceScene();
  resolve(source.gltf); await field.assetPromise;
  const population = [
    Object.freeze({ ...records[0], id: 'cut', surfaceY: records[0].y + 0.77 }),
    Object.freeze({ ...records[0], id: 'fill', x: 4, surfaceY: records[0].y - 0.77 }),
    Object.freeze({ ...records[0], id: 'zero', x: 6, surfaceY: 0 }),
    Object.freeze({ ...records[0], id: 'legacy', x: 8 }),
    Object.freeze({ ...records[0], id: 'null', x: 10, surfaceY: null }),
  ];
  const snapshot = structuredClone(population), actual = field.build(population);
  const legacy = field.build(population.map(({ surfaceY, ...record }) => record));
  const matrix = new THREE.Matrix4(), point = new THREE.Vector3();
  for (let part = 0; part < actual.length; part++) {
    const mesh = actual[part], positions = mesh.geometry.getAttribute('position');
    assert.deepEqual(mesh.instanceColor.array, legacy[part].instanceColor.array);
    assert.deepEqual(mesh.userData.population.ids, legacy[part].userData.population.ids);
    for (let i = 0; i < population.length; i++) {
      const expectedY = population[i].surfaceY ?? population[i].y;
      mesh.getMatrixAt(i, matrix);
      assert.ok(Math.abs(matrix.elements[13] - expectedY) < 1e-6);
      for (let j = 0; j < 16; j++) if (j !== 13) assert.equal(mesh.instanceMatrix.array[i * 16 + j], legacy[part].instanceMatrix.array[i * 16 + j],
        'surface grounding must not change authored flower posture or scale');
      for (let vertex = 0; vertex < positions.count; vertex++) {
        point.fromBufferAttribute(positions, vertex).applyMatrix4(matrix);
        assert.ok(mesh.boundingSphere.distanceToPoint(point) <= 1e-6);
      }
    }
  }
  assert.deepEqual(actual[0].instanceMatrix.array, actual[1].instanceMatrix.array);
  assert.deepEqual(population, snapshot);
});

test('flower CPU distance agrees with shader surface roots and world-space camera parents', async t => {
  const { field, resolve } = fixture(t), source = sourceScene();
  resolve(source.gltf); await field.assetPromise;
  const population = [{ ...records[0], x: 0, y: 0, z: 0, surfaceY: 0.77 }], meshes = field.build(population);
  const camera = new THREE.PerspectiveCamera(54), matrix = new THREE.Matrix4(), root = new THREE.Vector3();
  camera.position.set(0, 0, 72.007); camera.updateMatrixWorld();
  for (const mesh of meshes) {
    mesh.updateMatrixWorld(); mesh.getMatrixAt(0, matrix); root.setFromMatrixPosition(matrix);
    assert.ok(root.distanceTo(camera.position) > 72.01);
    assert.equal(mesh.userData.instanceVisible(0, camera), false, 'analytic y=0 would incorrectly retain this instance');
    assert.equal(mesh.userData.batchVisible(camera), false);
  }
  camera.position.set(0, 0.77, 71.999); camera.updateMatrixWorld();
  for (const mesh of meshes) assert.equal(mesh.userData.instanceVisible(0, camera), true);

  const parent = new THREE.Group(), cameraParent = new THREE.Group();
  parent.position.set(-300, 50, 100); parent.rotation.set(0.2, 0.4, 0); parent.scale.set(1.3, 0.7, 2); parent.add(...meshes);
  cameraParent.position.set(100, -20, 80); cameraParent.rotation.y = 0.3; cameraParent.add(camera);
  parent.updateMatrixWorld(true); cameraParent.updateMatrixWorld(true);
  const direction = new THREE.Vector3(0.25, 0.5, 0.8).normalize(), eye = new THREE.Vector3();
  for (const mesh of meshes) {
    mesh.getMatrixAt(0, matrix); root.setFromMatrixPosition(matrix).applyMatrix4(mesh.matrixWorld);
    for (const [distance, visible] of [[71.999, true], [72.02, false]]) {
      const desired = root.clone().addScaledVector(direction, distance);
      camera.position.copy(cameraParent.worldToLocal(desired)); cameraParent.updateMatrixWorld(true);
      eye.setFromMatrixPosition(camera.matrixWorld);
      assert.ok(Math.abs(eye.distanceTo(root) - distance) < 1e-6);
      assert.equal(mesh.userData.instanceVisible(0, camera), visible);
      assert.equal(mesh.userData.batchVisible(camera), visible);
    }
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    mesh.material.onBeforeCompile(shader);
    assert.match(shader.vertexShader, /vFlowerDistance = length\(\(modelMatrix \* instanceMatrix \* vec4\(0\.0, 0\.0, 0\.0, 1\.0\)\)\.xyz - cameraPosition\)/);
  }
});

test('surface-grounded flower batches preserve packed selection, restoration and template disposal ownership', async t => {
  const { field, resolve } = fixture(t), source = sourceScene();
  resolve(source.gltf); await field.assetPromise;
  const population = [
    { ...records[0], id: 'surface-far', x: 0, y: 3, surfaceY: 200, z: -20 },
    { ...records[0], id: 'surface-near', x: 0, y: 200, surfaceY: 3, z: -25, variant: 1 },
    { ...records[0], id: 'offscreen', x: 1000, surfaceY: 3, z: -20 },
  ];
  const meshes = field.build(population), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(54);
  scene.add(...meshes); camera.position.y = 3;
  const originals = meshes.map(mesh => ({ geometry: mesh.geometry, matrix: mesh.instanceMatrix,
    matrices: mesh.instanceMatrix.array.slice(), color: mesh.instanceColor, colors: mesh.instanceColor.array.slice(), ids: mesh.userData.population.ids.slice() }));
  const culler = new InstanceCuller();
  culler.prepare(scene, camera);
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    assert.equal(mesh.count, 1);
    assert.notEqual(mesh.geometry, originals[i].geometry);
    assert.equal(mesh.instanceMatrix.array[13], 3);
    assert.equal(mesh.instanceMatrix.array[14], -25);
    assert.equal(mesh.userData.instanceVisible(0, camera), true, 'packed index zero refers to the corrected near root');
  }
  culler.restore();
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i], original = originals[i];
    assert.equal(mesh.count, population.length);
    assert.equal(mesh.geometry, original.geometry); assert.equal(mesh.instanceMatrix, original.matrix);
    assert.equal(mesh.instanceColor, original.color);
    assert.deepEqual(mesh.instanceMatrix.array, original.matrices);
    assert.deepEqual(mesh.instanceColor.array, original.colors);
    assert.deepEqual(mesh.userData.population.ids, original.ids);
  }
  culler.dispose();
  const template = field.geometry.stem.getAttribute('position');
  field.disposeMesh(meshes[0]);
  assert.equal(field.geometry.stem.getAttribute('position'), template);
  assert.ok(field.geometry.stem.index);
  assert.equal(meshes[0].geometry.index, null);
  assert.equal(meshes[0].geometry.getAttribute('position'), undefined);
});

test('flower disposal is idempotent and releases every owned resource exactly once', async (t) => {
  const { field, resolve } = fixture(t), source = sourceScene();
  resolve(source.gltf);
  await field.assetPromise;
  const group = new THREE.Group(), meshes = field.build(records);
  group.add(...meshes);
  const resources = [...Object.values(field.geometry), ...Object.values(field.materials),
    ...meshes, ...meshes.map(mesh => mesh.geometry)];
  const counts = new Map(resources.map(resource => [resource, 0]));
  for (const resource of resources) resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource) + 1));
  field.dispose();
  field.dispose();
  assert.ok(resources.every(resource => counts.get(resource) === 1));
  assert.equal(field.geometry, null);
  assert.equal(field.meshes.size, 0);
  assert.equal(group.children.length, 0);
  assert.deepEqual(field.build(records), []);
});

test('flower population failures release both complete and partially populated meshes', async (t) => {
  const { field, resolve } = fixture(t), source = sourceScene();
  resolve(source.gltf);
  await field.assetPromise;
  const sourcePosition = field.geometry.stem.getAttribute('position'), sourceIndex = field.geometry.stem.index;
  const disposedMeshes = [], disposedGeometry = [];
  const meshDispose = THREE.InstancedMesh.prototype.dispose, geometryDispose = THREE.BufferGeometry.prototype.dispose;
  t.mock.method(THREE.InstancedMesh.prototype, 'dispose', function () { disposedMeshes.push(this); return meshDispose.call(this); });
  t.mock.method(THREE.BufferGeometry.prototype, 'dispose', function () { disposedGeometry.push(this); return geometryDispose.call(this); });
  const original = THREE.InstancedMesh.prototype.setColorAt;
  let calls = 0;
  const populate = t.mock.method(THREE.InstancedMesh.prototype, 'setColorAt', function (...args) {
    if (++calls === 2) throw new Error('synthetic blossom population failure');
    return original.apply(this, args);
  });
  assert.throws(() => field.build(records), /synthetic blossom population failure/);
  assert.equal(field.meshes.size, 0);
  assert.equal(disposedMeshes.length, 2);
  assert.equal(disposedGeometry.length, 2);
  assert.ok(disposedGeometry.every(geometry => geometry.index === null && Object.keys(geometry.attributes).length === 0));
  assert.strictEqual(field.geometry.stem.getAttribute('position'), sourcePosition);
  assert.strictEqual(field.geometry.stem.index, sourceIndex);
  populate.mock.restore();
  assert.equal(field.build(records).length, 2, 'failed cells do not prevent a clean retry');
});

test('flower geometry setup failures release an unowned cell wrapper without deleting templates', async (t) => {
  const { field, resolve } = fixture(t), source = sourceScene();
  resolve(source.gltf);
  await field.assetPromise;
  const blossom = field.geometry.blossom, descriptor = Object.getOwnPropertyDescriptor(blossom, 'attributes');
  const disposedGeometry = [], original = THREE.BufferGeometry.prototype.dispose;
  t.mock.method(THREE.BufferGeometry.prototype, 'dispose', function () { disposedGeometry.push(this); return original.call(this); });
  Object.defineProperty(blossom, 'attributes', { configurable: true, get() { throw new Error('synthetic geometry setup failure'); } });
  try { assert.throws(() => field.build(records), /synthetic geometry setup failure/); }
  finally { Object.defineProperty(blossom, 'attributes', descriptor); }
  assert.equal(field.meshes.size, 0);
  assert.equal(disposedGeometry.length, 2);
  assert.ok(disposedGeometry.every(geometry => geometry.index === null && Object.keys(geometry.attributes).length === 0));
  assert.ok(field.geometry.stem.index && blossom.index);
});

test('invalid loaded flower scenes release their source resources and expose the asset error', async (t) => {
  const { field, resolve } = fixture(t), source = sourceScene();
  source.gltf.scene.children[1].name = 'unknown';
  resolve(source.gltf);
  await field.assetPromise;
  assert.match(field.assetError, /missing Stem\/Blossom/);
  assert.equal(field.geometry, null);
  assert.ok(source.resources.every(resource => source.counts.get(resource) === 1));
});

test('late loader failures cannot mutate a disposed flower field', async (t) => {
  const { field, reject } = fixture(t);
  field.dispose();
  reject(new Error('late network failure'));
  await field.assetPromise;
  assert.equal(field.assetError, null);
  assert.equal(field.geometry, null);
});

test('cluster template changes retain two deterministic field batches and seasonal culling', async (t) => {
  const { field, resolve } = fixture(t), source = sourceScene();
  resolve(source.gltf); await field.assetPromise;
  const population = [...records, { ...records[0], id: 'second', x: 4, yaw: 1.2, height: 0.55, variant: 1 },
    { ...records[0], id: 'excluded-rank', rank: 0.2 }, { ...records[0], id: 'excluded-cover', cover: 0.9 }];
  const first = field.build(population), second = field.build(population);
  assert.equal(first.length, 2);
  for (const [i, mesh] of first.entries()) {
    assert.equal(mesh.count, 2);
    assert.deepEqual(mesh.userData.population.ids, ['grass:flower:flower', 'second:flower']);
    assert.deepEqual(mesh.instanceMatrix.array, second[i].instanceMatrix.array);
    assert.deepEqual(mesh.instanceColor.array, second[i].instanceColor.array);
  }
  assert.deepEqual(first[0].instanceMatrix.array, first[1].instanceMatrix.array);
  assert.equal(first[1].geometry.getAttribute('color'), field.geometry.blossom.getAttribute('color'));
  const colors = first[1].instanceColor.array;
  assert.ok(colors[0] > 0.9 && colors[1] > 0.9 && colors[2] > 0.9, 'white flowers must not inherit an orange multiplier');
  assert.ok(colors[3] > 0.9 && colors[4] > 0.9 && colors[5] > 0.65, 'alternate flowers remain pale yellow');
  const camera = new THREE.PerspectiveCamera(54), matrices = first.map(mesh => mesh.instanceMatrix.array.slice());
  for (const mesh of first) assert.equal(mesh.userData.instanceVisible(0, camera), true);
  field.update('winter');
  for (const mesh of first) {
    assert.equal(mesh.userData.instanceVisible(0, camera), false);
    assert.equal(mesh.userData.batchVisible(camera), false);
    assert.equal(mesh.userData.instanceVisibilityVersion, 1);
  }
  field.update('autumn');
  assert.equal(field.uniforms.uFlowerSeason.value, 0.4);
  first.forEach((mesh, i) => {
    assert.equal(mesh.userData.instanceVisible(0, camera), true);
    assert.deepEqual(mesh.instanceMatrix.array, matrices[i]);
  });
});

test('failed cluster preparation releases cloned and loader-owned geometry without publishing assets', async (t) => {
  const { field, resolve } = fixture(t), source = sourceScene();
  const clone = THREE.BufferGeometry.prototype.clone, compute = THREE.BufferGeometry.prototype.computeVertexNormals;
  const clones = [], disposed = new Map();
  const watch = geometry => {
    disposed.set(geometry, 0);
    geometry.addEventListener('dispose', () => disposed.set(geometry, disposed.get(geometry) + 1));
    return geometry;
  };
  t.mock.method(THREE.BufferGeometry.prototype, 'clone', function() {
    const geometry = watch(clone.call(this)); clones.push(geometry); return geometry;
  });
  t.mock.method(THREE.BufferGeometry.prototype, 'computeVertexNormals', function() {
    if (this.getAttribute('color')) { watch(this); throw new Error('synthetic petal preparation failure'); }
    return compute.call(this);
  });
  resolve(source.gltf); await field.assetPromise;
  assert.match(field.assetError, /synthetic petal preparation failure/);
  assert.equal(field.geometry, null);
  assert.equal(field.meshes.size, 0);
  assert.equal(clones.length, 2);
  assert.ok([...disposed.values()].every(count => count === 1));
  assert.ok(source.resources.every(resource => source.counts.get(resource) === 1));
});
