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
const { InstanceCuller } = await import('../src/vegetation/instanceCulling.js');

function fixture(points = [[0, 0, -10], [100, 0, -10], [1, 0, -12]]) {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.computeBoundingSphere();
  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), points.length);
  for (let i = 0; i < points.length; i++) {
    mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(...points[i]));
    mesh.setColorAt(i, new THREE.Color(i / 10, i / 5, i / 3));
  }
  geometry.setAttribute('iTint', new THREE.InstancedBufferAttribute(new Float32Array(points.flatMap((_, i) => [i + 1, i + 2, i + 3])), 3));
  geometry.setAttribute('iShape', new THREE.InstancedBufferAttribute(new Float32Array(points.map((_, i) => i / 10)), 1));
  geometry.setAttribute('iVariant', new THREE.InstancedBufferAttribute(new Uint16Array(points.map((_, i) => i + 4)), 1));
  geometry.setAttribute('iUv', new THREE.InstancedBufferAttribute(new Float32Array(points.flatMap((_, i) => [i, i + 0.1, i + 0.2, i + 0.3])), 4));
  root.add(mesh);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  const culler = new InstanceCuller();
  return { root, mesh, geometry, camera, culler };
}

test('stable compaction aligns every instance attribute and restores canonical state exactly', () => {
  const { root, mesh, geometry, camera, culler } = fixture();
  const matrix = mesh.instanceMatrix, color = mesh.instanceColor;
  const before = matrix.array.slice();
  const attributes = Object.fromEntries(Object.entries(geometry.attributes));
  try {
    const stats = culler.prepare(root, camera);
    assert.deepEqual(stats, { totalInstances: 3, visibleInstances: 2, culledInstances: 1, batches: 1 });
    assert.equal(mesh.count, 2);
    assert.notEqual(mesh.geometry, geometry);
    assert.notEqual(mesh.instanceMatrix, matrix);
    assert.equal(mesh.geometry.getAttribute('position'), geometry.getAttribute('position'));
    assert.equal(mesh.geometry.index, geometry.index);
    assert.equal(mesh.frustumCulled, false);
    for (const [destination, sourceIndex] of [0, 2].entries()) {
      assert.deepEqual(mesh.instanceMatrix.array.slice(destination * 16, (destination + 1) * 16), matrix.array.slice(sourceIndex * 16, (sourceIndex + 1) * 16));
      assert.deepEqual(mesh.instanceColor.array.slice(destination * 3, (destination + 1) * 3), color.array.slice(sourceIndex * 3, (sourceIndex + 1) * 3));
      for (const [name, source] of Object.entries(attributes)) {
        if (!source.isInstancedBufferAttribute) continue;
        const target = mesh.geometry.getAttribute(name), size = source.itemSize;
        assert.deepEqual(target.array.slice(destination * size, (destination + 1) * size), source.array.slice(sourceIndex * size, (sourceIndex + 1) * size));
      }
    }
    assert.deepEqual(mesh.instanceMatrix.updateRanges, [{ start: 0, count: 32 }]);
    culler.restore();
    assert.equal(mesh.geometry, geometry);
    assert.equal(mesh.instanceMatrix, matrix);
    assert.equal(mesh.instanceColor, color);
    assert.equal(mesh.count, 3);
    assert.equal(mesh.visible, true);
    assert.equal(mesh.frustumCulled, true);
    assert.deepEqual(matrix.array, before);
    assert.deepEqual(Object.fromEntries(Object.entries(geometry.attributes)), attributes);
  } finally { culler.dispose(); }
});

test('rotated and scaled instance bounds retain crowns intersecting a frustum edge', () => {
  const { root, mesh, geometry, camera, culler } = fixture([[6, 0, -10], [100, 0, -10]]);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 1);
  mesh.setMatrixAt(0, new THREE.Matrix4().compose(new THREE.Vector3(6, 0, -10),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 3), new THREE.Vector3(2, 3, 1)));
  mesh.instanceMatrix.needsUpdate = true;
  root.scale.set(1.1, 1.7, 1);
  root.rotation.z = 0.08;
  try {
    culler.prepare(root, camera);
    assert.equal(mesh.count, 1);
    assert.equal(mesh.visible, true);
    culler.restore();
    assert.equal(mesh.count, 2);
  } finally { culler.dispose(); }
});

