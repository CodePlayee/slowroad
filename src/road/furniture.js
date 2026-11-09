// src/road/furniture.js — roadside structures drawn beside the ribbon: timber
// post-and-rail fence, galvanised W-beam guardrail and dry-stone wall. Which one
// stands where comes from roadside.js; every station sits on the graded road
// cross-section (world.ground inside the verge), so each run follows the road's
// plan and vertical curve and is continuous across streamed segments.
import * as THREE from 'three';
import { vnoise } from '../core/noise.js';
import { FURNITURE, furnitureAt } from './roadside.js';
import { SURFACE_HASH_GLSL } from '../core/shaderNoise.js';

const STEP = 2.0;             // metres between stations
const FENCE_POST_H = 0.9;
const RAIL_POST_H = 0.70;
// W-beam cross-section: [offset toward the road, height above ground].
const RAIL_PROFILE = [[0.00, 0.40], [0.07, 0.45], [0.07, 0.51], [0.025, 0.56], [0.07, 0.61], [0.07, 0.67], [0.00, 0.72]];

function addBox(arr, cx, cy, cz, along, side, up, halfA, halfS, halfU) {
  const base = arr.length / 3;
  for (const [a, s, u] of [[-1,-1,-1], [1,-1,-1], [1,1,-1], [-1,1,-1], [-1,-1,1], [1,-1,1], [1,1,1], [-1,1,1]]) {
    arr.push(cx + along.x * a * halfA + side.x * s * halfS + up.x * u * halfU,
      cy + along.y * a * halfA + side.y * s * halfS + up.y * u * halfU,
      cz + along.z * a * halfA + side.z * s * halfS + up.z * u * halfU);
  }
  return base;
}

function boxIndices(out, b) {
  for (const q of [[0,1,2,0,2,3],[4,6,5,4,7,6],[0,4,5,0,5,1],[1,5,6,1,6,2],[2,6,7,2,7,3],[4,0,3,4,3,7]]) for (const i of q) out.push(b + i);
}

const WALL_HEAD = /* glsl */`
attribute vec2 aWall;
varying vec2 vWall;
varying vec3 vWallNormal;
`;
const WALL_FRAG_HEAD = /* glsl */`
varying vec2 vWall;
varying vec3 vWallNormal;
uniform vec3 uSnow;
uniform float uSnowAmount;
${SURFACE_HASH_GLSL}
`;
// Irregular dry-stone courses: rows of varying height, stones of one or two
// cells in length, deep dark voids between them, per-stone tone (dark grey,
// brown, pale lichen) and moss low on the face.
const WALL_FRAG_BODY = /* glsl */`
  {
    float rowY = vWall.y / 0.16;
    float row = floor(rowY), fy = fract(rowY);
    float u = vWall.x / 0.24 + surfaceHash(vec2(row, 3.7)) * 4.0;
    float cell = floor(u), fx = fract(u);
    float gu = u * 0.5, group = floor(gu), gf = fract(gu);
    bool split = surfaceHash(vec2(group, row + 17.0)) < 0.45;
    float id = split ? surfaceHash(vec2(cell, row)) : surfaceHash(vec2(group, row + 31.0));
    // Joint distance in metres along the course and across it.
    float jointX = split ? min(fx, 1.0 - fx) * 0.24 : min(gf, 1.0 - gf) * 0.48;
    float jointY = (min(fy, 1.0 - fy) + (id - 0.5) * 0.18) * 0.16;
    float joint = min(jointX, jointY);
    float face = smoothstep(0.006, 0.026, joint);
    vec3 stone = mix(vec3(0.075, 0.072, 0.064), vec3(0.19, 0.18, 0.155), id);
    stone = mix(stone, vec3(0.16, 0.12, 0.075), step(0.80, surfaceHash(vec2(row * 1.3, cell + 5.0))) * 0.7);
    stone = mix(stone, vec3(0.30, 0.30, 0.25), step(0.90, surfaceHash(vec2(cell + 2.0, row * 0.7))) * 0.6);
    float moss = smoothstep(0.55, 0.95, surfaceHash(floor(vWall * vec2(1.6, 3.0)) + 4.1)) * (1.0 - smoothstep(0.15, 0.9, vWall.y));
    stone = mix(stone, vec3(0.055, 0.085, 0.025), moss * 0.75);
    // Rounded stone faces: lit centres, shadowed rims.
    stone *= mix(0.70, 1.10, smoothstep(0.0, 0.07, joint));
    // Joints narrower than a pixel settle to their mean instead of aliasing.
    face = mix(face, 0.82, smoothstep(0.012, 0.05, fwidth(vWall.x) + fwidth(vWall.y)));
    diffuseColor.rgb = mix(vec3(0.012, 0.011, 0.010), stone, face);
    float wallSnow = uSnowAmount * smoothstep(0.45, 0.85, vWallNormal.y);
    diffuseColor.rgb = mix(diffuseColor.rgb, uSnow, wallSnow);
  }
`;

