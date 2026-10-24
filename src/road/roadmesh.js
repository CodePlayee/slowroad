// src/road/roadmesh.js — the ribbon: asphalt + shoulders + graded verge, with lane
// markings drawn in the shader (no decals, no z-fighting). Owned by the ROAD builder.

import * as THREE from 'three';
import { ROAD as R } from './params.js';
import { crossSection, ROAD_EDGES } from '../world/world.js';
import { clamp, lerp } from '../core/rng.js';

const { HALF_PAVE } = ROAD_EDGES;

const FENCE_STEP = 3.2;
const FENCE_POST_H = 0.9;

function addBox(arr, cx, cy, cz, along, side, up, halfA, halfS, halfU) {
  const base = arr.length / 3;
  const corners = [[-1,-1,-1], [1,-1,-1], [1,1,-1], [-1,1,-1], [-1,-1,1], [1,-1,1], [1,1,1], [-1,1,1]];
  for (const c of corners) {
    arr.push(cx + along.x * c[0] * halfA + side.x * c[1] * halfS + up.x * c[2] * halfU,
      cy + along.y * c[0] * halfA + side.y * c[1] * halfS + up.y * c[2] * halfU,
      cz + along.z * c[0] * halfA + side.z * c[1] * halfS + up.z * c[2] * halfU);
  }
  return base;
}

function boxIndices(out, b) {
  const f = [[0,1,2,0,2,3],[4,6,5,4,7,6],[0,4,5,0,5,1],[1,5,6,1,6,2],[2,6,7,2,7,3],[4,0,3,4,3,7]];
  for (const q of f) for (const i of q) out.push(b + i);
}

const VERT_HEAD = /* glsl */`
attribute vec3 aRoad;
varying vec3 vRoad;
varying vec3 vWPosR;
`;
const VERT_BODY = /* glsl */`
  vRoad = aRoad;
  vWPosR = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;
const FRAG_HEAD = /* glsl */`
varying vec3 vRoad;
varying vec3 vWPosR;
uniform vec3 uAsphalt;
uniform vec3 uShoulder;
uniform vec3 uVerge;
uniform vec3 uPaint;
uniform float uHalfPave;
uniform float uShoulderEdge;
uniform vec3 uVergeDirt;
uniform vec3 uSnow;
uniform float uSnowAmount;
uniform float uDashLen;
uniform float uGapLen;
uniform float uPaintWear;
uniform sampler2D uGroundDetail;
uniform vec3 uGroundLush;
uniform vec3 uGroundDry;
uniform vec3 uGroundSoil;
uniform vec4 uVehicleContact;
uniform vec4 uVehicleFootprint;
uniform float uVehicleShadowOpacity;

