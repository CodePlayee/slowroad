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
const { Suspension, roadTexture } = await import('../src/vehicle/suspension.js');
const { Handling } = await import('../src/vehicle/handling.js');
const { Vehicle } = await import('../src/vehicle/vehicle.js');
const { VEHICLE: V } = await import('../src/vehicle/params.js');
const { World } = await import('../src/world/world.js');
const { bendRoute } = await import('./route-stubs.mjs');

const G = 9.81, DEG = Math.PI / 180;
const model = () => new Suspension(V.suspension, { track: V.trackWidth, wheelbase: V.wheelbase });
const overshoot = zeta => Math.exp(-Math.PI * zeta / Math.sqrt(1 - zeta * zeta));

// Input as a function of absolute time, sampled at fraction f of each frame.
function driver(fill) {
  return { t0: 0, dt: 0, sampleSuspension(f, input) {
    input.ud.fill(0); input.aLong = 0; input.aLat = 0;
    fill(this.t0 + f * this.dt, input);
  } };
}
function run(sus, source, dt, seconds, each) {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) {
    source.t0 = i * dt; source.dt = dt;
    sus.advance(dt, source);
    each?.((i + 1) * dt, sus);
  }
}
function settle(sus, fill) {
  sus.input.u.fill(0); sus.input.ud.fill(0); sus.input.aLong = 0; sus.input.aLat = 0;
  fill?.(0, sus.input);
  sus.reset(sus.input);
}

test('modes: natural frequencies and damping ratios are those of a passenger car', () => {
  const { heave, pitch, roll } = model().modes;
  for (const mode of [heave, pitch, roll]) {
    assert.ok(mode.hz >= 1.1 && mode.hz <= 2.2, `${mode.hz} Hz`);
    assert.ok(mode.zeta >= 0.3 && mode.zeta <= 0.5, `zeta ${mode.zeta}`);
  }
});

test('heave step: a 5 cm road rise settles with the overshoot and period of the bounce mode', () => {
  const sus = model(), step = 0.05;
  settle(sus);
  let peak = -Infinity, peakT = 0;
  run(sus, driver((t, input) => input.u.fill(step)), 1 / 60, 6, (t, s) => {
    if (s.Y > peak) { peak = s.Y; peakT = t; }
  });
  const zeta = sus.modes.heave.zeta;
  assert.ok(Math.abs((peak - step) / step - overshoot(zeta)) < 0.02, `overshoot ${((peak - step) / step).toFixed(3)}`);
  const tPeak = 1 / (2 * V.suspension.heaveHz * Math.sqrt(1 - zeta * zeta));
  assert.ok(Math.abs(peakT - tPeak) < 0.03, `peak at ${peakT.toFixed(3)} s, expected ${tPeak.toFixed(3)} s`);
  assert.ok(Math.abs(sus.Y - step) < 1e-4 && Math.abs(sus.pitch) < 1e-9 && Math.abs(sus.roll) < 1e-9);
});

test('braking dives the nose, traction squats it, with the pitch mode overshoot', () => {
  const P = V.suspension, sus = model();
  settle(sus);
  let low = Infinity;
  run(sus, driver((t, input) => { input.aLong = -V.brake; }), 1 / 60, 6, (t, s) => { low = Math.min(low, s.pitch); });
  const expected = -P.sprungMass * P.cgHeight * (1 - P.antiDive) * V.brake / sus.kPitch;
  assert.ok(expected < -0.5 * DEG && expected > -2 * DEG, `dive ${(expected / DEG).toFixed(2)} deg`);
  assert.ok(Math.abs(sus.pitch / expected - 1) < 1e-3, 'settles at the static dive');
  assert.ok(Math.abs((low - expected) / expected - overshoot(sus.modes.pitch.zeta)) < 0.02);
  assert.ok(sus.compression[0] > 0.01 && sus.compression[1] > 0.01, 'front springs compress');
  assert.ok(sus.compression[2] < -0.01 && sus.compression[3] < -0.01, 'rear springs extend');
  settle(sus);
  run(sus, driver((t, input) => { input.aLong = V.accel; }), 1 / 60, 6);
  assert.ok(sus.pitch > 0.3 * DEG, 'nose rises under traction');
});