test('inherited shear bounds contain sampled transformed geometry directions', () => {
  const { root, mesh, geometry, camera, culler } = fixture([[0, 0, -10]]);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  mesh.setMatrixAt(0, new THREE.Matrix4().compose(new THREE.Vector3(0, 0, -10),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.5, 0.6)), new THREE.Vector3(1.3, 0.8, 2)));
  mesh.instanceMatrix.needsUpdate = true;
  root.scale.set(1, 4, 0.6);
  culler.prepare(root, camera);
  const state = culler._states.get(mesh), center = new THREE.Vector3().fromArray(state.bounds);
  const world = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, new THREE.Matrix4().fromArray(mesh.instanceMatrix.array));
  for (let k = 0; k < 200; k++) {
    const v = new THREE.Vector3(Math.sin(k), Math.cos(k * 1.7), Math.sin(k * 0.37)).normalize().multiplyScalar(1.25).applyMatrix4(world);
    assert.ok(v.distanceTo(center) <= state.bounds[3] + 1e-9);
  }
  culler.dispose();
});

test('selection cache reuses unchanged buffers and invalidates camera and woodland matrix changes', () => {
  const { root, mesh, camera, culler } = fixture();
  try {
    culler.prepare(root, camera);
    const packed = mesh.instanceMatrix, version = packed.version;
    culler.restore();
    culler.prepare(root, camera);
    assert.equal(mesh.instanceMatrix, packed);
    assert.equal(packed.version, version);
    culler.restore();
    mesh.instanceMatrix.array[12] = 1e8;
    mesh.instanceMatrix.needsUpdate = true;
    culler.prepare(root, camera);
    assert.equal(mesh.count, 1);
    assert.ok(packed.version > version);
    culler.restore();
    camera.lookAt(100, 0, -10);
    culler.prepare(root, camera);
    assert.equal(mesh.count, 1);
    assert.equal(mesh.instanceMatrix.array[12], 100);
    culler.restore();
    mesh.instanceColor.array[3] = 0.75;
    mesh.instanceColor.needsUpdate = true;
    culler.prepare(root, camera);
    assert.equal(mesh.instanceColor.array[0], 0.75);
  } finally { culler.dispose(); }
});

test('instanced attribute divisors are expanded without changing canonical records', () => {
  const { root, mesh, geometry, camera, culler } = fixture();
  const shared = new THREE.InstancedBufferAttribute(new Float32Array([11, 22]), 1, false, 2);
  geometry.setAttribute('iShared', shared);
  culler.prepare(root, camera);
  const packed = mesh.geometry.getAttribute('iShared');
  assert.equal(packed.meshPerAttribute, 1);
  assert.deepEqual(Array.from(packed.array.slice(0, mesh.count)), [11, 22]);
  culler.restore();
  assert.equal(mesh.geometry.getAttribute('iShared'), shared);
  assert.equal(shared.meshPerAttribute, 2);
  culler.dispose();
});

test('grass shader-zero culling preserves the nonzero eighteen-percent tail and invalidates focus', () => {
  const { root, mesh, geometry, camera, culler } = fixture([[0, 0, -300], [1, 0, -300]]);
  mesh.material.customProgramCacheKey = () => 'meadow-folded-leaf-v2';
  mesh.material.userData.uniforms = { uFocus: { value: new THREE.Vector2() }, uBand: { value: new THREE.Vector2(1, 285) } };
  geometry.getAttribute('iShape').array.set([0.01 / 31.73, 0.8 / 31.73]);
  geometry.getAttribute('iShape').needsUpdate = true;
  try {
    culler.prepare(root, camera);
    assert.equal(mesh.count, 1);
    assert.equal(mesh.instanceMatrix.array[12], 0);
    culler.restore();
    mesh.material.userData.uniforms.uFocus.value.set(0, -200);
    culler.prepare(root, camera);
    assert.equal(mesh.count, 2);
    culler.restore();
    mesh.material.userData.uniforms.uFocus.value.set(0, -300);
    culler.prepare(root, camera);
    assert.equal(mesh.count, 1, 'far layer inside62m must retain the existing shader tail');
  } finally { culler.dispose(); }
});

test('mesh disposal restores canonical references and releases only owned packed attributes', () => {
  const { root, mesh, geometry, camera, culler } = fixture();
  const matrix = mesh.instanceMatrix;
  let disposed = 0, sourceDisposed = false;
  geometry.addEventListener('dispose', () => { sourceDisposed = true; });
  culler.prepare(root, camera);
  const compact = mesh.geometry;
  const packedMatrix = mesh.instanceMatrix;
  compact.addEventListener('dispose', () => {
    disposed++;
    assert.equal(compact.index, null);
    assert.ok(Object.values(compact.attributes).every((attribute) => attribute.isInstancedBufferAttribute));
    assert.equal(compact.getAttribute('_instanceCullMatrix'), packedMatrix);
  });
  mesh.dispose();
  assert.equal(disposed, 1);
  assert.equal(sourceDisposed, false);
  assert.equal(mesh.geometry, geometry);
  assert.equal(mesh.instanceMatrix, matrix);
  assert.equal(mesh.count, 3);
  assert.equal(culler._states.size, 0);
  culler.restore();
  culler.dispose();
  assert.equal(disposed, 1);
});

