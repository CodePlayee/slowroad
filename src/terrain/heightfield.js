// src/terrain/heightfield.js
// The analytic, seeded landform. Pure functions of (x, z) — no state, no time.
// Everything downstream (road routing, water, vegetation, bridges) reads from here.
//
// PERFORMANCE NOTE: `full()` computes relief, base, natural, river, ground, moisture
// and rockiness in ONE pass with shared sub-expressions. It is ~3x cheaper than
// calling the individual accessors, and it is what the chunk/veg builders use.

import { fbm, ridged, warpedFbm, gnoise, vnoise } from '../core/noise.js';
import { clamp, smoothstep, lerp } from '../core/rng.js';
import { TERRAIN as P } from './params.js';

export class Heightfield {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.s = {
      cont: (seed ^ 0x1a2b3c4d) | 0,
      relief: (seed ^ 0x5f2b19a7) | 0,
      hills: (seed ^ 0x77c1de21) | 0,
      ridge: (seed ^ 0x2f9ab4c3) | 0,
      mid: (seed ^ 0x9931f7ad) | 0,
      det: (seed ^ 0xb5e2c199) | 0,
      river: (seed ^ 0x3c7d1f55) | 0,
      rwidth: (seed ^ 0x6ae90b13) | 0,
      moist: (seed ^ 0xd41c6e8b) | 0,
      rock: (seed ^ 0x0e5a92f7) | 0,
    };
    this._o = {};
  }

  // ------------------------------------------------------------- primitives

  relief(x, z) {
    return clamp(0.5 + P.reliefSpread * fbm(x * P.reliefFreq, z * P.reliefFreq, this.s.relief, 3), 0, 1);
  }

  _base(x, z, r) {
    const cont = fbm(x * P.continentFreq, z * P.continentFreq, this.s.cont, 4) * P.continentAmp;
    const hills = warpedFbm(x * P.hillsFreq, z * P.hillsFreq, this.s.hills, 4, P.hillsWarp)
      * P.hillsAmp * (0.42 + 0.95 * r);
    return cont + hills + P.baseOffset;
  }

  /** Very-low-frequency base. The water table rides on this, so rivers run downhill. */
  smoothBase(x, z) { return this._base(x, z, this.relief(x, z)); }

  _natural(x, z, r, base) {
    const rw = smoothstep(P.ridgeReliefLo, P.ridgeReliefHi, r);
    const ridge = rw > 0.001
      ? (ridged(x * P.ridgeFreq, z * P.ridgeFreq, this.s.ridge, 5) - 0.33) * P.ridgeAmp * rw
      : 0;
    const mid = fbm(x * P.midFreq, z * P.midFreq, this.s.mid, 4) * P.midAmp * (0.55 + 0.8 * r);
    const mid2 = fbm(x * P.mid2Freq, z * P.mid2Freq, this.s.mid ^ 0x4d, 3) * P.mid2Amp;
    const det = fbm(x * P.detailFreq, z * P.detailFreq, this.s.det, 3) * P.detailAmp;
    return base + ridge + mid + mid2 + det;
  }

  /** Full natural landform before any river or road surgery. */
  natural(x, z) {
    const r = this.relief(x, z);
    return this._natural(x, z, r, this._base(x, z, r));
  }

  _pot(x, z) {
    return fbm(x * P.riverFreq, z * P.riverFreq, this.s.river, P.riverOctaves, 2.0, P.riverGain);
  }

  // ------------------------------------------------------------ the one pass

  /**
   * Everything about a point, in one shared-subexpression pass.
   * out: { relief, base, natural, ground, dist, half, channelHalf, waterY,
   *        gx, gz, moisture, rockiness }
   */
  full(x, z, out = {}) {
    const r = clamp(0.5 + P.reliefSpread * fbm(x * P.reliefFreq, z * P.reliefFreq, this.s.relief, 3), 0, 1);
    const base = this._base(x, z, r);
    const nat = this._natural(x, z, r, base);

    // ---- river: |A| / |grad A| turns a noise contour into a metric distance ----
    const e = 9;
    const a = this._pot(x, z);
    const ax = (this._pot(x + e, z) - this._pot(x - e, z)) / (2 * e);
    const az = (this._pot(x, z + e) - this._pot(x, z - e)) / (2 * e);
    let g = Math.hypot(ax, az);
    if (g < P.riverGradMin) g = P.riverGradMin;
    const dist = Math.abs(a) / g;

    const wn = vnoise(x * P.riverWidthFreq, z * P.riverWidthFreq, this.s.rwidth);
    const half = lerp(P.riverHalfWidthMin, P.riverHalfWidthMax, wn * wn * (3 - 2 * wn));
    const channelHalf = half / 0.74;
    const waterY = base - P.valleyDepth - P.channelDepth + P.waterDepth;

    // ---- carve ----
    let ground = nat;
    if (dist <= P.valleyHalfWidth) {
      const sV = smoothstep(P.valleyHalfWidth, 0, dist);
      const sC = smoothstep(channelHalf * 1.35, 0, dist);
      const drop = P.valleyDepth * Math.pow(sV, 1.5) + P.channelDepth * sC;
      const carved = nat - drop;
      const smoothBed = base - drop;
      const detCut = smoothstep(channelHalf * 1.6, channelHalf * 0.4, dist);
      ground = lerp(carved, smoothBed, detCut * 0.85);
    }

    // ---- surface fields ----
    const mn = 0.5 + 0.5 * fbm(x * P.moistureFreq, z * P.moistureFreq, this.s.moist, 4);
    const nearRiver = dist < 420 ? smoothstep(420, 40, dist) : 0;
    const altWet = smoothstep(320, 60, base);
    const moisture = clamp(mn * 0.62 + nearRiver * 0.3 + altWet * 0.22, 0, 1);
    const rockiness = clamp(0.5 + 0.5 * fbm(x * 0.0009, z * 0.0009, this.s.rock, 3), 0, 1);

    out.relief = r; out.base = base; out.natural = nat; out.ground = ground;
    out.dist = dist; out.half = half; out.channelHalf = channelHalf; out.waterY = waterY;
    out.gx = ax; out.gz = az; out.a = a;
    out.moisture = moisture; out.rockiness = rockiness;
    return out;
  }

  /** Ground only (natural + river carve). Cheaper than full(): skips surface fields. */
  ground(x, z) {
    const r = clamp(0.5 + P.reliefSpread * fbm(x * P.reliefFreq, z * P.reliefFreq, this.s.relief, 3), 0, 1);
    const base = this._base(x, z, r);
    const nat = this._natural(x, z, r, base);
    const e = 9;
    const a = this._pot(x, z);
    const ax = (this._pot(x + e, z) - this._pot(x - e, z)) / (2 * e);
    const az = (this._pot(x, z + e) - this._pot(x, z - e)) / (2 * e);
    let g = Math.hypot(ax, az);
    if (g < P.riverGradMin) g = P.riverGradMin;
    const dist = Math.abs(a) / g;
    if (dist > P.valleyHalfWidth) return nat;
    const wn = vnoise(x * P.riverWidthFreq, z * P.riverWidthFreq, this.s.rwidth);
    const half = lerp(P.riverHalfWidthMin, P.riverHalfWidthMax, wn * wn * (3 - 2 * wn));
    const channelHalf = half / 0.74;
    const sV = smoothstep(P.valleyHalfWidth, 0, dist);
    const sC = smoothstep(channelHalf * 1.35, 0, dist);
    const drop = P.valleyDepth * Math.pow(sV, 1.5) + P.channelDepth * sC;
    const detCut = smoothstep(channelHalf * 1.6, channelHalf * 0.4, dist);
    return lerp(nat - drop, base - drop, detCut * 0.85);
  }

  /** Compatibility accessor used by the router. */
  river(x, z, out = {}) {
    const f = this.full(x, z, out);
    return f;
  }

  waterAt(x, z) {
    const f = this.full(x, z, this._o);
    return f.dist > f.channelHalf * 1.7 ? null : f.waterY;
  }

  moisture(x, z) { return this.full(x, z, this._o).moisture; }
  rockiness(x, z) { return this.full(x, z, this._o).rockiness; }

  normal(x, z, e = 2.0, out = { x: 0, y: 1, z: 0 }) {
    const hL = this.ground(x - e, z), hR = this.ground(x + e, z);
    const hD = this.ground(x, z - e), hU = this.ground(x, z + e);
    const nx = hL - hR, nz = hD - hU, ny = 2 * e;
    const inv = 1 / Math.hypot(nx, ny, nz);
    out.x = nx * inv; out.y = ny * inv; out.z = nz * inv;
    return out;
  }

  slope(x, z, e = 3.0) { return clamp(1 - this.normal(x, z, e).y, 0, 1); }
}
