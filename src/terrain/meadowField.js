import { TERRAIN as P } from './params.js';

// Open-meadow sward field shared by the terrain turf (fragment) and the grass
// models (vertex, sampled at each tuft root). Both evaluate the identical
// world-space functions, so hay/green patches and lodged swaths continue from
// the blades into the ground beyond the model corridor. Requires
// SURFACE_HASH_GLSL to be declared first. No fract(): the grass vertex
// contract forbids it.
const f = value => Number(value).toFixed(5);
const [windX, windZ] = P.meadowWindDir;

export const MEADOW_FIELD_GLSL = /* glsl */`
const vec2 MEADOW_WIND = vec2(${f(windX)}, ${f(windZ)});
float meadowNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 w = p - i;
  w = w * w * (3.0 - 2.0 * w);
  return mix(mix(surfaceHash(i), surfaceHash(i + vec2(1.0, 0.0)), w.x),
             mix(surfaceHash(i + vec2(0.0, 1.0)), surfaceHash(i + vec2(1.0, 1.0)), w.x), w.y);
}
// x: hay share, y: dark-green share, z: lodging (0 upright .. 1 laid with the wind).
// detail fades cluster-scale variation before the broader patches and swaths.
vec3 meadowSward(vec2 xz, float moist, float detail) {
  vec2 lay = vec2(dot(xz, MEADOW_WIND), dot(xz, vec2(-MEADOW_WIND.y, MEADOW_WIND.x)));
  float hayBroad = meadowNoise(xz * ${f(1 / P.meadowHayScale)} + vec2(31.7, -12.9));
  float hayFine = meadowNoise(mat2(0.8, -0.6, 0.6, 0.8) * xz * ${f(1 / P.meadowPatchScale)} + vec2(-7.3, 19.1));
  float greenTone = meadowNoise(mat2(0.6, 0.8, -0.8, 0.6) * xz * ${f(1 / P.meadowGreenScale)} + vec2(5.9, 43.2));
  // A shared ~12 m cluster field bridges individual grass tufts and the broad
  // hillside patches. Warp it with the existing fields so cluster boundaries
  // do not form a second regular grid; turf and blade roots stay in agreement.
  float cluster = (meadowNoise(mat2(0.8, 0.6, -0.6, 0.8) * xz
    * ${f(1 / (P.meadowPatchScale * 0.30))} + vec2(hayFine, greenTone) * 0.65
    + vec2(23.4, -41.7)) - 0.5) * detail * detail;
  float hay = smoothstep(0.40, 0.78, hayBroad * 0.72 + mix(0.5, hayFine, detail) * 0.28
    + (0.5 - moist) * 0.30 + cluster * 0.30);
  float lush = smoothstep(0.38, 0.82, greenTone + (moist - 0.5) * 0.24
    - cluster * 0.36) * (1.0 - hay);
  float swath = meadowNoise(vec2(lay.x * ${f(1 / P.meadowLodgeAlong)},
    (lay.y + (hayBroad - 0.5) * ${f(P.meadowLodgeMeander)}) * ${f(1 / P.meadowLodgeAcross)}) + vec2(-3.1, 8.7));
  return vec3(hay, lush, mix(0.5, smoothstep(0.22, 0.84, swath + cluster * 0.22), detail * 0.65));
}
// Broad hay/green transitions dominate the finer swaths, so grass and ground
// retain the same quiet field masses at middle distance. Mean luminance near 1.
vec3 meadowTint(vec3 sward) {
  vec3 tint = mix(vec3(1.02, 1.05, 0.90), vec3(0.72, 0.83, 0.70), sward.y * ${f(P.meadowGreenStrength)});
  tint = mix(tint, vec3(1.22, 1.07, 0.64), sward.x * ${f(P.meadowHayStrength)});
  return tint * mix(vec3(1.0), vec3(1.04, 1.02, 0.93), sward.z * 0.5);
}
// Lodged swaths read lighter looking down the grain and fade looking against it.
float meadowSheen(vec2 xz, vec3 eye, float lodge) {
  vec2 view = xz - eye.xz;
  float grain = dot(view, MEADOW_WIND) / max(length(view), 1.0);
  return 1.0 + ${f(P.meadowSheen)} * (lodge * 2.0 - 1.0) * (0.45 + 0.55 * grain);
}
`;
