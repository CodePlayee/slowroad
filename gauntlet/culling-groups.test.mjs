import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import * as THREE from 'three';
const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(new URL(url), 'utf8'), shortCircuit: true } : next(url, context);
} });
const { CullingGroup, groupFoliage } = await import('../src/vegetation/cullingGroup.js');
const { InstanceCuller } = await import('../src/vegetation/instanceCulling.js');

function mesh(x, z) {
  const g = new THREE.BoxGeometry(1, 1, 1), m = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial(), 2);
  m.setMatrixAt(0, new THREE.Matrix4().makeTranslation(x, 0, z));
  m.setMatrixAt(1, new THREE.Matrix4().makeTranslation(x + 1, 0, z));
  m.frustumCulled = false;
  m.userData.staticCullBox = new THREE.Box3(new THREE.Vector3(x - 2, -2, z - 2), new THREE.Vector3(x + 3, 2, z + 2));
  m.userData.staticCullValid = () => m.instanceMatrix.version === 0;
  m.userData.batchVisible = () => true;
  m.userData.batchAllVisible = () => true;
  m.userData.foliageLevel = 'far';
  return m;
}

test('a rejected group stops descent and restores visibility after the frame', () => {
  const m = mesh(5000, 5000), group = groupFoliage([m]), root = new THREE.Group(); root.add(group);
  const culler = new InstanceCuller(), camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  let calls = 0; m.userData.batchVisible = () => { calls++; return true; };
  culler.prepare(root, camera);
  assert.equal(group.visible, false); assert.equal(calls, 0); assert.equal(culler._states.size, 0);
  culler.restore(); assert.equal(group.visible, true); assert.equal(m.visible, true);
  culler.dispose(); m.geometry.dispose(); m.material.dispose();
});

test('fully visible static forest batches do not allocate compaction buffers', () => {
  const m = mesh(0, -100), root = new THREE.Group(); root.add(m);
  const culler = new InstanceCuller(), camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  culler.prepare(root, camera);
  assert.equal(m.count, 2); assert.equal(culler._states.size, 0);
  culler.restore();
  m.instanceMatrix.needsUpdate = true;
  culler.prepare(root, camera);
  assert.equal(culler._states.size, 1, 'changed buffers must fall back to exact validation');
  culler.dispose(); m.geometry.dispose(); m.material.dispose();
});

test('group checks cannot hide newly mutated member geometry behind stale bounds', () => {
  const m = mesh(5000, 5000), group = new CullingGroup([m]), root = new THREE.Group(); root.add(group);
  m.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, -10));
  m.instanceMatrix.needsUpdate = true;
  const culler = new InstanceCuller(), camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  culler.prepare(root, camera);
  assert.equal(group.visible, true); assert.equal(m.visible, true); assert.equal(m.count, 1);
  culler.dispose(); m.geometry.dispose(); m.material.dispose();
});
