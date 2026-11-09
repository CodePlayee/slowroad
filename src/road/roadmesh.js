// src/road/roadmesh.js — the ribbon: asphalt with a crumbled edge and lane markings
// drawn in the shader (no decals, no z-fighting). The dirt rim and turf beside the
// pavement belong to the terrain material. Owned by the ROAD builder.

import * as THREE from 'three';
import { ROAD as R } from './params.js';
import { crossSection, ROAD_EDGES } from '../world/world.js';
import { lerp } from '../core/rng.js';
import { SURFACE_HASH_GLSL } from '../core/shaderNoise.js';
import { buildFurniture, createFurnitureMaterials } from './furniture.js';

const { HALF_PAVE } = ROAD_EDGES;
// Pavement + shoulder stations per ribbon row (see _build).
export const RIBBON_STATIONS = 7;

const VERT_HEAD = /* glsl */`
attribute vec2 aRoad;
varying vec2 vRoad;
varying vec3 vWPosR;
`;
const VERT_BODY = /* glsl */`
  vRoad = aRoad;
  vWPosR = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;
const FRAG_HEAD = /* glsl */`
varying vec2 vRoad;
varying vec3 vWPosR;
uniform vec3 uAsphalt;
uniform vec3 uPaint;
uniform float uHalfPave;
uniform vec3 uEdgeGravel;
uniform float uRoadScuffInner;
uniform float uRoadContactDarken;
uniform vec3 uSnow;
uniform float uSnowAmount;
uniform float uDashLen;
uniform float uGapLen;
uniform float uPaintWear;
uniform vec4 uVehicleContact;
uniform vec4 uVehicleFootprint;
uniform float uVehicleShadowOpacity;

