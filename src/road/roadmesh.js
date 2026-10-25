// src/road/roadmesh.js — the ribbon: asphalt with a crumbled edge and lane markings
// drawn in the shader (no decals, no z-fighting). The dirt rim and turf beside the
// pavement belong to the terrain material. Owned by the ROAD builder.

import * as THREE from 'three';
import { ROAD as R } from './params.js';
import { crossSection, ROAD_EDGES } from '../world/world.js';
import { lerp } from '../core/rng.js';
import { SURFACE_HASH_GLSL } from '../core/shaderNoise.js';

const { HALF_PAVE } = ROAD_EDGES;
// Pavement + shoulder stations per ribbon row (see _build).
export const RIBBON_STATIONS = 7;

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
  float laneLat = abs( lat - 1.75 );
  float wheelTrack = exp( -pow( ( laneLat - 0.80 ) * 3.6, 2.0 ) ) * ( 0.70 + 0.30 * coarse );
  asphalt *= 1.0 - 0.11 * wheelTrack;
  asphalt *= 1.0 + 0.06 * ( 1.0 - smoothstep( 0.0, 0.45, laneLat ) ) + 0.05 * ( 1.0 - smoothstep( 0.0, 0.9, lat ) );
  // Winter tarmac is wet and darker under the slush; the bare wheel paths are
  // wettest of all.
  asphalt *= 1.0 - 0.14 * uSnowAmount;
  asphalt *= 1.0 - 0.16 * uSnowAmount * wheelTrack;
  // The outer decimetres are broken, gravel-filled asphalt whose albedo meets
  // the terrain's dirt rim, so the cut edge reads as a lip, not a pale seam.
  float rim = 1.0 - smoothstep( 0.0, 0.34, edgeDist );
  vec3 gravel = uEdgeGravel * ( 0.80 + 0.40 * rvnAA( rot * ru * 7.0 + vec2( 3.0, 1.0 ) ) );
  vec3 col = mix( asphalt, gravel, rim * ( 0.30 + 0.40 * grain ) );
  // Winter: thrown slush gathers along the edge and thins toward the wheel paths.
  float edgeSlush = uSnowAmount * ( 1.0 - smoothstep( 0.0, 0.62, edgeDist + ( coarse - 0.5 ) * 0.40 ) );
  col = mix( col, uSnow * ( 0.74 + 0.14 * coarse ), edgeSlush * ( 0.45 + 0.35 * grain ) );

  float ec = uHalfPave - 0.30;
  float edge = ( 1.0 - smoothstep( 0.055, 0.085, abs( lat - ec ) ) );
  float period = uDashLen + uGapLen;
  float dash = step( fract( sAlong / period ), uDashLen / period );
  float centre = ( 1.0 - smoothstep( 0.048, 0.070, lat ) ) * dash;
  float paint = clamp( edge + centre, 0.0, 1.0 );
  paint *= uPaintWear * ( 0.62 + 0.38 * rfbm( vWPosR.xz * 5.0 ) );
  col = mix( col, uPaint, paint );
  // Winter: traffic keeps two bare, wet wheel paths per lane; packed snow lies
  // between and outside them and partly buries the markings. The breakup is
  // world-space and isotropic: noise stretched along the lane projects into long
  // fan-shaped streaks under perspective. Its octaves fade with pixel footprint,
  // so at range the cover settles to its mean instead of thresholding to speckle.
  float snowPatch = rvnAA( rot * ru * 1.3 + vec2( -4.0, 6.0 ) );
  float snowPowder = rvnAA( rot * ru * 6.5 + vec2( 13.0, -2.0 ) );
  float snowBreak = snowPatch * 0.50 + mottle * 0.22 + coarse * 0.14 + snowPowder * 0.14;
  // Slush banks up on the crown and toward the edge, where wheels rarely pass.
  float snowBank = max( 1.0 - smoothstep( 0.15, 0.60, lat ), smoothstep( 2.90, 3.30, lat ) );
  float laneSnow = uSnowAmount * ( 1.0 - smoothstep( 0.10, 0.55, wheelTrack ) )
    * smoothstep( 0.34, 0.62, snowBreak + 0.16 * snowBank );
  col = mix( col, uSnow * ( 0.70 + 0.12 * mottle + 0.06 * aggregate + 0.10 * ( snowPowder - 0.5 ) ), laneSnow * 0.85 );
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
      uPaint: { value: new THREE.Color(0.90, 0.90, 0.87) },
      uHalfPave: { value: HALF_PAVE },
      uDashLen: { value: R.centreDashLen },
      uGapLen: { value: R.centreDashGap },
      uPaintWear: { value: 0.92 },
      // Gravel caught in the crumbled lip; applyPalette() matches it to the
      // terrain's dirt rim (mix(soil * 0.62, rock * 0.50, 0.30)).
      uEdgeGravel: { value: new THREE.Color(0.181, 0.152, 0.113) },
      // Share seasonal snow controls with terrain so winter slush on the lip
      // matches the snow field that the terrain carries up to the pavement.
      uSnow: terrain.uniforms.uSnow,
      uSnowAmount: terrain.uniforms.uSnowAmount,
    };
    this._terrainSoil = terrain.uniforms.uSoil;
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
          // Antialias only the crumbled pavement edge: coverage ramps over one
          // pixel footprint, so alpha-to-coverage cannot quantise a wide feather
          // into stepped translucent bands over the terrain.
          float paveCoverage = clamp(edgeDist / max(fwidth(edgeDist), 0.0001) + 0.5, 0.0, 1.0);
          if (paveCoverage <= 0.001) discard;
          diffuseColor.a *= paveCoverage;`);
    };
    this.material.customProgramCacheKey = () => 'road-crumbled-edge-v5';
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