test('disabled culling restores a pending frame and does not mutate visibility or unsupported morph data', () => {
  const { root, mesh, geometry, camera, culler } = fixture();
  culler.prepare(root, camera);
  culler.enabled = false;
  culler.prepare(root, camera);
  assert.equal(mesh.geometry, geometry);
  assert.equal(mesh.count, 3);
  culler.enabled = true;
  mesh.morphTexture = new THREE.DataTexture();
  culler.prepare(root, camera);
  assert.equal(mesh.count, 3);
  assert.equal(mesh.geometry, geometry);
  assert.equal(culler.stats.culledInstances, 0);
  mesh.visible = false;
  culler.prepare(root, camera);
  assert.equal(culler.stats.totalInstances, 0);
  culler.restore();
  assert.equal(mesh.visible, false);
  culler.dispose();
});

test('replaced source geometry and mutated bounds invalidate cached compact state', () => {
  const { root, mesh, geometry, camera, culler } = fixture();
  culler.prepare(root, camera);
  const old = mesh.geometry;
  let released = 0;
  old.addEventListener('dispose', () => released++);
  culler.restore();
  geometry.boundingSphere.radius = 200;
  culler.prepare(root, camera);
  assert.equal(mesh.count, 3);
  culler.restore();
  mesh.geometry = geometry.clone();
  mesh.geometry.boundingSphere.radius = 1;
  culler.prepare(root, camera);
  assert.equal(mesh.count, 2);
  assert.equal(released, 1);
  culler.dispose();
});

test('fully culled batches are hidden only during rendering and padded roots remain conservative', () => {
  const { root, mesh, geometry, camera, culler } = fixture([[100, 0, -10], [110, 0, -10]]);
  culler.prepare(root, camera);
  assert.equal(mesh.count, 0);
  assert.equal(mesh.visible, false);
  culler.restore();
  assert.equal(mesh.count, 2);
  assert.equal(mesh.visible, true);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 10, 0), 1);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, -2));
  mesh.instanceMatrix.needsUpdate = true;
  culler.prepare(root, camera);
  assert.equal(mesh.count, 1, 'a tuft shrinking toward a visible root must not be discarded with its authored crown');
  culler.dispose();
  assert.equal(mesh.count, 2);
  assert.equal(mesh.geometry, geometry);
});

test('aggregate padded bounds reject whole batches before per-instance tests and invalidate with transforms', () => {
  const { root, mesh, camera, culler } = fixture([[100, 0, -10], [110, 0, -10]]);
  let spheres = 0, predicates = 0;
  const intersectsSphere = culler._frustum.intersectsSphere.bind(culler._frustum);
  culler._frustum.intersectsSphere = sphere => { spheres++; return intersectsSphere(sphere); };
  mesh.userData.instanceVisible = () => { predicates++; return true; };
  try {
    culler.prepare(root, camera);
    assert.equal(mesh.count, 0);
    assert.equal(spheres, 0);
    assert.equal(predicates, 0);
    culler.restore();
    root.position.x = -100;
    culler.prepare(root, camera);
    assert.equal(mesh.count, 1);
    assert.equal(spheres, 2);
    assert.equal(predicates, 1);
    culler.restore();
    mesh.userData.worldBoundsPadding = 100;
    culler.prepare(root, camera);
    assert.equal(mesh.count, 2, 'aggregate bounds must include the current world-space padding');
  } finally { culler.dispose(); }
});

test('per-instance frustum rejection precedes visibility predicates without changing compacted records', () => {
  const { root, mesh, camera, culler } = fixture();
  const visited = [];
  mesh.userData.instanceVisible = index => { visited.push(index); return index !== 2; };
  try {
    culler.prepare(root, camera);
    assert.deepEqual(visited, [0, 2]);
    assert.equal(mesh.count, 1);
    assert.equal(mesh.geometry.getAttribute('iTint').array[0], 1);
  } finally { culler.dispose(); }
});

