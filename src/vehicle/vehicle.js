// src/vehicle/vehicle.js — loaded vehicle, procedural fallback and route autodrive.
// Owned by the JOURNEY builder agent.

import * as THREE from 'three';
import { VEHICLE as V } from './params.js';
import { crossSection } from '../world/world.js';
import { clamp, lerp } from '../core/rng.js';
import { loadVehicleAsset } from './asset.js';
import { animateWheels, travelWheels } from './wheels.js';
import { Suspension, roadTexture } from './suspension.js';
import { Handling } from './handling.js';
import { createHeadlight, createTailSpill } from './lamps.js';
import { updateRearMirror } from './mirror.js';

// Low body is a tapered longitudinal mesh.  Keeping the shoulder below the cabin
// prevents an opaque extruded side profile from swallowing the glazing.
function lowerBodyGeometry() {
  const stations = [
    [-2.20, 1.48, 0.20, 0.58], [-2.08, 1.70, 0.20, 0.70],
    [-1.50, 1.80, 0.20, 0.78], [-0.70, 1.84, 0.20, 0.84],
    [0.65, 1.84, 0.20, 0.82], [1.45, 1.78, 0.20, 0.74],
    [2.08, 1.62, 0.20, 0.63], [2.20, 1.42, 0.20, 0.48],
  ];
  const verts = [];
  for (const [z, width, bottom, top] of stations) {
    const w = width * 0.5;
    const low = bottom + 0.16;
    for (const [x, y] of [[-w * 0.76, low], [-w, low + 0.06], [-w, top - 0.08],
      [-w * 0.88, top], [w * 0.88, top], [w, top - 0.08], [w, low + 0.06], [w * 0.76, low]]) {
      verts.push(x, y, z);
    }
  }
  const idx = [];
  const n = stations.length;
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < 8; k++) {
      const j = (k + 1) % 8, a = i * 8 + k, b = (i + 1) * 8 + k;
      idx.push(a, b, (i + 1) * 8 + j, a, (i + 1) * 8 + j, i * 8 + j);
    }
  }
  for (const end of [0, n - 1]) {
    const center = verts.length / 3;
    verts.push(0, (stations[end][2] + 0.16 + stations[end][3]) * 0.5, stations[end][0]);
    for (let k = 0; k < 8; k++) {
      const a = end * 8 + k, b = end * 8 + (k + 1) % 8;
      if (end === 0) idx.push(center, a, b); else idx.push(center, b, a);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

function panelGeometry(points) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

// Smallest visible cabin depth from the eye is 0.255 m (supplied GLB); 1.45 puts
// it at 0.37 m, beyond the 0.35 m near plane. Visible cabin surfaces stay in
// front of the road plane seen along the same rays up to a factor of 1.86.
const COCKPIT_CABIN_SCALE = 1.45;

// Crossfall slope across the wheel tracks of the lane (left side higher > 0).
const LANE_CROSSFALL = (crossSection(Math.abs(V.laneOffset - V.trackWidth / 2)) -
  crossSection(Math.abs(V.laneOffset + V.trackWidth / 2))) / V.trackWidth;

export class Vehicle {
  constructor(world, atmo) {
    this.world = world;
    this.route = world.route;
    this.atmo = atmo;
    this.group = new THREE.Group();
    this.group.name = 'vehicle';

    const bodyMat = new THREE.MeshStandardMaterial({ color: V.bodyColor, roughness: 0.32, metalness: 0.12 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x243e51, roughness: 0.18, metalness: 0.15, side: THREE.DoubleSide });
    const tyreMat = new THREE.MeshStandardMaterial({ color: V.tyreColor, roughness: 0.92 });
    const rimMat = new THREE.MeshStandardMaterial({ color: V.rimColor, roughness: 0.42, metalness: 0.75 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x20262d, roughness: 0.52, metalness: 0.45 });
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xb8c1c9, roughness: 0.22, metalness: 0.9 });
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xf3d320, roughness: 0.5, metalness: 0.05 });
    const lampR = new THREE.MeshStandardMaterial({ color: 0x2a0608, emissive: 0xd8202c, emissiveIntensity: 0.9, roughness: 0.4 });
    const lampF = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, emissive: 0xfff3d8, emissiveIntensity: 0.4, roughness: 0.2 });
    for (const m of [bodyMat, glassMat, tyreMat, rimMat, trimMat, chromeMat, plateMat, lampR, lampF]) atmo.register(m);
    this.lampF = lampF;
    this.lampR = lampR;

    const body = new THREE.Mesh(lowerBodyGeometry(), bodyMat);
    body.castShadow = true; body.receiveShadow = true;
    this.group.add(body);
    // Cabin is intentionally assembled from thin panels so the silhouette and
    // transparent surfaces remain legible from chase and cine cameras.
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.36, 0.065, 1.04), bodyMat);
    roof.position.set(0, 1.34, -0.08); this.group.add(roof);
    const windshield = new THREE.Mesh(panelGeometry([[-0.81, 0.85, 1.06], [0.81, 0.85, 1.06], [0.66, 1.315, 0.44], [-0.66, 1.315, 0.44]]), glassMat);
    this.group.add(windshield);
    const rearWindow = new THREE.Mesh(panelGeometry([[0.79, 0.85, -1.16], [-0.79, 0.85, -1.16], [-0.66, 1.315, -0.60], [0.66, 1.315, -0.60]]), glassMat);
    this.group.add(rearWindow);
    for (const sx of [-1, 1]) {
      const sideWin = new THREE.Mesh(panelGeometry([[sx * 0.81, 0.85, 1.02], [sx * 0.79, 0.85, -1.12], [sx * 0.675, 1.31, -0.60], [sx * 0.675, 1.31, 0.43]]), glassMat);
      this.group.add(sideWin);
    }

    // Simple layered planes make the low-poly shell read as a modern coupe.
    const hood = new THREE.Mesh(new THREE.BoxGeometry(1.54, 0.055, 0.92), bodyMat);
    hood.position.set(0, 0.83, 1.50); hood.rotation.x = -0.055;
    this.group.add(hood);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.06, 0.60), bodyMat);
    deck.position.set(0, 0.83, -1.54); deck.rotation.x = 0.045;
    this.group.add(deck);
    for (const sx of [-1, 1]) {
      const shoulder = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.075, 3.02), bodyMat);
      shoulder.position.set(sx * 0.86, 0.74, 0.0);
      this.group.add(shoulder);
    }

    for (const sx of [-1, 1]) {
      const sill = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 1.68), trimMat);
      sill.position.set(sx * 0.86, 0.80, 0.0); this.group.add(sill);
    }
    // Slim pillars and a contrasting shoulder line give the cabin a coupe profile.
    for (const sx of [-1, 1]) {
      for (const [z, rot] of [[0.73, -0.48], [-0.71, 0.48]]) {
        const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.50, 0.075), trimMat);
        pillar.position.set(sx * 0.925, 1.065, z); pillar.rotation.x = rot;
        this.group.add(pillar);
      }
    }

    // Lower aero, bumpers and rear valance create a grounded, shadow-catching stance.
    const sill = new THREE.Mesh(new THREE.BoxGeometry(1.88, 0.13, 3.28), trimMat);
    sill.position.y = 0.34; this.group.add(sill);
    const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.26, 0.16), trimMat);
    frontBumper.position.set(0, 0.36, 2.16); this.group.add(frontBumper);
    const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(1.74, 0.25, 0.16), trimMat);
    rearBumper.position.set(0, 0.36, -2.16); this.group.add(rearBumper);
    const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.13, 0.18), trimMat);
    diffuser.position.set(0, 0.25, -2.17); this.group.add(diffuser);
    for (const sx of [-1, 1]) {
      const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.16, 10), chromeMat);
      exhaust.rotation.x = Math.PI / 2; exhaust.position.set(sx * 0.53, 0.29, -2.27);
      this.group.add(exhaust);
    }
    const grille = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.15, 0.025), chromeMat);
    grille.position.set(0, 0.58, 2.245); this.group.add(grille);
    for (const sx of [-1, 1]) {
      const intake = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.105, 0.028), trimMat);
      intake.position.set(sx * 0.68, 0.48, 2.245); this.group.add(intake);
    }
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.10, 0.028), plateMat);
    plate.position.set(0, 0.48, -2.245); this.group.add(plate);

    // tail / head lamps
    const tl = new THREE.BoxGeometry(0.52, 0.13, 0.075);
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(tl, lampR);
      m.position.set(sx * 0.56, 0.66, -2.19);
      this.group.add(m);
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.10, 0.06), lampF);
      f.position.set(sx * 0.60, 0.62, 2.18);
      this.group.add(f);
      const lampBar = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.025, 0.018), chromeMat);
      lampBar.position.set(sx * 0.60, 0.73, -2.232); this.group.add(lampBar);
    }

    // Aerodynamic mirrors with black stalks.
    for (const sx of [-1, 1]) {
      const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.16), trimMat);
      stalk.position.set(sx * 0.99, 0.98, 0.68); stalk.rotation.x = -0.2;
      this.group.add(stalk);
      const mirror = new THREE.Mesh(new THREE.SphereGeometry(0.105, 10, 6), bodyMat);
      mirror.scale.set(0.45, 0.65, 1.25); mirror.position.set(sx * 1.02, 1.05, 0.72);
      this.group.add(mirror);
    }

    // wheels
    this.wheels = [];
    const tyre = new THREE.CylinderGeometry(V.wheelRadius, V.wheelRadius, V.wheelWidth, 18, 1);
    tyre.rotateZ(Math.PI / 2);
    const rim = new THREE.CylinderGeometry(V.wheelRadius * 0.62, V.wheelRadius * 0.62, V.wheelWidth + 0.012, 12, 1);
    rim.rotateZ(Math.PI / 2);
    for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const w = new THREE.Group();
      const t = new THREE.Mesh(tyre, tyreMat); t.castShadow = true;
      const r = new THREE.Mesh(rim, rimMat);
      w.add(t, r);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(V.wheelRadius * 0.42, V.wheelRadius * 0.42, V.wheelWidth + 0.018, 16), chromeMat);
      disc.rotation.z = Math.PI / 2; w.add(disc);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(V.wheelRadius * 0.15, V.wheelRadius * 0.15, V.wheelWidth + 0.03, 12), trimMat);
      hub.rotation.z = Math.PI / 2; w.add(hub);
      const arch = new THREE.Mesh(new THREE.TorusGeometry(V.wheelRadius * 1.06, 0.035, 8, 20, Math.PI), trimMat);
      arch.rotation.y = Math.PI / 2; arch.rotation.z = Math.PI; arch.position.x = sx * 0.05;
      w.position.set(sx * V.trackWidth / 2, V.wheelRadius, sz * V.wheelbase / 2);
      arch.position.add(w.position); this.group.add(arch);
      w.rollGroup = new THREE.Group();
      for (const child of [...w.children]) w.rollGroup.add(child);
      w.add(w.rollGroup);
      Object.assign(w.userData, { front: sz > 0, radius: V.wheelRadius,
        lateral: sx * V.trackWidth / 2, wheelbase: V.wheelbase, restY: w.position.y });
      this.group.add(w);
      this.wheels.push(w);
    }

    // ---- cockpit interior (only shown by the cockpit camera) ----
    this.interior = new THREE.Group();
    const dashMat = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.85 });
    const interiorTrim = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.7 });
    atmo.register(dashMat); atmo.register(interiorTrim);
    const dash = new THREE.Mesh(new THREE.BoxGeometry(1.34, 0.13, 0.34), dashMat);
    dash.position.set(0, 0.78, 1.02);
    this.interior.add(dash);
    const cowl = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.08, 0.26), dashMat);
    cowl.position.set(-0.34, 0.91, 0.90);
    this.interior.add(cowl);
    const wheelG = new THREE.TorusGeometry(0.185, 0.024, 8, 24);
    const wheelM = new THREE.Mesh(wheelG, interiorTrim);
    wheelM.position.set(-0.34, 0.91, 0.70);
    wheelM.rotation.x = 0.18;
    this.interior.add(wheelM);
    const hub = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.10), interiorTrim);
    hub.position.copy(wheelM.position);
    this.interior.add(hub);
    for (const sx of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.50, 0.030), interiorTrim);
      pillar.position.set(sx * 1.15, 1.38, 1.25);
      pillar.rotation.x = -0.42;
      this.interior.add(pillar);
    }
    this.group.add(this.interior);
    this.interior.traverse((obj) => { obj.userData.interior = true; });
    this.interior.visible = false;

    // Low-beam headlight (cookie-shaped SpotLight) and the tail lamps' faint
    // red spill onto the road and rear bodywork.
    this.headlight = createHeadlight();
    this.tailSpill = createTailSpill();
    this.group.add(this.headlight, this.headlight.target, this.tailSpill);
    this.lampMaterials = [];

    this.s = this.route.kmToS(0);
    this.speed = V.cruiseKph / 3.6;
    this.pos = new THREE.Vector3();
    this.heading = 0;
    this.grade = 0;
    this._q = {};
    this._qt = {};
    this._qa = {};
    this._qb = {};
    this.suspension = new Suspension(V.suspension, { track: V.trackWidth, wheelbase: V.wheelbase });
    this.handling = new Handling(V.handling, { wheelbase: V.wheelbase, laneOffset: V.laneOffset });
    this.assetWheels = [];
    this.assetMaterials = [];
    this.rearMirror = null;
    this.snapTo(this.s);
    this.assetReady = false;
    this.assetError = null;
    this.assetPromise = loadVehicleAsset(this).catch((error) => {
      this.assetError = String(error.message || error);
      console.error('Vehicle asset failed:', error);
    });
  }

  get km() { return this.route.sToKm(this.s); }
  get dimensions() { return V; }

  /** Deterministic placement at arc length s: cruise speed, lane centre, suspension at rest. */
  snapTo(s) {
    this.s = this.route.clampS(s);
    // Roll depends on speed, so restoring only the position is not deterministic.
    this.speed = V.cruiseKph / 3.6;
    this.accel = 0;
    this.handling.reset(this.route, this.s, this.speed);
    this._settle();
    this._place(0, true);
  }

  /** Suspension to its steady state at the current s and speed (no transient). */
  _settle() {
    this._s0 = this.s; this._v0 = this.speed; this._aFrame = 0;
    this._e0 = this.handling.offset; this._lat0 = this.handling.aLat;
    const input = this.suspension.input;
    this.sampleSuspension(1, input);
    this.suspension.reset(input);
  }

  /**
   * Suspension input at fraction f of the current frame: s, speed, the lane
   * offset and the lateral acceleration of the handling model move linearly
   * from the frame start; the frame's mean acceleration applies.
   */
  sampleSuspension(f, input) {
    const S = V.suspension, route = this.route, half = S.contactPatch, seed = route.seed | 0, H = this.handling;
    const s = this._s0 + (this.s - this._s0) * f, v = this._v0 + (this.speed - this._v0) * f;
    const offset = this._e0 + (H.offset - this._e0) * f;
    for (let axle = 0; axle < 2; axle++) {
      // The tyre averages the ribbon over its contact patch.
      const sa = s + (axle === 0 ? 0.5 : -0.5) * V.wheelbase;
      const a = route.at(sa - half, this._qa), b = route.at(sa + half, this._qb);
      const y = (a.y + b.y) / 2, slope = (b.y - a.y) / (2 * half);
      for (let side = 0; side < 2; side++) {
        // Left wheels (side 0) run nearer the crown.
        const lat = V.laneOffset + offset + (side === 0 ? -0.5 : 0.5) * V.trackWidth;
        const ta = roadTexture(sa - half, side, S.roughness, seed, S.roughnessCorrelation);
        const tb = roadTexture(sa + half, side, S.roughness, seed, S.roughnessCorrelation);
        input.u[axle * 2 + side] = y + (ta + tb) / 2 + crossSection(Math.abs(lat)) + V.rideHeight;
        input.ud[axle * 2 + side] = v * (slope + (tb - ta) / (2 * half));
      }
    }
    input.aLong = this._aFrame;
    // Side force of the tyres over the mass: the car's own path, not the route's.
    input.aLat = this._lat0 + (H.aLat - this._lat0) * f;
  }

  /**
   * Speed the autodrive aims for: the corner comfort limit sqrt(latAccel/c)
   * at every route node ahead, relaxed by a planned braking distance at
   * cornerDecel. The window reaches far enough that a node entering it cannot
   * bind, so the target is continuous in s with a bounded rate.
   */
  targetSpeed() {
    const route = this.route, s = this.s, vMin = V.minKph / 3.6, vMax = V.maxKph / 3.6, b = V.cornerDecel;
    const reach = (vMax * vMax - vMin * vMin) / (2 * b);
    const limits = this._cornerLimits();
    const f = s / route.ds, i = Math.min(limits.length - 2, Math.floor(f));
    let v2 = Math.min(vMax * vMax, lerp(limits[i], limits[i + 1], f - i));
    for (let n = Math.ceil(f), d = n * route.ds - s; d <= reach && n < limits.length; n++, d += route.ds) {
      v2 = Math.min(v2, limits[n] + 2 * b * d);
    }
    return clamp(Math.sqrt(v2), vMin, vMax);
  }

  /**
   * Squared corner comfort speed at every route node, computed once per
   * route. Like a driver judging a bend, it uses the mean curvature over
   * V.cornerSpan of road (the heading change across it), not one node's.
   */
  _cornerLimits() {
    const route = this.route;
    if (this._limitsRoute !== route) {
      const n = Math.floor(route.length / route.ds) + 1, w = Math.max(0, Math.round(V.cornerSpan / (2 * route.ds)));
      const sum = new Float64Array(n + 1);
      for (let k = 0; k < n; k++) sum[k + 1] = sum[k] + route.at(k * route.ds, this._qt).curv;
      const limits = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        const a = Math.max(0, k - w), b = Math.min(n, k + w + 1), c = Math.abs(sum[b] - sum[a]) / (b - a);
        // Finite on straights too, so the limit interpolates between nodes.
        limits[k] = V.latAccel / Math.max(c, 1e-5);
      }
      this._limits = limits;
      this._limitsRoute = route;
    }
    return this._limits;
  }

  update(dt) {
    let wrapped = false;
    if (dt > 0) {
      const s0 = this.s, v0 = this.speed, H = this.handling;
      const e0 = H.offset, lat0 = H.aLat;
      // Speed control with a jerk-limited acceleration, so the body sees
      // braking and traction loads build up and fade as in a real car. The
      // demand unwinds early enough (speed error a^2 / 2J, 20 % margin) to
      // settle on the target without overshoot.
      const e = this.targetSpeed() - this.speed;
      const demand = Math.sign(e) * Math.min(Math.abs(e) / V.speedLag, Math.sqrt(1.6 * V.jerk * Math.abs(e)));
      const want = clamp(demand, -V.brake, V.accel);
      this.accel += clamp(want - this.accel, -V.jerk * dt, V.jerk * dt);
      this.speed = Math.max(0, this.speed + this.accel * dt);
      // The car drives its own path; s is where that path stands along the route.
      this.s = H.advance(dt, this.route, s0, v0, this.speed);
      if (this.s > this.route.length - 200) {
        this.s = this.route.kmToS(0);
        wrapped = true;
      }
      if (wrapped) {
        H.reset(this.route, this.s, this.speed);
        this._settle();
      } else {
        this._s0 = s0; this._v0 = v0; this._aFrame = (this.speed - v0) / dt;
        this._e0 = e0; this._lat0 = lat0;
        this.suspension.advance(dt, this);
      }
    }
    this._place(dt, false);
    return wrapped;
  }

  _place(dt) {
    const p = this.route.at(this.s, this._q), H = this.handling;
    const x = H.x, z = H.z;
    const y = p.y + crossSection(Math.abs(V.laneOffset + H.offset)) + V.rideHeight;
    this.pos.set(x, y, z);
    this.heading = H.heading;
    this.grade = p.grade;
    // Path curvature the front wheels steer for (right turn > 0).
    this.curv = Math.tan(H.steer) / V.wheelbase;

    const sus = this.suspension;
    if (!sus.ready) this._settle();
    // The car's own path frame (pos, heading) is smooth for the cameras and
    // the contact shadow; the body rides on the suspension above it.
    this.group.position.set(x, sus.Y, z);
    // model faces +Z, world heading is atan2(tz,tx) measured from +X
    this.group.rotation.set(0, -this.heading + Math.PI / 2, 0);
    this.group.rotateX(-sus.pitch);
    // The cockpit camera keeps world up, so a body banked by the lane's
    // crossfall would show the cabin tilted against a level horizon. In the
    // cockpit the body drops that static bank (crossfall and its gravity
    // lean) and keeps its roll relative to the road: corners and bumps.
    const roll = this.cockpitMode ? sus.roll - sus.bankRoll(LANE_CROSSFALL) : sus.roll;
    this.group.rotateZ(roll);

    const wheels = this.assetReady ? this.assetWheels : this.wheels;
    animateWheels(wheels, this.s - this.route.kmToS(0), this.curv);
    // Wheels hold their road contact: travel into the arch, upright to the road.
    const u = sus.input.u;
    const crossfall = Math.atan(((u[0] + u[2]) - (u[1] + u[3])) / (2 * V.trackWidth));
    travelWheels(wheels, sus.compression, crossfall - roll, this.assetReady ? this.asset.scale.y : 1);

    const night = 1 - (this.atmo.palette.dayness ?? 1);
    const on = night > 0.35;
    this.headlight.intensity = on ? V.headlight.intensity : 0;
    this.lampF.emissiveIntensity = on ? 2.4 : 0.35;
    if (this.lampR) this.lampR.emissiveIntensity = on ? V.tailLight.emissive : 0.9;
    if (this.tailSpill) this.tailSpill.intensity = on ? V.tailLight.spill : 0;
    for (const material of this.lampMaterials || []) {
      material.emissiveIntensity = on
        ? (material.userData.lampRole === 'tail' ? V.tailLight.emissive : V.headlampEmissive) : 0;
    }
    if (this.assetEnvironment?.update?.(this.atmo)) {
      for (const material of this.assetMaterials) material.envMap = this.assetEnvironment.texture;
    }
    // The baked sky already contains day/night radiance; do not dim it twice.
    for (const material of this.assetMaterials) material.envMapIntensity = 0.6;
    if (this.rearMirror) updateRearMirror(this.rearMirror, this.atmo, this.s);
  }

  setCockpit(v) {
    this.cockpitMode = v;
    this.interior.visible = v && !this.assetReady;
    // Remove opaque exterior panels while looking from the driver's seat.
    this.group.traverse((obj) => {
      if (!obj.isMesh) return;
      if (this.assetReady && obj.userData.fallback) { obj.visible = false; return; }
      obj.visible = !v || !!obj.userData.interior;
    });
    // The headliner and upper door frame sit ~0.25 m from the driver's eye,
    // inside the camera's 0.35 m near plane, which cut them open (sky and a
    // stray black trim triangle above the A-pillar). Scaling the cabin about
    // the eye leaves its projection unchanged and moves every visible surface
    // beyond the near plane; only interior meshes are drawn in this mode.
    const base = this.assetBase;
    if (base) {
      const k = v ? COCKPIT_CABIN_SCALE : 1;
      this.asset.scale.setScalar(base.scale * k);
      this.asset.position.copy(base.position).sub(this.cockpitEye).multiplyScalar(k).add(this.cockpitEye);
    }
  }

  cockpitPose(pos, aim) {
    // Resolve the eye and look direction in vehicle-local space; this remains
    // correct on banked/graded sections where world-axis offsets drift.
    this.group.updateMatrixWorld(true);
    if (this.cockpitEye) pos.copy(this.cockpitEye); else pos.set(-0.34, 1.18, 0.10);
    aim.copy(pos); aim.z += 35; aim.y -= 0.025;
    this.group.localToWorld(pos);
    this.group.localToWorld(aim);
  }
}
