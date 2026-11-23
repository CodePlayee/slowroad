// src/vehicle/handling.js — lateral dynamics of the car and its autodrive steering.
//
// A linear single-track (bicycle) model in the ground plane: the body's
// lateral velocity vy (at the centre of mass, right positive) and yaw rate r
// (heading increasing, i.e. turning right, positive) respond to the axle side
// forces of linear tyres. Each axle force builds up over the tyre's
// relaxation length, so a steering input reaches the body as a smooth yaw and
// lateral acceleration with the lag of a real car rather than instantly. The
// car integrates its own world position and heading from that motion; the
// lateral acceleration handed to the suspension is the tyres' total side force
// over the mass, i.e. the curvature of the path the body actually drives.
//
// A preview driver steers: feedforward from the lane's mean curvature a
// little ahead (covering its own steering lag and the car's yaw lag), plus
// pure-pursuit-like feedback on the rear axle's offset and direction of
// travel, plus the steady-state understeer angle, through a neuromuscular
// lag. On a smooth route this tracks the lane to centimetres; the lane is
// read over spans of metres, so residual kinks in the route are driven
// through on a smooth path (cut by centimetres) instead of reaching the body
// as yaw-rate steps.
//
// Like the suspension, the state is integrated with fixed substeps
// (semi-implicit Euler) and displayed one partial step past the last
// substep, so the motion does not depend on the frame rate.

export class Handling {
  /**
   * @param {object} P tunables (VEHICLE.handling)
   * @param {{wheelbase:number, laneOffset:number}} geometry
   */
  constructor(P, geometry) {
    this.P = P;
    const L = geometry.wheelbase;
    this.wheelbase = L;
    this.laneOffset = geometry.laneOffset;
    this.mass = P.mass;
    this.a = L * (1 - P.frontShare);     // centre of mass to front axle
    this.b = L * P.frontShare;           // centre of mass to rear axle
    this.Iz = P.yawInertia;
    this.Cf = P.corneringFront;
    this.Cr = P.corneringRear;
    // Understeer gradient, rad per m/s^2 of lateral acceleration.
    this.understeer = this.mass / L * (this.b / this.Cf - this.a / this.Cr);
    this.h = P.substep;
    // Integrated state at the last substep: world position of the body origin
    // (axle midpoint), unwrapped heading, lateral velocity, yaw rate, axle
    // side forces and the front road-wheel angle.
    this.st = new Float64Array(8);
    this.acc = 0;
    this.ready = false;
    // Displayed state at the end of the last frame.
    this.x = 0; this.z = 0; this.heading = 0;
    this.yawRate = 0; this.aLat = 0; this.steer = 0; this.vy = 0;
    this.offset = 0;      // metres right of the lane centre
    this.s = 0;           // arc length of the body origin along the route
    this._d = new Float64Array(8);
    this._disp = new Float64Array(8);
    this._frame = { dt: 0, s0: 0, v0: 0, v1: 0 };
    this._q = {};
  }

  /** Lateral and yaw response of the linear model at speed v. */
  modes(v) {
    const m = this.mass, Iz = this.Iz, Cf = this.Cf, Cr = this.Cr, a = this.a, b = this.b, L = this.wheelbase;
    const w2 = Cf * Cr * L * L / (m * Iz * v * v) + (Cr * b - Cf * a) / Iz;
    const w = Math.sqrt(w2);
    const zeta = ((Cf + Cr) * Iz + (Cf * a * a + Cr * b * b) * m) / (2 * m * Iz * v * w);
    return { hz: w / (2 * Math.PI), zeta, yawGain: v / (L + this.understeer * v * v) };
  }

