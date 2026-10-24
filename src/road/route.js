// src/road/route.js
// Routes a scenic 2-lane road over the heightfield: a cost-driven walk that prefers
// gentle grades, low ground and square river crossings, then a smoothed vertical
// profile, then bridge envelopes where it crosses water.
//
// Everything here is deterministic given (heightfield seed, route seed).

import { fbm } from '../core/noise.js';
import { clamp, smoothstep, lerp } from '../core/rng.js';
import { ROAD as R } from './params.js';
import { TERRAIN as T } from '../terrain/params.js';

const TAU = Math.PI * 2;
function angWrap(a) { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; }

export class Route {
  constructor(hf, seed) {
    this.hf = hf;
    this.seed = (seed ^ 0x51a3c7f9) >>> 0;
    this.kmZero = 400;      // metres of lead-in road behind km 0
    this.pts = null;        // Float64Array-backed resampled samples
    this.bridges = [];
    this.cellSize = 64;
    this.grid = new Map();
  }

  // ------------------------------------------------------------------ build

  build() {
    const raw = this._walk();
    this._smoothPlan(raw);
    const res = this._resample(raw);
    this._profile(res);
    this._findBridges(res);
    this._applyBridgeEnvelopes(res);
    this._finalise(res);
    this._index();
    return this;
  }

  _walk() {
    const hf = this.hf;
    const step = R.step;
    const total = R.aheadMetres + R.behindMetres + this.kmZero;
    const n = Math.ceil(total / step);
    const pts = [];

    // deterministic start
    const a0 = fbm(this.seed * 0.0013, 7.77, this.seed, 2) * Math.PI;
    let x = 0, z = 0, th = a0, prevD = 0;
    pts.push({ x, z });

    const probe = (px, pz) => {
      const r = R.probeRadius;
      return 0.25 * (hf.smoothBase(px + r, pz) + hf.smoothBase(px - r, pz)
        + hf.smoothBase(px, pz + r) + hf.smoothBase(px, pz - r));
    };

    let hCur = hf.natural(x, z);
    for (let i = 1; i < n; i++) {
      const s = i * step;
      const desired = a0 + R.wanderAmp * fbm(s * R.wanderFreq, 41.3, this.seed ^ 0x7ab1, 3) * Math.PI;

      let best = null;
      for (let c = 0; c < R.candidates; c++) {
        const dTheta = (c / (R.candidates - 1) * 2 - 1) * R.maxTurnPerStep;
        const nth = th + dTheta;
        const nx = x + Math.cos(nth) * step;
        const nz = z + Math.sin(nth) * step;

        const h = hf.natural(nx, nz);
        const grade = (h - hCur) / step;

        const riv = hf.river(nx, nz);
        const rel = riv.base - probe(nx, nz);

        // running *along* a channel is bad; crossing it squarely is fine
        let along = 0;
        if (riv.dist < T.valleyHalfWidth * 0.55) {
          const g = Math.hypot(riv.gx, riv.gz) || 1e-9;
          const tx = -riv.gz / g, tz = riv.gx / g;        // channel tangent
          const par = Math.abs(Math.cos(nth) * tx + Math.sin(nth) * tz);
          along = smoothstep(T.valleyHalfWidth * 0.62, 0, riv.dist) * (0.15 + Math.pow(par, 1.6) * 4.2);
        }

        const hd = angWrap(nth - desired);
        const cost =
          R.gradeWeight * grade * grade +
          R.turnWeight * dTheta * dTheta +
          R.turnChangeWeight * (dTheta - prevD) * (dTheta - prevD) +
          R.altitudeWeight * Math.max(0, rel) +
          R.riverAlongWeight * along +
          R.headingWeight * hd * hd;

        if (!best || cost < best.cost) best = { cost, dTheta, nth, nx, nz, h };
      }

      th = best.nth; x = best.nx; z = best.nz; prevD = best.dTheta; hCur = best.h;
      pts.push({ x, z });
    }
    return pts;
  }

