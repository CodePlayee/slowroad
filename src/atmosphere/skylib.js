// src/atmosphere/skylib.js
// The ONE definition of "what colour is the sky in direction d".
//
// This GLSL is injected into two places:
//   1. the sky dome (sky.js)            -> skyFull()  : gradient + clouds + sun disc + stars
//   2. three's fog chunk (fog.js)       -> skyBase()  : gradient + sunward haze + aureole
//
// Because the fog inscatter colour is *literally the sky colour in the view direction*,
// a distant ridge converges on the exact pixel value of the sky immediately above it.
// That is what makes ridgelines separate into layers instead of dissolving into one
// grey wall — see src/atmosphere/TARGETS.md, sr_01 / sr_03.
//
// Owned by the ATMOSPHERE builder.

import * as THREE from 'three';

/**
 * Shared-by-reference uniforms. Every material that draws sky or receives fog gets
 * these exact objects, so `Atmosphere.apply()` is the single update point.
 */
export const skyUniforms = {
  // ---- vertical gradient: 3 stops evaluated against an airmass-ish parameter
  uSkyZenith: { value: new THREE.Color(0.045, 0.16, 0.62) },
  uSkyMid: { value: new THREE.Color(0.16, 0.40, 0.86) },
  uSkyHorizon: { value: new THREE.Color(0.52, 0.72, 1.00) },
  uSkySunHaze: { value: new THREE.Color(0.80, 0.86, 1.00) },
  uSkyGround: { value: new THREE.Color(0.30, 0.38, 0.48) },
  // x = profile exponent (higher -> horizon colours hug the horizon)
  // y = position of the mid stop along the profile 0..1
  // z = sunward wedge exponent, w = sunward wedge amount
  uSkyShape: { value: new THREE.Vector4(2.4, 0.55, 2.2, 0.9) },

  // ---- sun
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunTint: { value: new THREE.Color(1, 1, 1) },
  // x = Mie g, y = aureole amount, z = disc amount, w = disc angular radius (rad)
  // Keep the broad Mie lobe restrained at low sun; the authored sky ramp
  // supplies the warm gradient, while this lobe should not bleach the whole
  // golden frame around the sun.
  uSunLobe: { value: new THREE.Vector4(0.76, 0.12, 6.0, 0.0075) },

  // ---- night
  uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
  uMoonTint: { value: new THREE.Color(0.90, 0.93, 1.0) },
  // x = moon amount, y = moon phase (-1..1), z = star amount, w = milky way amount
  uNight: { value: new THREE.Vector4(0, 0.35, 0, 0) },

  // ---- clouds
  // x = low deck cover, y = low deck opacity, z = cirrus cover, w = cirrus opacity
  uCloud: { value: new THREE.Vector4(0.42, 0.55, 0.45, 0.30) },
  uCloudLit: { value: new THREE.Color(1.0, 0.99, 0.96) },
  uCloudDark: { value: new THREE.Color(0.42, 0.50, 0.62) },
  // x,y = low deck drift, z = cirrus drift, w = low deck softness
  uCloudDrift: { value: new THREE.Vector4(0, 0, 0, 0.5) },
  uSkyTime: { value: 0 },
};

/** GLSL: uniform declarations. Include once per shader that uses SKY_FUNCS. */
export const SKY_UNIFORM_DECL = /* glsl */`
uniform vec3 uSkyZenith;
uniform vec3 uSkyMid;
uniform vec3 uSkyHorizon;
uniform vec3 uSkySunHaze;
uniform vec3 uSkyGround;
uniform vec4 uSkyShape;
uniform vec3 uSunDir;
uniform vec3 uSunTint;
uniform vec4 uSunLobe;
uniform vec3 uMoonDir;
uniform vec3 uMoonTint;
uniform vec4 uNight;
uniform vec4 uCloud;
uniform vec3 uCloudLit;
uniform vec3 uCloudDark;
uniform vec4 uCloudDrift;
uniform float uSkyTime;
`;

