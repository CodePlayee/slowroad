import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import * as THREE from 'three';
const root = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(root) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(new URL(url), 'utf8'), shortCircuit: true } : next(url, context);
} });
const { geometrySubset, animateWheels, indexHash } = await import('../src/vehicle/wheels.js');
const rig = JSON.parse(readFileSync(new URL('../src/vehicle/model-y-wheel-rig.json', import.meta.url)));

test('wheel partition covers every original triangle exactly once and includes four calipers', () => {
  assert.equal(rig.wheels.length, 4);
  const roles = new Map();
  for (const mesh of rig.meshes) {
    const counts = new Uint8Array(mesh.indexCount / 3);
    for (const part of mesh.parts) {
      for (const [start, length] of part.ranges) {
        assert.ok(start >= 0 && start + length <= counts.length);
        for (let i = start; i < start + length; i++) counts[i]++;
      }
      if (part.wheel) roles.set(`${part.wheel}:${part.rolling}`, true);
    }
    assert.ok(counts.every(count => count === 1));
    assert.ok(mesh.maxWheelSurfaceError < 0.003);
  }
  for (const wheel of rig.wheels) {
    assert.ok(roles.has(`${wheel.name}:true`) && roles.has(`${wheel.name}:false`));
    assert.ok(wheel.radius > 0.35 && wheel.radius < 0.36);
  }
});

test('geometry partition preserves raw position, normal, UV and normalized attribute values', () => {
  const source = new THREE.BoxGeometry(1, 1, 1);
  const colors = new Uint8Array(source.attributes.position.count * 3).map((_, i) => i % 256);
  source.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  const ranges = [[3, 2], [0, 1]], before = indexHash(source.index.array);
  const subset = geometrySubset(source, ranges);
  let cursor = 0;
  for (const [start, length] of ranges) for (let i = start * 3; i < (start + length) * 3; i++, cursor++) {
    for (const [name, attribute] of Object.entries(source.attributes)) {
      const target = subset.attributes[name];
      const a = source.index.array[i] * attribute.itemSize, b = subset.index.array[cursor] * attribute.itemSize;
      assert.equal(target.normalized, attribute.normalized);
      assert.deepEqual(target.array.slice(b, b + target.itemSize), attribute.array.slice(a, a + attribute.itemSize));
    }
  }
  assert.equal(subset.index.count, 9);
  assert.equal(indexHash(source.index.array), before);
  source.dispose(); subset.dispose();
});

function wheels() {
  return rig.wheels.map(spec => {
    const wheel = new THREE.Group(); wheel.name = spec.name;
    Object.assign(wheel.userData, { front: spec.front, lateral: spec.center[0], radius: 0.36, wheelbase: 2.89 });
    wheel.rollGroup = new THREE.Group(); wheel.add(wheel.rollGroup);
    wheel.caliper = new THREE.Object3D(); wheel.caliper.position.set(0, 0.1, -0.15); wheel.add(wheel.caliper);
    return wheel;
  });
}

test('rolling direction and angular distance match forward travel, pause and return poses are stable', () => {
  const all = wheels();
  animateWheels(all, 0.036, 0);
  for (const wheel of all) {
    assert.ok(Math.abs(wheel.rollGroup.rotation.x - 0.1) < 1e-12);
    const bottom = new THREE.Vector3(0, -0.36, 0).applyQuaternion(wheel.rollGroup.quaternion);
    assert.ok(bottom.z < 0, 'bottom tread must move backward relative to a forward-moving car');
    assert.equal(wheel.rotation.y, 0);
  }
  const pose = () => all.map(wheel => [wheel.quaternion.toArray(), wheel.rollGroup.quaternion.toArray()]);
  const before = pose(); animateWheels(all, 0.036, 0); assert.deepEqual(pose(), before);
  animateWheels(all, 12, 0.05); assert.notDeepEqual(pose(), before);
  animateWheels(all, 0.036, 0); assert.deepEqual(pose(), before);
});

test('Ackermann front steering follows both curve directions; rear wheels and calipers do not spin together', () => {
  const all = wheels(), [lf, rf, lb, rb] = all;
  animateWheels(all, 2, 0.08, 1.72);
  assert.ok(rf.rotation.y < lf.rotation.y && lf.rotation.y < 0, 'right curve: right wheel turns farther inward');
  assert.equal(lb.rotation.y, 0); assert.equal(rb.rotation.y, 0);
  all.forEach(wheel => wheel.updateMatrixWorld(true));
  const calipers = all.map(wheel => wheel.caliper.matrixWorld.clone());
  animateWheels(all, 2.2, 0.08, 1.72);
  all.forEach((wheel, i) => { wheel.updateMatrixWorld(true); assert.ok(wheel.caliper.matrixWorld.equals(calipers[i])); });
  animateWheels(all, 2.2, -0.08, 1.72);
  assert.ok(lf.rotation.y > rf.rotation.y && rf.rotation.y > 0, 'left curve: left wheel turns farther inward');
  animateWheels(all, 2.2, 0); assert.ok(all.every(wheel => wheel.rotation.y === 0));
  animateWheels(all, 2.2, 5, 1.72);
  assert.ok(all.every(wheel => Number.isFinite(wheel.rotation.y) && Math.abs(wheel.rotation.y) <= Math.PI / 5));
});
