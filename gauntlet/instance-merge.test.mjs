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

// Impostor-like batches: one shared card geometry and material, per-batch
// instance rows (matrix + iFoliage), identity transforms, opted in to merging.
function scene(batches) {
  const root = new THREE.Group(), material = new THREE.MeshBasicMaterial();
  const card = new THREE.PlaneGeometry(1, 1);
  card.computeBoundingSphere();
  const meshes = batches.map((points, b) => {
    const geometry = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(card.attributes)) geometry.setAttribute(name, attribute);
    geometry.setIndex(card.index);
    geometry.boundingSphere = card.boundingSphere.clone();
    geometry.setAttribute('iFoliage', new THREE.InstancedBufferAttribute(
      new Float32Array(points.flatMap((_, i) => [b, i, b * 10 + i, 0.5])), 4));
    const mesh = new THREE.InstancedMesh(geometry, material, points.length);
    points.forEach((p, i) => mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(...p)));
    mesh.frustumCulled = false;
    mesh.userData.instanceMerge = true;
    root.add(mesh);
    return mesh;
  });
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  return { root, material, meshes, camera, culler: new InstanceCuller() };
}

// Rows the renderer would draw this frame, as [x, z, iFoliage...] per instance.
function drawnRows(root) {
  const rows = [];
  root.traverseVisible((object) => {
    if (!object.isInstancedMesh) return;
    const foliage = object.geometry.getAttribute('iFoliage');
    for (let i = 0; i < object.count; i++) {
      const m = object.instanceMatrix.array;
      rows.push([m[i * 16 + 12], m[i * 16 + 14], ...foliage.array.slice(i * 4, i * 4 + 4)].join(','));
    }
  });
  return rows.sort();
}

function drawCalls(root) {
  let calls = 0;
  root.traverseVisible((object) => { if (object.isInstancedMesh && object.count > 0) calls++; });
  return calls;
}

test('merged batches draw exactly the selected rows of every member in one draw and restore the scene', () => {
  const { root, meshes, camera, culler } = scene([[[0, 0, -10], [500, 0, -10]], [[1, 0, -12], [2, 0, -14]], [[-1, 0, -11]]]);
  const children = [...root.children];
  // Reference: the same frame without merging.
  for (const mesh of meshes) mesh.userData.instanceMerge = false;
  culler.prepare(root, camera);
  const expected = drawnRows(root), expectedCalls = drawCalls(root);
  culler.restore();
  for (const mesh of meshes) mesh.userData.instanceMerge = true;
  try {
    culler.prepare(root, camera);
    assert.deepEqual(drawnRows(root), expected);
    assert.equal(expectedCalls, 3);
    assert.equal(drawCalls(root), 1);
    culler.restore();
    assert.deepEqual(root.children, children, 'the merged draw is detached after rendering');
    for (const mesh of meshes) assert.equal(mesh.visible, true);
    assert.equal(meshes[0].count, 2);
  } finally { culler.dispose(); }
});

test('merged rows follow member source changes, camera moves and membership changes', () => {
  const { root, meshes, camera, culler } = scene([[[0, 0, -10], [3, 0, -10]], [[1, 0, -12]], [[-2, 0, -15]]]);
  try {
    culler.prepare(root, camera); culler.restore();
    // Mutate one member's source rows.
    meshes[1].setMatrixAt(0, new THREE.Matrix4().makeTranslation(4, 0, -20));
    meshes[1].instanceMatrix.needsUpdate = true;
    meshes[1].geometry.getAttribute('iFoliage').array[2] = 77;
    meshes[1].geometry.getAttribute('iFoliage').needsUpdate = true;
    culler.prepare(root, camera);
    const merged = drawnRows(root);
    culler.restore();
    for (const mesh of meshes) mesh.userData.instanceMerge = false;
    culler.prepare(root, camera);
    assert.deepEqual(merged, drawnRows(root));
    culler.restore();
    for (const mesh of meshes) mesh.userData.instanceMerge = true;
    // Rotate the camera so one member leaves the view, then back.
    for (const yaw of [0.9, 0]) {
      camera.rotation.y = yaw; camera.updateMatrixWorld();
      culler.prepare(root, camera);
      const rows = drawnRows(root);
      culler.restore();
      for (const mesh of meshes) mesh.userData.instanceMerge = false;
      culler.prepare(root, camera);
      assert.deepEqual(rows, drawnRows(root), `yaw ${yaw}`);
      culler.restore();
      for (const mesh of meshes) mesh.userData.instanceMerge = true;
    }
    // A member removed from the scene leaves the merged draw.
    root.remove(meshes[2]);
    culler.prepare(root, camera);
    assert.equal(drawnRows(root).some((row) => row.startsWith('-2,-15')), false);
    culler.restore();
  } finally { culler.dispose(); }
});

test('transformed or incompatible batches are drawn on their own', () => {
  const { root, meshes, camera, culler } = scene([[[0, 0, -10]], [[1, 0, -12]], [[2, 0, -14]]]);
  try {
    meshes[0].position.x = 0.5; meshes[0].updateMatrix();
    meshes[1].material = new THREE.MeshBasicMaterial();
    culler.prepare(root, camera);
    assert.equal(drawCalls(root), 3);
    culler.restore();
  } finally { culler.dispose(); }
});

test('a camera sweep keeps merged rows equal to separate draws while member counts change', () => {
  const batches = [];
  for (let b = 0; b < 6; b++) batches.push(Array.from({ length: 5 }, (_, i) => [b * 6 - 15 + i, 0, -20 - b]));
  const { root, meshes, camera, culler } = scene(batches);
  try {
    for (let step = 0; step <= 12; step++) {
      camera.position.x = -20 + step * 3.5; camera.rotation.y = 0.3 - step * 0.05; camera.updateMatrixWorld();
      culler.prepare(root, camera);
      const rows = drawnRows(root);
      culler.restore();
      for (const mesh of meshes) mesh.userData.instanceMerge = false;
      culler.prepare(root, camera);
      assert.deepEqual(rows, drawnRows(root), `step ${step}`);
      culler.restore();
      for (const mesh of meshes) mesh.userData.instanceMerge = true;
    }
  } finally { culler.dispose(); }
});