  _smoothPlan(pts) {
    for (let p = 0; p < R.planSmoothPasses; p++) {
      const cp = pts.map((q) => ({ x: q.x, z: q.z }));
      for (let i = 1; i < pts.length - 1; i++) {
        pts[i].x = 0.25 * cp[i - 1].x + 0.5 * cp[i].x + 0.25 * cp[i + 1].x;
        pts[i].z = 0.25 * cp[i - 1].z + 0.5 * cp[i].z + 0.25 * cp[i + 1].z;
      }
    }
  }

  /** Uniform arc-length resample with Catmull-Rom interpolation. */
  _resample(pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    }
    const total = cum[cum.length - 1];
    const ds = R.resample;
    const m = Math.floor(total / ds);
    const out = [];
    let j = 0;
    for (let i = 0; i <= m; i++) {
      const s = i * ds;
      while (j < cum.length - 2 && cum[j + 1] < s) j++;
      const t = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
      out.push({
        s,
        x: lerp(pts[j].x, pts[j + 1].x, t),
        z: lerp(pts[j].z, pts[j + 1].z, t),
        y: 0, bridge: 0,
      });
    }
    return out;
  }

  _profile(res) {
    const hf = this.hf;
    const n = res.length;
    const raw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = res[i];
      const g = hf.ground(p.x, p.z);
      const r = hf.river(p.x, p.z);
      // never chase the road down into the riverbed — it wants the valley floor
      raw[i] = r.dist < r.channelHalf * 2.2 ? Math.max(g, r.waterY + 1.0) : g;
      p._raw = raw[i];
      p._river = r;
    }

    let y = movingAverage(raw, 22);
    y = movingAverage(y, 22);

    // keep the road within a plausible cut/fill envelope of the natural ground
    for (let i = 0; i < n; i++) {
      y[i] = softClamp(y[i], raw[i] - 8.5, raw[i] + 10.5, 2.5);
    }
    y = movingAverage(y, 13);
    limitGrade(y, R.resample, R.maxGrade);
    for (let i = 0; i < n; i++) res[i].y = y[i];
  }

  _findBridges(res) {
    const n = res.length;
    const wet = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = res[i]._river;
      wet[i] = r.dist < r.channelHalf * 0.95 ? 1 : 0;
    }
    const runs = [];
    let i = 0;
    while (i < n) {
      if (!wet[i]) { i++; continue; }
      let j = i;
      while (j + 1 < n && wet[j + 1]) j++;
      // bridge gaps of a couple of samples (braided channel) into one crossing
      if (runs.length && i - runs[runs.length - 1][1] < 8) runs[runs.length - 1][1] = j;
      else runs.push([i, j]);
      i = j + 1;
    }

    this.bridges = [];
    for (const [i0, i1] of runs) {
      const W = (i1 - i0) * R.resample;          // wetted width along the road
      const setback = clamp(0.20 * W, 7, 34);
      const back = Math.max(2, Math.round(setback / R.resample));
      const a0 = Math.max(1, i0 - back);
      const a1 = Math.min(n - 2, i1 + back);
      const L = (a1 - a0) * R.resample;          // structure length
      if (L < 9) continue;

      let maxWater = -Infinity;
      for (let k = i0; k <= i1; k++) maxWater = Math.max(maxWater, res[k]._river.waterY);

      const nSpans = W <= 18 ? 1 : W <= 35 ? 2 : W <= 70 ? 3 : Math.ceil(W / 26);
      const span = L / nSpans;
      const deckDepth = clamp(span / 16, 0.42, 2.1);
      const soffit = clamp(1.6 + span * 0.045, 1.6, 3.4);
      const requiredY = maxWater + soffit + deckDepth;

      this.bridges.push({
        i0, i1, a0, a1, W, L, span, nSpans, deckDepth, soffit,
        waterY: maxWater, requiredY,
        km: 0, s0: 0, s1: 0,
      });
    }
  }

  _applyBridgeEnvelopes(res) {
    const n = res.length;
    const ds = R.resample;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = res[i].y;

    const approach = 130; // metres of vertical curve to reach deck level
    const env = new Float64Array(n).fill(-Infinity);
    for (const b of this.bridges) {
      const ra = Math.ceil(approach / ds);
      for (let k = b.a0 - ra; k <= b.a1 + ra; k++) {
        if (k < 0 || k >= n) continue;
        let w;
        if (k >= b.a0 && k <= b.a1) w = 1;
        else if (k < b.a0) w = smoothstep(0, 1, 1 - (b.a0 - k) / ra);
        else w = smoothstep(0, 1, 1 - (k - b.a1) / ra);
        const v = lerp(y[k], b.requiredY, w);
        if (v > env[k]) env[k] = v;
      }
    }
    for (let i = 0; i < n; i++) if (env[i] > y[i]) y[i] = env[i];

    let sm = movingAverage(y, 9);
    for (let i = 0; i < n; i++) if (env[i] > sm[i]) sm[i] = env[i];
    limitGrade(sm, ds, R.maxGrade);
    for (let i = 0; i < n; i++) if (env[i] > sm[i]) sm[i] = env[i];
    sm = movingAverage(sm, 5);
    for (let i = 0; i < n; i++) if (env[i] > sm[i]) sm[i] = env[i];

    for (let i = 0; i < n; i++) res[i].y = sm[i];

    // bridgeMask: 1 over the water span, 0 by the abutment — used to switch the
    // terrain cut/fill off so the river is not filled in.
    for (const b of this.bridges) {
      for (let k = b.a0; k <= b.a1; k++) {
        let w;
        if (k >= b.i0 && k <= b.i1) w = 1;
        else if (k < b.i0) w = smoothstep(b.a0, b.i0, k);
        else w = smoothstep(b.a1, b.i1, k);
        res[k].bridge = Math.max(res[k].bridge, w);
      }
      b.deckY0 = res[b.a0].y;
      b.deckY1 = res[b.a1].y;
      b.s0 = res[b.a0].s;
      b.s1 = res[b.a1].s;
      b.km = (0.5 * (b.s0 + b.s1) - this.kmZero) / 1000;
    }
  }

  _finalise(res) {
    const n = res.length;
    this.n = n;
    this.ds = R.resample;
    this.length = (n - 1) * R.resample;
    const X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n);
    const TX = new Float64Array(n), TZ = new Float64Array(n);
    const CURV = new Float64Array(n), GRADE = new Float64Array(n), BR = new Float64Array(n);
    for (let i = 0; i < n; i++) { X[i] = res[i].x; Y[i] = res[i].y; Z[i] = res[i].z; BR[i] = res[i].bridge; }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let dx = X[b] - X[a], dz = Z[b] - Z[a];
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      TX[i] = dx; TZ[i] = dz;
      GRADE[i] = (Y[b] - Y[a]) / ((b - a) * R.resample);
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const dth = angWrap(Math.atan2(TZ[b], TX[b]) - Math.atan2(TZ[a], TX[a]));
      CURV[i] = dth / ((b - a) * R.resample);
    }
    this.X = X; this.Y = Y; this.Z = Z; this.TX = TX; this.TZ = TZ;
    this.CURV = CURV; this.GRADE = GRADE; this.BR = BR;
  }

  _index() {
    this.grid.clear();
    const cs = this.cellSize;
    for (let i = 0; i < this.n; i++) {
      const cx = Math.floor(this.X[i] / cs), cz = Math.floor(this.Z[i] / cs);
      const k = cx * 73856093 ^ cz * 19349663;
      let arr = this.grid.get(k);
      if (!arr) { arr = []; this.grid.set(k, arr); }
      arr.push(i);
    }
  }

  // ------------------------------------------------------------------ query

  clampS(s) { return clamp(s, 0, this.length - 1e-3); }

  /** Interpolated sample at arc length s. */
  at(s, out = {}) {
    s = this.clampS(s);
    const f = s / this.ds;
    let i = Math.floor(f);
    if (i >= this.n - 1) i = this.n - 2;
    const t = f - i, j = i + 1;
    out.s = s;
    out.x = lerp(this.X[i], this.X[j], t);
    out.y = lerp(this.Y[i], this.Y[j], t);
    out.z = lerp(this.Z[i], this.Z[j], t);
    let tx = lerp(this.TX[i], this.TX[j], t), tz = lerp(this.TZ[i], this.TZ[j], t);
    const l = Math.hypot(tx, tz) || 1;
    out.tx = tx / l; out.tz = tz / l;
    out.curv = lerp(this.CURV[i], this.CURV[j], t);
    out.grade = lerp(this.GRADE[i], this.GRADE[j], t);
    out.bridge = lerp(this.BR[i], this.BR[j], t);
    out.heading = Math.atan2(out.tz, out.tx);
    return out;
  }

  kmToS(km) { return this.clampS(this.kmZero + km * 1000); }
  sToKm(s) { return (s - this.kmZero) / 1000; }
  get maxKm() { return this.sToKm(this.length); }

  /**
   * Nearest point on the centreline. Returns null when further than ~1.5 cells,
   * which is the common case and keeps terrain sampling cheap.
   */
  nearest(x, z, maxDist = R.carveOuter) {
    const cs = this.cellSize;
    const cx = Math.floor(x / cs), cz = Math.floor(z / cs);
    const rad = Math.max(1, Math.ceil(maxDist / cs));
    let bi = -1, bd = Infinity;
    for (let dz = -rad; dz <= rad; dz++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const arr = this.grid.get((cx + dx) * 73856093 ^ (cz + dz) * 19349663);
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          const d = (this.X[i] - x) ** 2 + (this.Z[i] - z) ** 2;
          if (d < bd) { bd = d; bi = i; }
        }
      }
    }
    if (bi < 0) return null;
    // refine along the segment either side of the closest sample
    let bestS = bi * this.ds, bestD2 = bd, bestSide = 0;
    for (const j of [bi - 1, bi]) {
      if (j < 0 || j >= this.n - 1) continue;
      const ax = this.X[j], az = this.Z[j];
      const bx = this.X[j + 1], bz = this.Z[j + 1];
      const ex = bx - ax, ez = bz - az;
      const len2 = ex * ex + ez * ez || 1;
      let t = ((x - ax) * ex + (z - az) * ez) / len2;
      t = clamp(t, 0, 1);
      const px = ax + ex * t, pz = az + ez * t;
      const d2 = (px - x) ** 2 + (pz - z) ** 2;
      if (d2 < bestD2) { bestD2 = d2; bestS = (j + t) * this.ds; }
    }
    const dist = Math.sqrt(bestD2);
    if (dist > maxDist * 1.35) return null;
    const p = this.at(bestS);
    bestSide = Math.sign((x - p.x) * p.tz - (z - p.z) * p.tx);
    p.dist = dist; p.side = bestSide || 1;
    return p;
  }

  /** First bridge at or after `fromKm`; wraps once. */
  findBridge(fromKm = 0) {
    if (!this.bridges.length) return null;
    for (const b of this.bridges) if (b.km >= fromKm + 0.05) return b;
    return this.bridges[0];
  }
}

