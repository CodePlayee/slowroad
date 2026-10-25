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
const { CameraRig } = await import('../src/camera/cameras.js');
const { CAMERAS } = await import('../src/camera/params.js');

function fixture() {
  const world = { ground: () => 0 };
  const vehicle = { s: 1000, pos: new THREE.Vector3(1000, 0.145, 0), heading: 0,
    dimensions: { bodyLength: 4.79 }, setCockpit() {},
    route: { kmZero: 1000, at(s, out = {}) { return Object.assign(out, { x: s, y: 0, z: 0, tx: 1, tz: 0 }); } },
    cockpitPose(pos, aim) { pos.copy(this.pos).add(new THREE.Vector3(0, 1.3, 0.379)); aim.copy(pos); aim.x += 35; },
  };
  return { world, vehicle, rig: new CameraRig(vehicle, world) };
}

test('chase framing varies distance, height and both sides continuously within bounds', () => {
  const { vehicle, rig } = fixture();
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const tanPitch = Math.tan(CAMERAS.chase.pitch * Math.PI / 180);
  let previous;
  for (let distance = 0; distance <= 2000; distance++) {
    vehicle.s = 1000 + distance; vehicle.pos.x = vehicle.s;
    rig._target(rig._pos, rig._aim);
    const relative = [vehicle.pos.x - rig._pos.x, rig._pos.y - vehicle.pos.y, rig._pos.z];
    relative.forEach((value, i) => { min[i] = Math.min(min[i], value); max[i] = Math.max(max[i], value); });
    if (previous) relative.forEach((value, i) => assert.ok(Math.abs(value - previous[i]) < 0.04));
    previous = relative;
    assert.equal(rig._aim.x, vehicle.s + CAMERAS.chase.lookAhead);
    // level road, level ground either side: no lean, constant downward pitch
    assert.equal(rig._aim.z, 0);
    const horizontal = Math.hypot(rig._aim.x - rig._pos.x, rig._aim.z - rig._pos.z);
    assert.ok(Math.abs((rig._pos.y - rig._aim.y) / horizontal - tanPitch) < 1e-9);
  }
  assert.ok(min[0] >= 9.79 && max[0] <= 16.21 && max[0] - min[0] > 6);
  assert.ok(min[1] >= 3.4 && max[1] <= 7.0 && max[1] - min[1] > 2.5);
  assert.ok(min[2] < -3.7 && max[2] > 3.7);
});

test('1920x1080 chase composition stays on the reference framing through the drift cycle', () => {
  const { vehicle, rig } = fixture();
  rig.resize(1920, 1080);
  const point = new THREE.Vector3(), forward = new THREE.Vector3();
  for (let distance = 0; distance <= 2000; distance += 5) {
    vehicle.s = 1000 + distance; vehicle.pos.x = vehicle.s; rig.snap();
    rig.camera.getWorldDirection(forward);
    point.set(forward.x, 0, forward.z).normalize().multiplyScalar(1e5).add(rig.camera.position).project(rig.camera);
    const horizon = (1 - point.y) / 2;
    let x0 = Infinity, x1 = -Infinity, bottom = -Infinity;
    for (const x of [-2.395, 2.395]) for (const y of [0, 1.54]) for (const z of [-0.991, 0.991]) {
      point.set(vehicle.pos.x + x, vehicle.pos.y + y, z).project(rig.camera);
      x0 = Math.min(x0, point.x); x1 = Math.max(x1, point.x); bottom = Math.max(bottom, (1 - point.y) / 2);
    }
    const width = (x1 - x0) / 2;
    assert.ok(horizon > 0.27 && horizon < 0.31, `${distance}m horizon ${horizon}`);
    assert.ok(width > 0.07 && width < 0.21, `${distance}m car width ${width}`);
    assert.ok(bottom > 0.68 && bottom < 0.85, `${distance}m car bottom ${bottom}`);
  }
});