export function createFurnitureMaterials(atmo, snowUniforms) {
  const fence = new THREE.MeshStandardMaterial({ color: 0x847157, roughness: 0.95, metalness: 0 });
  fence.name = 'road-fence';
  // Galvanised steel reads pale against asphalt; no environment map, so keep it dielectric.
  const rail = new THREE.MeshStandardMaterial({ color: 0xd2d6d8, roughness: 0.46, metalness: 0, side: THREE.DoubleSide });
  rail.name = 'road-guardrail';
  const wall = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, metalness: 0, side: THREE.DoubleSide });
  wall.name = 'road-drystone-wall';
  wall.onBeforeCompile = (shader) => {
    shader.uniforms.uSnow = snowUniforms.uSnow;
    shader.uniforms.uSnowAmount = snowUniforms.uSnowAmount;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WALL_HEAD)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWall = aWall;\nvWallNormal = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + WALL_FRAG_HEAD)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + WALL_FRAG_BODY);
  };
  wall.customProgramCacheKey = () => 'road-drystone-wall-v1';
  for (const material of [fence, rail, wall]) atmo.register(material);
  return { fence, rail, wall };
}

/** Station frame for side sgn at arc length s: ground point at lateral `lat`. */
function station(world, s, sgn, lat, q) {
  const p = world.route.at(s, q);
  const nx = -p.tz * sgn, nz = p.tx * sgn;
  const x = p.x + nx * lat, z = p.z + nz * lat;
  return { s, x, z, y: world.ground(x, z), nx, nz, tx: p.tx, tz: p.tz };
}

function fenceRun(run, sStart, sEnd, out) {
  const { pos, idx } = out;
  const up = { x: 0, y: 1, z: 0 };
  for (let i = 0; i < run.length; i++) {
    const a = run[i];
    const along = { x: a.tx, y: 0, z: a.tz }, side = { x: -a.tz, y: 0, z: a.tx };
    if (a.s >= sStart && a.s < sEnd && Math.round(a.s / STEP) % 2 === 0) {
      boxIndices(idx, addBox(pos, a.x, a.y + FENCE_POST_H * 0.5 + 0.02, a.z, along, side, up, 0.065, 0.065, FENCE_POST_H * 0.5));
    }
    if (i === 0) continue;
    const b = run[i - 1];
    const vx = a.x - b.x, vy = a.y - b.y, vz = a.z - b.z, len = Math.hypot(vx, vy, vz) || 1;
    const beamAlong = { x: vx / len, y: vy / len, z: vz / len }, beamSide = { x: -beamAlong.z, y: 0, z: beamAlong.x };
    const my = (a.y + b.y) * 0.5 + 0.02 + FENCE_POST_H * 0.73;
    for (const lift of [0, -0.42]) {
      boxIndices(idx, addBox(pos, (a.x + b.x) * 0.5, my + lift, (a.z + b.z) * 0.5, beamAlong, beamSide, up, len * 0.5 + 0.03, 0.045, 0.052));
    }
  }
}

function railRun(run, sStart, sEnd, out) {
  const { pos, idx, posts } = out;
  const up = { x: 0, y: 1, z: 0 };
  // Posts stand just behind the beam, every station.
  for (const a of run) {
    if (!(a.s >= sStart && a.s < sEnd)) continue;
    const along = { x: a.tx, y: 0, z: a.tz }, side = { x: -a.tz, y: 0, z: a.tx };
    boxIndices(posts.idx, addBox(posts.pos, a.x + a.nx * 0.12, a.y + RAIL_POST_H * 0.5 - 0.1, a.z + a.nz * 0.12,
      along, side, up, 0.045, 0.05, RAIL_POST_H * 0.5 + 0.1));
  }
  const n = RAIL_PROFILE.length, base = pos.length / 3;
  for (const a of run) {
    for (const [o, h] of RAIL_PROFILE) pos.push(a.x - a.nx * o, a.y + h, a.z - a.nz * o);
  }
  for (let i = 0; i < run.length - 1; i++) {
    for (let k = 0; k < n - 1; k++) {
      const p0 = base + i * n + k, p1 = p0 + 1, q0 = p0 + n, q1 = q0 + 1;
      idx.push(p0, p1, q0, p1, q1, q0);
    }
  }
}

