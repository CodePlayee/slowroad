import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as THREE from 'three';

const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  if (url.startsWith(src) && url.endsWith('.js')) {
    return { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
  }
  return next(url, context);
} });
const { Vehicle } = await import('../src/vehicle/vehicle.js');
const { VEHICLE } = await import('../src/vehicle/params.js');
const { Suspension } = await import('../src/vehicle/suspension.js');
const { Handling } = await import('../src/vehicle/handling.js');
const { CameraRig } = await import('../src/camera/cameras.js');
const { CAMERAS } = await import('../src/camera/params.js');
const { World } = await import('../src/world/world.js');

function vehicleFixture(km) {
  const world = new World(7).build();
  const vehicle = Object.assign(Object.create(Vehicle.prototype), {
    world, route: world.route, atmo: { palette: { dayness: 1 } },
    group: new THREE.Group(), interior: new THREE.Group(), pos: new THREE.Vector3(), _q: {}, _qt: {}, _qa: {}, _qb: {},
    suspension: new Suspension(VEHICLE.suspension, { track: VEHICLE.trackWidth, wheelbase: VEHICLE.wheelbase }),
    handling: new Handling(VEHICLE.handling, { wheelbase: VEHICLE.wheelbase, laneOffset: VEHICLE.laneOffset }),
    speed: VEHICLE.cruiseKph / 3.6,
    wheels: [], assetWheels: [], assetMaterials: [new THREE.MeshStandardMaterial()],
    headlight: new THREE.SpotLight(), lampF: new THREE.MeshStandardMaterial(),
  });
  vehicle.snapTo(world.route.kmToS(km));
  return vehicle;
}

const builtTiles = rig => new Set([...rig._canopy.tiles.values()].filter(e => e.crowns).map(e => e.key));
const reachNodes = rig => Object.values(rig._reachNodes).map(cache => [...cache.keys()].sort((a, b) => a - b));
const pose = rig => [...rig.camera.position.toArray(), ...rig.camera.quaternion.toArray()];

test('elevated-rig canopy data streams in every mode, so a switch into cine or vista computes nothing in-frame', () => {
  // km 12.1 is the wooded vista_wide station, where the cine eye is pulled out of crowns.
  const vehicle = vehicleFixture(12.1);
  const rig = new CameraRig(vehicle, vehicle.world);
  rig.snap();
  assert.equal(rig.mode, 'chase');
  // Background work keeps running while paused or holding a frame (zero-time
  // updates); without workers it advances on a small main-thread budget per call.
  const n = Math.floor(vehicle.s / CAMERAS.canopy.spacing);
  const done = () => rig._canopy && [...rig._canopy.tiles.values()].every(e => e.crowns) &&
    Object.values(rig._reachSmooth).every(cache => cache.has(n) && cache.has(n + 1));
  let calls = 0;
  do rig.update(0); while (++calls < 100000 && !done());
  const built = builtTiles(rig), nodes = reachNodes(rig);
  assert.ok(built.size > 0, 'chase must prefetch the elevated rigs\' tree tiles');
  assert.ok(nodes.every(keys => keys.length > 0), 'chase must precompute both elevated rigs\' clearance');
  assert.ok(calls > 2, 'background work is spread over many calls');

  // Prefetching only moves work earlier: poses equal a rig that builds everything on demand.
  const fresh = new CameraRig(vehicle, vehicle.world);
  for (const mode of ['cine', 'vista', 'cockpit', 'cine']) {
    rig.setMode(mode);
    rig.snap();
    assert.deepEqual(builtTiles(rig), built, `${mode} snap built tree tiles in-frame`);
    assert.deepEqual(reachNodes(rig), nodes, `${mode} snap tested canopy clearance in-frame`);
    fresh.setMode(mode);
    fresh.snap();
    assert.deepEqual(pose(rig), pose(fresh), `${mode} pose changed`);
  }
});

test('the chase lean stays current while another rig is active, so switching back computes nothing in-frame', () => {
  const world = { ground: (x, z) => 20 * Math.sin(x * 0.004) + 0.1 * z };
  const vehicle = { s: 1000, pos: new THREE.Vector3(1000, 0, 0), heading: 0, dimensions: { bodyLength: 4.79 }, setCockpit() {},
    route: { kmZero: 0, at(s, out = {}) { return Object.assign(out, { x: s, y: 0, z: 0, tx: 1, tz: 0 }); } },
    cockpitPose(pos, aim) { pos.copy(this.pos); pos.y += 1.2; aim.copy(pos); aim.x += 35; },
  };
  const rig = new CameraRig(vehicle, world);
  rig.setMode('cockpit');
  rig.snap();
  for (let s = 1000; s <= 1600; s += 0.5) { vehicle.s = vehicle.pos.x = s; rig.update(1 / 60); }
  const cached = [rig._openRaw.size, rig._openSmooth.size];
  rig.setMode('chase');
  rig.snap();
  assert.deepEqual([rig._openRaw.size, rig._openSmooth.size], cached);
  const fresh = new CameraRig(vehicle, world);
  fresh.snap();
  assert.deepEqual(pose(rig), pose(fresh));
});