test('cornering rolls the body to the outside by the roll gradient', () => {
  const P = V.suspension;
  for (const sign of [1, -1]) {
    // aLat > 0: right-hand turn (positive route curvature); +X is the left side.
    const sus = model();
    settle(sus);
    run(sus, driver((t, input) => { input.aLat = sign * V.latAccel; }), 1 / 60, 6);
    const expected = -sign * P.rollGradient * DEG * V.latAccel / G;
    assert.ok(Math.abs(sus.roll / expected - 1) < 1e-3, `roll ${(sus.roll / DEG).toFixed(2)} deg`);
    assert.ok(Math.abs(expected) < 3 * DEG && Math.abs(expected) > 1 * DEG);
    const left = sus.compression[0] + sus.compression[2], right = sus.compression[1] + sus.compression[3];
    assert.ok(sign > 0 ? left > right + 0.02 : right > left + 0.02, 'outside wheels compress');
  }
});

test('crossfall: the body lies on the road plane and leans slightly toward the low side', () => {
  const sus = model(), cross = 0.022;
  const fill = (t, input) => { for (let i = 0; i < 4; i++) input.u[i] = (i & 1 ? -1 : 1) * cross * V.trackWidth / 2; };
  settle(sus, fill);
  assert.ok(sus.roll > cross && sus.roll < cross + 0.2 * DEG, `roll ${(sus.roll / DEG).toFixed(3)} deg`);
});

test('frame-rate independence: 1/30 s and 1/144 s frames give the same motion', () => {
  const fill = (t, input) => {
    // Braking from 0.5 s, a corner from 1 s and a 3 cm crest under the front axle at 1.5 s.
    input.aLong = t > 0.5 ? -3 : 0;
    input.aLat = t > 1 ? Math.min(1, t - 1) * 2.5 : 0;
    const bump = t > 1.5 ? 0.03 * Math.sin(Math.min(Math.PI, (t - 1.5) * 4)) : 0;
    input.u[0] = input.u[1] = bump;
  };
  const trace = (dt) => {
    const sus = model(), out = [];
    settle(sus);
    run(sus, driver(fill), dt, 3, (t, s) => {
      if (Math.abs(t * 6 - Math.round(t * 6)) < 1e-9) out.push([s.Y, s.pitch, s.roll, ...s.compression]);
    });
    return out;
  };
  const slow = trace(1 / 30), fast = trace(1 / 144);
  assert.equal(slow.length, 18);
  assert.equal(fast.length, 18);
  for (let i = 0; i < slow.length; i++) {
    for (let k = 0; k < slow[i].length; k++) assert.ok(Math.abs(slow[i][k] - fast[i][k]) < 1e-9, `sample ${i}:${k}`);
  }
});

test('steady state: a body reset on a constant grade and crossfall has no transient', () => {
  const sus = model(), v = 25, grade = 0.07;
  const fill = (t, input) => {
    for (let i = 0; i < 4; i++) {
      const z = i < 2 ? V.wheelbase / 2 : -V.wheelbase / 2, x = i & 1 ? -V.trackWidth / 2 : V.trackWidth / 2;
      input.u[i] = 300 + grade * (v * t + z) + 0.022 * x;
      input.ud[i] = grade * v;
    }
    input.aLat = 1.2;
  };
  settle(sus, fill);
  const start = [sus.pitch, sus.roll, sus.Y - sus.input.u[0]];
  run(sus, driver(fill), 1 / 60, 3, (t, s) => {
    assert.ok(Math.abs(s.pitch - start[0]) < 1e-9 && Math.abs(s.roll - start[1]) < 1e-9);
    assert.ok(Math.abs(s.Y - s.input.u[0] - start[2]) < 1e-9);
  });
  // Climbing at constant speed loads the rear axle like traction: a slight squat.
  assert.ok(sus.pitch > Math.atan(grade));
});

test('extreme inputs stay finite and inside the travel', () => {
  const sus = model();
  settle(sus);
  run(sus, driver((t, input) => {
    input.u.fill(t > 0.2 ? 0.6 : 0); input.u[1] = -0.4;
    input.aLong = -40; input.aLat = 60;
  }), 0.05, 4, (t, s) => {
    for (const value of [s.Y, s.pitch, s.roll]) assert.ok(Number.isFinite(value));
    for (const c of s.compression) assert.ok(c <= V.suspension.bump && c >= -V.suspension.rebound);
  });
});

