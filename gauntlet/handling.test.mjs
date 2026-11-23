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
const { bendRoute, polylineRoute } = await import('./route-stubs.mjs');

const G = 9.81, DEG = Math.PI / 180, dt = 1 / 60, CRUISE = V.cruiseKph / 3.6;
const geometry = { wheelbase: V.wheelbase, laneOffset: V.laneOffset };

function vehicleOn(route, s, speed = CRUISE) {
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
    world: { route }, route, atmo: { palette: { dayness: 1 } }, group, wheels,
    pos: new THREE.Vector3(), _q: {}, _qt: {}, _qa: {}, _qb: {},
    suspension: new Suspension(V.suspension, { track: V.trackWidth, wheelbase: V.wheelbase }),
    handling: new Handling(V.handling, geometry),
    assetWheels: [], assetMaterials: [], headlight: new THREE.SpotLight(), lampF: new THREE.MeshStandardMaterial(),
  });
  // Hold the speed so the lateral behaviour is measured on its own.
  vehicle.targetSpeed = () => speed;
  vehicle.snapTo(s);
  return vehicle;
}

// Per-frame body yaw (from the drawn pose), yaw rate, roll and lateral acceleration.
function drive(vehicle, seconds) {
  const out = [], e = vehicle.group.matrixWorld.elements;
  let yaw0 = null;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    vehicle.update(dt);
    vehicle.group.updateMatrixWorld(true);
    const yaw = Math.atan2(e[10], e[8]);
    let r = 0;
    if (yaw0 !== null) { r = yaw - yaw0; r -= 2 * Math.PI * Math.round(r / (2 * Math.PI)); r /= dt; }
    yaw0 = yaw;
    out.push({ r, roll: vehicle.suspension.roll, aLat: vehicle.suspension.input.aLat, offset: vehicle.handling.offset });
  }
  return out.slice(1);
}
const maxStep = (a, f) => a.slice(1).reduce((m, x, i) => Math.max(m, Math.abs(f(x) - f(a[i]))), 0);
const std = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };

test('handling: linear single-track response of a passenger car at highway speed', () => {
  const h = new Handling(V.handling, geometry);
  assert.ok(h.understeer > 0, 'understeers');
  for (const v of [15, 25, 30]) {
    const { hz, zeta } = h.modes(v);
    assert.ok(hz > 0.5 && hz < 2 && zeta > 0.5 && zeta < 1, `yaw mode ${hz.toFixed(2)} Hz, zeta ${zeta.toFixed(2)} at ${v} m/s`);
  }
});

test('handling: a steady bend is driven on the lane with the yaw rate, side force and steering of its radius', () => {
  const R = 300, vehicle = vehicleOn(bendRoute(1 / R), 200);
  const flat = vehicleOn(bendRoute(0), 200), bank = flat.suspension.roll;
  const late = drive(vehicle, 30).slice(-180);
  const H = vehicle.handling, v = vehicle.speed, k = 1 / (R - V.laneOffset);   // the lane runs inside the bend
  assert.ok(Math.abs(H.yawRate / (v * k) - 1) < 0.01, `yaw rate ${H.yawRate}`);
  assert.ok(Math.abs(H.aLat / (v * v * k) - 1) < 0.01, `lateral acceleration ${H.aLat}`);
  // Centimetres: the axle midpoint sits off the rear axle's path by the body slip.
  assert.ok(Math.abs(H.offset) < 0.04, `lane offset ${H.offset.toFixed(3)} m`);
  // Body roll to the outside by the roll gradient, on top of the lane's crossfall
  // bank (3 s mean: the road texture adds hundredths of a degree).
  const roll = late.reduce((s, o) => s + o.roll, 0) / late.length - bank;
  const expected = -V.suspension.rollGradient * DEG * H.aLat / G;
  assert.ok(Math.abs(roll / expected - 1) < 0.02, `roll ${(roll / DEG).toFixed(3)} deg, expected ${(expected / DEG).toFixed(3)}`);
  // The front wheels point into the bend by more than the geometric angle (understeer).
  const front = vehicle.wheels.filter(w => w.userData.front).map(w => -w.rotation.y);
  assert.ok(front.every(a => a > Math.atan(V.wheelbase * k)), 'steered into the bend');
  assert.ok(Math.abs(Math.atan(V.wheelbase * vehicle.curv) - H.steer) < 1e-12);
});

