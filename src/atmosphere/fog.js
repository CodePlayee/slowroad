// src/atmosphere/fog.js
// Aerial perspective. Replaces three's fog chunks entirely.
//
// Three things happen per fragment, in this order, and the order is the whole trick:
//
//  1. TWO haze layers are integrated analytically along the view ray:
//       A — a broad exponential-height column (the "air"), e-folding over ~450 m.
//           This is what separates ridge from ridge: the base of a far ridge sits deep
//           in the column and washes out, its top pokes into thinner air and stays
//           readable, so each ridge reads as a distinct silhouette.
//       B — a shallow, dense valley layer with a steep falloff (~40 m e-fold) and a
//           hard-ish top. This is dawn/dusk valley mist: it fills the low ground and
//           leaves everything above it crisp (sr_13, sr_05).
//     plus a height-independent distance term so the very far field always closes.
//
//  2. The surface colour is DESATURATED toward its own luminance in proportion to the
//     haze, *before* being mixed with the haze colour. Without this step a green hill
//     mixed 60% toward pale blue is a muddy teal; with it, it becomes the pale blue with
//     its own value structure, which is what the reference actually shows
//     (sr_01 far hill: hue 205 deg, S0.38 — the sky's saturation, not grey).
//
//  3. The mix toward the haze colour uses a LOWER exponent for dark pixels than for
//     bright ones, so local contrast collapses slightly before value does. Distant
//     forest becomes a flat blue mass rather than a blue-tinted forest.
//
// The haze colour is `skyBase(viewDir)` — the same function the sky dome draws with. A
// ridge therefore converges on the exact pixel value of the sky above it.
//
// Owned by the ATMOSPHERE builder.

import * as THREE from 'three';
import { skyUniforms, SKY_UNIFORM_DECL, SKY_FUNCS, NOISE_FUNCS } from './skylib.js';
import { gradeUniforms } from './tonemap.js';

export const fogUniforms = {
  // layer A — broad aerial column
  // x = density at base, y = 1/m height falloff, z = base altitude, w = flat distance term
  uHazeA: { value: new THREE.Vector4(0.00075, 0.0022, 4.0, 0.000030) },
  // layer B — valley mist
  // x = density, y = 1/m falloff, z = base altitude, w = ceiling softness
  uHazeB: { value: new THREE.Vector4(0.0, 0.020, 0.0, 1.0) },
  // x = aerial desaturation, y = dark-pixel exponent, z = mist tint blend,
  // w = perceptual mix gamma (see the note in fog_fragment)
  uAerial: { value: new THREE.Vector4(0.85, 0.74, 0.5, 3.4) },
  uMistColor: { value: new THREE.Color(0.82, 0.84, 0.88) },

  // ---------------------------------------------------------------------------------
  // READ-ONLY COMPATIBILITY HOOK for src/water/water.js.
  // water.js injects its own grazing-angle sky reflection into `#include <fog_fragment>`
  // and reads `uFogColorHigh * 0.86 + uFogColorLow * 0.14` from THIS chunk's uniform
  // block. Removing them silently broke the water shader's compile (it rendered as a
  // blown-out white band across the horizon). They are kept, declared, and driven from
  // the sky: High = mid-sky radiance (what a grazing reflection actually sees looking
  // up), Low = horizon haze radiance. water.js is NOT modified.
  // Any future rename here must be mirrored in water.js by the water owner.
  uFogColorHigh: { value: new THREE.Color(0.45, 0.6, 0.8) },
  uFogColorLow: { value: new THREE.Color(0.7, 0.78, 0.87) },
};

/**
 * Everything a scene material needs bound: haze, the shared sky description (the fog
 * inscatter colour is evaluated from it) and the grade/vignette used by
 * CustomToneMapping. Shared by reference, so Atmosphere.apply() is one update point.
 */
export function allFogUniforms() {
  return Object.assign({}, fogUniforms, skyUniforms, gradeUniforms);
}

let installed = false;