// ------------------------------------------------------------------ helpers

function movingAverage(src, half) {
  const n = src.length;
  const out = new Float64Array(n);
  let acc = 0;
  const w = half * 2 + 1;
  for (let i = -half; i <= half; i++) acc += src[clamp(i, 0, n - 1)];
  for (let i = 0; i < n; i++) {
    out[i] = acc / w;
    acc -= src[clamp(i - half, 0, n - 1)];
    acc += src[clamp(i + half + 1, 0, n - 1)];
  }
  return out;
}

function softClamp(v, lo, hi, k) {
  // smooth min/max so the envelope does not crease
  const smin = (a, b) => { const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1); return lerp(b, a, h) - k * h * (1 - h); };
  const smax = (a, b) => { const h = clamp(0.5 + 0.5 * (a - b) / k, 0, 1); return lerp(b, a, h) + k * h * (1 - h); };
  return smax(smin(v, hi), lo);
}

function limitGrade(y, ds, maxGrade) {
  const n = y.length, m = maxGrade * ds;
  for (let p = 0; p < 3; p++) {
    for (let i = 1; i < n; i++) {
      const d = y[i] - y[i - 1];
      if (d > m) y[i] = y[i - 1] + m; else if (d < -m) y[i] = y[i - 1] - m;
    }
    for (let i = n - 2; i >= 0; i--) {
      const d = y[i] - y[i + 1];
      if (d > m) y[i] = y[i + 1] + m; else if (d < -m) y[i] = y[i + 1] - m;
    }
  }
}
