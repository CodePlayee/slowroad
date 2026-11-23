// src/road/route.js
// Routes a scenic 2-lane road over the heightfield: a cost-driven walk that prefers
// gentle grades, hillside shelves with a view over valley floors, and square river
// crossings, then a smoothed vertical profile, then bridge envelopes where it
// crosses water.
//
// Everything here is deterministic given (heightfield seed, route seed).

import { fbm } from '../core/noise.js';
import { clamp, smoothstep, lerp } from '../core/rng.js';
import { ROAD as R } from './params.js';
import { TERRAIN as T } from '../terrain/params.js';

// Sharpest vertical curve (1/m): a 460 m radius keeps the vertical acceleration
// within 0.2 g at 108 km/h, the autodrive's top speed, which leaves the
// suspension clear of its bump stops in the tightest sag.
const MAX_VERTICAL_CURVATURE = 0.2 * 9.81 / 30 ** 2;
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
    this._probe = {};       // scratch for the walk's look-ahead heightfield sample
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

    // The landform term (see _sideTerm) varies smoothly across the candidate
    // fan, so it is probed on the fan's two edges and centre only and
    // interpolated quadratically in between: three probe sets per step, not nine.
    const C = R.candidates, mid = (C - 1) / 2;
    const fo = {};

    let hCur = hf.natural(x, z);
    for (let i = 1; i < n; i++) {
      const s = i * step;
      const desired = a0 + R.wanderAmp * fbm(s * R.wanderFreq, 41.3, this.seed ^ 0x7ab1, 3) * Math.PI;

      const sm = this._sideTerm(x, z, th, -R.maxTurnPerStep);
      const s0 = this._sideTerm(x, z, th, 0);
      const sp = this._sideTerm(x, z, th, R.maxTurnPerStep);
      const sa = 0.5 * (sp - sm), sb = 0.5 * (sp + sm) - s0;

      let best = null;
      for (let c = 0; c < C; c++) {
        const t = (c - mid) / mid;
        const dTheta = t * R.maxTurnPerStep;
        const nth = th + dTheta;
        const cx = Math.cos(nth), cz = Math.sin(nth);
        const nx = x + cx * step;
        const nz = z + cz * step;

        const riv = hf.full(nx, nz, fo);
        const h = riv.natural;
        const grade = (h - hCur) / step;

        // running *along* a channel is bad; crossing it squarely is fine
        const along = riverAlong(riv, cx, cz);

        // Contours close on themselves: a walk rewarded for holding a hillside
        // would circle a hill or double back along the far side of its valley.
        // A barrier beyond `headingSlack` off the drifting bearing forbids it.
        const hd = angWrap(nth - desired);
        const stray = Math.max(0, Math.abs(hd) - R.headingSlack);
        const cost =
          R.gradeWeight * grade * grade +
          R.turnWeight * dTheta * dTheta +
          R.turnChangeWeight * (dTheta - prevD) * (dTheta - prevD) +
          R.riverAlongWeight * along +
          R.headingWeight * hd * hd +
          R.headingBarrier * stray * stray +
          s0 + sa * t + sb * t * t;

        if (!best || cost < best.cost) best = { cost, dTheta, nth, nx, nz, h };
      }

      th = best.nth; x = best.nx; z = best.nz; prevD = best.dTheta; hCur = best.h;
      pts.push({ x, z });
    }
    return pts;
  }

  /**
   * Landform cost of the candidate turning dTheta from (x, z, th): a road on
   * the valley floor sees a bank on both sides; a road on the hillside sees one
   * bank and one slope falling away in plain view, and a road heading out over
   * lower ground sees the land ahead.  Probed `sideAhead` metres along the
   * candidate's constant-turn arc, where the fan has spread wide enough for the
   * term to steer a one-step greedy walk.  The river-alignment cost is repeated
   * there so a crossing is squared up before the walk reaches the channel.
   */
  _sideTerm(x, z, th, dTheta) {
    const hf = this.hf;
    const A = R.step + R.sideAhead, k = A / R.step;
    const mh = th + dTheta * k * 0.5, eh = th + dTheta * k;
    const px = x + Math.cos(mh) * A, pz = z + Math.sin(mh) * A;
    const ex = Math.cos(eh), ez = Math.sin(eh);
    const riv = hf.full(px, pz, this._probe);
    const h = riv.natural, dn = R.sideNear, df = R.sideFar, vn = R.viewNear, vf = R.viewFar;
    const eye = R.sideEye, cap = R.openMax;
    const hl1 = hf.natural(px - ez * dn, pz + ex * dn) - h, hl2 = hf.natural(px - ez * df, pz + ex * df) - h;
    const hr1 = hf.natural(px + ez * dn, pz - ex * dn) - h, hr2 = hf.natural(px + ez * df, pz - ex * df) - h;
    const hv1 = hf.natural(px + ex * vn, pz + ez * vn) - h, hv2 = hf.natural(px + ex * vf, pz + ez * vf) - h;
    const trough = Math.max(0, Math.min(hl1, hr1)) + Math.max(0, Math.min(hl2, hr2));
    return R.troughWeight * Math.min(trough, cap)
      - R.openWeight * Math.max(openSide(hl1, hl2, dn, df, eye, cap), openSide(hr1, hr2, dn, df, eye, cap))
      - R.viewWeight * openSide(hv1, hv2, vn, vf, eye, R.viewMax)
      + R.riverAlongWeight * R.riverAheadScale * riverAlong(riv, ex, ez);
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

  /**
   * Uniform arc-length samples of the cubic spline through the smoothed plan
   * points. The plan is a 22 m polyline; sampled linearly it turned the road
   * only at its vertices (half the 5.5 m nodes had zero turn, the rest up to
   * 6 degrees). The spline is C2, so heading and curvature change continuously
   * and the curve still passes through every plan point, which keeps the road
   * within ~0.3 m of the plan and its length (hence every km) within a few
   * metres over the route.
   */
  _resample(pts) {
    const m = pts.length, spans = m - 1;
    // Uniform cubic B-spline controls, padded one each end; reflected end
    // controls pin the curve to the plan's end points.
    const cx = new Float64Array(m + 2), cz = new Float64Array(m + 2);
    for (let i = 0; i < m; i++) { cx[i + 1] = pts[i].x; cz[i + 1] = pts[i].z; }
    interpolatingControls(cx, m); interpolatingControls(cz, m);
    cx[0] = 2 * cx[1] - cx[2]; cz[0] = 2 * cz[1] - cz[2];
    cx[m + 1] = 2 * cx[m] - cx[m - 1]; cz[m + 1] = 2 * cz[m] - cz[m - 1];
    const q = {};
    // Speed |r'(u)| at global parameter g (span floor(g), local g - span).
    const speed = (g) => {
      const k = Math.min(spans - 1, Math.floor(g));
      bspline(cx, cz, k, g - k, q);
      return Math.hypot(q.dx, q.dz);
    };
    // Arc length of [g0, g1] by 2-point Gauss-Legendre (the speed is smooth
    // inside a span; sub-intervals never straddle a knot).
    const G = 0.5 / Math.sqrt(3);
    const length = (g0, g1) => {
      const c = 0.5 * (g0 + g1), w = g1 - g0;
      return 0.5 * w * (speed(c - G * w) + speed(c + G * w));
    };
    const K = 16, sub = spans * K;
    const cum = new Float64Array(sub + 1);
    for (let j = 0; j < sub; j++) cum[j + 1] = cum[j] + length(j / K, (j + 1) / K);

    const ds = R.resample;
    const count = Math.floor(cum[sub] / ds);
    const out = [];
    let j = 0;
    for (let i = 0; i <= count; i++) {
      const s = i * ds;
      while (j < sub - 1 && cum[j + 1] < s) j++;
      // Linear guess inside the sub-interval, then one Newton step on arc length.
      const g0 = j / K;
      let g = g0 + (s - cum[j]) / ((cum[j + 1] - cum[j]) || 1) / K;
      g = clamp(g + (s - cum[j] - length(g0, g)) / (speed(g) || 1), 0, spans);
      const k = Math.min(spans - 1, Math.floor(g));
      bspline(cx, cz, k, g - k, q);
      out.push({ s, x: q.x, z: q.z, y: 0, bridge: 0 });
    }
    return out;
  }

  _profile(res) {
    const hf = this.hf;
    const n = res.length;
    const raw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = res[i];
      const r = hf.full(p.x, p.z);
      const g = r.ground;
      // never chase the road down into the riverbed — it wants the valley floor
      raw[i] = r.dist < r.channelHalf * 2.2 ? Math.max(g, r.waterY + 1.0) : g;
      p._raw = raw[i];
      p._river = r;
    }

    let y = movingAverage(raw, 22);
    y = movingAverage(y, 22);

    // keep the road within a plausible cut/fill envelope of the natural ground
    for (let i = 0; i < n; i++) {
      y[i] = softClamp(y[i], raw[i] - R.profileCut, raw[i] + R.profileFill, 2.5);
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
        // The envelope only lifts the road toward a deck above it. A deck at
        // or below the profile used to contribute the profile itself, which
        // re-imposed after smoothing put a single-node hump (18 cm on seed 12
        // km 1.55) where the smoothing had lowered a crest.
        if (k < 0 || k >= n || b.requiredY <= y[k]) continue;
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
    // Re-imposing the deck envelope can leave a ramp steeper than maxGrade where
    // the deck stands well above the approach: lift the approaches into fill
    // instead (never lowers, so the deck clearance is kept).
    raiseToGrade(sm, ds, R.maxGrade);
    // The grade limits leave corners where a ramp meets the approach (an 11 %
    // grade change in one 5.5 m step on seed 7 km 10.54). Round every vertex
    // into a vertical curve while each deck keeps its clearance level.
    const deck = new Float64Array(n).fill(-Infinity);
    for (const b of this.bridges) for (let k = b.a0; k <= b.a1; k++) deck[k] = Math.max(deck[k], b.requiredY);
    limitVerticalCurves(sm, ds, R.maxGrade, MAX_VERTICAL_CURVATURE, deck);

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

  /**
   * Sample at arc length s. The plan is the quintic Hermite through the node
   * positions, unit tangents and curvatures (C2, so the tangent and curvature
   * reported are continuous and belong to the curve drawn). Height and grade
   * retain the profile solver's bounded linear interpolation.
   */
  at(s, out = {}) {
    s = this.clampS(s);
    const f = s / this.ds;
    let i = Math.floor(f);
    if (i >= this.n - 1) i = this.n - 2;
    const t = f - i, j = i + 1;
    const X = this.X, Z = this.Z, TX = this.TX, TZ = this.TZ, CURV = this.CURV;
    // The chord stands in for the arc length between nodes (they differ by
    // ds^3 kappa^2 / 24, a few micrometres), and keeps an evenly spaced straight
    // polyline exactly linear whatever its spacing.
    const h = Math.hypot(X[j] - X[i], Z[j] - Z[i]), h2 = h * h;
    const t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t;
    // Quintic Hermite basis for velocity (v) and acceleration (a) at node i (0)
    // and j (1), with first (d) and second (dd) t-derivatives; the position
    // weights are 1 - p1 at node i and p1 at node j.
    const p1 = 10 * t3 - 15 * t4 + 6 * t5;
    const v0 = t - 6 * t3 + 8 * t4 - 3 * t5, v1 = -4 * t3 + 7 * t4 - 3 * t5;
    const a0 = 0.5 * (t2 - 3 * t3 + 3 * t4 - t5), a1 = 0.5 * (t3 - 2 * t4 + t5);
    const dp = 30 * (t2 - 2 * t3 + t4);
    const dv0 = 1 - 18 * t2 + 32 * t3 - 15 * t4, dv1 = -12 * t2 + 28 * t3 - 15 * t4;
    const da0 = 0.5 * (2 * t - 9 * t2 + 12 * t3 - 5 * t4), da1 = 0.5 * (3 * t2 - 8 * t3 + 5 * t4);
    const ddp = 60 * (t - 3 * t2 + 2 * t3);
    const ddv0 = -36 * t + 96 * t2 - 60 * t3, ddv1 = -24 * t + 84 * t2 - 60 * t3;
    const dda0 = 1 - 9 * t + 18 * t2 - 10 * t3, dda1 = 3 * t - 12 * t2 + 10 * t3;
    // Node velocity h T and acceleration h^2 kappa N, with N = (-tz, tx).
    const vx0 = h * TX[i], vz0 = h * TZ[i], vx1 = h * TX[j], vz1 = h * TZ[j];
    const ax0 = -h2 * CURV[i] * TZ[i], az0 = h2 * CURV[i] * TX[i];
    const ax1 = -h2 * CURV[j] * TZ[j], az1 = h2 * CURV[j] * TX[j];
    const ex = X[j] - X[i], ez = Z[j] - Z[i];
    out.s = s;
    out.x = X[i] + p1 * ex + v0 * vx0 + v1 * vx1 + a0 * ax0 + a1 * ax1;
    out.z = Z[i] + p1 * ez + v0 * vz0 + v1 * vz1 + a0 * az0 + a1 * az1;
    const dx = dp * ex + dv0 * vx0 + dv1 * vx1 + da0 * ax0 + da1 * ax1;
    const dz = dp * ez + dv0 * vz0 + dv1 * vz1 + da0 * az0 + da1 * az1;
    const ddx = ddp * ex + ddv0 * vx0 + ddv1 * vx1 + dda0 * ax0 + dda1 * ax1;
    const ddz = ddp * ez + ddv0 * vz0 + ddv1 * vz1 + dda0 * az0 + dda1 * az1;
    const l = Math.hypot(dx, dz);
    if (l > 0) {
      out.tx = dx / l; out.tz = dz / l;
      out.curv = (dx * ddz - dz * ddx) / (l * l * l);
    } else {
      out.tx = TX[i]; out.tz = TZ[i];
      out.curv = lerp(CURV[i], CURV[j], t);
    }
    // The profile solver bounds the piecewise-linear height and its node grades.
    // Cubic height interpolation can overshoot both the grade limit and bridge
    // clearance between those constrained nodes; smooth only the plan here.
    out.y = lerp(this.Y[i], this.Y[j], t);
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
    if (Math.sqrt(bestD2) > maxDist * 1.35) return null;
    // The chords cut inside the curve by up to ds^2 kappa / 8: one Newton step
    // puts the foot on the curve's own normal through (x, z).
    let p = this.at(bestS);
    const ex = x - p.x, ez = z - p.z;
    const along = ex * p.tx + ez * p.tz, lat = ez * p.tx - ex * p.tz;
    if (along !== 0) p = this.at(bestS + along / Math.max(0.25, 1 - p.curv * lat));
    bestSide = Math.sign((x - p.x) * p.tz - (z - p.z) * p.tx);
    p.dist = Math.hypot(x - p.x, z - p.z); p.side = bestSide || 1;
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

/**
 * Turns c[1..m], the plan coordinates P[0..m-1], into the uniform cubic
 * B-spline controls D[0..m-1] (in place) whose curve passes through every
 * P[i]: (D[i-1] + 4 D[i] + D[i+1]) / 6 = P[i], with D[0] = P[0] and
 * D[m-1] = P[m-1] (reflected end controls). Tridiagonal (Thomas) solve.
 */
function interpolatingControls(c, m) {
  const n = m - 2;
  if (n < 1) return;
  const p0 = c[1], p1 = c[m], cp = new Float64Array(n), dp = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let rhs = 6 * c[i + 2];
    if (i === 0) rhs -= p0;
    if (i === n - 1) rhs -= p1;
    const den = 4 - (i > 0 ? cp[i - 1] : 0);
    cp[i] = 1 / den;
    dp[i] = (rhs - (i > 0 ? dp[i - 1] : 0)) / den;
  }
  for (let i = n - 2; i >= 0; i--) dp[i] -= cp[i] * dp[i + 1];
  for (let i = 0; i < n; i++) c[i + 2] = dp[i];
}

/**
 * Uniform cubic B-spline span k (padded controls k..k+3) at local u in [0, 1]:
 * position and first derivative into out.
 */
function bspline(cx, cz, k, u, out) {
  const w = 1 - u, u2 = u * u, u3 = u2 * u;
  const b0 = w * w * w / 6, b1 = (3 * u3 - 6 * u2 + 4) / 6, b2 = (-3 * u3 + 3 * u2 + 3 * u + 1) / 6, b3 = u3 / 6;
  const d0 = -0.5 * w * w, d1 = 0.5 * (3 * u2 - 4 * u), d2 = 0.5 * (-3 * u2 + 2 * u + 1), d3 = 0.5 * u2;
  out.x = b0 * cx[k] + b1 * cx[k + 1] + b2 * cx[k + 2] + b3 * cx[k + 3];
  out.z = b0 * cz[k] + b1 * cz[k + 1] + b2 * cz[k + 2] + b3 * cz[k + 3];
  out.dx = d0 * cx[k] + d1 * cx[k + 1] + d2 * cx[k + 2] + d3 * cx[k + 3];
  out.dz = d0 * cz[k] + d1 * cz[k + 1] + d2 * cz[k + 2] + d3 * cz[k + 3];
  return out;
}

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

/**
 * Cost of heading (cx, cz) at a heightfield sample `riv` (Heightfield.full):
 * zero away from a channel, small when crossing it squarely, large along it.
 */
function riverAlong(riv, cx, cz) {
  if (riv.dist >= T.valleyHalfWidth * 0.55) return 0;
  const g = Math.hypot(riv.gx, riv.gz) || 1e-9;
  const tx = -riv.gz / g, tz = riv.gx / g;        // channel tangent
  const par = Math.abs(cx * tx + cz * tz);
  return smoothstep(T.valleyHalfWidth * 0.62, 0, riv.dist) * (0.15 + Math.pow(par, 1.6) * 4.2);
}

/**
 * How far a lateral slope falls away *in view* of a driver: the drop at the far
 * probe, faded out when a bench between the probes hides it (the far sample sits
 * below the sight line grazing the near one).
 */
function openSide(h1, h2, d1, d2, eye, cap) {
  const drop = -h2;
  if (drop <= 0) return 0;
  const shown = (h2 - eye) / d2 - (h1 - eye) / d1;   // >= 0: far slope visible
  return Math.min(drop, cap) * smoothstep(-0.03, 0.01, shown);
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

/** Smallest profile >= y whose every step is within maxGrade (one pass each way). */
function raiseToGrade(y, ds, maxGrade) {
  const n = y.length, m = maxGrade * ds;
  for (let i = 1; i < n; i++) if (y[i] < y[i - 1] - m) y[i] = y[i - 1] - m;
  for (let i = n - 2; i >= 0; i--) if (y[i] < y[i + 1] - m) y[i] = y[i + 1] - m;
}

/**
 * Round every vertex whose change of grade exceeds maxCurvature * ds into a
 * vertical curve, keeping steps within maxGrade and the floor (bridge deck
 * clearance). Each offending corner is solved in a window of +-350 m (its
 * rounding settles within a few dozen metres), so the rest of the route is
 * neither iterated nor moved; the whole profile is solved only if a window
 * edge would leave a corner behind.
 */
function limitVerticalCurves(y, ds, maxGrade, maxCurvature, floor) {
  const n = y.length, c = maxCurvature * ds * ds, m = maxGrade * ds, reach = 64;
  const bent = (i) => Math.abs(y[i - 1] - 2 * y[i] + y[i + 1]) > c + 1e-6;
  for (let i = 1; i < n - 1; i++) {
    if (!bent(i)) continue;
    const lo = Math.max(0, i - reach);
    let hi = Math.min(n, i + reach + 1);
    for (let j = i + 1; j < Math.min(hi, n - 1); j++) if (bent(j)) hi = Math.min(n, j + reach + 1);
    projectProfile(y.subarray(lo, hi), c, m, floor.subarray(lo, hi));
    i = hi - 1;
  }
  for (let i = 1; i < n - 1; i++) if (bent(i)) { projectProfile(y, c, m, floor); return; }
}

/**
 * Nearest profile (least squares) to y whose second differences stay within
 * c, steps within m and values above floor: Dykstra's alternating projection
 * onto these convex constraints. Nodes away from violations do not move, and
 * a corner is rounded by cutting crests and filling sags about equally
 * rather than by shifting a whole ramp.
 */
function projectProfile(y, c, m, floor) {
  const n = y.length;
  // Dykstra corrections, one scalar per constraint along its normal.
  const curv = new Float64Array(n), grade = new Float64Array(n), deck = new Float64Array(n);
  for (let pass = 0; pass < 20000; pass++) {
    let moved = 0;
    for (let i = 1; i < n - 1; i++) {
      // Normal (1, -2, 1), |a|^2 = 6.
      const mu = curv[i], t = y[i - 1] - 2 * y[i] + y[i + 1] + 6 * mu;
      const delta = ((t > c ? c : t < -c ? -c : t) - t) / 6, step = mu + delta;
      curv[i] = -delta;
      if (step === 0) continue;
      y[i - 1] += step; y[i] -= 2 * step; y[i + 1] += step;
      moved = Math.max(moved, Math.abs(step));
    }
    for (let i = 0; i < n - 1; i++) {
      // Normal (-1, 1), |a|^2 = 2.
      const mu = grade[i], t = y[i + 1] - y[i] + 2 * mu;
      const delta = ((t > m ? m : t < -m ? -m : t) - t) / 2, step = mu + delta;
      grade[i] = -delta;
      if (step === 0) continue;
      y[i] -= step; y[i + 1] += step;
      moved = Math.max(moved, Math.abs(step));
    }
    for (let i = 0; i < n; i++) {
      if (floor[i] === -Infinity) continue;
      const mu = deck[i], t = y[i] + mu;
      const delta = Math.max(t, floor[i]) - t, step = mu + delta;
      deck[i] = -delta;
      y[i] += step;
      moved = Math.max(moved, Math.abs(step));
    }
    if (moved < 1e-6) return;
  }
}