test('camera, transform and padding changes reuse unchanged selected buffers without upload churn', () => {
  const { root, mesh, camera, culler } = fixture();
  try {
    culler.prepare(root, camera);
    const packed = mesh.instanceMatrix;
    const attributes = [packed, mesh.instanceColor, ...Object.values(mesh.geometry.attributes).filter(a => a.isInstancedBufferAttribute)];
    const versions = attributes.map(attribute => attribute.version);
    const bytes = attributes.map(attribute => attribute.array.slice());
    culler.restore();
    for (const change of [() => { camera.position.x += 0.00001; },
      () => { root.position.x += 0.00001; }, () => { mesh.userData.worldBoundsPadding = 0.00001; }]) {
      change();
      culler.prepare(root, camera);
      assert.equal(mesh.count, 2);
      assert.equal(mesh.instanceMatrix, packed);
      assert.deepEqual(attributes.map(attribute => attribute.version), versions);
      attributes.forEach((attribute, index) => assert.deepEqual(attribute.array, bytes[index]));
      culler.restore();
    }
  } finally { culler.dispose(); }
});

test('unchanged selections repack changed source attributes and source colors', () => {
  const { root, mesh, geometry, camera, culler } = fixture();
  const color = mesh.instanceColor;
  try {
    culler.prepare(root, camera);
    const packed = mesh.instanceMatrix;
    const tint = mesh.geometry.getAttribute('iTint');
    const packedColor = mesh.instanceColor;
    let version = packed.version;
    culler.restore();
    geometry.getAttribute('iTint').array[6] = 42;
    geometry.getAttribute('iTint').needsUpdate = true;
    culler.prepare(root, camera);
    assert.equal(mesh.count, 2);
    assert.equal(tint.array[3], 42);
    assert.ok(packed.version > version);
    version = packed.version;
    culler.restore();
    color.array[6] = 0.75;
    color.needsUpdate = true;
    culler.prepare(root, camera);
    assert.equal(mesh.count, 2);
    assert.equal(packedColor.array[3], 0.75);
    assert.ok(packed.version > version);
    version = packed.version;
    culler.restore();
    mesh.instanceMatrix.array[12] = 0.5;
    mesh.instanceMatrix.needsUpdate = true;
    culler.prepare(root, camera);
    assert.equal(mesh.count, 2);
    assert.equal(packed.array[12], 0.5);
    assert.ok(packed.version > version);
  } finally { culler.dispose(); }
});

test('reduced and empty selections cannot reuse stale trailing packed attributes when expanded', () => {
  const { root, mesh, geometry, camera, culler } = fixture();
  const source = geometry.getAttribute('iTint');
  try {
    culler.prepare(root, camera);
    const packed = mesh.geometry.getAttribute('iTint');
    culler.restore();
    mesh.count = 1;
    source.array[6] = 42;
    source.needsUpdate = true;
    culler.prepare(root, camera);
    assert.equal(mesh.count, 1);
    culler.restore();
    mesh.count = 3;
    culler.prepare(root, camera);
    assert.equal(mesh.count, 2);
    assert.equal(packed.array[3], 42);
    culler.restore();
    camera.lookAt(0, 0, 10);
    source.array[6] = 84;
    source.needsUpdate = true;
    const version = packed.version;
    culler.prepare(root, camera);
    assert.equal(mesh.count, 0);
    assert.equal(mesh.visible, false);
    assert.equal(packed.version, version, 'an empty selection needs no buffer upload');
    culler.restore();
    camera.lookAt(0, 0, -10);
    culler.prepare(root, camera);
    assert.equal(mesh.count, 2);
    assert.equal(packed.array[3], 84);
    culler.restore();
    assert.equal(mesh.count, 3);
    assert.equal(mesh.geometry, geometry);
  } finally { culler.dispose(); }
});

test('partial repacking retains pending upload ranges when earlier updates have not rendered', () => {
  const { root, mesh, geometry, camera, culler } = fixture([[0, 0, -10], [1, 0, -10], [2, 0, -10], [3, 0, -10]]);
  let excluded = 3;
  mesh.userData.instanceVisible = index => index !== excluded;
  try {
    culler.prepare(root, camera);
    const packed = mesh.instanceMatrix;
    packed.clearUpdateRanges();
    culler.restore();
    geometry.getAttribute('iTint').array[0] = 42;
    geometry.getAttribute('iTint').needsUpdate = true;
    excluded = -1;
    mesh.userData.instanceVisibilityVersion = 1;
    culler.prepare(root, camera);
    assert.equal(mesh.count, 4, 'all-visible frames render the canonical mesh rather than packed buffers');
    assert.deepEqual(packed.updateRanges, [{ start: 0, count: 64 }]);
    culler.restore();
    excluded = 1;
    mesh.userData.instanceVisibilityVersion = 2;
    culler.prepare(root, camera);
    assert.equal(mesh.count, 3);
    assert.deepEqual(packed.updateRanges, [{ start: 0, count: 64 }]);
    assert.equal(mesh.geometry.getAttribute('iTint').array[0], 42);
    packed.clearUpdateRanges();
    culler.restore();
    excluded = 2;
    mesh.userData.instanceVisibilityVersion = 3;
    culler.prepare(root, camera);
    assert.deepEqual(packed.updateRanges, [{ start: 16, count: 16 }]);
  } finally { culler.dispose(); }
});

