// src/camera/cameras.js — chase / cockpit / cine / vista rigs.
// All of them are pure functions of the vehicle state so a screenshot is reproducible:
// `snap()` places the camera with zero smoothing.

import * as THREE from 'three';
import { CAMERAS as C } from './params.js';
import { clamp, lerp } from '../core/rng.js';
import { POPULATION, generatePopulation } from '../vegetation/population.js';
import { PopulationPool } from '../vegetation/populationPool.js';
import { TREE_SPECIES } from '../vegetation/treeSpecies.js';

const K = C.canopy;
// Crown cylinder per tree: x, z, bottom y, top y, radius.
const CROWN_STRIDE = 5;
const MAX_CROWN = K.crownRadius * Math.max(...Object.values(TREE_SPECIES).map(t => t.heightRange[1] * t.widthRatio[1]));
// Cine side drift by arc length; one full swing per ~17 km.
const cineSide = s => Math.sin(s * 0.00037) * C.cine.side;

function packCrowns(records) {
  const crowns = new Float64Array(records.length * CROWN_STRIDE);
  for (let n = 0, k = 0; n < records.length; n++, k += CROWN_STRIDE) {
    const t = records[n];
    crowns[k] = t.x; crowns[k + 1] = t.z;
    crowns[k + 2] = t.y + t.height * K.crownBase; crowns[k + 3] = t.y + t.height;
    crowns[k + 4] = t.width * K.crownRadius;
  }
  return crowns;
}

/** True when the eye is inside, or the eye→target segment passes through, a crown. */
function canopyBlocks(crowns, eye, target) {
  const dx = target.x - eye.x, dy = target.y - eye.y, dz = target.z - eye.z;
  const length = Math.hypot(dx, dy, dz), horizontal = dx * dx + dz * dz;
  const end = Math.max(0, 1 - K.targetSkip / Math.max(length, 1e-6));
  const pad = K.eyePad;
  for (let k = 0; k < crowns.length; k += CROWN_STRIDE) {
    const ox = eye.x - crowns[k], oz = eye.z - crowns[k + 1], bottom = crowns[k + 2], top = crowns[k + 3], r = crowns[k + 4];
    if (ox * ox + oz * oz < (r + pad) ** 2 && eye.y > bottom - pad && eye.y < top + pad) return true;
    // Segment parameter interval inside the infinite cylinder…
    let lo = 0, hi = end;
    const b = ox * dx + oz * dz, c = ox * ox + oz * oz - r * r;
    if (horizontal < 1e-9) {
      if (c >= 0) continue;
    } else {
      const disc = b * b - horizontal * c;
      if (disc <= 0) continue;
      const q = Math.sqrt(disc);
      lo = Math.max(lo, (-b - q) / horizontal); hi = Math.min(hi, (-b + q) / horizontal);
    }
    // …clipped to the crown's height band.
    if (Math.abs(dy) < 1e-9) {
      if (eye.y < bottom || eye.y > top) continue;
    } else {
      const ua = (bottom - eye.y) / dy, ub = (top - eye.y) / dy;
      lo = Math.max(lo, Math.min(ua, ub)); hi = Math.min(hi, Math.max(ua, ub));
    }
    if (hi > lo) return true;
  }
  return false;
}

/**
 * Tree crowns around the elevated rigs. Tiles come from the vegetation placement
 * itself (every accepted tree record is drawn), so the rig avoids exactly the
 * trees on screen. Only tiles under the rig's own footprint are ever built:
 * ahead of the car on a population worker, or on the main thread when a pose is
 * needed before the worker delivered (snap/teleport) or no worker exists.
 */
class CanopyIndex {
  static supports(world) {
    return typeof world?.sample === 'function' && typeof world.slopeAt === 'function' && Number.isFinite(world.seed);
  }

  constructor(world) {
    this.world = world;
    this.tiles = new Map();
    this.pool = null;
  }

  dispose() {
    this.pool?.dispose();
    this.tiles.clear();
  }

  _entry(i, j) {
    const key = `${i},${j}`;
    let entry = this.tiles.get(key);
    if (!entry) this.tiles.set(key, entry = { key, i, j, iterator: null, crowns: null, workerFailed: false });
    return entry;
  }

  /** Advances a tile's placement on this thread until `deadline`; true once its crowns exist. */
  _build(entry, deadline = Infinity) {
    if (entry.crowns) return true;
    entry.iterator ||= generatePopulation(this.world, 'tree', entry.i, entry.j);
    for (;;) {
      const step = entry.iterator.next();
      if (step.done) {
        entry.crowns = packCrowns(step.value);
        entry.iterator = null;
        return true;
      }
      if (performance.now() >= deadline) return false;
    }
  }