function wallProfile(height) {
  // [lateral offset along the side normal (negative = road side), height].
  return [[-0.38, -0.30], [-0.28, height], [-0.15, height + 0.11], [0.15, height + 0.11], [0.28, height], [0.38, -0.30]];
}

function wallRun(world, run, sgn, capStart, capEnd, out) {
  const { pos, idx, wall } = out;
  const seed = (world.seed ^ 0x3c71d5) >>> 0;
  const profiles = run.map(a => wallProfile(0.86 + 0.20 * vnoise(a.s / 3.3, sgn * 5.1, seed)));
  // One strip per face; vertices are shared along the run only, so faces keep
  // crisp edges and the run's plan and profile curvature stay smooth.
  for (let face = 0; face < 5; face++) {
    const base = pos.length / 3;
    for (let i = 0; i < run.length; i++) {
      const a = run[i];
      for (const k of [face, face + 1]) {
        const [w, h] = profiles[i][k];
        pos.push(a.x + a.nx * w, a.y + h, a.z + a.nz * w);
        // Stones course along the wall; the cap shows the same pattern.
        wall.push(a.s, face === 2 ? h + (w + 0.15) : h + 0.3);
      }
    }
    for (let i = 0; i < run.length - 1; i++) {
      const a0 = base + i * 2, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3;
      if (sgn > 0) idx.push(a0, b0, a1, b0, b1, a1);
      else idx.push(a0, a1, b0, b0, a1, b1);
    }
  }
  for (const [i, enabled] of [[0, capStart], [run.length - 1, capEnd]]) {
    if (!enabled) continue;
    const a = run[i], base = pos.length / 3;
    for (const [w, h] of profiles[i]) { pos.push(a.x + a.nx * w, a.y + h, a.z + a.nz * w); wall.push(w * 2.0, h + 0.3); }
    for (let k = 1; k < 5; k++) idx.push(base, base + k, base + k + 1);
  }
}

function meshFrom(pos, idx, material, { wall = null, flat = false } = {}) {
  if (!idx.length) return null;
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (wall) g.setAttribute('aWall', new THREE.Float32BufferAttribute(wall, 2));
  g.setIndex(idx);
  // Boxes are faceted; extruded beams and walls keep smooth normals along the run.
  if (flat) g = g.toNonIndexed();
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, material);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/** Meshes for every structure run touching [sStart, sEnd]. */
export function buildFurniture(world, sStart, sEnd, materials) {
  const route = world.route, q = {};
  const fence = { pos: [], idx: [] }, rail = { pos: [], idx: [], posts: { pos: [], idx: [] } };
  const wall = { pos: [], idx: [], wall: [] };
  const k0 = Math.floor(sStart / STEP), k1 = Math.ceil(sEnd / STEP);
  for (const sgn of [-1, 1]) {
    // Types one station beyond either end tell a true run end from a segment cut.
    const types = [];
    for (let k = k0 - 1; k <= k1 + 1; k++) {
      const s = Math.max(0, Math.min(route.length, k * STEP));
      const bridge = route.at(s, q).bridge;
      types.push(bridge > FURNITURE.bridgeSkip ? 'none' : furnitureAt(world, s, sgn));
    }
    let start = 1;
    for (let t = 2; t <= types.length - 1; t++) {
      if (t < types.length - 1 && types[t] === types[start]) continue;
      const type = types[start], end = t - 1;      // stations start..end (index into types)
      if (type !== 'none' && end > start) {
        const run = [];
        for (let u = start; u <= end; u++) {
          const s = Math.max(0, Math.min(route.length, (k0 - 1 + u) * STEP));
          run.push(station(world, s, sgn, FURNITURE.lat[type], q));
        }
        if (type === 'fence') fenceRun(run, sStart, sEnd, fence);
        else if (type === 'rail') railRun(run, sStart, sEnd, rail);
        else wallRun(world, run, sgn, types[start - 1] !== 'wall', types[end + 1] !== 'wall', wall);
      }
      start = t;
    }
  }
  return [meshFrom(fence.pos, fence.idx, materials.fence, { flat: true }),
    meshFrom(rail.posts.pos, rail.posts.idx, materials.rail, { flat: true }),
    meshFrom(rail.pos, rail.idx, materials.rail),
    meshFrom(wall.pos, wall.idx, materials.wall, { wall: wall.wall })].filter(Boolean);
}
