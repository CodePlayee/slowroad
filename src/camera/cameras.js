// src/camera/cameras.js — chase / cockpit / cine / vista rigs.
// All of them are pure functions of the vehicle state so a screenshot is reproducible:
// `snap()` places the camera with zero smoothing.

import * as THREE from 'three';
import { CAMERAS as C } from './params.js';
import { clamp, lerp } from '../core/rng.js';

export class CameraRig {
  constructor(vehicle, world) {
    this.vehicle = vehicle;
    this.world = world;
    this.camera = new THREE.PerspectiveCamera(C.chase.fov, 16 / 9, C.near, C.far);
    this.mode = 'chase';
    this.distScale = 1;
    this._pos = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._smoothPos = new THREE.Vector3();
    this._smoothAim = new THREE.Vector3();
    this._ahead = {};
    this._init = false;
  }

  setMode(m) {
    if (!['chase', 'cockpit', 'cine', 'vista'].includes(m)) m = 'chase';
    this.mode = m;
    this.vehicle.setCockpit(m === 'cockpit');
    const cfg = C[m];
    this.camera.fov = cfg.fov;
    this.camera.updateProjectionMatrix();
    this._init = false;
  }

  /** Compute the ideal (unsmoothed) camera placement. */
  _target(pos, aim) {
    const v = this.vehicle;
    const dirX = Math.cos(v.heading), dirZ = Math.sin(v.heading);
    const rgtX = -dirZ, rgtZ = dirX;
    const p = v.pos;

    if (this.mode === 'cockpit') {
      v.cockpitPose(pos, aim);
      return;
    }
    if (this.mode === 'cine') {
      const cfg = C.cine;
      const side = Math.sin(v.s * 0.00037) * cfg.side;
      pos.set(
        p.x - dirX * cfg.back + rgtX * side,
        p.y + cfg.up,
        p.z - dirZ * cfg.back + rgtZ * side
      );
      const g = this.world.ground(pos.x, pos.z) + 4;
      if (pos.y < g) pos.y = g;
      const ahead = v.route.at(v.s + cfg.lookAhead, this._ahead);
      aim.set(lerp(p.x, ahead.x, 0.45), p.y + 1.2, lerp(p.z, ahead.z, 0.45));
      return;
    }
    if (this.mode === 'vista') {
      const cfg = C.vista;
      pos.set(p.x - dirX * cfg.back, p.y + cfg.up, p.z - dirZ * cfg.back);
      this._clearGround(pos);
      const ahead = v.route.at(v.s + cfg.lookAhead, this._ahead);
      aim.set(ahead.x, ahead.y + 6, ahead.z);
      return;
    }
    // Independent long-period curves make a gentle dolly, rise and side drift.
    // Arc length keeps revisits/captures deterministic and freezes on pause.
    const cfg = C.chase;
    const travel = v.s - (v.route.kmZero || 0);
    const halfHorizontal = Math.tan(this.camera.fov * Math.PI / 360) * this.camera.aspect;
    const framingBack = (v.dimensions?.bodyLength ?? 4.8) / 2 + 1.1 / Math.max(0.05, halfHorizontal) + 1;
    const back = Math.max(cfg.minBack, framingBack,
      (cfg.back + cfg.driftBack * Math.sin(travel * Math.PI * 2 / cfg.backPeriod)) * this.distScale);
    const up = Math.max(cfg.minUp, (cfg.up + cfg.driftUp * Math.sin(travel * Math.PI * 2 / cfg.upPeriod)) * (0.72 + 0.28 * this.distScale));
    // Portrait views need less sideways motion to keep the entire car in frame.
    const side = cfg.lateral * Math.cos(travel * Math.PI * 2 / cfg.sidePeriod) * Math.min(1, this.distScale)
      * clamp(this.camera.aspect * this.camera.aspect * 0.85, 0, 1);
    pos.set(
      p.x - dirX * back + rgtX * side,
      p.y + up,
      p.z - dirZ * back + rgtZ * side
    );
    this._clearGround(pos);
    const ahead = v.route.at(v.s + cfg.lookAhead * this.distScale, this._ahead);
    aim.set(ahead.x, ahead.y + cfg.lookUp, ahead.z);
  }

  _clearGround(pos) {
    if (this.mode === 'cockpit') return;
    pos.y = Math.max(pos.y, this.world.ground(pos.x, pos.z) + (this.mode === 'chase' ? 1.4 : 4));
  }

  snap() {
    this._target(this._pos, this._aim);
    this._smoothPos.copy(this._pos);
    this._smoothAim.copy(this._aim);
    this.camera.position.copy(this._smoothPos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._smoothAim);
    this.camera.updateMatrixWorld();
    this._init = true;
  }

  update(dt) {
    if (!this._init) return this.snap();
    // Pausing/loading must not snap a moving camera forward to its ideal pose.
    // Teleports, mode changes and deterministic captures call snap explicitly.
    if (!Number.isFinite(dt) || dt <= 0) return;
    this._target(this._pos, this._aim);
    const cfg = C[this.mode];
    const k = 1 - Math.exp(-(cfg.lag ?? 6) * dt);
    this._smoothPos.lerp(this._pos, this.mode === 'cockpit' ? 1 : k);
    this._smoothAim.lerp(this._aim, this.mode === 'cockpit' ? 1 : k);
    this._clearGround(this._smoothPos);
    this.camera.position.copy(this._smoothPos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._smoothAim);
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._init = false;
  }
}
