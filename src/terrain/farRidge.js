// src/terrain/farRidge.js — the visual-only distant ridge lift.
// One definition, two forms: JS (foliage LOD/culling on the CPU) and GLSL (terrain and
// foliage vertex shaders). Both evaluate the same expressions in the same order.
//
// lift = farRidgeAmp * smoothstep(near, far, d) * hill * ramp * (base + (1 - base) * shape)
//   shape  three ridged crest trains (crest spacing ~2.3 / 3.7 / 6.1 km) with an
//          along-crest swell, so each skyline row has peaks and saddles. World-fixed.
//   ramp   keeps the lift at farRidgeNearScale inside the streamed road range.
//   hill   inside that range lifts only ground above the eye, so valley roads and
//          rivers (unlifted ribbon / water meshes) stay on their ground.
// Every factor is in [0, 1], so 0 <= lift <= farRidgeAmp * smoothstep(near, far, d):
// the padding used by terrain bounds and foliage culling remains a strict bound.
import { TERRAIN as P } from './params.js';

const smoothstep = (a, b, value) => { const t = Math.max(0, Math.min(1, (value - a) / (b - a))); return t * t * (3 - 2 * t); };

/** World-fixed crest field in [0, 1]. */
export function farRidgeShape(x, z) {
  const wx = x + 900 * Math.sin(z * 0.00031 + 1.3) + 520 * Math.sin((x + z) * 0.00057);
  const wz = z + 900 * Math.sin(x * 0.00027 - 0.7) + 520 * Math.sin((x - z) * 0.00049);
  const a = 1 - Math.abs(Math.sin(wx * 0.00112 + wz * 0.00081));
  const b = 1 - Math.abs(Math.sin(wx * -0.00046 + wz * 0.00071 + 1.9));
  const c = 1 - Math.abs(Math.sin(wx * 0.00041 + wz * -0.00028 + 0.6));
  const pa = 0.55 + 0.45 * Math.sin(wx * -0.00081 + wz * 0.00112 + 0.4);
  const pb = 0.55 + 0.45 * Math.sin(wx * 0.00071 + wz * 0.00046 - 1.2);
  const pc = 0.60 + 0.40 * Math.sin(wx * 0.00028 + wz * 0.00041 + 2.3);
  const crest = a * a * pa * 0.42 + b * b * pb * 0.36 + c * c * pc * 0.42;
  return P.farRidgeBase + (1 - P.farRidgeBase) * Math.min(1, crest);
}

/** Camera-relative factor: horizontal distance and ground height above the eye. */
export function farRidgeEnvelope(distance, aboveEye) {
  if (distance <= P.farRidgeNear) return 0;
  const hill = Math.max(smoothstep(P.farRidgeOpen[0], P.farRidgeOpen[1], distance),
    P.farRidgeHillFloor + (1 - P.farRidgeHillFloor) * smoothstep(P.farRidgeHill[0], P.farRidgeHill[1], aboveEye));
  const ramp = P.farRidgeNearScale + (1 - P.farRidgeNearScale) * smoothstep(P.farRidgeRamp[0], P.farRidgeRamp[1], distance);
  return P.farRidgeAmp * smoothstep(P.farRidgeNear, P.farRidgeFar, distance) * hill * ramp;
}

export function farRidgeOffset(x, z, y, cameraX, cameraY, cameraZ) {
  const envelope = farRidgeEnvelope(Math.hypot(x - cameraX, z - cameraZ), y - cameraY);
  return envelope === 0 ? 0 : farRidgeShape(x, z) * envelope;
}

const f = value => (Number.isInteger(value) ? value.toFixed(1) : String(value));

/**
 * GLSL with `float farRidgeLift(vec3 p)` (uses cameraPosition). `amp`, `near` and `far`
 * are GLSL expressions so the terrain can keep them as uniforms; the remaining
 * constants are literals from TERRAIN.
 */
export function farRidgeGlsl({ amp = f(P.farRidgeAmp), near = f(P.farRidgeNear), far = f(P.farRidgeFar) } = {}) {
  return /* glsl */`
float farRidgeShape( vec2 p ) {
  float wx = p.x + 900.0 * sin( p.y * 0.00031 + 1.3 ) + 520.0 * sin( ( p.x + p.y ) * 0.00057 );
  float wz = p.y + 900.0 * sin( p.x * 0.00027 - 0.7 ) + 520.0 * sin( ( p.x - p.y ) * 0.00049 );
  float a = 1.0 - abs( sin( wx * 0.00112 + wz * 0.00081 ) );
  float b = 1.0 - abs( sin( wx * -0.00046 + wz * 0.00071 + 1.9 ) );
  float c = 1.0 - abs( sin( wx * 0.00041 + wz * -0.00028 + 0.6 ) );
  float pa = 0.55 + 0.45 * sin( wx * -0.00081 + wz * 0.00112 + 0.4 );
  float pb = 0.55 + 0.45 * sin( wx * 0.00071 + wz * 0.00046 - 1.2 );
  float pc = 0.60 + 0.40 * sin( wx * 0.00028 + wz * 0.00041 + 2.3 );
  float crest = a * a * pa * 0.42 + b * b * pb * 0.36 + c * c * pc * 0.42;
  return ${f(P.farRidgeBase)} + ${f(1 - P.farRidgeBase)} * min( 1.0, crest );
}
float farRidgeEnvelope( float d, float aboveEye ) {
  if ( d <= ${near} ) return 0.0;
  float hill = max( smoothstep( ${f(P.farRidgeOpen[0])}, ${f(P.farRidgeOpen[1])}, d ),
    ${f(P.farRidgeHillFloor)} + ${f(1 - P.farRidgeHillFloor)} * smoothstep( ${f(P.farRidgeHill[0])}, ${f(P.farRidgeHill[1])}, aboveEye ) );
  float ramp = ${f(P.farRidgeNearScale)} + ${f(1 - P.farRidgeNearScale)} * smoothstep( ${f(P.farRidgeRamp[0])}, ${f(P.farRidgeRamp[1])}, d );
  return ${amp} * smoothstep( ${near}, ${far}, d ) * hill * ramp;
}
float farRidgeLift( vec3 p ) {
  float envelope = farRidgeEnvelope( distance( p.xz, cameraPosition.xz ), p.y - cameraPosition.y );
  return envelope == 0.0 ? 0.0 : farRidgeShape( p.xz ) * envelope;
}
`;
}