export function installFog() {
  if (installed) return;
  installed = true;

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
  varying vec3 vFogWorldPos;
#endif`;

  THREE.ShaderChunk.fog_vertex = /* glsl */`
#ifdef USE_FOG
  #ifdef USE_INSTANCING
    vFogWorldPos = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
  #else
    vFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  #endif
#endif`;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  varying vec3 vFogWorldPos;
  uniform vec4 uHazeA;
  uniform vec4 uHazeB;
  uniform vec4 uAerial;
  uniform vec3 uMistColor;
  uniform vec3 uFogColorHigh;   // compat hook consumed by src/water/water.js
  uniform vec3 uFogColorLow;    // compat hook consumed by src/water/water.js
${SKY_UNIFORM_DECL}
${NOISE_FUNCS}
${SKY_FUNCS}

  /**
   * Optical depth of an exponentially stratified layer along a ray.
   *   rho(y) = D * exp( -k * ( y - base ) )
   * integrated from the camera to the fragment. dy is the signed altitude change and L
   * the path length; the ( 1 - e^-k dy ) / ( k dy ) factor is the exact average of the
   * exponential over the segment, so it stays correct looking steeply up or down.
   */
  float atmoOpticalDepth( float D, float k, float base, float camY, float dy, float L ) {
    if ( D <= 0.0 ) return 0.0;
    float kd = k * dy;
    float avg = abs( kd ) > 0.008 ? ( 1.0 - exp( -kd ) ) / kd : 1.0 - 0.5 * kd;
    return D * exp( -k * ( camY - base ) ) * avg * L;
  }
#endif`;

  THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG
{
  vec3 fgV = vFogWorldPos - cameraPosition;
  float fgL = length( fgV );
  vec3 fgDir = fgV / max( fgL, 1e-4 );

  float odA = atmoOpticalDepth( uHazeA.x, uHazeA.y, uHazeA.z, cameraPosition.y, fgV.y, fgL );
  float odB = atmoOpticalDepth( uHazeB.x, uHazeB.y, uHazeB.z, cameraPosition.y, fgV.y, fgL );
  float fgF = 1.0 - exp( -max( odA + odB, 0.0 ) );
  fgF = max( fgF, 1.0 - exp( -uHazeA.w * fgL ) );
  // Keep the near road and vegetation contrast intact, but close the valley's
  // far tree line progressively into blue-gray air. This distance-only term
  // creates the reference's separate ridge steps without changing terrain or
  // camera fixtures.
  float farPerspective = smoothstep( 420.0, 1900.0, fgL ) * 0.22;
  fgF = 1.0 - ( 1.0 - fgF ) * ( 1.0 - farPerspective );
  fgF = clamp( fgF, 0.0, 1.0 );

  // haze colour = the sky in this exact direction (no disc, no clouds, no stars)
  vec3 fgCol = skyBase( fgDir );
  // the valley layer is optically thick and locally lit, so it reads as its own colour
  float mistShare = clamp( odB / max( odA + odB, 1e-5 ), 0.0, 1.0 );
  fgCol = mix( fgCol, uMistColor, mistShare * uAerial.z );

  // (2) chroma loss before the mix
  float lum = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( lum ), fgF * uAerial.x );

  // (3) darks lose contrast before brights lose value
  float fDark = pow( fgF, uAerial.y );
  float wMix = mix( fDark, fgF, smoothstep( 0.0, 0.45, lum ) );

  // (4) MIX IN A PERCEPTUALLY COMPRESSED DOMAIN, not in linear radiance.
  // A clear-day horizon is ~100x brighter than a shaded conifer, so a linear
  // extinction/inscatter blend spends its whole visible range in the first 20% of the
  // ladder: measured, a tree at f=0.25 landed on V0.90 where the reference's equivalent
  // ridge step sits at V0.62. Compressing both operands by 1/gamma before the lerp gives
  // an even ladder — 0.21 / 0.68 / 0.86 / 0.93 / 0.96 against the reference's
  // 0.34 / 0.62 / 0.64 / 0.96 (sr_01) — which is what makes successive ridges read as
  // separate layers instead of all snapping to the sky at once.
  float ig = 1.0 / max( uAerial.w, 1.0 );
  vec3 pa = pow( max( gl_FragColor.rgb, 0.0 ), vec3( ig ) );
  vec3 pb = pow( max( fgCol, 0.0 ), vec3( ig ) );
  gl_FragColor.rgb = pow( mix( pa, pb, wMix ), vec3( uAerial.w ) );
}
#endif`;
}

export function fogBeforeOutput(source) {
  // Three's stock fog blends display colors. Our atmosphere is linear HDR,
  // so it must run before the shared tone mapper and output encoding.
  return source.replace(
    /#include <tonemapping_fragment>\s*#include <colorspace_fragment>\s*#include <fog_fragment>/g,
    '#include <fog_fragment>\n#include <tonemapping_fragment>\n#include <colorspace_fragment>',
  );
}

/** Attach the shared uniforms to a material (call once per material). */
export function registerFogMaterial(mat) {
  const prev = mat.onBeforeCompile;
  const shared = allFogUniforms();
  mat.onBeforeCompile = function (shader, renderer) {
    // Do this before the owner's hook. Water injects its reflection immediately
    // before fog and must stay in the same linear-light part of the pipeline.
    shader.fragmentShader = fogBeforeOutput(shader.fragmentShader);
    for (const k in shared) shader.uniforms[k] = shared[k];
    if (prev) prev.call(this, shader, renderer);
  };
  return mat;
}