test('on a hillside the chase aim leans smoothly toward the lower side and stays deterministic', () => {
  const { vehicle, rig, world } = fixture();
  // ground falls to the right (+z) before x = 3000 and to the left after it
  world.ground = (x, z) => (x < 3000 ? -0.3 : 0.3) * z;
  const lean = [];
  for (let s = 2000; s <= 4000; s++) {
    vehicle.s = s; vehicle.pos.x = s;
    rig._target(rig._pos, rig._aim);
    lean.push(rig._aim.z); // heading +x: the right-hand normal is +z
  }
  assert.ok(Math.abs(lean[0] - CAMERAS.chase.open.aim) < 1e-9);
  assert.ok(Math.abs(lean.at(-1) + CAMERAS.chase.open.aim) < 1e-9);
  for (let k = 1; k < lean.length; k++) assert.ok(Math.abs(lean[k] - lean[k - 1]) < 0.05);
  vehicle.s = 3010; vehicle.pos.x = 3010; rig.snap();
  const first = rig.camera.quaternion.clone();
  rig._openRaw.clear(); rig._openSmooth.clear(); rig.snap();
  assert.ok(rig.camera.quaternion.equals(first));
});

test('damped driving has no sudden jumps, pause holds its current pose, and snap restores a deterministic view', () => {
  const { vehicle, rig } = fixture();
  rig.snap();
  const initialPosition = rig.camera.position.clone(), initialRotation = rig.camera.quaternion.clone();
  for (let frame = 0; frame < 3600; frame++) {
    const previous = rig.camera.position.clone(), rotation = rig.camera.quaternion.clone();
    vehicle.s += 0.5; vehicle.pos.x = vehicle.s;
    rig.update(1 / 60);
    assert.ok(rig.camera.position.distanceTo(previous) < 0.65);
    assert.ok(rig.camera.quaternion.angleTo(rotation) < 0.01);
  }
  const held = rig.camera.position.clone(), rotation = rig.camera.quaternion.clone();
  for (const dt of [0, 0, -1, NaN, Infinity]) rig.update(dt);
  assert.ok(rig.camera.position.equals(held)); assert.ok(rig.camera.quaternion.equals(rotation));
  vehicle.s = 1000; vehicle.pos.x = 1000; rig.snap();
  assert.ok(rig.camera.position.equals(initialPosition));
  assert.ok(rig.camera.quaternion.equals(initialRotation));
});

test('portrait framing contains the car throughout the drift cycle', () => {
  const { vehicle, rig } = fixture();
  const point = new THREE.Vector3();
  for (const [width, height] of [[1920, 1080], [390, 844], [320, 568], [844, 390]]) {
    rig.resize(width, height);
    for (let distance = 0; distance <= 2000; distance += 10) {
      vehicle.s = 1000 + distance; vehicle.pos.x = vehicle.s; rig.snap();
      for (const x of [-2.395, 2.395]) for (const y of [0, 1.54]) for (const z of [-1.06, 1.06]) {
        point.set(vehicle.pos.x + x, vehicle.pos.y + y, z).project(rig.camera);
        assert.ok(Math.abs(point.x) < 1 && Math.abs(point.y) < 1 && point.z < 1,
          `${width}x${height}, ${distance}m: ${point.toArray()}`);
      }
    }
  }
});

test('terrain clearance applies after damping, and cockpit remains attached to the seat', () => {
  const { vehicle, rig, world } = fixture();
  rig.snap();
  world.ground = () => 20;
  rig.update(1 / 60);
  assert.ok(rig.camera.position.y >= 21.4);
  rig.setMode('cockpit'); rig.update(0);
  assert.equal(rig.camera.position.y, vehicle.pos.y + 1.3);
  vehicle.s += 100; vehicle.pos.x = vehicle.s; rig.update(1 / 60);
  assert.equal(rig.camera.position.x, vehicle.pos.x);
  assert.equal(rig.camera.position.y, vehicle.pos.y + 1.3);
});

test('a paused resize reframes once for the new aspect rather than cropping a frozen side offset', () => {
  const { rig } = fixture();
  rig.snap(); const wideSide = rig.camera.position.z;
  rig.resize(390, 844); rig.update(0);
  assert.ok(Math.abs(rig.camera.position.z) < Math.abs(wideSide) / 3);
  const portrait = rig.camera.position.clone(); rig.update(0);
  assert.ok(rig.camera.position.equals(portrait));
});

test('cinematic side motion no longer jumps when its sine changes sign', () => {
  const { vehicle, rig } = fixture(); rig.setMode('cine');
  vehicle.s = Math.PI / 0.00037 - 0.01; vehicle.pos.x = vehicle.s;
  rig._target(rig._pos, rig._aim); const before = rig._pos.z;
  vehicle.s += 0.02; vehicle.pos.x = vehicle.s;
  rig._target(rig._pos, rig._aim);
  assert.ok(Math.abs(rig._pos.z - before) < 0.001);
});
