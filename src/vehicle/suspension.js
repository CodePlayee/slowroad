// src/vehicle/suspension.js — sprung body on four spring-dampers.
//
// The chassis is a rigid sprung mass with three degrees of freedom about the
// body origin (axle midpoint, ride height): heave Y (world metres), pitch
// (radians, nose up positive) and roll (radians, local +X = left side up
// positive). Each corner carries a spring and damper between the body and its
// road contact; an anti-roll bar per axle resists left/right travel
// difference; bump and rebound stops stiffen the ends of the travel. Inertial
// loads enter as pitch and roll moments: longitudinal load transfer from the
// autodrive acceleration and the grade, lateral load transfer from the car's
// own lateral acceleration (handling.js) and the crossfall. The wheels
// (unsprung) follow the road. The body is integrated with fixed substeps
// (semi-implicit Euler) and displayed one partial step past the last
// substep, so the motion does not depend on the frame rate.
//
// Corners: 0 left front, 1 right front, 2 left rear, 3 right rear. A corner's
// road input u is the world height its body point has at static equilibrium
// (road contact height + ride height), ud its rate; compression = u - body
// corner height (positive = wheel pushed up into the arch).

import { vnoise } from '../core/noise.js';

const G = 9.81;
const DEG = Math.PI / 180;
const UNCORRELATED = [0, 0];

/**
 * Deterministic road texture height (metres) at arc length s on wheel track
 * `track` (0 left, 1 right): two value-noise octaves whose amplitude grows
 * with wavelength like a good asphalt road's displacement spectrum. Shorter
 * wavelengths move the body by well under a millimetre and are omitted.
 * `correlation` [long, short] is each octave's correlation coefficient
 * between the two tracks: real wheel paths share most of the long
 * undulations and fewer of the short ones. A shared and a per-track noise
 * are mixed with unchanged variance.
 */
export function roadTexture(s, track, amplitude, seed = 0, correlation = UNCORRELATED) {
  if (!(amplitude > 0)) return 0;
  const y = track * 17.3 + 0.5;
  return amplitude * (octave(s / 11.0, y, 41.5, correlation[0], seed) * 2 +
    octave(s / 4.3, y + 3.1, 44.5, correlation[1], seed) * 0.78);
}

function octave(x, own, shared, rho, seed) {
  const n = vnoise(x, own, seed) - 0.5;
  return rho > 0 ? Math.sqrt(rho) * (vnoise(x, shared, seed) - 0.5) + Math.sqrt(1 - rho) * n : n;
}

export class Suspension {
  /**
   * @param {object} P tunables (VEHICLE.suspension)
   * @param {{track:number, wheelbase:number}} geometry corner layout, metres
   */
  constructor(P, geometry) {
    this.P = P;
    const m = P.sprungMass, T = geometry.track, L = geometry.wheelbase;
    this.track = T;
    this.wheelbase = L;
    // Corner offsets from the body origin: x left, z forward.
    this.cx = new Float64Array([T / 2, -T / 2, T / 2, -T / 2]);
    this.cz = new Float64Array([L / 2, L / 2, -L / 2, -L / 2]);
    // Equal corners about a centred mass: heave, pitch and roll decouple.
    const kHeave = m * (2 * Math.PI * P.heaveHz) ** 2;
    this.k = kHeave / 4;                                         // wheel rate, N/m
    this.c = 2 * P.heaveDamping * Math.sqrt(kHeave * m) / 4;     // damper rate, N s/m
    this.rollArm = P.cgHeight - P.rollCentre;
    const kRollSprings = this.k * T * T;
    const kRollTarget = m * G * this.rollArm / (P.rollGradient * DEG);
    // Anti-roll bar rate per axle on the left/right travel difference.
    this.kArb = Math.max(0, kRollTarget - kRollSprings) / (2 * T * T);
    this.kPitch = this.k * L * L;
    this.kRoll = kRollSprings + 2 * this.kArb * T * T;
    this.mass = m;
    this.inertiaPitch = this.kPitch / (2 * Math.PI * P.pitchHz) ** 2;
    this.inertiaRoll = this.kRoll / (2 * Math.PI * P.rollHz) ** 2;
    this.kBump = this.k * P.bumpStop;
    this.h = P.substep;

    // Integrated state at the last fixed substep.
    this.q = new Float64Array(3);
    this.qd = new Float64Array(3);
    this.acc = 0;                 // frame time already past the last substep
    this.ready = false;
    // Displayed pose at the end of the last frame.
    this.Y = 0; this.pitch = 0; this.roll = 0;
    this.compression = new Float64Array(4);
    // Reused inputs and scratch; advance() allocates nothing. `input` is the
    // road at the frame end (display); `_start` at the time of the state q.
    this.input = { u: new Float64Array(4), ud: new Float64Array(4), aLong: 0, aLat: 0 };
    this._start = { u: new Float64Array(4), ud: new Float64Array(4), aLong: 0, aLat: 0 };
    this._a = new Float64Array(3);
    this._m = new Float64Array(3);
    this._q = new Float64Array(3);
    this._qd = new Float64Array(3);
  }

  /** Natural frequency and damping ratio of the three body modes. */
  get modes() {
    const P = this.P, sum = 4 * this.c, T = this.track, L = this.wheelbase;
    return {
      heave: { hz: P.heaveHz, zeta: P.heaveDamping },
      pitch: { hz: P.pitchHz, zeta: sum * L * L / 4 / (2 * Math.sqrt(this.kPitch * this.inertiaPitch)) },
      roll: { hz: P.rollHz, zeta: sum * T * T / 4 / (2 * Math.sqrt(this.kRoll * this.inertiaRoll)) },
    };
  }