  /**
   * Front road-wheel angle the driver asks for with the car at arc length s
   * (state st, speed v). Feedforward: the lane's mean curvature over
   * curvatureSpan, read anticipation seconds ahead to cover the steering and
   * yaw lags. Feedback: the rear axle's offset from the lane and its
   * direction of travel against the lane's chord over curvatureSpan (the
   * body itself points into a bend by the rear tyres' slip angle), steered
   * out over previewTime like pure pursuit. The steady-state understeer
   * angle is added to the total. Reading the lane over spans of metres
   * rather than at single points keeps residual kinks in the route from
   * reaching the steering as steps.
   */
  _demand(route, st, v, s) {
    const P = this.P, q = this._q, lane = this.laneOffset, half = this.wheelbase / 2;
    const c = s + P.anticipation * v, w = P.curvatureSpan / 2;
    route.at(c - w, q);
    const h0 = Math.atan2(q.tz, q.tx);
    route.at(c + w, q);
    const turn = wrap(Math.atan2(q.tz, q.tx) - h0);
    // The lane runs laneOffset right of the centreline: shorter in right bends.
    const ff = turn / Math.max(1, 2 * w - lane * turn);
    const ref = this._laneHeading(route, s - half);
    // Rear axle against the lane abreast of it.
    const p = route.at(s - half, q), hx = Math.cos(st[2]), hz = Math.sin(st[2]);
    const dx = st[0] - hx * half - (p.x - p.tz * lane), dz = st[1] - hz * half - (p.z + p.tx * lane);
    const offset = -dx * p.tz + dz * p.tx;
    const angle = wrap(st[2] + Math.atan2(st[3] - this.b * st[4], v) - ref);
    const reach = Math.max(P.previewMin, P.previewTime * v);
    const k = ff - 2 * (offset + reach * angle) / (reach * reach);
    return Math.atan(this.wheelbase * k) + this.understeer * v * v * k;
  }

  /** Direction of the lane's chord over curvatureSpan centred at arc length s. */
  _laneHeading(route, s) {
    const q = this._q, lane = this.laneOffset, w = this.P.curvatureSpan / 2;
    route.at(s - w, q);
    const ax = q.x - q.tz * lane, az = q.z + q.tx * lane;
    route.at(s + w, q);
    return Math.atan2(q.z + q.tx * lane - az, q.x - q.tz * lane - ax);
  }

  /**
   * Steady state at arc length s and speed v: the rear axle on the lane
   * centre travelling along it, the driver's steady steering and the
   * matching cornering forces, so a snapped car starts without a transient.
   */
  reset(route, s, v) {
    const st = this.st, lane = this.laneOffset, half = this.wheelbase / 2;
    const heading = this._laneHeading(route, s - half);
    const p = route.at(s - half, this._q), rx = p.x - p.tz * lane, rz = p.z + p.tx * lane;
    st[2] = heading; st[3] = st[4] = 0;
    const ve = Math.max(v, this.P.minSpeed);
    const m = this.mass, a = this.a, b = this.b, L = this.wheelbase;
    // The body points into a bend by the rear slip angle (about a degree at
    // 3 m/s^2), which depends on the steering: a few fixed-point passes converge.
    for (let pass = 0; pass < 5; pass++) {
      st[0] = rx + Math.cos(st[2]) * half; st[1] = rz + Math.sin(st[2]) * half;
      const delta = this._demand(route, st, ve, s);
      const r = ve * delta / (L + this.understeer * ve * ve);
      st[4] = r;
      st[3] = b * r - m * ve * ve * r * a / (L * this.Cr);
      st[5] = m * ve * r * b / L;
      st[6] = m * ve * r * a / L;
      st[7] = delta;
      st[2] = heading - Math.atan2(st[3] - b * r, ve);
    }
    st[0] = rx + Math.cos(st[2]) * half; st[1] = rz + Math.sin(st[2]) * half;
    this.acc = 0;
    this.ready = true;
    this._display(st, route, s);
    return this.s;
  }

