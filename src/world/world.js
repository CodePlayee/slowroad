// src/world/world.js
// Binds the heightfield and the route together. THIS is what everything samples:
// ground() here already includes river carving AND road cut-and-fill.

import { Heightfield } from '../terrain/heightfield.js';
import { Route } from '../road/route.js';
import { ROAD as R } from '../road/params.js';
import { TERRAIN as T } from '../terrain/params.js';
import { clamp, lerp, seedFrom } from '../core/rng.js';

const HALF_PAVE = (R.laneWidth * R.lanes) / 2;
const SHOULDER_EDGE = HALF_PAVE + R.shoulderWidth;
const VERGE_EDGE = SHOULDER_EDGE + R.vergeWidth;

/** Road cross-section offset (metres, relative to centreline height) at |lateral| d. */
export function crossSection(d) {
  if (d <= HALF_PAVE) return -R.crown * d;
  const edge = -R.crown * HALF_PAVE;
  if (d <= SHOULDER_EDGE) return edge - 0.05 * (d - HALF_PAVE);
  const sh = edge - 0.05 * R.shoulderWidth;
  return sh - 0.10 * Math.min(d - SHOULDER_EDGE, R.vergeWidth);
}
export const ROAD_EDGES = { HALF_PAVE, SHOULDER_EDGE, VERGE_EDGE };

const smin = (a, b, k) => { const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1); return lerp(b, a, h) - k * h * (1 - h); };
const smax = (a, b, k) => { const h = clamp(0.5 + 0.5 * (a - b) / k, 0, 1); return lerp(b, a, h) + k * h * (1 - h); };

export class World {
  constructor(seedInput) {
    this.seedInput = seedInput;
    this.seed = seedFrom(seedInput);
    this.hf = new Heightfield(this.seed);
    this.route = new Route(this.hf, this.seed);
    this._o = {};
    this._f = {};
  }

  build() {
    const t0 = performance.now();
    this.route.build();
    this.buildMs = performance.now() - t0;
    return this;
  }

  // ------------------------------------------------------------- elevation

  /**
   * Apply road cut-and-fill to a natural ground height.
   * The clamp between the cut plane and the fill plane IS the earthworks;
   * smooth-min/max round the daylight line so it does not crease.
   */
  _carve(x, z, nat, info) {
    const p = this.route.nearest(x, z, R.carveOuter);
    if (info) { info.roadDist = Infinity; info.bridge = 0; }
    if (!p || p.dist >= R.carveOuter) return nat;
    if (info) { info.roadDist = p.dist; info.bridge = p.bridge; }
    const d = p.dist;
    const edgeY = p.y + crossSection(Math.min(d, VERGE_EDGE));
    let graded;
    if (d <= VERGE_EDGE) graded = edgeY;
    else {
      const o = d - VERGE_EDGE;
      graded = smax(smin(nat, edgeY + R.cutSlope * o, R.blendSoftness), edgeY - R.fillSlope * o, R.blendSoftness);
    }
    // over the water span the deck is a bridge: leave the river alone
    if (p.bridge > 0.001) graded = lerp(graded, nat, p.bridge);
    return graded;
  }

  /** Final terrain height including river valley and road cut/fill. */
  ground(x, z) { return this._carve(x, z, this.hf.ground(x, z), null); }

  /**
   * One-pass sample: height + all surface fields, road-aware.
   * out gets { y, natural, roadDist, bridge, waterY, riverDist, channelHalf,
   *            moisture, rockiness, inWater }.
   */
  sample(x, z, out = {}) {
    const f = this.hf.full(x, z, this._f);
    const y = this._carve(x, z, f.ground, out);
    out.y = y;
    out.natural = f.natural;
    out.base = f.base;
    out.waterY = f.waterY;
    out.riverDist = f.dist;
    out.channelHalf = f.channelHalf;
    out.riverHalf = f.half;
    out.moisture = f.moisture;
    out.rockiness = f.rockiness;
    out.gx = f.gx; out.gz = f.gz;
    out.inWater = y < f.waterY && f.dist < f.channelHalf * 2.6;
    return out;
  }

  /** Cheap slope estimate given a known height at (x,z). 2 extra ground evals. */
  slopeAt(x, z, y, e = 3.0, gradient = null) {
    const hR = this.ground(x + e, z);
    const hU = this.ground(x, z + e);
    const nx = (y - hR) / e, nz = (y - hU) / e;
    if (gradient) { gradient.dx = -nx; gradient.dz = -nz; }
    return clamp(1 - 1 / Math.sqrt(1 + nx * nx + nz * nz), 0, 1);
  }

  normal(x, z, e = 1.6, out = { x: 0, y: 1, z: 0 }) {
    const hL = this.ground(x - e, z), hR = this.ground(x + e, z);
    const hD = this.ground(x, z - e), hU = this.ground(x, z + e);
    const nx = hL - hR, nz = hD - hU, ny = 2 * e;
    const inv = 1 / Math.hypot(nx, ny, nz);
    out.x = nx * inv; out.y = ny * inv; out.z = nz * inv;
    return out;
  }

  slope(x, z, e = 2.4) { return clamp(1 - this.normal(x, z, e).y, 0, 1); }

  waterHeight(x, z) {
    const f = this.hf.full(x, z, this._o);
    return f.dist < f.channelHalf * 2.6 ? f.waterY : null;
  }

  // --------------------------------------------------------------- queries

  findBridgeKm(fromKm = 0) {
    const b = this.route.findBridge(fromKm);
    return b ? b.km : null;
  }

  /** First point at/after fromKm where open water is visible near the road. */
  findWaterKm(fromKm = 0) {
    const rt = this.route;
    const start = rt.kmToS(fromKm + 0.05);
    const q = {};
    for (let s = start; s < rt.length; s += 30) {
      const p = rt.at(s, q);
      for (let lat = -260; lat <= 260; lat += 45) {
        const x = p.x - p.tz * lat, z = p.z + p.tx * lat;
        const f = this.hf.full(x, z, this._o);
        if (f.dist < f.channelHalf && f.half > 15) return rt.sToKm(s);
      }
    }
    return null;
  }

  /**
   * A vista: road high relative to its surroundings with a long open sightline.
   * Scored over the next ~14 km, not first-match.
   */
  findVistaKm(fromKm = 0) {
    const rt = this.route;
    const start = rt.kmToS(fromKm + 0.05);
    const end = Math.min(rt.length, start + 14000);
    let best = null;
    const q = {};
    for (let s = start; s < end; s += 60) {
      const p = rt.at(s, q);
      const here = this.hf.smoothBase(p.x, p.z);
      let below = 0, ahead = 0;
      for (let a = 0; a < 8; a++) {
        const th = (a / 8) * Math.PI * 2, rr = 700;
        below += here - this.hf.smoothBase(p.x + Math.cos(th) * rr, p.z + Math.sin(th) * rr);
      }
      below /= 8;
      for (let d = 250; d <= 2250; d += 250) {
        ahead += Math.max(0, here - this.hf.smoothBase(p.x + p.tx * d, p.z + p.tz * d)) * 0.02;
      }
      const score = below + ahead * 3;
      if (!best || score > best.score) best = { score, km: rt.sToKm(s) };
    }
    return best ? best.km : null;
  }
}