  /** Pitch and roll moments (N m) of the inertial and gravity loads, into out[1], out[2]. */
  _moments(input, out) {
    const u = input.u, P = this.P;
    const grade = ((u[0] + u[1]) - (u[2] + u[3])) / (2 * this.wheelbase);
    const cross = ((u[0] + u[2]) - (u[1] + u[3])) / (2 * this.track);   // left higher > 0
    // Rearward load at the centre of mass: acceleration plus the grade's gravity.
    const long = input.aLong + G * grade / Math.sqrt(1 + grade * grade);
    const anti = long < 0 ? P.antiDive : P.antiSquat;
    out[1] = this.mass * P.cgHeight * (1 - anti) * long;
    // The tyres' side force toward the turn centre (right for aLat > 0) acts
    // below the roll axis and rolls the body to the outside; crossfall gravity
    // leans it toward the low side.
    out[2] = -this.mass * this.rollArm * (input.aLat - G * cross / Math.sqrt(1 + cross * cross));
  }

  /** Static roll on a straight road whose crossfall slope is s (left higher > 0). */
  bankRoll(s) {
    return s + this.mass * this.rollArm * G * s / Math.sqrt(1 + s * s) / this.kRoll;
  }

  /** Body coordinates balancing corner inputs v and moments (mp, mr). */
  _balance(v, mp, mr, out) {
    let sz = 0, sx = 0;
    for (let i = 0; i < 4; i++) { sz += this.cz[i] * v[i]; sx += this.cx[i] * v[i]; }
    out[0] = (v[0] + v[1] + v[2] + v[3]) / 4;
    out[1] = (this.k * sz + mp) / this.kPitch;
    out[2] = (this.k * sx + this.kArb * this.track * ((v[0] - v[1]) + (v[2] - v[3])) + mr) / this.kRoll;
  }

  /** Steady-state equilibrium for `input`: the body moves with the road, no transient. */
  reset(input) {
    const m = this._m;
    this._moments(input, m);
    this._balance(input.u, m[1], m[2], this.q);
    this._balance(input.ud, 0, 0, this.qd);
    const start = this._start;
    start.u.set(input.u); start.ud.set(input.ud); start.aLong = input.aLong; start.aLat = input.aLat;
    this.acc = 0;
    this.ready = true;
    this._display(this.q, input);
  }

  /** Generalised accelerations at (q, qd) for `input`, into out. */
  _accel(q, qd, input, out) {
    const u = input.u, ud = input.ud, P = this.P;
    let Fy = 0, Mp = 0, Mr = 0, front = 0, rear = 0;
    for (let i = 0; i < 4; i++) {
      const x = this.cx[i], z = this.cz[i];
      const c = u[i] - (q[0] + z * q[1] + x * q[2]);
      const cd = ud[i] - (qd[0] + z * qd[1] + x * qd[2]);
      let F = this.k * c + this.c * cd;
      if (c > P.bump) F += this.kBump * (c - P.bump);
      else if (c < -P.rebound) F += this.kBump * (c + P.rebound);
      Fy += F; Mp += z * F; Mr += x * F;
      // Anti-roll bars push up the more compressed side of each axle.
      const side = i & 1 ? -c : c;
      if (i < 2) front += side; else rear += side;
    }
    Mr += this.kArb * this.track * (front + rear);
    const m = this._m;
    this._moments(input, m);
    out[0] = Fy / this.mass;
    out[1] = (Mp + m[1]) / this.inertiaPitch;
    out[2] = (Mr + m[2]) / this.inertiaRoll;
  }

  /**
   * Advance by frame time dt. `source.sampleSuspension(f, input)` fills the
   * road and load input at fraction f of the frame (0 start, 1 end). Each
   * fixed substep evaluates its forces at its start time (symplectic Euler),
   * which follows a steady ramp exactly.
   */
  advance(dt, source) {
    if (!(dt > 0)) return;
    const input = this.input, start = this._start;
    if (!this.ready) { source.sampleSuspension(1, input); this.reset(input); return; }
    const h = this.h, q = this.q, qd = this.qd, a = this._a;
    let t = h - this.acc;
    for (; t <= dt + 1e-12; t += h) {
      this._accel(q, qd, start, a);
      for (let i = 0; i < 3; i++) { qd[i] += a[i] * h; q[i] += qd[i] * h; }
      source.sampleSuspension(t / dt, start);
    }
    const r = this.acc = Math.max(0, dt - (t - h));
    source.sampleSuspension(1, input);
    if (!(Number.isFinite(q[0] + q[1] + q[2] + qd[0] + qd[1] + qd[2]))) { this.reset(input); return; }
    // Display at the frame end: one partial step of length r past the last substep.
    const qr = this._q, qdr = this._qd;
    this._accel(q, qd, start, a);
    for (let i = 0; i < 3; i++) { qdr[i] = qd[i] + a[i] * r; qr[i] = q[i] + qdr[i] * r; }
    this._display(qr, input);
  }

  _display(q, input) {
    this.Y = q[0]; this.pitch = q[1]; this.roll = q[2];
    const u = input.u, P = this.P;
    for (let i = 0; i < 4; i++) {
      const c = u[i] - (q[0] + this.cz[i] * q[1] + this.cx[i] * q[2]);
      this.compression[i] = Math.min(P.bump, Math.max(-P.rebound, c));
    }
  }
}