${SURFACE_HASH_GLSL}
// Integer hash: the old fract()-of-large-product float hash lost every fractional
// bit a few km from the origin, so fine octaves went flat or quantised en route.
float rhash( vec2 p ) { return surfaceHash( p ); }
float rvn( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( rhash( i ), rhash( i + vec2( 1, 0 ) ), f.x ), mix( rhash( i + vec2( 0, 1 ) ), rhash( i + vec2( 1, 1 ) ), f.x ), f.y );
}
// Value noise whose contrast settles to its mean once a cell nears one pixel,
// so fine material octaves never alias into speckle at range.
float rvnAA( vec2 p ) {
  return mix( 0.5, rvn( p ), 1.0 - smoothstep( 0.35, 1.10, length( fwidth( p ) ) ) );
}
float rfbm( vec2 p ) {
  float s = 0.0, a = 0.5, cell = length( fwidth( p ) );
  for ( int i = 0; i < 4; i ++ ) {
    s += a * mix( 0.5, rvn( p ), 1.0 - smoothstep( 0.35, 1.10, cell ) );
    p *= 2.11; cell *= 2.11; a *= 0.5;
  }
  return s;
}
`;
const FRAG_BODY = /* glsl */`
  float lat = abs( vRoad.x );
  float sAlong = vRoad.y;

  vec2 ru = vWPosR.xz;
  mat2 rot = mat2( 0.82, -0.57, 0.57, 0.82 );
  float grain = rfbm( rot * ru * 0.42 );
  float coarse = rfbm( ru * 0.075 + vec2( 11.0, -4.0 ) );

  // The ribbon stops at the pavement. Its shoulder/verge vertices only carry the
  // crumbled asphalt lip; the terrain draws the dirt rim and turf from the same
  // road distance, so there is no second coplanar ground layer to feather.
  // Two world-space octaves bite 0.08-0.22 m past the paved half-width.
  float edgeBreak = 0.62 * rvn( ru * 0.9 + vec2( 5.0, -7.0 ) )
    + 0.38 * rvnAA( rot * ru * 4.3 + vec2( -2.0, 3.0 ) );
  float paveEdge = uHalfPave + 0.08 + 0.14 * edgeBreak;
  float edgeDist = paveEdge - lat;
  // Asphalt: coarse aggregate at centimetre scale (faded by its pixel footprint so
  // it never aliases), mid-scale binder mottling, sealed repair patches, and two
  // polished wheel paths per lane with dustier ground between and outside them.
  vec2 aggUv = rot * ru * 16.0;
  float aggFootprint = length( fwidth( aggUv ) );
  float aggregate = ( rvn( aggUv ) - 0.5 ) * ( 1.0 - smoothstep( 0.35, 1.10, aggFootprint ) );
  float mottle = rfbm( ru * 0.85 + vec2( -6.0, 2.0 ) );
  float patchField = rvn( rot * ru * 0.11 + vec2( 9.0, 4.0 ) );
  float repair = smoothstep( 0.70, 0.76, patchField ) * smoothstep( 0.30, 0.55, coarse );
  vec3 asphalt = uAsphalt * ( 0.86 + 0.20 * grain ) * ( 0.94 + 0.12 * coarse ) * ( 0.90 + 0.20 * mottle );
  asphalt *= 1.0 + 0.22 * aggregate;
  asphalt *= 1.0 - 0.16 * repair;
  // Traffic wanders by a few centimetres; a world-fixed soft footprint avoids
  // four ruler-straight dark rails when snow reveals the wheel paths.
  float laneLat = abs( lat - uHalfPave * 0.5 );
  float trackOffset = ( coarse - 0.47 ) * 0.20 + ( mottle - 0.47 ) * 0.10;
  float trackWidth = 0.24 + 0.10 * grain;
  float trackDistance = abs( laneLat - 0.80 - trackOffset );
  float wheelTrack = 1.0 - smoothstep( trackWidth * 0.35, trackWidth + 0.20, trackDistance );
  asphalt *= 1.0 - 0.11 * wheelTrack;
  asphalt *= 1.0 + 0.06 * ( 1.0 - smoothstep( 0.0, 0.45, laneLat ) ) + 0.05 * ( 1.0 - smoothstep( 0.0, 0.9, lat ) );
  // Winter tarmac is dark and wet; pale dust below supplies the only lane
  // contrast, so the wheel paths barely deepen beyond the summer polish.
  asphalt *= 1.0 - 0.26 * uSnowAmount;
  asphalt *= 1.0 - 0.06 * uSnowAmount * wheelTrack;
  // Terrain owns the shoulder. Match its world-space scuff, gravel and contact
  // fields at the cut; only the inner transition retains asphalt. Keep these
  // coordinates in sync with terrain.js's bare-rim material contract.
  float rim = 1.0 - smoothstep( 0.0, 0.26 + 0.18 * edgeBreak, edgeDist );
  float rimFootprint = max(length(dFdx(ru)), length(dFdy(ru)));
  float scuffNoise = 0.5, gravelGrain = 0.5, shoulderContact = 0.0, bankContact = 0.0;
  vec3 gravel = uEdgeGravel;
  // All derivatives are outside this branch; interior pavement needs none of
  // the five shoulder noise samples. The slush ramp also ends inside 0.85 m.
  if (edgeDist < 0.85) {
    scuffNoise = mix(rvn(ru * 0.18 + vec2(21.0, -14.0)),
      mix(0.5, rvn(ru * 1.60 + vec2(-3.0, 8.0)),
        1.0 - smoothstep(0.35, 1.10, rimFootprint * 1.60)), 0.32);
    float rimMicro = mix(0.5, rvn(ru * 0.22 + vec2(4.0, 9.0)),
      1.0 - smoothstep(0.20, 0.85, rimFootprint * 0.22));
    float shoulderDistance = lat + (scuffNoise - 0.5) * 1.15 + (rimMicro - 0.5) * 0.30;
    shoulderContact = 1.0 - smoothstep(uRoadScuffInner - 0.55, uRoadScuffInner + 0.45, shoulderDistance);
    // Winter contact follows terrain.js's plough-bank edge, not the scuff meander.
    if (uSnowAmount > 0.0) {
      vec2 bankUv = mat2(0.6, 0.8, -0.8, 0.6) * ru;
      float bankLat = lat + (rvn(bankUv * 0.62 + vec2(9.0, 4.0)) - 0.5) * 0.46
        + (mix(0.5, rvn(bankUv * 2.4 + vec2(-5.0, 12.0)),
          1.0 - smoothstep(0.35, 1.10, rimFootprint * 2.4)) - 0.5) * 0.18;
      bankContact = 1.0 - smoothstep(uRoadScuffInner - 0.85, uRoadScuffInner - 0.45, bankLat);
    }
    gravelGrain = mix(rvn(ru * 0.9 + vec2(-13.0, 5.0)),
      rvn(mat2(0.8, -0.6, 0.6, 0.8) * ru * 3.4 + vec2(7.0, 2.0)),
      0.55 * (1.0 - smoothstep(0.35, 1.10, rimFootprint * 3.4)));
    gravel *= (0.82 + 0.20 * scuffNoise + 0.26 * (gravelGrain - 0.5))
      * (1.0 - shoulderContact * uRoadContactDarken * (0.68 + 0.32 * scuffNoise));
  }
  float lipContact = 1.0 - smoothstep(0.0, 0.14, edgeDist);
  vec3 col = mix(asphalt, gravel, rim * mix(0.78 + 0.18 * grain, 1.0, lipContact));

  float ec = uHalfPave - 0.30;
  float edge = ( 1.0 - smoothstep( 0.055, 0.085, abs( lat - ec ) ) );
  float period = uDashLen + uGapLen;
  float dash = step( fract( sAlong / period ), uDashLen / period );
  float centre = ( 1.0 - smoothstep( 0.048, 0.070, lat ) ) * dash;
  // The edge line lies under the verge slush in winter; the crown dash survives.
  float paint = clamp( edge * ( 1.0 - 0.9 * uSnowAmount ) + centre, 0.0, 1.0 );
  paint *= uPaintWear * ( 0.62 + 0.38 * rfbm( vWPosR.xz * 5.0 ) );
  col = mix( col, uPaint, paint );
  // Snow survives where tyres do not run: a soft ridge on the crown and a dusted
  // strip down the middle of each lane, on otherwise bare wet tarmac. Position,
  // width and presence come from broad world-space fields sampled independently
  // per lane, so the strips meander, thin out and vanish instead of repeating as
  // parallel rails. Fine noise fades with footprint, avoiding distant speckle.
  float snowPatch = rvnAA( rot * ru * 1.3 + vec2( -4.0, 6.0 ) );
  float snowPowder = rvnAA( rot * ru * 6.5 + vec2( 13.0, -2.0 ) );
  float laneSnow = 0.0, dustMid = 0.5;
  if ( uSnowAmount > 0.0 ) {
    float dustSide = vRoad.x < 0.0 ? 1.0 : -1.0;
    float dustBroad = rvnAA( mat2( 0.91, 0.41, -0.41, 0.91 ) * ru * 0.055 + vec2( 3.0 + 37.0 * dustSide, 17.0 ) );
    dustMid = rvnAA( rot * ru * 0.26 + vec2( -8.0, 1.0 + 11.0 * dustSide ) );
    float dustBreak = snowPatch * 0.36 + dustMid * 0.40 + snowPowder * 0.12 + mottle * 0.12;
    float dustShift = ( dustBroad - 0.5 ) * 0.62 + ( dustMid - 0.5 ) * 0.22;
    float laneDust = 1.0 - smoothstep( 0.06 + 0.10 * dustMid, 0.30 + 0.24 * dustBroad,
      abs( lat - uHalfPave * 0.5 - dustShift ) );
    laneDust *= smoothstep( 0.32, 0.72, dustBreak + ( dustBroad - 0.5 ) * 0.30 );
    // Noise that fades to its mean would leave constant lines converging at range.
    laneDust *= 1.0 - 0.6 * smoothstep( 80.0, 300.0, length( vViewPosition ) );
    // Lane fields are sided, so the crown uses only fields continuous across it.
    float crownBreak = snowPatch * 0.55 + mottle * 0.30 + snowPowder * 0.15;
    float crownDust = 1.0 - smoothstep( 0.06 + 0.08 * mottle, 0.18 + 0.16 * coarse,
      abs( vRoad.x - ( coarse - 0.47 ) * 0.30 - ( snowPatch - 0.5 ) * 0.12 - ( mottle - 0.5 ) * 0.10 ) );
    crownDust *= smoothstep( 0.25, 0.62, crownBreak + 0.12 );
    float roadFilm = 0.02 + 0.08 * smoothstep( 0.46, 0.80, dustBreak );
    laneSnow = max( roadFilm, max( laneDust * 0.42, crownDust * 0.70 ) )
      * ( 1.0 - wheelTrack * 0.55 ) * uSnowAmount;
    vec3 snowCol = uSnow * ( 0.74 + 0.16 * mottle );
    snowCol *= 0.97 + 0.06 * snowPowder + 0.04 * aggregate;
    col = mix( col, snowCol, laneSnow );
  }
  // Blend the completed winter material, not just its snow coverage: otherwise
  // road powder, paint and packed tyre tint survive at the terrain-owned cut.
  // Shared world-space scuff/gravel/contact supply the rim variation. Terrain's
  // unsampled drift fields use their gentle-ground means here, preserving the
  // existing sample budget rather than adding a second terrain shader.
  float edgeSlush = 1.0 - smoothstep( 0.04, 0.20 + 0.40 * dustMid,
    edgeDist + ( dustMid - 0.5 ) * 0.20 + ( snowPatch - 0.5 ) * 0.24 );
  float rimSnow = 0.84 * (1.0 - 0.12 - 0.14 * scuffNoise - 0.10 * bankContact);
  // terrain.js snow accumulation=0.5, grain=0.9625 and hollow=0.5.
  // Retain its packed/powder mix, cool hollow tint and post-snow colour order.
  vec3 rimSnowCol = mix(uSnow * vec3(0.76, 0.80, 0.85) * 0.97775,
    uSnow * 0.897, smoothstep(0.20, 0.75, 0.5));
  rimSnowCol *= 0.98 * mix(vec3(1.0), vec3(0.88, 0.93, 1.03), 0.275);
  vec3 winterRim = mix(gravel, rimSnowCol, uSnowAmount * rimSnow);
  winterRim *= mix(1.01, 1.0025, uSnowAmount * rimSnow);
  float rimWinterDistance = smoothstep(260.0, 2600.0, length(vViewPosition));
  float rimReliefWeight = 1.0 - smoothstep(65.0, 220.0, length(vViewPosition));
  vec3 rimWinterSnow = mix(vec3(0.34, 0.39, 0.42), vec3(0.72, 0.78, 0.81), 0.96) * 1.07175;
  winterRim = mix(winterRim, rimWinterSnow,
    (0.16 + 0.12 * rimWinterDistance) * (1.0 - 0.45 * rimReliefWeight));
  winterRim *= mix(0.90, 1.07, 0.6425);
  winterRim *= 1.0 - bankContact * uRoadContactDarken * (0.34 + 0.16 * scuffNoise);
  float winterEdge = step(0.5, uSnowAmount) * edgeSlush;
  col = mix(col, winterRim, winterEdge);
  laneSnow = mix(laneSnow, uSnowAmount * rimSnow, winterEdge);
  // Millimetre aggregate and centimetre slush affect actual lighting, not just
  // albedo. Reuse the sampled fields and retire relief before it becomes subpixel.
  float roadReliefFade = 1.0 - smoothstep( 25.0, 110.0, length( vViewPosition ) );
  float roadMicroHeight = mix( aggregate * 0.0015 + rim * gravelGrain * 0.003,
    snowPatch * 0.018 + snowPowder * 0.002, laneSnow ) * roadReliefFade;
  // A road-space soft contact decal, not a projected light shadow. It follows
  // the actual ribbon (including grades, crown and bridges), with no overlay
  // plane, depth fighting, extra draw call or offscreen render pass.
  vec2 vehicleDelta = vWPosR.xz - uVehicleContact.xy;
  vec2 vehicleForward = uVehicleContact.zw;
  vec2 vehicleLocal = vec2(dot(vehicleDelta, vec2(-vehicleForward.y, vehicleForward.x)), dot(vehicleDelta, vehicleForward));
  if (uVehicleShadowOpacity > 0.0 && abs(vehicleLocal.x) < uVehicleFootprint.x + 0.7 && abs(vehicleLocal.y) < uVehicleFootprint.y + 0.7) {
    vec2 bodyUV = abs(vehicleLocal) / (uVehicleFootprint.xy * vec2(0.98, 0.93));
    vec2 bodySquared = bodyUV * bodyUV;
    float bodyContact = 1.0 - smoothstep(0.45, 1.45, dot(bodySquared, bodySquared));
    vec2 wheelUV = (abs(vehicleLocal) - uVehicleFootprint.zw) / vec2(0.20, 0.34);
    float wheelContact = 1.0 - smoothstep(0.1, 1.0, dot(wheelUV, wheelUV));
    float occlusion = 1.0 - (1.0 - 0.36 * bodyContact) * (1.0 - 0.60 * wheelContact);
    col *= 1.0 - occlusion * uVehicleShadowOpacity;
  }
  diffuseColor.rgb *= col;