test('handling: a sudden bend is entered with continuous yaw, side force and roll', () => {
  // The centreline's curvature steps from 0 to 1/300 m^-1 without a transition.
  const vehicle = vehicleOn(bendRoute(1 / 300), 200), out = drive(vehicle, 20);
  const aLatStep = maxStep(out, o => o.aLat), yawStep = maxStep(out, o => o.r), rollRate = maxStep(out, o => o.roll) / dt;
  assert.ok(aLatStep < 0.05, `lateral acceleration jumps ${aLatStep.toFixed(3)} m/s^2 in a frame`);
  assert.ok(yawStep < 0.2 * DEG, `yaw rate jumps ${(yawStep / DEG).toFixed(3)} deg/s in a frame`);
  assert.ok(rollRate < 2.5 * DEG, `roll rate ${(rollRate / DEG).toFixed(2)} deg/s`);
  assert.ok(out.every(o => Math.abs(o.offset) < 0.2), 'stays in its lane');
});

test('handling: a kinked polyline bend does not reach the body as yaw or roll rocking', () => {
  // 6.3 deg corners every 22 m (mean radius 210 m): curvature spikes between straight chords.
  const vehicle = vehicleOn(polylineRoute(1 / 210, 22), 300), out = drive(vehicle, 25).slice(300);
  const mean = out.reduce((s, o) => s + o.aLat, 0) / out.length;
  assert.ok(Math.abs(mean / (CRUISE ** 2 / (210 - V.laneOffset)) - 1) < 0.02, `mean lateral acceleration ${mean.toFixed(3)}`);
  assert.ok(std(out.map(o => o.aLat)) < 0.1, `lateral acceleration std ${std(out.map(o => o.aLat)).toFixed(3)} m/s^2`);
  assert.ok(maxStep(out, o => o.r) < 0.2 * DEG, `yaw rate jumps ${(maxStep(out, o => o.r) / DEG).toFixed(3)} deg/s in a frame`);
  assert.ok(std(out.map(o => o.roll)) < 0.1 * DEG, `roll std ${(std(out.map(o => o.roll)) / DEG).toFixed(3)} deg`);
  // The smooth path stays within the polyline's 0.29 m sagitta of the lane.
  assert.ok(out.every(o => Math.abs(o.offset) < 0.3), 'stays in its lane');
});

test('handling: the motion does not depend on the frame rate', () => {
  const route = bendRoute(1 / 250, 100), v = 26;
  const trace = (step) => {
    const h = new Handling(V.handling, geometry), out = [];
    let s = h.reset(route, 60, v);
    for (let i = 1; i <= Math.round(8 / step); i++) {
      s = h.advance(step, route, s, v, v);
      if (i % Math.round(1 / 6 / step) === 0) out.push([h.x, h.z, h.heading, h.yawRate, h.aLat, h.steer]);
    }
    return out;
  };
  const slow = trace(1 / 30), fast = trace(1 / 144);
  assert.equal(slow.length, fast.length);
  for (let i = 0; i < slow.length; i++) {
    assert.ok(Math.hypot(slow[i][0] - fast[i][0], slow[i][1] - fast[i][1]) < 2e-3, `position at sample ${i}`);
    for (let k = 2; k < 6; k++) assert.ok(Math.abs(slow[i][k] - fast[i][k]) < 1e-3 * (1 + Math.abs(fast[i][k])), `sample ${i}:${k}`);
  }
});

test('handling: reset is a steady state in a bend (no transient after a snap)', () => {
  const route = bendRoute(-1 / 200, 0), v = 24, h = new Handling(V.handling, geometry);
  let s = h.reset(route, 500, v);
  const start = [h.yawRate, h.aLat, h.steer, h.offset];
  for (let i = 0; i < 120; i++) {
    s = h.advance(dt, route, s, v, v);
    assert.ok(Math.abs(h.yawRate / start[0] - 1) < 0.01 && Math.abs(h.aLat / start[1] - 1) < 0.01, `frame ${i}`);
    assert.ok(Math.abs(h.steer / start[2] - 1) < 0.01 && Math.abs(h.offset - start[3]) < 0.01, `frame ${i}`);
  }
});

test('road texture: wheel tracks share the long undulations more than the short ones', () => {
  const n = 40000, corr = (rho) => {
    let ll = 0, rr = 0, lr = 0;
    for (let i = 0; i < n; i++) {
      const s = i * 0.37, l = roadTexture(s, 0, 1, 5, rho), r = roadTexture(s, 1, 1, 5, rho);
      ll += l * l; rr += r * r; lr += l * r;
    }
    return { c: lr / Math.sqrt(ll * rr), rms: Math.sqrt(ll / n) };
  };
  const none = corr([0, 0]), shared = corr([0.8, 0.4]), all = corr([1, 1]);
  assert.ok(Math.abs(none.c) < 0.1, `independent tracks correlate ${none.c.toFixed(3)}`);
  assert.ok(shared.c > 0.5 && shared.c < 0.85, `correlation ${shared.c.toFixed(3)}`);
  assert.ok(all.c > 0.999);
  // Mixing keeps each track's amplitude.
  assert.ok(Math.abs(shared.rms / none.rms - 1) < 0.1, `rms ${shared.rms.toFixed(4)} vs ${none.rms.toFixed(4)}`);
});