  /** Off-frame generation: a worker when one is available, otherwise budgeted steps here. */
  _background(entry, deadline, priority) {
    if (entry.crowns) return true;
    if (!entry.iterator && !entry.workerFailed) {
      if (this.pool === null) {
        this.pool = new PopulationPool();
        if (this.pool.available) this.pool.reset(this.world);
      }
      if (this.pool.available) {
        if (!this.pool.has(entry.key)) {
          this.pool.request(entry.key, { kind: 'tree', i: entry.i, j: entry.j }, priority);
          return true;
        }
        const result = this.pool.poll(entry.key);
        if (!result) return true;
        if (result.records) {
          entry.crowns = packCrowns(result.records);
          return true;
        }
      }
      entry.workerFailed = true;
    }
    return this._build(entry, deadline);
  }

  /** Visits tiles whose trees can reach the circle; stops when `visit` returns false. */
  _tilesNear(x, z, r, visit) {
    const T = POPULATION.tree.tile, reach = r + MAX_CROWN;
    for (let i = Math.floor((x - reach) / T); i <= Math.floor((x + reach) / T); i++) {
      for (let j = Math.floor((z - reach) / T); j <= Math.floor((z + reach) / T); j++) {
        if (visit(this._entry(i, j)) === false) return false;
      }
    }
    return true;
  }

  /** Crowns overlapping the circle (x, z, r); missing tiles are built synchronously. */
  gather(x, z, r, out) {
    out.length = 0;
    this._tilesNear(x, z, r, (entry) => {
      this._build(entry);
      const c = entry.crowns;
      for (let k = 0; k < c.length; k += CROWN_STRIDE) {
        const dx = c[k] - x, dz = c[k + 1] - z, limit = r + c[k + 4];
        if (dx * dx + dz * dz < limit * limit) for (let q = 0; q < CROWN_STRIDE; q++) out.push(c[k + q]);
      }
    });
    return out;
  }

  /** Background generation for the circle; false when the main-thread budget ran out. */
  prefetch(x, z, r, deadline, priority) {
    return this._tilesNear(x, z, r, entry => this._background(entry, deadline, priority));
  }