float rhash( vec2 p ) { p = fract( p * vec2( 443.897, 441.423 ) ); p += dot( p, p + 19.19 ); return fract( p.x * p.y ); }
float rvn( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( rhash( i ), rhash( i + vec2( 1, 0 ) ), f.x ), mix( rhash( i + vec2( 0, 1 ) ), rhash( i + vec2( 1, 1 ) ), f.x ), f.y );
}
float rfbm( vec2 p ) { float s = 0.0, a = 0.5; for ( int i = 0; i < 4; i ++ ) { s += a * rvn( p ); p *= 2.11; a *= 0.5; } return s; }
`;
const FRAG_BODY = /* glsl */`
  float lat = abs( vRoad.x );
  float sAlong = vRoad.y;
  float band = vRoad.z;

  vec2 ru = vWPosR.xz;
  mat2 rot = mat2( 0.82, -0.57, 0.57, 0.82 );
  float grain = rfbm( rot * ru * 0.42 );
  float coarse = rfbm( ru * 0.075 + vec2( 11.0, -4.0 ) );

  // Shade the ribbon from lateral distance instead of the discrete band id.
  // The old band split made the coplanar shoulder/verge vertices read as a hard
  // polygon strip.  A single continuous blend lets the world-space field noise
  // carry through the seam while retaining a crisp asphalt edge line.
  float asphaltMask = 1.0 - smoothstep( uHalfPave - 0.08, uHalfPave + 0.14, lat );
  float vergeMask = smoothstep( uShoulderEdge - 0.16, uShoulderEdge + 0.78, lat );
  float shoulderNoise = rfbm( ru * 0.12 + vec2( 5.0, -7.0 ) );
  vec3 asphalt = uAsphalt * ( 0.86 + 0.20 * grain ) * ( 0.94 + 0.12 * coarse ) * ( 0.95 + 0.08 * rvn( rot * ru * 2.6 ) );
  float wheel = exp( -pow( ( lat - 1.72 ) * 1.6, 2.0 ) );
  asphalt *= 1.0 - 0.09 * wheel;
  asphalt *= 1.0 + 0.05 * ( 1.0 - smoothstep( 0.0, 0.9, lat ) );

  float fieldNoise = 0.58 * coarse + 0.42 * rfbm( ru * 0.014 + vec2( -9.0, 17.0 ) );
  // Keep the graded edge tied to the same world-space field as the terrain;
  // the existing coarse octave supplies enough breakup without a second
  // per-fragment stochastic rotation/noise pass.
  float fieldMix = smoothstep( 0.20, 0.82, fieldNoise );
  vec3 field = mix( uGroundDry, uGroundLush, fieldMix );
  float blades = dot( texture2D( uGroundDetail,
    mat2( 0.8, -0.6, 0.6, 0.8 ) * ru * 0.42 + vec2( 4.0, -6.0 ) ).rgb,
    vec3( 0.2126, 0.7152, 0.0722 ) );
  field *= clamp( 0.62 + 2.70 * blades + 0.16 * shoulderNoise, 0.55, 1.36 );
  float soil = smoothstep( 0.34, 0.76, shoulderNoise + ( 0.5 - fieldMix ) * 0.24 );
  vec3 verge = mix( field, uGroundSoil * ( 0.82 + 0.24 * shoulderNoise ), soil * 0.26 );
  vec3 shoulder = mix( uShoulder * ( 0.78 + 0.30 * shoulderNoise ), field, 0.28 + 0.16 * shoulderNoise );
  // Feather the shoulder into the field with a second broad value ramp.  The
  // contact darkening is strongest at the asphalt/soil interface and quickly
  // relaxes outward, grounding the ribbon without a visible halo.
  float shoulderBlend = smoothstep( uShoulderEdge - 0.28, uShoulderEdge + 1.16, lat );
  vec3 edgeCol = mix( shoulder, verge, max( vergeMask, shoulderBlend * 0.38 ) );
  float contact = 1.0 - smoothstep( uHalfPave + 0.10, uShoulderEdge + 2.6, lat );
  edgeCol *= 1.0 - contact * ( 0.035 + 0.045 * ( 1.0 - fieldMix ) );
  float snowMask = uSnowAmount * ( 0.74 + 0.26 * fieldNoise ) *
    smoothstep( uHalfPave - 0.10, uShoulderEdge + 0.88, lat );
  edgeCol = mix( edgeCol, uSnow * ( 0.90 + 0.10 * fieldNoise ), snowMask );
  vec3 col = mix( edgeCol, asphalt, asphaltMask );

  if ( asphaltMask > 0.5 ) {
    float ec = uHalfPave - 0.30;
    float edge = ( 1.0 - smoothstep( 0.055, 0.085, abs( lat - ec ) ) );
    float period = uDashLen + uGapLen;
    float dash = step( fract( sAlong / period ), uDashLen / period );
    float centre = ( 1.0 - smoothstep( 0.048, 0.070, lat ) ) * dash;
    float paint = clamp( edge + centre, 0.0, 1.0 ) * asphaltMask;
    paint *= uPaintWear * ( 0.62 + 0.38 * rfbm( vWPosR.xz * 5.0 ) );
    col = mix( col, uPaint, paint );
  }
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

