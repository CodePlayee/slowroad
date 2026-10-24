// src/vehicle/vehicle.js — loaded vehicle, procedural fallback and route autodrive.
// Owned by the JOURNEY builder agent.

import * as THREE from 'three';
import { VEHICLE as V } from './params.js';
import { crossSection } from '../world/world.js';
import { clamp, lerp } from '../core/rng.js';
import { loadVehicleAsset } from './asset.js';
import { animateWheels } from './wheels.js';

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
        lateral: sx * V.trackWidth / 2, wheelbase: V.wheelbase });
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

    // headlight cones
    this.headlight = new THREE.SpotLight(0xfff0d4, 0, 90, 0.42, 0.55, 1.2);
    this.headlight.position.set(0, 0.66, 2.1);
    this.headlight.target.position.set(0, 0.0, 30);
    this.group.add(this.headlight, this.headlight.target);

    this.s = this.route.kmToS(0);
    this.speed = V.cruiseKph / 3.6;
    this.pos = new THREE.Vector3();
    this.heading = 0;
    this.grade = 0;
    this._q = {};
    this.assetWheels = [];
    this.assetMaterials = [];
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

  /** Deterministic placement at arc length s, no smoothing. */
  snapTo(s) {
    this.s = this.route.clampS(s);
    // Roll depends on speed, so restoring only the position is not deterministic.
    this.speed = V.cruiseKph / 3.6;
    this._place(0, true);
  }

  targetSpeed() {
    const p = this.route.at(this.s, this._q);
    const c = Math.abs(p.curv);
    let v = V.maxKph / 3.6;
    if (c > 1e-5) v = Math.min(v, Math.sqrt(V.latAccel / c));
    // look ahead so it slows before the corner
    for (let d = 20; d <= 120; d += 20) {
      const q = this.route.at(this.s + d, {});
      const cc = Math.abs(q.curv);
      if (cc > 1e-5) v = Math.min(v, Math.sqrt(V.latAccel / cc) + d * 0.06);
    }
    return clamp(v, V.minKph / 3.6, V.maxKph / 3.6);
  }

  update(dt) {
    let wrapped = false;
    if (dt > 0) {
      const tgt = this.targetSpeed();
      const a = tgt > this.speed ? V.accel : -V.brake;
      this.speed = a > 0 ? Math.min(tgt, this.speed + a * dt) : Math.max(tgt, this.speed + a * dt);
      this.s += this.speed * dt;
      if (this.s > this.route.length - 200) {
        this.s = this.route.kmToS(0);
        wrapped = true;
      }
    }
    this._place(dt, false);
    return wrapped;
  }

  _place(dt) {
    const p = this.route.at(this.s, this._q);
    const nx = -p.tz, nz = p.tx;
    const lat = V.laneOffset;
    const x = p.x + nx * lat, z = p.z + nz * lat;
    const y = p.y + crossSection(Math.abs(lat)) + V.rideHeight;
    this.pos.set(x, y, z);
    this.heading = Math.atan2(p.tz, p.tx);
    this.grade = p.grade;
    this.curv = p.curv;

    this.group.position.set(x, y, z);
    // model faces +Z, world heading is atan2(tz,tx) measured from +X
    this.group.rotation.set(0, -this.heading + Math.PI / 2, 0);
    // pitch with the road grade, roll into the corner a touch
    const pitch = -Math.atan(p.grade);
    const roll = clamp(-p.curv * this.speed * this.speed * 0.010, -0.055, 0.055);
    this.group.rotateX(pitch);
    this.group.rotateZ(roll);

    animateWheels(this.assetReady ? this.assetWheels : this.wheels,
      this.s - this.route.kmToS(0), p.curv, V.laneOffset);

    const night = 1 - (this.atmo.palette.dayness ?? 1);
    const on = night > 0.35;
    this.headlight.intensity = on ? 55 : 0;
    this.lampF.emissiveIntensity = on ? 2.4 : 0.35;
    if (this.assetEnvironment?.update?.(this.atmo)) {
      for (const material of this.assetMaterials) material.envMap = this.assetEnvironment.texture;
    }
    // The baked sky already contains day/night radiance; do not dim it twice.
    for (const material of this.assetMaterials) material.envMapIntensity = 0.6;
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
