// src/vehicle/mirror.js — interior rear-view mirror without a second render pass.
//
// The supplied Model Y authors the mirror glass as white, fully metallic,
// roughness ~0.1 texels of M_Int_ChromePlastic. Under the vehicle IBL (a
// desaturated sky/ground-only PMREM) that is a polished white reflector of the
// bright upper sky, so the mirror rendered as a blank white plate. The glass is
// split into its own unlit material that draws what a planar mirror aimed at
// the rear window shows: the shared sky (same function as the dome) along the
// true reflected ray, and a cheap analytic world behind the car — the road
// with its markings, verges, roadside tree lines and distant hills — lit by the
// scene's own sun/sky/ambient light and seen through the tinted rear glass.
import * as THREE from 'three';
import { VEHICLE as V } from './params.js';
import { ROAD } from '../road/params.js';
import { skyUniforms, SKY_UNIFORM_DECL, SKY_FUNCS, NOISE_FUNCS } from '../atmosphere/skylib.js';
import { splitTrianglesByRole } from './lamps.js';

export const MIRROR_MESH = 'Roof_Internal_ChromePlastic';

export const MIRROR = {
  aimDown: 0.026,        // tan of the reflected centre ray below level (driver aims it at the rear window)
  glassTint: 0.72,       // rear-glass transmission
  reflectance: 0.82,     // silvered glass
  asphalt: [0.128, 0.130, 0.134], // roadmesh.js uAsphalt / uPaint
  paint: [0.90, 0.90, 0.87],
  snow: [0.80, 0.82, 0.86],
  haze: 0.0011,          // 1/m aerial fade toward the horizon sky
};

// Mirror glass of the supplied model: the rear-facing face of the mirror head
// (model space, +Z forward) that samples the white metal texels (uv < 0.2, 0.05);
// the dark bezel ring in front of it uses other texels and stays base material.
export function isMirrorGlass(centre, normal, uv) {
  return Math.abs(centre.x) < 0.12 && centre.y > 1.37 && centre.y < 1.435 && centre.z > 0.335 && centre.z < 0.352
    && Math.abs(normal.z) > 0.8 && uv.x < 0.2 && uv.y < 0.05;
}

/**
 * Move the mirror glass triangles of `geometry` into a second material group.
 * Returns the glass centre in model space, or null when the mesh has none.
 */
export function splitMirrorGlass(geometry, toModel) {
  const uvs = geometry.attributes.uv;
  if (!uvs) return null;
  const centre = new THREE.Vector3(), uv = new THREE.Vector2();
  let count = 0;
  const roles = splitTrianglesByRole(geometry, toModel, (c, n, i0) => {
    if (!isMirrorGlass(c, n, uv.fromBufferAttribute(uvs, i0))) return null;
    centre.add(c); count++;
    return 'mirror';
  }, ['mirror']);
  return roles ? centre.divideScalar(count) : null;
}

const f = (x) => Number(x).toFixed(5);
const v3 = (a) => `vec3(${a.map(f).join(', ')})`;
const HALF_PAVE = ROAD.laneWidth + ROAD.shoulderWidth;

const VERT_DECL = /* glsl */`
uniform vec3 uMirrorNormal;
uniform vec3 uMirrorSide;
uniform vec3 uMirrorForward;
varying vec3 vMirrorPos;
varying vec3 vMirrorN;
varying vec3 vMirrorSide;
varying vec3 vMirrorFwd;`;

const VERT_BODY = /* glsl */`
vMirrorPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vMirrorN = mat3( modelMatrix ) * uMirrorNormal;
vMirrorSide = mat3( modelMatrix ) * uMirrorSide;
vMirrorFwd = mat3( modelMatrix ) * uMirrorForward;`;