export class RoadMesh {
  constructor(world, atmo, scheduler, terrain) {
    this.world = world;
    this.atmo = atmo;
    this.scheduler = scheduler;
    this.route = world.route;
    this.group = new THREE.Group();
    this.group.name = 'road';
    this.fenceMaterial = new THREE.MeshStandardMaterial({ color: 0x847157, roughness: 0.95, metalness: 0 });
    atmo.register(this.fenceMaterial);
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
      uAsphalt: { value: new THREE.Color(0.128, 0.130, 0.134) },
      uShoulder: { value: new THREE.Color(0.30, 0.27, 0.22) },
      uVerge: { value: new THREE.Color(0.24, 0.28, 0.14) },
      uPaint: { value: new THREE.Color(0.90, 0.90, 0.87) },
      uHalfPave: { value: HALF_PAVE },
      uDashLen: { value: R.centreDashLen },
      uGapLen: { value: R.centreDashGap },
      uPaintWear: { value: 0.92 },
      uShoulderEdge: { value: HALF_PAVE + R.shoulderWidth },
      uVergeDirt: { value: new THREE.Color(0.26, 0.23, 0.18) },
      // Share seasonal snow controls with terrain so the graded edge remains a
      // continuous surface in winter instead of exposing a tan road apron.
      uSnow: terrain.uniforms.uSnow,
      uSnowAmount: terrain.uniforms.uSnowAmount,
      uGroundDetail: terrain.uniforms.uGrassDetail,
      // Reuse the terrain palette so road shoulders inherit the same biome
      // values instead of introducing a separate coloured apron.
      uGroundLush: terrain.uniforms.uGrassLush,
      uGroundDry: terrain.uniforms.uGrassDry,
      uGroundSoil: terrain.uniforms.uSoil,
    };
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
        .replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
          // Reveal the actual meadow beneath the graded apron, not its polygon edge.
          float vergeEdge = lat + (shoulderNoise - 0.5) * 0.45;
          float vergeCoverage = 1.0 - smoothstep(uShoulderEdge + 0.02, uShoulderEdge + 0.82, vergeEdge);
          if (vergeCoverage <= 0.001) discard;
          diffuseColor.a *= vergeCoverage;`);
    };
    this.material.customProgramCacheKey = () => 'road-vehicle-contact-v4';
    atmo.register(this.material);
  }

  applyPalette() {
    const p = this.atmo.palette;
    const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
    const verge = mixc(p.grassDry, p.grassLush, 0.45);
    this.uniforms.uVerge.value.setRGB(verge[0] * 0.94, verge[1] * 0.94, verge[2] * 0.94);
    this.uniforms.uVergeDirt.value.setRGB(p.sand[0] * 0.60, p.sand[1] * 0.55, p.sand[2] * 0.46);
    this.uniforms.uShoulder.value.setRGB(p.sand[0] * 0.52, p.sand[1] * 0.48, p.sand[2] * 0.42);
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

    // Lateral stations. Band ids MUST be duplicated at every material boundary,
    // otherwise the band attribute interpolates across the quad and half a lane of
    // asphalt gets shaded as gravel shoulder.
    const STAT = 13;
    const BANDS = [2, 2, 1, 1, 0, 0, 0, 0, 0, 1, 1, 2, 2];
    const pos = new Float32Array(n * STAT * 3);
    const road = new Float32Array(n * STAT * 3);
    const cy = new Float32Array(n);
    const q = {};
    const origin = rt.at(sStart + (sEnd - sStart) / 2, {});
    const ox = origin.x, oz = origin.z, oy = origin.y;

    for (let i = 0; i < n; i++) {
      const s = Math.min(sEnd, sStart + i * ds);
      const p = rt.at(s, q);
      const b = p.bridge;
      const shoulderW = lerp(R.shoulderWidth, 0.05, b);
      const vergeW = lerp(R.vergeWidth, 0.02, b);
      const SE = HALF_PAVE + shoulderW;
      const VE = SE + vergeW;
      const HP = HALF_PAVE;
      const lats = [-VE, -SE, -SE, -HP, -HP, -HP * 0.5, 0, HP * 0.5, HP, HP, SE, SE, VE];
      const nx = -p.tz, nz = p.tx;
      cy[i] = p.y;
      for (let k = 0; k < STAT; k++) {
        const lat = lats[k];
        const al = Math.abs(lat);
        let y = p.y + crossSection(al) + R.surfaceLift;
        const x = p.x + nx * lat, z = p.z + nz * lat;
        if (BANDS[k] === 2 && b < 0.5) {
          const g = this.world.ground(x, z) + 0.03;
          if (g > y) y = g;
        }
        const o = (i * STAT + k) * 3;
        pos[o] = x - ox; pos[o + 1] = y - oy; pos[o + 2] = z - oz;
        road[o] = lat; road[o + 1] = s; road[o + 2] = BANDS[k];
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
    g.setAttribute('aRoad', new THREE.BufferAttribute(road, 3));
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

    // Low-profile timber guide rails: sparse posts and two continuous beams make
    // the road read at landscape scale without turning every bend into a fence tunnel.
    const fp = [], fi = [];
    const fq = {};
    const addFenceSide = (sgn) => {
      const count = Math.max(1, Math.floor((sEnd - sStart) / FENCE_STEP));
      for (let qn = 0; qn <= count; qn++) {
        const s = Math.min(sEnd, sStart + qn * FENCE_STEP);
        const p = rt.at(s, fq);
        if (p.bridge > 0.45) continue;
        const nx = -p.tz * sgn, nz = p.tx * sgn;
        const x = p.x + nx * (HALF_PAVE + R.shoulderWidth + 1.0);
        const z = p.z + nz * (HALF_PAVE + R.shoulderWidth + 1.0);
        const gy = this.world.ground(x, z) + 0.02;
        const up = { x: 0, y: 1, z: 0 };
        const side = { x: -p.tz, y: 0, z: p.tx };
        const along = { x: p.tx, y: 0, z: p.tz };
        const b = addBox(fp, x, gy + FENCE_POST_H * 0.5, z, along, side, up, 0.065, 0.065, FENCE_POST_H * 0.5);
        boxIndices(fi, b);
        if (qn > 0) {
          const prevS = Math.min(sEnd, sStart + (qn - 1) * FENCE_STEP);
          const pp = rt.at(prevS, fq);
          if (pp.bridge <= 0.45) {
            const px = pp.x - pp.tz * sgn * (HALF_PAVE + R.shoulderWidth + 1.0);
            const pz = pp.z + pp.tx * sgn * (HALF_PAVE + R.shoulderWidth + 1.0);
            const py = this.world.ground(px, pz) + 0.02;
            const vx = x - px, vy = gy - py, vz = z - pz, len = Math.hypot(vx, vy, vz) || 1;
            const midx = (x + px) * 0.5, midz = (z + pz) * 0.5;
            const my = (gy + py) * 0.5 + FENCE_POST_H * 0.73;
            const beamAlong = { x: vx / len, y: vy / len, z: vz / len };
            const beamSide = { x: -beamAlong.z, y: 0, z: beamAlong.x };
            for (const lift of [0, -0.42]) {
              const bb = addBox(fp, midx, my + lift, midz, beamAlong, beamSide, up, len * 0.5, 0.045, 0.052);
              boxIndices(fi, bb);
            }
          }
        }
      }
    };
    addFenceSide(-1);
    if (fp.length) {
      let fg = new THREE.BufferGeometry();
      fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
      fg.setIndex(fi); fg = fg.toNonIndexed(); fg.computeVertexNormals();
      const fm = new THREE.Mesh(fg, this.fenceMaterial); fm.castShadow = true; fm.receiveShadow = true;
      fm.position.set(0, 0, 0); segmentGroup.add(fm);
    }
    this.group.add(segmentGroup);
    this.segments.set(key, segmentGroup);
  }
}
