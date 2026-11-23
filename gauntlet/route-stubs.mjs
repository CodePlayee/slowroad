// Synthetic routes for vehicle tests: the subset of the Route API the
// vehicle uses (at, clampS, kmToS, sToKm, ds, length, seed).

const DS = 5.5;

function api(length, at) {
  return { at, ds: DS, length, seed: 0, kmZero: 0,
    clampS: s => Math.min(Math.max(s, 0), length - 1e-3), kmToS: km => km * 1000, sToKm: s => s / 1000 };
}

/** Level road along +X that turns at s = turnAt into a bend of constant curvature (right > 0), with no transition. */
export function bendRoute(curvature, turnAt = 400, length = 20000) {
  return api(length, (s, q = {}) => {
    const u = Math.max(0, s - turnAt), th = curvature * u;
    const x = Math.min(s, turnAt) + (curvature ? Math.sin(th) / curvature : u);
    const z = curvature ? (1 - Math.cos(th)) / curvature : 0;
    return Object.assign(q, { s, x, y: 0, z, tx: Math.cos(th), tz: Math.sin(th),
      curv: s > turnAt ? curvature : 0, grade: 0, bridge: 0, heading: th });
  });
}

/**
 * Bend of mean curvature `curvature` drawn as a polyline with a corner every
 * `chord` metres, sampled every 5.5 m with central-difference tangents and
 * curvature interpolated between samples: the route noise of a kinked
 * centreline (curvature spikes at the corners, zero between them).
 */
export function polylineRoute(curvature, chord = 11, length = 20000) {
  const n = Math.floor(length / DS) + 1, X = new Float64Array(n), Z = new Float64Array(n);
  const turn = curvature * chord;
  let x = 0, z = 0, th = 0, along = 0;
  for (let i = 0; i < n; i++) {
    X[i] = x; Z[i] = z;
    x += Math.cos(th) * DS; z += Math.sin(th) * DS; along += DS;
    if (along >= chord - 1e-9) { along = 0; th += turn; }
  }
  const TX = new Float64Array(n), TZ = new Float64Array(n), H = new Float64Array(n), CURV = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1), l = Math.hypot(X[b] - X[a], Z[b] - Z[a]);
    TX[i] = (X[b] - X[a]) / l; TZ[i] = (Z[b] - Z[a]) / l; H[i] = Math.atan2(TZ[i], TX[i]);
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let d = H[b] - H[a]; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
    CURV[i] = d / ((b - a) * DS);
  }
  const lerp = (p, r, t) => p + (r - p) * t;
  return api((n - 1) * DS, (s, q = {}) => {
    const f = Math.min(Math.max(s, 0), (n - 1) * DS - 1e-3) / DS, i = Math.min(n - 2, Math.floor(f)), t = f - i;
    const tx = lerp(TX[i], TX[i + 1], t), tz = lerp(TZ[i], TZ[i + 1], t), l = Math.hypot(tx, tz);
    return Object.assign(q, { s, x: lerp(X[i], X[i + 1], t), y: 0, z: lerp(Z[i], Z[i + 1], t), tx: tx / l, tz: tz / l,
      curv: lerp(CURV[i], CURV[i + 1], t), grade: 0, bridge: 0, heading: Math.atan2(tz, tx) });
  });
}
