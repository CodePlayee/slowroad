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
const { Hud } = await import('../src/ui/hud.js');
const { Atmosphere } = await import('../src/atmosphere/atmosphere.js');
const { Vehicle } = await import('../src/vehicle/vehicle.js');
const { VEHICLE } = await import('../src/vehicle/params.js');
const { CameraRig } = await import('../src/camera/cameras.js');
const { World } = await import('../src/world/world.js');

test('HUD treats arbitrary seed text as text, never HTML', () => {
  const elements = new Map();
  const previous = globalThis.document;
  globalThis.document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, {
      textContent: '',
      set innerHTML(_) { assert.fail('HUD must not parse runtime values as HTML'); },
    });
    return elements.get(id);
  } };
  try {
    const hud = new Hud();
    const seed = '<img src=x onerror="window.__hudXss=1">';
    hud.update(1, {
      vehicle: { speed: 10, km: 6 },
      cameras: { mode: 'chase' },
      atmo: { time: 12.5, seasonName: 'summer', weatherName: 'clear' },
      world: { seedInput: seed }, stats: { fps: 60 },
    });
    assert.ok(elements.get('hud-runtime').textContent.includes(seed));
    assert.ok(elements.get('hud-environment').textContent.includes('12:30'));
    assert.ok(elements.get('hud-mode').textContent.startsWith('AUTODRIVE'));
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test('season and weather reject inherited properties and preserve valid settings', () => {
  const atmo = new Atmosphere(new THREE.Scene(), {});
  atmo.set({ season: 'autumn', weather: 'clear' });
  for (const invalid of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'unknown', '', null]) {
    assert.doesNotThrow(() => atmo.set({ season: invalid, weather: invalid }));
    assert.equal(atmo.seasonName, 'autumn');
    assert.equal(atmo.weatherName, 'clear');
    assert.ok(Number.isFinite(atmo.palette.dayness));
  }
  atmo.set({ season: 'winter', weather: 'overcast' });
  assert.equal(atmo.seasonName, 'winter');
  assert.equal(atmo.weatherName, 'overcast');
});

function vehicleFixture() {
  const world = new World(7).build();
  const vehicle = Object.assign(Object.create(Vehicle.prototype), {
    world, route: world.route, atmo: { palette: { dayness: 1 } },
    group: new THREE.Group(), pos: new THREE.Vector3(), _q: {},
    speed: VEHICLE.cruiseKph / 3.6,
    wheels: [], assetWheels: [], assetMaterials: [new THREE.MeshStandardMaterial()],
    headlight: new THREE.SpotLight(), lampF: new THREE.MeshStandardMaterial(),
  });
  vehicle.snapTo(world.route.kmToS(6));
  return vehicle;
}

test('snap restores speed, full vehicle pose, and cockpit camera after driving', () => {
  const vehicle = vehicleFixture();
  const camera = new CameraRig(vehicle, vehicle.world);
  camera.mode = 'cockpit';
  camera.snap();
  const snapshot = () => ({
    speed: vehicle.speed, position: vehicle.pos.toArray(),
    rotation: vehicle.group.quaternion.toArray(),
    camera: camera.camera.position.toArray(), cameraRotation: camera.camera.quaternion.toArray(),
  });
  const start = snapshot(), s = vehicle.s;
  for (let i = 0; i < 50; i++) vehicle.update(0.05);
  assert.notEqual(vehicle.speed, start.speed);
  vehicle.snapTo(s);
  camera.snap();
  assert.deepEqual(snapshot(), start);
});

test('zero-time vehicle updates refresh day/night appearance without advancing', () => {
  const vehicle = vehicleFixture();
  const s = vehicle.s, speed = vehicle.speed;
  vehicle.atmo.palette.dayness = 0;
  vehicle.update(0);
  assert.equal(vehicle.headlight.intensity, VEHICLE.headlight.intensity);
  assert.equal(vehicle.assetMaterials[0].envMapIntensity, 0.6);
  vehicle.atmo.palette.dayness = 1;
  vehicle.update(0);
  assert.equal(vehicle.headlight.intensity, 0);
  assert.equal(vehicle.s, s);
  assert.equal(vehicle.speed, speed);
});

test('route wrap reports a discontinuity once, but never during a zero-time update', () => {
  const vehicle = vehicleFixture();
  vehicle.snapTo(vehicle.route.length - 200.01);
  const end = vehicle.s;
  assert.equal(vehicle.update(0), false);
  assert.equal(vehicle.s, end);
  assert.equal(vehicle.update(1 / 60), true);
  assert.equal(vehicle.s, vehicle.route.kmToS(0));
  assert.ok(vehicle.pos.toArray().every(Number.isFinite));
  assert.equal(vehicle.update(0), false);
  assert.equal(vehicle.update(1 / 60), false);
  assert.ok(vehicle.s > vehicle.route.kmToS(0));
});
