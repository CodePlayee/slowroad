import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(new URL(url), 'utf8'), shortCircuit: true } : next(url, context);
} });
const { rigModelYWheels, animateWheels } = await import('../src/vehicle/wheels.js');
const require = createRequire(resolve(process.env.CAR_ASSET_TOOLS_ROOT || '/Users/minimax/Documents/Play/cars-high-model', 'package.json'));
const { NodeIO } = await import(require.resolve('@gltf-transform/core'));
const { ALL_EXTENSIONS } = await import(require.resolve('@gltf-transform/extensions'));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await require('draco3dgltf').createDecoderModule() });
const doc = await io.read(new URL('../public/models/tesla-model-y-2025-awd-compact.glb', import.meta.url).pathname);
const root = new THREE.Group(), originals = new Map();
const names = { POSITION: 'position', NORMAL: 'normal', TEXCOORD_0: 'uv', TEXCOORD_1: 'uv1', COLOR_0: 'color' };
for (const node of doc.getRoot().listNodes()) for (const primitive of node.getMesh()?.listPrimitives() || []) {
  const material = new THREE.MeshStandardMaterial(); material.name = primitive.getMaterial().getName();
  if (!['M_Ext_Wheel', 'M_Ext_ChromePlastic'].includes(material.name)) { material.dispose(); continue; }
  const geometry = new THREE.BufferGeometry();
  for (const semantic of primitive.listSemantics()) {
    const attribute = primitive.getAttribute(semantic);
    geometry.setAttribute(names[semantic], new THREE.BufferAttribute(attribute.getArray(), attribute.getElementSize(), attribute.getNormalized()));
  }
  geometry.setIndex(new THREE.BufferAttribute(primitive.getIndices().getArray(), 1));
  const mesh = new THREE.Mesh(geometry, material); mesh.name = node.getName();
  mesh.applyMatrix4(new THREE.Matrix4().fromArray(node.getWorldMatrix())); root.add(mesh);
  originals.set(mesh.name, mesh);
}
const wheels = rigModelYWheels(root, 1); assert.equal(wheels.length, 4);
root.updateMatrixWorld(true);
for (const wheel of wheels) {
  const box = new THREE.Box3().setFromObject(wheel, true);
  assert.ok(Math.max(Math.abs(box.min.x - wheel.position.x), Math.abs(box.max.x - wheel.position.x)) < 0.16);
  assert.ok(Math.max(Math.abs(box.min.y - wheel.position.y), Math.abs(box.max.y - wheel.position.y),
    Math.abs(box.min.z - wheel.position.z), Math.abs(box.max.z - wheel.position.z)) < 0.365);
}
let corners = 0, maxPositionError = 0;
const before = new THREE.Vector3(), after = new THREE.Vector3();
root.traverse(mesh => {
  if (!mesh.isMesh) return;
  const original = originals.get(mesh.userData.wheelSource);
  let targetIndex = 0;
  for (const [start, count] of mesh.userData.wheelRanges) for (let i = start * 3; i < (start + count) * 3; i++, targetIndex++) {
    const a = original.geometry.index.array[i], b = mesh.geometry.index.array[targetIndex];
    for (const [name, attribute] of Object.entries(original.geometry.attributes)) {
      const target = mesh.geometry.attributes[name];
      for (let k = 0; k < attribute.itemSize; k++) assert.equal(target.array[b * target.itemSize + k], attribute.array[a * attribute.itemSize + k]);
    }
    before.fromBufferAttribute(original.geometry.attributes.position, a).applyMatrix4(original.matrix);
    after.fromBufferAttribute(mesh.geometry.attributes.position, b).applyMatrix4(mesh.matrixWorld);
    maxPositionError = Math.max(maxPositionError, before.distanceTo(after)); corners++;
  }
});
assert.equal(corners, [...originals.values()].reduce((sum, mesh) => sum + mesh.geometry.index.count, 0));
assert.ok(maxPositionError < 1e-8);
const body = root.children.find(mesh => mesh.isMesh), bodyMatrix = body.matrixWorld.clone();
animateWheels(wheels, 0.3, 0.08, 1.72); root.updateMatrixWorld(true);
assert.ok(body.matrixWorld.equals(bodyMatrix));
const report = { status: 'passed', corners, triangles: corners / 3, maxPositionError,
  wheels: wheels.map(wheel => ({ name: wheel.name, rollingParts: wheel.rollGroup.children.length,
    calipers: wheel.children.filter(child => child.isMesh).length, radius: wheel.userData.radius })) };
writeFileSync(process.argv[2] || '/tmp/slowroad-wheel-geometry.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
