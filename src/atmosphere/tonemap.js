// src/atmosphere/tonemap.js
// Display transform for the whole game, installed by replacing three's
// `CustomToneMapping` stub inside the `tonemapping_pars_fragment` chunk.
//
// WHY here and not a post pass: three injects `tonemapping_pars_fragment` into the
// fragment prefix of *every* non-raw material, sky dome included. Overriding the stub
// therefore gives us one grade point for the entire frame at the cost of zero extra
// draw calls, zero render targets, and no loss of MSAA. A EffectComposer bloom/grade
// chain would cost a full 1920x1080 resolve + several passes for a look the reference
// set does not actually have (there is no visible bloom in any of the 24 official shots).
//
// Chain: exposure -> AgX (log2 encode + sigmoid contrast) -> look (slope/power/sat)
//        -> AgX EOTF -> vignette -> ordered dither.
//
// AgX rather than ACES because ACES' RRT shoulder desaturates saturated blues toward
// white, which is precisely the failure mode of the old sky (S0.03 on the hazy vista).
// AgX holds hue into the highlights, so a horizon at V1.0 stays blue.
//
// The dither matters: our sky is now a long smooth gradient across ~2000px and banded
// visibly at 8 bit without it.
//
// Owned by the ATMOSPHERE builder.

import * as THREE from 'three';

export const gradeUniforms = {
  // x = slope, y = power, z = saturation, w = unused
  uGradeLook: { value: new THREE.Vector4(1.0, 1.0, 1.12, 0.0) },
  // per-time-of-day split tone: multiplied into shadows / highlights
  uGradeShadow: { value: new THREE.Color(1.0, 1.0, 1.0) },
  uGradeHigh: { value: new THREE.Color(1.0, 1.0, 1.0) },
  // x = vignette amount, y = vignette radius, z = dither amount, w = unused
  uGradeVig: { value: new THREE.Vector4(0.16, 0.72, 1.0, 0.0) },
  uGradeRes: { value: new THREE.Vector2(1920, 1080) },
};

const STUB = 'vec3 CustomToneMapping( vec3 color ) { return color; }';

const IMPL = /* glsl */`
uniform vec4 uGradeLook;
uniform vec3 uGradeShadow;
uniform vec3 uGradeHigh;
uniform vec4 uGradeVig;
uniform vec2 uGradeRes;

vec3 agxLookGrade( vec3 v ) {
  float luma = dot( v, vec3( 0.2126, 0.7152, 0.0722 ) );
  v = pow( max( v * uGradeLook.x, 0.0 ), vec3( uGradeLook.y ) );
  v = luma + uGradeLook.z * ( v - luma );
  // split tone in the display-encoded domain: cool shadows / warm highs read as
  // atmospheric depth for free and cost three mixes.
  float lo = 1.0 - smoothstep( 0.02, 0.55, luma );
  float hi = smoothstep( 0.45, 1.0, luma );
  v *= mix( vec3( 1.0 ), uGradeShadow, lo );
  v *= mix( vec3( 1.0 ), uGradeHigh, hi );
  return max( v, 0.0 );
}

vec3 CustomToneMapping( vec3 color ) {
  const mat3 AgXIn = mat3(
    vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
    vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
    vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 )
  );
  const mat3 AgXOut = mat3(
    vec3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826 ),
    vec3( -0.11060664309660323, 1.157823702216272, -0.11060664309660294 ),
    vec3( -0.016493938717834573, -0.016493938717834257, 1.2519364065950405 )
  );
  const float MinEv = -12.47393;
  const float MaxEv = 4.026069;

  color = max( color, 0.0 ) * toneMappingExposure;
  color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
  color = AgXIn * color;
  color = log2( max( color, 1e-10 ) );
  color = clamp( ( color - MinEv ) / ( MaxEv - MinEv ), 0.0, 1.0 );
  color = agxDefaultContrastApprox( color );
  color = agxLookGrade( color );
  color = AgXOut * color;
  color = pow( max( color, 0.0 ), vec3( 2.2 ) );
  color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
  color = clamp( color, 0.0, 1.0 );

  // ---- vignette (guarded: unbound uniforms read as 0 on unregistered materials)
  if ( uGradeVig.x > 0.001 && uGradeRes.x > 4.0 ) {
    vec2 uv = gl_FragCoord.xy / uGradeRes - 0.5;
    uv.x *= uGradeRes.x / uGradeRes.y;
    float r = length( uv ) / max( uGradeVig.y, 0.05 );
    float v = 1.0 - uGradeVig.x * smoothstep( 0.55, 1.35, r );
    color *= v;
  }

  // ---- dither: kills gradient banding in the sky at 8 bit
  if ( uGradeVig.z > 0.001 ) {
    vec2 fc = gl_FragCoord.xy;
    float d = fract( sin( dot( fc, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
    float d2 = fract( sin( dot( fc + 1.7, vec2( 63.7264, 10.873 ) ) ) * 24634.6345 );
    color += ( d + d2 - 1.0 ) * ( uGradeVig.z / 255.0 ) * 0.85;
    color = max( color, 0.0 );
  }
  return color;
}`;

let installed = false;

/** Patch the chunk. MUST be called before the first material compiles. */
export function installToneMapping(renderer) {
  if (!installed) {
    installed = true;
    const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
    if (chunk.indexOf(STUB) < 0) {
      console.warn('[atmosphere] CustomToneMapping stub not found — three version drift; ' +
        'falling back to AgX. Expected: ' + STUB);
      renderer.toneMapping = THREE.AgXToneMapping;
      return false;
    }
    THREE.ShaderChunk.tonemapping_pars_fragment = chunk.replace(STUB, IMPL);
  }
  renderer.toneMapping = THREE.CustomToneMapping;
  return true;
}