test('cached compaction matches exhaustive sphere selection through movement, resizing and source changes', () => {
  const points = Array.from({ length: 24 }, (_, i) => [(i % 6 - 3) * 8, (i % 3 - 1) * 2, -8 - Math.floor(i / 6) * 12]);
  const { root, mesh, geometry, camera, culler } = fixture(points);
  const matrix = mesh.instanceMatrix, color = mesh.instanceColor;
  geometry.setAttribute('iShared', new THREE.InstancedBufferAttribute(new Float32Array(12).map((_, i) => i + 7), 1, false, 2));
  const attributes = Object.entries(geometry.attributes).filter(([, attribute]) => attribute.isInstancedBufferAttribute);
  const sphere = new THREE.Sphere();
  try {
    for (let frame = 0; frame < 48; frame++) {
      culler.restore();
      mesh.count = 1 + frame % points.length;
      root.position.x = Math.sin(frame * 0.3) * 9;
      root.scale.set(1, 1 + frame % 4 * 0.25, 1);
      root.rotation.z = Math.sin(frame * 0.2) * 0.2;
      camera.position.x = Math.cos(frame * 0.4) * 5;
      camera.lookAt(Math.sin(frame * 0.5) * 20, 0, frame % 9 === 0 ? 10 : -20);
      mesh.userData.worldBoundsPadding = frame % 5;
      mesh.userData.instanceVisibilityVersion = frame;
      mesh.userData.instanceVisible = index => (index + frame) % 5 !== 0;
      const updated = frame % points.length;
      matrix.array[updated * 16 + 12] += 0.1;
      matrix.needsUpdate = true;
      color.array[updated * 3] = frame / 48;
      color.needsUpdate = true;
      geometry.getAttribute('iTint').array[updated * 3] = frame;
      geometry.getAttribute('iTint').needsUpdate = true;
      const sourceCount = mesh.count;
      culler.prepare(root, camera);
      const state = culler._states.get(mesh), selected = [];
      for (let index = 0; index < sourceCount; index++) {
        sphere.center.fromArray(state.bounds, index * 4);
        sphere.radius = state.bounds[index * 4 + 3];
        if (culler._frustum.intersectsSphere(sphere) && (index + frame) % 5 !== 0) selected.push(index);
      }
      assert.equal(mesh.count, selected.length);
      for (const [targetIndex, sourceIndex] of selected.entries()) {
        for (const [source, target] of [[matrix, mesh.instanceMatrix], [color, mesh.instanceColor],
          ...attributes.map(([name, attribute]) => [attribute, mesh.geometry.getAttribute(name)])]) {
          const from = Math.floor(sourceIndex / source.meshPerAttribute) * source.itemSize;
          const to = Math.floor(targetIndex / target.meshPerAttribute) * target.itemSize;
          assert.deepEqual(target.array.slice(to, to + target.itemSize), source.array.slice(from, from + source.itemSize));
        }
      }
    }
  } finally { culler.dispose(); }
});

test('moving frames reuse signature storage and the canonical restore snapshot', () => {
  const { root, mesh, geometry, camera, culler } = fixture();
  const signatures = { boundSignature: new Set(), sourceSignature: new Set(), selectionSignature: new Set() };
  let layout, snapshot;
  try {
    for (let frame = 0; frame < 100; frame++) {
      camera.position.x = Math.sin(frame) * 0.2;
      mesh.instanceMatrix.needsUpdate = true;
      geometry.attributes.iTint.needsUpdate = true;
      culler.prepare(root, camera);
      const state = culler._states.get(mesh);
      layout ||= state.layout; snapshot ||= state.snapshot;
      assert.equal(state.layout, layout);
      assert.equal(state.saved, snapshot);
      for (const key of Object.keys(signatures)) signatures[key].add(state[key]);
      assert.equal(mesh.count, 2);
      culler.restore();
      assert.equal(mesh.geometry, geometry);
      assert.equal(mesh.count, 3);
    }
    for (const buffers of Object.values(signatures)) assert.equal(buffers.size, 2);
  } finally { culler.dispose(); }
  assert.equal(culler._layoutScratch.length, 0);
});