  /** Keeps the tiles nearest (x, z) and drops worker jobs nobody waits for. */
  prune(x, z) {
    if (this.tiles.size <= K.maxTiles) return;
    const T = POPULATION.tree.tile;
    const distance = e => Math.hypot((e.i + 0.5) * T - x, (e.j + 0.5) * T - z);
    const order = [...this.tiles].sort((a, b) => distance(a[1]) - distance(b[1]));
    for (let n = K.maxTiles; n < order.length; n++) this.tiles.delete(order[n][0]);
    if (this.pool?.available) {
      const waiting = new Set();
      for (const [key, entry] of this.tiles) if (!entry.crowns) waiting.add(key);
      this.pool.cancelExcept(waiting);
    }
  }
}

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
    this._here = {};
    // Open-side lean state: pure caches of functions of (world, route node).
    this._openWorld = null;
    this._openQ = {};
    this._openRaw = new Map();
    this._openSmooth = new Map();
    this._init = false;
    // Canopy clearance state: pure caches of functions of (world, mode, node).
    this._canopy = null;
    this._reachNodes = { cine: new Map(), vista: new Map() };
    this._reachSmooth = { cine: new Map(), vista: new Map() };
    this._crowns = [];
    this._node = {};
    this._behind = {};
    this._eye = new THREE.Vector3();
    this._sight = new THREE.Vector3();
    this._footprint = { x: 0, z: 0, r: 0, bx: 0, by: 0, bz: 0, dirX: 1, dirZ: 0 };
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
    if (this.mode === 'cine' || this.mode === 'vista') {
      // Orbited behind the car over the road (cine) or raised (vista) only where
      // crowns would swallow the eye or its sight line to the car.
      this._elevatedPose(this.mode, v.s, p.x, p.y, p.z, dirX, dirZ, this._reach(this.mode, v.s), pos);
      const cfg = C[this.mode];
      const ahead = v.route.at(v.s + cfg.lookAhead, this._ahead);
      if (this.mode === 'cine') aim.set(lerp(p.x, ahead.x, 0.45), p.y + 1.2, lerp(p.z, ahead.z, 0.45));
      else aim.set(ahead.x, ahead.y + 6, ahead.z);
      return;
    }
    // Independent long-period curves make a gentle dolly, rise and side drift.
    // Arc length keeps revisits/captures deterministic and freezes on pause.
    const cfg = C.chase;
    const travel = v.s - (v.route.kmZero || 0);
    const halfHorizontal = Math.tan(this.camera.fov * Math.PI / 360) * this.camera.aspect;
    // Portrait views need less sideways motion to keep the entire car in frame.
    const side = cfg.lateral * Math.cos(travel * Math.PI * 2 / cfg.sidePeriod) * Math.min(1, this.distScale)
      * clamp(this.camera.aspect * this.camera.aspect * 0.85, 0, 1);
    // The car's near corners, pushed sideways by the drift, stay inside the half width.
    const framingBack = (v.dimensions?.bodyLength ?? 4.8) / 2 + (1.1 + Math.abs(side)) / Math.max(0.05, halfHorizontal) + 1;
    const back = Math.max(cfg.minBack, framingBack,
      (cfg.back + cfg.driftBack * Math.sin(travel * Math.PI * 2 / cfg.backPeriod)) * this.distScale);
    // Height rides with the dolly, so the car keeps its depression angle and place
    // in frame as it grows and shrinks; a slower independent swell sits on top.
    const up = Math.max(cfg.minUp, cfg.up * back / cfg.back + cfg.driftUp * Math.sin(travel * Math.PI * 2 / cfg.upPeriod));
    pos.set(
      p.x - dirX * back + rgtX * side,
      p.y + up,
      p.z - dirZ * back + rgtZ * side
    );
    const eyeY = pos.y;
    this._clearGround(pos);
    const ahead = v.route.at(v.s + cfg.lookAhead * this.distScale, this._ahead);
    const here = v.route.at(v.s, this._here);
    const lean = cfg.open.aim * this._openSide(v.s);
    aim.x = ahead.x + rgtX * lean;
    aim.z = ahead.z + rgtZ * lean;
    // Fixed downward pitch from the unclamped eye on a level road (a terrain lift
    // tilts further down onto the car); the road climbing or falling ahead tilts it as before.
    aim.y = eyeY - Math.tan(cfg.pitch * Math.PI / 180) * Math.hypot(aim.x - pos.x, aim.z - pos.z) + (ahead.y - here.y);
  }

  /**
   * Lower (more open) side of the road at arc length s: +1 right, −1 left, 0 level.
   * Ground either side of route nodes, raised-cosine smoothed along arc length,
   * so it is continuous and a pure function of (world, s).
   */
  _openSide(s) {
    if (this._openWorld !== this.world) {
      this._openWorld = this.world;
      this._openRaw.clear(); this._openSmooth.clear();
    }
    const u = s / C.chase.open.spacing, n = Math.floor(u);
    return lerp(this._openNode(n), this._openNode(n + 1), u - n);
  }

  _openRawNode(n) {
    let value = this._openRaw.get(n);
    if (value !== undefined) return value;
    const O = C.chase.open, p = this.vehicle.route.at(n * O.spacing, this._openQ);
    let diff = 0;
    if (Number.isFinite(p.tx) && Number.isFinite(p.tz)) {
      // right minus left; right is (-tz, tx) as for the lane offset
      for (const d of O.lateral) diff += this.world.ground(p.x - p.tz * d, p.z + p.tx * d) - this.world.ground(p.x + p.tz * d, p.z - p.tx * d);
    }
    value = clamp(-diff / (O.lateral.length * O.drop), -1, 1);
    if (this._openRaw.size > 1024) this._openRaw.clear();
    this._openRaw.set(n, value);
    return value;
  }

  _openNode(n) {
    let value = this._openSmooth.get(n);
    if (value !== undefined) return value;
    const h = C.chase.open.smooth;
    let sum = 0, weight = 0;
    for (let k = -h; k <= h; k++) {
      const w = 0.5 + 0.5 * Math.cos(Math.PI * k / (h + 1));
      sum += w * this._openRawNode(n + k); weight += w;
    }
    if (this._openSmooth.size > 1024) this._openSmooth.clear();
    this._openSmooth.set(n, value = sum / weight);
    return value;
  }

  _clearGround(pos) {
    if (this.mode === 'cockpit') return;
    pos.y = Math.max(pos.y, this.world.ground(pos.x, pos.z) + (this.mode === 'chase' ? 1.4 : 4));
  }

  /**
   * Elevated pose family. f = 1 is the nominal framing. Lower f orbits the cine
   * eye at constant distance from its side offset to behind the car, and blends
   * from the heading tangent onto the lane that same arc length back, so on a
   * bend the pulled-in eye stays over the road rather than over the outside
   * verge. The car keeps its size and place in frame. Vista has no side offset
   * and rises instead.
   */
  _elevatedPose(mode, s, bx, by, bz, dirX, dirZ, f, out) {
    const cfg = C[mode];
    if (mode === 'cine') {
      const full = cineSide(s), side = full * f;
      const distance = Math.hypot(cfg.back, full);
      const back = Math.sqrt(cfg.back * cfg.back + full * full * (1 - f * f));
      out.set(bx - dirX * back - dirZ * side, by + cfg.up, bz - dirZ * back + dirX * side);
      if (f < 1) {
        const q = this.vehicle.route.at(s - distance, this._behind);
        const lat = this.vehicle.dimensions?.laneOffset ?? 0, w = 1 - f;
        out.x += w * (q.x - q.tz * lat - (bx - dirX * distance));
        out.z += w * (q.z + q.tx * lat - (bz - dirZ * distance));
      }
    } else {
      out.set(bx - dirX * cfg.back, by + cfg.up + (1 - f) * cfg.clearLift, bz - dirZ * cfg.back);
    }
    out.y = Math.max(out.y, this.world.ground(out.x, out.z) + 4);
    return out;
  }

  _canopyIndex() {
    if (!CanopyIndex.supports(this.world) || typeof this.vehicle.route?.at !== 'function') return null;
    if (this._canopy?.world !== this.world) {
      this._canopy?.dispose();
      this._canopy = new CanopyIndex(this.world);
      for (const caches of [this._reachNodes, this._reachSmooth]) {
        for (const cache of Object.values(caches)) cache.clear();
      }
    }
    return this._canopy;
  }

  /** Route-derived car base at node arc length s and a circle around every family eye and the car. */
  _nodeFootprint(mode, s) {
    const out = this._footprint, p = this.vehicle.route.at(s, this._node);
    const lat = this.vehicle.dimensions?.laneOffset ?? 0;
    out.bx = p.x - p.tz * lat; out.by = p.y; out.bz = p.z + p.tx * lat;
    out.dirX = p.tx; out.dirZ = p.tz;
    // Every family eye lies within this horizontal distance of the car.
    const radius = mode === 'cine' ? Math.hypot(C.cine.back, cineSide(s)) : C.vista.back;
    out.x = out.bx; out.z = out.bz; out.r = radius + K.eyePad;
    return out;
  }

  /** Largest f such that every tested family pose up to f is clear at node n. */
  _nodeReach(mode, n) {
    const cache = this._reachNodes[mode];
    let reach = cache.get(n);
    if (reach !== undefined) return reach;
    const s = n * K.spacing, foot = this._nodeFootprint(mode, s);
    const crowns = this._canopy.gather(foot.x, foot.z, foot.r, this._crowns);
    this._sight.set(foot.bx, foot.by + K.targetUp, foot.bz);
    reach = 0;
    for (let k = 0; k <= K.steps; k++) {
      const f = k / K.steps;
      this._elevatedPose(mode, s, foot.bx, foot.by, foot.bz, foot.dirX, foot.dirZ, f, this._eye);
      if (canopyBlocks(crowns, this._eye, this._sight)) break;
      reach = f;
    }
    cache.set(n, reach);
    return reach;
  }

  /** Raised-cosine average of the reach eroded over ±erode nodes (smooth < erode keeps it ≤ each node's reach). */
  _smoothReach(mode, n) {
    const cache = this._reachSmooth[mode];
    let value = cache.get(n);
    if (value !== undefined) return value;
    let sum = 0, weight = 0;
    for (let k = -K.smooth; k <= K.smooth; k++) {
      let eroded = 1;
      for (let e = -K.erode; e <= K.erode && eroded > 0; e++) eroded = Math.min(eroded, this._nodeReach(mode, n + k + e));
      const w = 0.5 + 0.5 * Math.cos(Math.PI * k / (K.smooth + 1));
      sum += w * eroded; weight += w;
    }
    cache.set(n, value = sum / weight);
    return value;
  }

  /** Pose-family parameter at arc length s: continuous, and a pure function of (world, mode, s). */
  _reach(mode, s) {
    if (!this._canopyIndex()) return 1;
    const u = s / K.spacing, n = Math.floor(u);
    return lerp(this._smoothReach(mode, n), this._smoothReach(mode, n + 1), u - n);
  }

  /** Requests tree tiles ahead of the elevated rigs (worker, or a per-frame budget), so `_target` rarely builds one. */
  _prefetchCanopy() {
    if (this.mode !== 'cine' && this.mode !== 'vista') return;
    const index = this._canopyIndex();
    if (!index) return;
    const deadline = performance.now() + K.prefetchMs, step = 8 * K.spacing, s = this.vehicle.s;
    const ahead = (K.erode + K.smooth + 1) * K.spacing + K.prefetch;
    for (let d = 0; d <= ahead; d += step) {
      const foot = this._nodeFootprint(this.mode, s + d);
      if (!index.prefetch(foot.x, foot.z, foot.r + step / 2, deadline, d)) break;
    }
    index.prune(this.vehicle.pos.x, this.vehicle.pos.z);
    const n = Math.floor(s / K.spacing), keep = 2 * (K.erode + K.smooth + 2) + Math.ceil(K.prefetch / K.spacing);
    for (const caches of [this._reachNodes, this._reachSmooth]) {
      for (const cache of Object.values(caches)) {
        if (cache.size > 4 * keep) for (const key of cache.keys()) if (Math.abs(key - n) > keep) cache.delete(key);
      }
    }
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
    this._prefetchCanopy();
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