const world7 = new World(7).build();
function vehicleFixture(km, route = world7.route) {
  const world = { route };
  const group = new THREE.Group(), wheels = [];
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const wheel = new THREE.Group();
    wheel.position.set(sx * V.trackWidth / 2, V.wheelRadius - V.rideHeight, sz * V.wheelbase / 2);
    wheel.rollGroup = new THREE.Group(); wheel.add(wheel.rollGroup);
    Object.assign(wheel.userData, { front: sz > 0, radius: V.wheelRadius, lateral: sx * V.trackWidth / 2,
      wheelbase: V.wheelbase, restY: wheel.position.y });
    group.add(wheel); wheels.push(wheel);
  }
  const vehicle = Object.assign(Object.create(Vehicle.prototype), {
    world, route: world.route, atmo: { palette: { dayness: 1 } }, group, wheels,
    pos: new THREE.Vector3(), _q: {}, _qt: {}, _qa: {}, _qb: {},
    suspension: new Suspension(V.suspension, { track: V.trackWidth, wheelbase: V.wheelbase }),
    handling: new Handling(V.handling, { wheelbase: V.wheelbase, laneOffset: V.laneOffset }),
    assetWheels: [], assetMaterials: [], headlight: new THREE.SpotLight(), lampF: new THREE.MeshStandardMaterial(),
  });
  vehicle.snapTo(route.kmToS(km));
  return vehicle;
}

// Wheel index i in the fixture matches suspension corner i (LF, RF, LB, RB).
function wheelHeights(vehicle) {
  vehicle.group.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  return vehicle.wheels.map((wheel, i) => wheel.getWorldPosition(p).y - vehicle.suspension.input.u[i]);
}

test('vehicle: wheels stay on their road contact while the body pitches, rolls and heaves', () => {
  const vehicle = vehicleFixture(2);
  const rest = wheelHeights(vehicle);
  let travel = 0, roll = 0;
  for (let i = 0; i < 60 * 40; i++) {
    vehicle.update(1 / 60);
    const now = wheelHeights(vehicle);
    // Millimetre residue: the rigid body's small-angle geometry on grades.
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(now[k] - rest[k]) < 0.004, `wheel ${k} drifts ${(now[k] - rest[k]).toFixed(4)} m`);
    for (const c of vehicle.suspension.compression) travel = Math.max(travel, Math.abs(c));
    roll = Math.max(roll, Math.abs(vehicle.suspension.roll - 0.022));
    // The path frame used by cameras and the contact shadow is the car's own
    // smooth path, carries no body motion and stays in the lane.
    assert.ok(vehicle.pos.x === vehicle.handling.x && vehicle.pos.z === vehicle.handling.z);
    assert.ok(Math.abs(vehicle.handling.offset) < 0.3, `lane offset ${vehicle.handling.offset.toFixed(3)} m`);
  }
  assert.ok(travel > 0.015, `suspension travel ${travel.toFixed(3)} m`);
  assert.ok(roll > 0.5 * DEG, 'the body rolls in corners');
});

test('vehicle: snapTo restores the identical equilibrium pose after driving', () => {
  const vehicle = vehicleFixture(3.1), s = vehicle.s;
  const pose = () => [vehicle.group.matrixWorld.toArray(), ...vehicle.wheels.map(w => w.matrixWorld.toArray())];
  vehicle.group.updateMatrixWorld(true);
  const start = pose();
  for (let i = 0; i < 300; i++) vehicle.update(1 / 60);
  vehicle.group.updateMatrixWorld(true);
  assert.notDeepEqual(pose(), start);
  vehicle.snapTo(s);
  vehicle.group.updateMatrixWorld(true);
  assert.deepEqual(pose(), start);
  // A fresh vehicle snapped to the same place agrees too.
  const other = vehicleFixture(3.1);
  other.group.updateMatrixWorld(true);
  assert.deepEqual(pose(), [other.group.matrixWorld.toArray(), ...other.wheels.map(w => w.matrixWorld.toArray())]);
});