const FRAG_DECL = /* glsl */`
#ifndef USE_FOG
${SKY_UNIFORM_DECL}
${NOISE_FUNCS}
${SKY_FUNCS}
#endif
uniform float uMirrorHeight;
uniform float uMirrorTravel;
uniform vec3 uMirrorLight;
uniform vec3 uMirrorGrass;
uniform vec3 uMirrorTrees;
varying vec3 vMirrorPos;
varying vec3 vMirrorN;
varying vec3 vMirrorSide;
varying vec3 vMirrorFwd;

// Pixel coverage of a line of half-width hw at distance d (box-filtered).
float mirrorLine( float d, float hw ) {
  float w = max( fwidth( d ), 1e-4 );
  return clamp( ( hw + 0.5 * w - d ) / w, 0.0, 1.0 ) * min( 1.0, 2.0 * hw / w );
}

vec3 mirrorView() {
  vec3 R = reflect( normalize( vMirrorPos - cameraPosition ), normalize( vMirrorN ) );
  vec3 side = normalize( vMirrorSide ), fwd = normalize( vMirrorFwd );
  // Vehicle frame: +x toward the road centre (the car keeps right), b behind.
  float rx = dot( R, side ), rb = max( -dot( R, fwd ), 1e-3 );
  float horiz = max( length( vec2( rx, rb ) ), 1e-4 );
  float slope = R.y / horiz;                 // tan(elevation)
  vec3 haze = skyBase( normalize( vec3( R.x, 0.0, R.z ) + vec3( 0.0, 1e-4, 0.0 ) ) );
  vec3 col = skyFull( normalize( vec3( R.x, max( R.y, 0.0 ), R.z ) ) );

  // Distant hills, anchored to the world azimuth so they turn with the car.
  float worldAz = atan( R.x, R.z );
  float ridge = 0.004 + 0.016 * atmoFbm( vec2( worldAz * 6.0, 2.7 ), 3 );
  if ( slope < ridge ) col = mix( uMirrorTrees * uMirrorLight * 0.7, haze, 0.82 );

  float dist = 1e9;
  vec3 surface = col;
  // Ground plane behind the car: asphalt, markings, verge.
  if ( slope < 0.0 ) {
    float d = uMirrorHeight / -slope;
    float x = rx / horiz * d, back = rb / horiz * d;
    float lat = abs( x - ${f(V.laneOffset)} );
    vec3 albedo = uMirrorGrass;
    if ( lat < ${f(HALF_PAVE)} ) {
      float period = ${f(ROAD.centreDashLen + ROAD.centreDashGap)};
      float dash = step( fract( ( uMirrorTravel - back ) / period ), ${f(ROAD.centreDashLen / (ROAD.centreDashLen + ROAD.centreDashGap))} );
      float paint = max( mirrorLine( abs( lat - ${f(HALF_PAVE - 0.30)} ), ${f(ROAD.edgeLineWidth / 2)} ),
        mirrorLine( lat, ${f(ROAD.centreLineWidth / 2)} ) * dash );
      albedo = mix( ${v3(MIRROR.asphalt)}, ${v3(MIRROR.paint)}, paint * 0.92 );
    }
    surface = albedo * uMirrorLight;
    dist = d;
  }
  // Roadside tree lines beyond each verge; the canopy height varies along the
  // road and scrolls with the distance driven.
  float rowX = rx > 0.0 ? ${f(V.laneOffset + HALF_PAVE + ROAD.vergeWidth + 5.0)} : ${f(V.laneOffset - HALF_PAVE - ROAD.vergeWidth - 3.0)};
  float dRow = rowX / ( rx / horiz );
  if ( dRow > 0.0 && dRow < dist ) {
    float back = rb / horiz * dRow, sideId = rx > 0.0 ? 7.3 : -4.1;
    float s = ( uMirrorTravel - back ) / 16.0;
    // Far rows are averaged toward a mean canopy instead of aliasing to speckle.
    float far = smoothstep( 150.0, 600.0, dRow );
    float stand = mix( smoothstep( 0.36, 0.52, atmoFbm( vec2( s, sideId ), 3 ) ), 0.5, far );
    float height = stand * mix( 7.0 + 12.0 * atmoVNoise( vec2( s * 3.1, sideId * 2.0 ) ), 13.0, far );
    float y = slope * dRow + uMirrorHeight;  // ray height above the road at the row
    if ( y < height ) {
      float shade = 0.55 + 0.25 * atmoVNoise( vec2( s * 9.0, y * 1.7 + sideId ) );
      surface = uMirrorTrees * uMirrorLight * shade;
      dist = dRow;
    }
  }
  if ( dist < 1e8 ) col = mix( surface, haze, 1.0 - exp( -dist * ${f(MIRROR.haze)} ) );

  // Seen through the tinted rear window (it fills the glass from the driver's eye).
  return col * ${f(MIRROR.glassTint * MIRROR.reflectance)};
}`;

/**
 * Unlit material for the split mirror glass. `toModel` maps the mesh's
 * geometry to model space; `eye` and `centre` are model-space points. The
 * normal is re-aimed (as a driver adjusts the mirror) so the eye's ray to the
 * glass centre reflects straight back through the rear window.
 */
export function createRearMirrorMaterial(toModel, eye, centre) {
  const toObject = new THREE.Matrix4().copy(toModel).invert();
  const view = centre.clone().sub(eye).normalize();
  const back = new THREE.Vector3(0, -MIRROR.aimDown, -1).normalize();
  const uniforms = {
    uMirrorNormal: { value: back.sub(view).normalize().transformDirection(toObject) },
    uMirrorSide: { value: new THREE.Vector3(1, 0, 0).transformDirection(toObject) },
    uMirrorForward: { value: new THREE.Vector3(0, 0, 1).transformDirection(toObject) },
    uMirrorHeight: { value: centre.y + V.rideHeight },
    uMirrorTravel: { value: 0 },
    uMirrorLight: { value: new THREE.Color(0.3, 0.3, 0.3) },
    uMirrorGrass: { value: new THREE.Color(0.16, 0.315, 0.09) },
    uMirrorTrees: { value: new THREE.Color(0.1, 0.19, 0.09) },
  };
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  material.name = 'M_Int_RearMirror';
  material.userData.mirrorUniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, skyUniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>\n${FRAG_DECL}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mirrorView();');
  };
  return material;
}

const _color = new THREE.Color();

/** Per-frame: scene light, seasonal albedos and distance driven. */
export function updateRearMirror(material, atmo, travel) {
  const u = material.userData.mirrorUniforms;
  u.uMirrorTravel.value = travel;
  const { sun, hemi, ambient, palette } = atmo;
  if (!sun || !hemi || !ambient || !palette) return;
  // Lambert radiance per unit albedo of a level surface (three.js: albedo/pi ×
  // (direct·cos + hemisphere sky + ambient)).
  const dir = (palette.dayness ?? 1) > 0.02 ? atmo.sunDir : atmo.moonDir;
  const light = u.uMirrorLight.value.copy(sun.color).multiplyScalar(sun.intensity * Math.max(dir?.y ?? 0, 0));
  light.add(_color.copy(hemi.color).multiplyScalar(hemi.intensity));
  light.add(_color.copy(ambient.color).multiplyScalar(ambient.intensity));
  light.multiplyScalar(1 / Math.PI);
  const snow = palette.snowAmount || 0;
  if (palette.grassLush) u.uMirrorGrass.value.setRGB(...palette.grassLush).lerp(_color.setRGB(...MIRROR.snow), snow * 0.9);
  if (palette.conifer) u.uMirrorTrees.value.setRGB(...palette.conifer).lerp(_color.setRGB(...MIRROR.snow), snow * 0.25);
}