`;

const ROAD_NORMAL_BODY = /* glsl */`
  vec3 roadDx = dFdx(-vViewPosition), roadDy = dFdy(-vViewPosition);
  vec3 roadR1 = cross(roadDy, normal), roadR2 = cross(normal, roadDx);
  float roadDet = dot(roadDx, roadR1) * faceDirection;
  vec3 roadGradient = sign(roadDet) *
    (dFdx(roadMicroHeight) * roadR1 + dFdy(roadMicroHeight) * roadR2);
  normal = normalize(max(abs(roadDet), 0.000001) * normal - roadGradient);
`;

export class RoadMesh {
  constructor(world, atmo, scheduler, terrain) {
    this.world = world;
    this.atmo = atmo;
    this.scheduler = scheduler;
    this.route = world.route;
    this.group = new THREE.Group();
    this.group.name = 'road';
    this.segments = new Map();
    this.segLen = 260;                    // metres per segment
    this.behind = 620;
    this.ahead = 3400;
    this.version = 0;
    // The vehicle moves every frame, but the resident segment window only changes
    // when it crosses a segment boundary. Keep that window stable between crossings
    // so we do not allocate a Set or walk every segment on every frame.
    this._lastI0 = -1;
    this._lastI1 = -1;
    this._wantKeys = new Set();

    this.uniforms = {
      uVehicleContact: { value: new THREE.Vector4() },
      uVehicleFootprint: { value: new THREE.Vector4(1, 2.4, 0.82, 1.45) },
      uVehicleShadowOpacity: { value: 0 },
      uAsphalt: { value: new THREE.Color(0.150, 0.146, 0.138) },
      uPaint: { value: new THREE.Color(0.90, 0.90, 0.87) },
      uHalfPave: { value: HALF_PAVE },
      uDashLen: { value: R.centreDashLen },
      uGapLen: { value: R.centreDashGap },
      uPaintWear: { value: 0.92 },
      // Gravel caught in the crumbled lip; applyPalette() matches it to the
      // terrain's dirt rim (mix(soil * 0.62, rock * 0.50, 0.30)).
      uEdgeGravel: { value: new THREE.Color(0.181, 0.152, 0.113) },
      // Reference the terrain controls directly; seasonal changes cannot leave
      // the ribbon lip with a different contact width or darkening strength.
      uRoadScuffInner: terrain.uniforms.uRoadScuffInner,
      uRoadContactDarken: terrain.uniforms.uRoadContactDarken,
      // Share seasonal snow controls with terrain so winter slush on the lip
      // matches the snow field that the terrain carries up to the pavement.
      uSnow: terrain.uniforms.uSnow,
      uSnowAmount: terrain.uniforms.uSnowAmount,
    };
    this._terrainSoil = terrain.uniforms.uSoil;
    this.furnitureMaterials = createFurnitureMaterials(atmo, this.uniforms);
    const U = this.uniforms;
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, metalness: 0.0,
      dithering: true, alphaToCoverage: true });
    this.material.name = 'road';
    this.material.onBeforeCompile = (shader) => {
      for (const k in U) shader.uniforms[k] = U[k];
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_BODY)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          // Dry aggregate and loose snow stay matte; compacted wheel paths are
          // damp, not mirror-like. The same cover mask drives colour and response.
          roughnessFactor = mix(0.90 - 0.06 * wheelTrack,
            0.66 - 0.18 * wheelTrack, uSnowAmount);
          roughnessFactor = mix(roughnessFactor, 0.94, laneSnow);
          roughnessFactor = mix(roughnessFactor, 0.96, rim * (1.0 - uSnowAmount));`)
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + ROAD_NORMAL_BODY)
        .replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
          // Antialias only the crumbled pavement edge: coverage ramps over one
          // pixel footprint, so alpha-to-coverage cannot quantise a wide feather
          // into stepped translucent bands over the terrain.
          float paveCoverage = clamp(edgeDist / max(fwidth(edgeDist), 0.0001) + 0.5, 0.0, 1.0);
          if (paveCoverage <= 0.001) discard;
          diffuseColor.a *= paveCoverage;`);
    };
    this.material.customProgramCacheKey = () => 'road-seasonal-surface-v8';
    atmo.register(this.material);
  }

  applyPalette() {
    const p = this.atmo.palette;
    const soil = this._terrainSoil.value;
    this.uniforms.uEdgeGravel.value.setRGB(
      lerp(soil.r * 0.62, p.rock[0] * 0.50, 0.30),
      lerp(soil.g * 0.62, p.rock[1] * 0.50, 0.30),
      lerp(soil.b * 0.62, p.rock[2] * 0.50, 0.30));
  }

  setVehicleContact(vehicle) {
    const { pos, heading, dimensions } = vehicle;
    this.uniforms.uVehicleContact.value.set(pos.x, pos.z, Math.cos(heading), Math.sin(heading));
    this.uniforms.uVehicleFootprint.value.set(dimensions.bodyWidth / 2, dimensions.bodyLength / 2,
      dimensions.trackWidth / 2, dimensions.wheelbase / 2);
    this.uniforms.uVehicleShadowOpacity.value = 1;
  }

  rebuildAll() {
    this.version++;
    for (const [, m] of this.segments) {
      this.group.remove(m);
      m.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
    this.segments.clear();
    this.scheduler.drop((k) => k.startsWith('road:'));
    this._wantKeys.clear();
    this._lastI0 = -1;
    this._lastI1 = -1;
  }

  update(carS) {
    const s0 = Math.max(0, carS - this.behind);
    const s1 = Math.min(this.route.length, carS + this.ahead);
    const i0 = Math.floor(s0 / this.segLen), i1 = Math.floor(s1 / this.segLen);
    // Nothing in the residency window changed; the scheduler and renderer can keep
    // using the existing segments without any per-frame allocation or disposal work.
    if (i0 === this._lastI0 && i1 === this._lastI1) return;
    this._lastI0 = i0;
    this._lastI1 = i1;
    const want = this._wantKeys;
    want.clear();
    for (let i = i0; i <= i1; i++) want.add(`road:${this.version}:${i}`);
    for (const [k, m] of this.segments) {
      if (!want.has(k)) { this.group.remove(m); m.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); this.segments.delete(k); }
    }
    this.scheduler.drop((k) => k.startsWith('road:') && !want.has(k));
    this.required = want.size;
    for (let i = i0; i <= i1; i++) {
      const key = `road:${this.version}:${i}`;
      if (this.segments.has(key) || this.scheduler.has(key)) continue;
      const prio = Math.abs(i * this.segLen + this.segLen / 2 - carS) * 0.01;
      this.scheduler.push(key, prio, () => this._build(key, i));
    }
  }

  get resident() { return this.segments.size; }

  _build(key, segIdx) {
    const rt = this.route;
    const ds = rt.ds;
    const sStart = segIdx * this.segLen;
    const sEnd = Math.min(rt.length, sStart + this.segLen);
    if (sEnd <= sStart) { this.segments.set(key, new THREE.Group()); return; }
    // Include the exact endpoint even when the segment length is not a multiple
    // of ds; rounding down leaves a transverse gap before the next segment.
    const n = Math.ceil((sEnd - sStart) / ds) + 1;

    // Lateral stations: pavement plus the graded shoulder that carries the
    // crumbled asphalt lip. The verge beyond is terrain-only (same graded surface,
    // see world.crossSection), so the ribbon no longer lays a second ground layer.
    const STAT = RIBBON_STATIONS;
    const pos = new Float32Array(n * STAT * 3);
    const road = new Float32Array(n * STAT * 2);
    const q = {};
    const origin = rt.at(sStart + (sEnd - sStart) / 2, {});
    const ox = origin.x, oz = origin.z, oy = origin.y;

    for (let i = 0; i < n; i++) {
      const s = Math.min(sEnd, sStart + i * ds);
      const p = rt.at(s, q);
      const b = p.bridge;
      const shoulderW = lerp(R.shoulderWidth, 0.05, b);
      const SE = HALF_PAVE + shoulderW;
      const HP = HALF_PAVE;
      const lats = [-SE, -HP, -HP * 0.5, 0, HP * 0.5, HP, SE];
      const nx = -p.tz, nz = p.tx;
      for (let k = 0; k < STAT; k++) {
        const lat = lats[k];
        const y = p.y + crossSection(Math.abs(lat)) + R.surfaceLift;
        const x = p.x + nx * lat, z = p.z + nz * lat;
        const o = (i * STAT + k) * 3;
        pos[o] = x - ox; pos[o + 1] = y - oy; pos[o + 2] = z - oz;
        const r = (i * STAT + k) * 2;
        road[r] = lat; road[r + 1] = s;
      }
    }

    const idx = new Uint32Array((n - 1) * (STAT - 1) * 6);
    let ii = 0;
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < STAT - 1; k++) {
        // lateral axis is (-tz, tx) and longitudinal is (tx, tz); this winding is the
        // one that yields UPWARD normals. Get it wrong and the ribbon is backface-culled.
        const a = i * STAT + k, bq = a + 1, c = a + STAT, d = c + 1;
        idx[ii++] = a; idx[ii++] = bq; idx[ii++] = c;
        idx[ii++] = bq; idx[ii++] = d; idx[ii++] = c;
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aRoad', new THREE.BufferAttribute(road, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();

    const mesh = new THREE.Mesh(g, this.material);
    mesh.position.set(ox, oy, oz);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = 0;
    const segmentGroup = new THREE.Group();
    segmentGroup.name = key;
    segmentGroup.add(mesh);

    // Roadside structures (fence, guardrail, dry-stone wall) vary by section;
    // see furniture.js and roadside.js.
    for (const m of buildFurniture(this.world, sStart, sEnd, this.furnitureMaterials)) segmentGroup.add(m);
    this.group.add(segmentGroup);
    this.segments.set(key, segmentGroup);
  }
}