test('vehicle: body motion does not depend on the frame rate', () => {
  const sample = (dt) => {
    const vehicle = vehicleFixture(4.4), out = [];
    for (let i = 1; i <= Math.round(12 / dt); i++) {
      vehicle.update(dt);
      if (i % Math.round(1 / dt) === 0) out.push([vehicle.suspension.pitch, vehicle.suspension.roll]);
    }
    return out;
  };
  // The autodrive's Euler speed integration lets s drift by centimetres
  // between the two runs; the body pose agrees to a few hundredths of a degree.
  const slow = sample(1 / 30), fast = sample(1 / 144);
  assert.equal(slow.length, 12);
  for (let i = 0; i < slow.length; i++) {
    assert.ok(Math.abs(slow[i][0] - fast[i][0]) < 0.05 * DEG, `pitch at ${i + 1} s`);
    assert.ok(Math.abs(slow[i][1] - fast[i][1]) < 0.05 * DEG, `roll at ${i + 1} s`);
  }
});

test('autodrive: smooth, jerk-limited speed that respects the corner comfort limit', () => {
  const vehicle = vehicleFixture(1), dt = 1 / 60;
  let a0 = 0, worstJerk = 0, worstLat = 0, vMax = 0;
  for (let i = 0; i < 60 * 150; i++) {
    const v0 = vehicle.speed;
    vehicle.update(dt);
    const a = (vehicle.speed - v0) / dt;
    if (i > 0) worstJerk = Math.max(worstJerk, Math.abs(a - a0) / dt);
    a0 = a;
    // The car's own lateral acceleration (tyre side force over mass).
    worstLat = Math.max(worstLat, Math.abs(vehicle.handling.aLat));
    vMax = Math.max(vMax, vehicle.speed);
  }
  assert.ok(worstJerk <= V.jerk + 1e-6, `jerk ${worstJerk.toFixed(2)} m/s^3`);
  assert.ok(worstLat < V.latAccel * 1.15, `lateral ${worstLat.toFixed(2)} m/s^2`);
  assert.ok(vMax <= V.maxKph / 3.6 + 1e-6);
});

test('cockpit: the body drops the static crossfall bank, keeps corner roll and braking dive', () => {
  const straight = { at: (s, q) => Object.assign(q, { x: s, y: 0, z: 0, tx: 1, tz: 0, grade: 0, curv: 0 }),
    kmToS: () => 0, clampS: s => s, sToKm: s => s / 1000, ds: 5.5, length: 1e5, seed: 0 };
  const attitude = (vehicle) => {
    vehicle.group.updateMatrixWorld(true);
    const e = vehicle.group.matrixWorld.elements;
    return { pitch: Math.asin(e[9]), roll: Math.asin(e[1]) };   // nose up, left side up
  };
  const vehicle = vehicleFixture(2);
  Object.assign(vehicle, { route: straight });
  vehicle.snapTo(1000);
  const outside = attitude(vehicle).roll;
  assert.ok(outside > 1.1 * DEG && outside < 1.6 * DEG, `exterior body banks with the lane: ${(outside / DEG).toFixed(2)} deg`);
  vehicle.cockpitMode = true;
  vehicle.update(0);
  // Only the subtle road texture remains: as level as HEAD's body on this lane.
  assert.ok(Math.abs(attitude(vehicle).roll) < 0.1 * DEG, `cockpit roll ${(attitude(vehicle).roll / DEG).toFixed(3)} deg`);

  // Braking into a left-hand bend entered above its comfort speed: dynamic roll and dive remain.
  const driven = vehicleFixture(0.395, bendRoute(-1 / 120));
  driven.cockpitMode = true;
  driven.snapTo(driven.s);
  for (let i = 0; i < 97; i++) driven.update(1 / 60);
  const u = driven.suspension.input.u;
  const chord = Math.atan(((u[0] + u[1]) - (u[2] + u[3])) / (2 * V.wheelbase));
  const { pitch, roll } = attitude(driven);
  assert.ok(driven.accel < -2 && driven.handling.aLat < -2, 'braking in a left-hand corner');
  assert.ok(roll > 1 * DEG, `cockpit rolls toward the outside: ${(roll / DEG).toFixed(2)} deg`);
  assert.ok(pitch - chord < -0.4 * DEG, `cockpit dives: ${((pitch - chord) / DEG).toFixed(2)} deg`);
  const eye = new THREE.Vector3(), aim = new THREE.Vector3();
  driven.cockpitPose(eye, aim);
  assert.ok(Math.atan2(aim.y - eye.y, Math.hypot(aim.x - eye.x, aim.z - eye.z)) - chord < -0.4 * DEG, 'the view dives with the body');
});