/** GLSL: hash / value noise / fbm. Standalone so fog can use the dither too. */
export const NOISE_FUNCS = /* glsl */`
float atmoHash12( vec2 p ) {
  p = fract( p * vec2( 233.34, 851.73 ) );
  p += dot( p, p + 23.45 );
  return fract( p.x * p.y );
}
float atmoVNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = atmoHash12( i );
  float b = atmoHash12( i + vec2( 1.0, 0.0 ) );
  float c = atmoHash12( i + vec2( 0.0, 1.0 ) );
  float d = atmoHash12( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
float atmoFbm( vec2 p, const int oct ) {
  float s = 0.0, a = 0.5, n = 0.0;
  for ( int i = 0; i < oct; i ++ ) {
    s += a * atmoVNoise( p );
    n += a; p = p * 2.07 + vec2( 17.3, -9.1 ); a *= 0.5;
  }
  return s / n;
}
`;

/**
 * GLSL: the sky itself.
 *
 *   vec3 skyBase( vec3 d )   gradient + sunward wedge + Mie aureole    (fog uses this)
 *   vec3 skyFull( vec3 d )   skyBase + sun disc + moon + stars + clouds (dome uses this)
 *
 * The vertical profile is `w = pow(1 - max(d.y,0), n)` — a cheap stand-in for relative
 * airmass. It is 0 at the zenith and 1 at the horizon, and the exponent concentrates the
 * bright horizon band into the low sky the way a real Rayleigh column does. Three colour
 * stops (zenith / mid / horizon) are needed because dusk requires a long hue rotation
 * (mauve 324 deg high -> peach 27 deg at the horizon, sr_02).
 *
 * The sunward wedge replaces the horizon stop with a warm one as a function of *azimuthal*
 * proximity to the sun only. A full horizon ring would be wrong: sr_02 is peach on the
 * sun side and mauve 60 deg away at the same elevation.
 */