  /** Time derivatives at state st and speed v, into d (the steering is the driver's). */
  _deriv(st, v, d) {
    const m = this.mass, a = this.a, b = this.b, L = this.wheelbase;
    const vy = st[3], r = st[4];
    // Lateral velocity of the body origin (axle midpoint), a - L/2 ahead of the centre of mass.
    const vo = vy + r * (a - L / 2);
    const c = Math.cos(st[2]), s = Math.sin(st[2]);
    d[0] = v * c - vo * s;
    d[1] = v * s + vo * c;
    d[2] = r;
    d[3] = (st[5] + st[6]) / m - v * r;
    d[4] = (a * st[5] - b * st[6]) / this.Iz;
  }

  _step(st, v, h, route, s) {
    const d = this._d, P = this.P;
    // Axle side forces relax toward the linear tyre force (exact first order).
    const ff = this.Cf * (st[7] - (st[3] + this.a * st[4]) / v);
    const fr = -this.Cr * (st[3] - this.b * st[4]) / v;
    const relax = 1 - Math.exp(-v * h / P.relaxation);
    st[5] += (ff - st[5]) * relax;
    st[6] += (fr - st[6]) * relax;
    this._deriv(st, v, d);
    st[3] += d[3] * h; st[4] += d[4] * h;
    this._deriv(st, v, d);
    st[0] += d[0] * h; st[1] += d[1] * h; st[2] += d[2] * h;
    const want = this._demand(route, st, v, s);
    st[7] += (want - st[7]) * (1 - Math.exp(-h / P.steerLag));
  }

  /**
   * Advance by frame time dt while the speed moves linearly from v0 to v1 and
   * the car started the frame at arc length s0. Returns the arc length of
   * the displayed position (its projection on the lane centre).
   */
  advance(dt, route, s0, v0, v1) {
    if (!(dt > 0)) return s0;
    if (!this.ready) return this.reset(route, s0, v1);
    const h = this.h, st = this.st, f = this._frame;
    f.dt = dt; f.s0 = s0; f.v0 = v0; f.v1 = v1;
    let t = h - this.acc;
    // Each step integrates from the previous substep time, where its inputs apply.
    for (; t <= dt + 1e-12; t += h) this._stepAt(st, t - h, h, route);
    const r = this.acc = Math.max(0, dt - (t - h));
    // Display: one partial step of length r past the last substep.
    const disp = this._disp;
    disp.set(st);
    if (r > 0) this._stepAt(disp, dt - r, r, route);
    let ok = true;
    for (let i = 0; i < 8; i++) ok = ok && Number.isFinite(st[i]);
    if (!ok) return this.reset(route, s0 + (v0 + v1) / 2 * dt, v1);
    this._display(disp, route, s0 + (v0 + v1) / 2 * dt);
    return this.s;
  }

  /** One step of length h from frame time t: speed and the car's arc length move with the frame. */
  _stepAt(st, t, h, route) {
    const f = this._frame;
    const v = Math.max(this.P.minSpeed, f.v0 + (f.v1 - f.v0) * t / f.dt);
    // Arc length at the end of the step, where the driver reads the lane.
    const te = t + h;
    this._step(st, v, h, route, f.s0 + f.v0 * te + (f.v1 - f.v0) * te * te / (2 * f.dt));
  }

  _display(st, route, sGuess) {
    this.x = st[0]; this.z = st[1];
    this.heading = Math.atan2(Math.sin(st[2]), Math.cos(st[2]));
    this.vy = st[3]; this.yawRate = st[4]; this.steer = st[7];
    this.aLat = (st[5] + st[6]) / this.mass;
    // Arc length and lateral offset of the body origin from the lane centre.
    let s = sGuess, e = 0;
    const q = this._q, lane = this.laneOffset;
    for (let k = 0; k < 3; k++) {
      const p = route.at(s, q);
      const dx = st[0] - (p.x - p.tz * lane), dz = st[1] - (p.z + p.tx * lane);
      s = route.clampS(s + dx * p.tx + dz * p.tz);
      e = -dx * p.tz + dz * p.tx;
    }
    this.s = s; this.offset = e;
  }
}

function wrap(a) {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}