export const SKY_FUNCS = /* glsl */`
vec3 atmoGradient( vec3 d ) {
  float up = clamp( d.y, 0.0, 1.0 );
  float w = pow( 1.0 - up, uSkyShape.x );

  // sunward warm wedge (azimuth only), GATED BY HEIGHT.
  // The height gate is not optional: applied to the stops unmodulated it lifts the whole
  // dome toward the warm/pale haze colour and takes a clear midday sky from S0.32 to
  // S0.04. Because the profile exponent drops at low sun, w stays high much further up
  // the dome at dusk, so the wedge automatically reaches higher then — which is what
  // sr_02 and sr_04 show.
  vec2 hd = d.xz;
  vec2 sd = uSunDir.xz;
  float hl = length( hd ), sl = length( sd );
  float az = ( hl > 1e-5 && sl > 1e-5 ) ? dot( hd / hl, sd / sl ) : 1.0;
  float wedge = pow( max( az * 0.5 + 0.5, 0.0 ), uSkyShape.z ) * uSkyShape.w;
  wedge *= 0.13 + 0.87 * w;

  vec3 hor = mix( uSkyHorizon, uSkySunHaze, wedge );
  vec3 mid = mix( uSkyMid, uSkySunHaze, wedge * 0.42 );

  float m = uSkyShape.y;
  float a = clamp( w / max( m, 1e-3 ), 0.0, 1.0 );
  float b = clamp( ( w - m ) / max( 1.0 - m, 1e-3 ), 0.0, 1.0 );
  vec3 col = mix( mix( uSkyZenith, mid, a ), hor, b );

  // Below the horizon we stay on the horizon colour and only darken well down, so that
  // fully hazed distant terrain converges on the pixel value of the sky right above it
  // (sr_11: hill #acb5bd vs sky #abb4bd). Scaling the horizon stop down instead reveals
  // its true chroma — a clear-day horizon is B/R ~ 46 in linear and only looks pale
  // because the tonemapper compresses it — and paints every distant hill electric blue.
  col = mix( col, uSkyGround, smoothstep( 0.0, -0.30, d.y ) );
  return col;
}

vec3 atmoAureole( vec3 d ) {
  // Two Henyey-Greenstein Mie lobes, both *tinted*: a broad one for the general sunward
  // brightening and a very tight one for the circumsolar glow that stops the sun disc
  // reading as a pasted-on dot. A white halo added over the whole hemisphere (the old
  // pow(cos,7) term) is what washed the sky to S0.03.
  float cg = dot( d, uSunDir );
  float g = uSunLobe.x;
  float d1 = max( 1.0 + g * g - 2.0 * g * cg, 1e-4 );
  float hg1 = ( 1.0 - g * g ) / ( 12.5663706 * pow( d1, 1.5 ) );
  const float g2 = 0.955;
  float d2 = max( 1.0 + g2 * g2 - 2.0 * g2 * cg, 2.0e-3 );
  float hg2 = ( 1.0 - g2 * g2 ) / ( 12.5663706 * pow( d2, 1.5 ) );
  float horizonBoost = 1.0 + 0.60 * exp( -max( d.y, 0.0 ) * 6.0 );
  return uSunTint * ( hg1 + hg2 * 0.34 ) * uSunLobe.y * horizonBoost;
}

vec3 skyBase( vec3 d ) {
  return atmoGradient( d ) + atmoAureole( d );
}

vec3 atmoStars( vec3 d ) {
  if ( uNight.z < 0.002 || d.y < -0.03 ) return vec3( 0.0 );
  // gnomonic-ish projection keeps star size roughly constant
  vec3 ad = abs( d );
  vec2 sp = ad.y >= max( ad.x, ad.z ) ? d.xz / ad.y
          : ( ad.x >= ad.z ? d.zy / ad.x : d.xy / ad.z );
  sp *= 118.0;
  vec2 cell = floor( sp );
  float r1 = atmoHash12( cell );
  vec3 col = vec3( 0.0 );
  if ( r1 > 0.9955 ) {
    vec2 jit = vec2( atmoHash12( cell + 5.7 ), atmoHash12( cell + 11.3 ) );
    float dd = length( fract( sp ) - jit );
    float mag = ( r1 - 0.9955 ) / 0.0045;
    float bright = 0.25 + 1.75 * mag * mag;
    float tw = 0.82 + 0.18 * sin( uSkyTime * 2.1 + r1 * 90.0 );
    float core = exp( -dd * dd * 620.0 ) + 0.20 * exp( -dd * dd * 55.0 );
    vec3 tint = mix( vec3( 1.0, 0.86, 0.72 ), vec3( 0.78, 0.86, 1.0 ), atmoHash12( cell + 23.1 ) );
    col += tint * core * bright * tw;
  }
  // milky way: soft band about a fixed great circle, broken up by fbm
  if ( uNight.w > 0.002 ) {
    const vec3 mwAxis = vec3( 0.512, 0.694, -0.506 );
    float t = dot( d, mwAxis );
    float band = exp( -t * t * 34.0 );
    float n = atmoFbm( vec2( atan( d.z, d.x ) * 2.6, d.y * 5.5 ), 4 );
    col += vec3( 0.62, 0.66, 0.86 ) * band * ( 0.30 + 0.90 * n ) * uNight.w * 0.045;
  }
  return col * uNight.z * smoothstep( -0.03, 0.14, d.y );
}

vec3 atmoClouds( vec3 d, vec3 col ) {
  if ( d.y < 0.004 ) return col;
  vec2 sunAz = uSunDir.xz;
  float sl = length( sunAz );
  sunAz = sl > 1e-4 ? sunAz / sl : vec2( 0.0, 1.0 );

  // ---- low deck (cumulus / stratus) --------------------------------------
  // The plane projection d.xz / d.y is in units of (ground distance / deck altitude).
  // A ~1 km cloud under a ~2 km deck therefore needs a noise scale near 1.5. The first
  // version of this used 0.055, which put the whole visible sky inside a single noise
  // cell — the "cloud" became a uniform near-white veil and single-handedly washed the
  // sky from S0.31 to S0.03. Do not lower these numbers.
  if ( uCloud.y > 0.004 ) {
    vec2 p = d.xz * ( 1.55 / max( d.y, 0.030 ) ) + uCloudDrift.xy;
    float n = atmoFbm( p, 5 );
    // second tap offset toward the sun -> real directional shading on the edges
    float ns = atmoFbm( p + sunAz * 0.55, 4 );
    float soft = mix( 0.26, 0.03, uCloudDrift.w );
    float lo = mix( 0.70, 0.14, uCloud.x );
    float cover = smoothstep( lo, lo + soft + 0.09, n );
    cover *= smoothstep( 0.010, 0.075, d.y );          // thin out at the horizon
    // Fade the deck out again as it approaches the horizon: a cloud layer seen edge-on is
    // hidden behind its own haze, and without this the deck ends in a hard bright line
    // exactly where the terrain silhouette is, which reads as a rendering seam.
    cover *= 1.0 - 0.55 * exp( -max( d.y, 0.0 ) * 22.0 );
    float lit = clamp( ( n - ns ) * 3.4 + 0.52, 0.0, 1.0 );
    lit = mix( lit, smoothstep( 0.30, 0.80, n ), 0.35 );
    vec3 cc = mix( uCloudDark, uCloudLit, lit );
    col = mix( col, cc, cover * uCloud.y );
  }

  // ---- high cirrus: thin, stretched streaks, deliberately faint -----------
  if ( uCloud.w > 0.004 ) {
    vec2 q = d.xz * ( 1.0 / max( d.y, 0.055 ) );
    q = q * vec2( 1.15, 4.40 ) + vec2( uCloudDrift.z, uCloudDrift.z * 0.35 );
    float n = atmoFbm( q, 4 );
    float lo = mix( 0.62, 0.34, uCloud.z );
    float cover = smoothstep( lo, lo + 0.26, n ) * smoothstep( 0.03, 0.22, d.y );
    // cirrus is optically thin: it brightens the sky it sits on rather than replacing it
    vec3 cc = mix( col, uCloudLit, 0.72 );
    col = mix( col, cc, cover * uCloud.w );
  }
  return col;
}

vec3 skyFull( vec3 d ) {
  vec3 col = atmoGradient( d );
  col = atmoClouds( d, col );
  col += atmoAureole( d );
  col += atmoStars( d );

  // sun disc with limb darkening, drawn on top of the clouds only when high enough
  float cg = dot( d, uSunDir );
  float ang = acos( clamp( cg, -1.0, 1.0 ) );
  float r = ang / uSunLobe.w;
  float disc = 1.0 - smoothstep( 0.90, 1.02, r );
  float mu = sqrt( max( 1.0 - min( r * r, 1.0 ), 0.0 ) );
  float limb = 0.42 + 0.58 * pow( mu, 0.62 );
  col += uSunTint * disc * limb * uSunLobe.z;

  // moon: disc + phase terminator + small glow
  if ( uNight.x > 0.002 ) {
    float mg = dot( d, uMoonDir );
    float mang = acos( clamp( mg, -1.0, 1.0 ) );
    float mr = mang / 0.0092;
    float mdisc = 1.0 - smoothstep( 0.88, 1.02, mr );
    // phase: shade the limb away from the (virtual) light direction
    vec3 up = abs( uMoonDir.y ) < 0.95 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
    vec3 rx = normalize( cross( up, uMoonDir ) );
    float lx = dot( normalize( d - uMoonDir * mg ), rx ) * min( mr, 1.0 );
    float phase = smoothstep( uNight.y - 0.22, uNight.y + 0.22, lx );
    float mmu = sqrt( max( 1.0 - min( mr * mr, 1.0 ), 0.0 ) );
    col += uMoonTint * mdisc * ( 0.10 + 0.90 * phase ) * ( 0.55 + 0.45 * mmu ) * 3.2 * uNight.x;
    float mglow = exp( -mang * mang * 1400.0 ) * 0.11 + exp( -mang * mang * 130.0 ) * 0.012;
    col += uMoonTint * mglow * uNight.x;
  }
  return col;
}
`;
