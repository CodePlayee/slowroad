// src/vehicle/lamps.js — headlight beam cookie and lamp material helpers.
import * as THREE from 'three';
import { VEHICLE as V } from './params.js';
import { lerp, smoothstep } from '../core/rng.js';

/** Lamp height above the road surface (the vehicle origin sits rideHeight above it). */
export const headlightHeight = (cfg = V.headlight) => cfg.mountY + V.rideHeight;

/**
 * Relative low-beam intensity toward a direction given as tangents of its
 * azimuth (positive = kerb side, right) and elevation about a horizontal axis.
 * Below the hot zone the value follows the distance of the road point seen in
 * that direction, so road illuminance (∝ I·h/z^(decay+1)) falls gently instead
 * of collapsing into a pool at the bumper.
 *
 * A surface facing the lamp receives ~z/h times the irradiance of the road at
 * the same distance (incidence cosine ~1 instead of h/z), so the beam is also
 * shaped by where each ray would meet the road plane: the cut-off ends at the
 * horizon, and rays landing beyond the paved edges fade to a floor. Raised
 * verges, cut slopes and grass project outward/farther on that plane, so they
 * dim while the asphalt keeps its near/far ramp.
 */
export function headlightCookieValue(tanH, tanV, cfg = V.headlight, height = headlightHeight(cfg)) {
  const road = tanV < 0 ? height / -tanV : Infinity;
  // Steep foreground directions are held back (as real low beams do) so the
  // road in front of the bumper does not flare into a hot pool.
  const near = lerp(cfg.nearFloor, 1, smoothstep(cfg.nearStart, cfg.nearEnd, road));
  const reach = near * Math.min(1, Math.pow(road / cfg.fullThrow, cfg.throwPower));
  const kerb = tanH > 0 ? cfg.kerbRise * smoothstep(0, cfg.kerbWidth, tanH) : 0;
  const start = cfg.cutoff + kerb;
  const cut = lerp(cfg.spill, 1, 1 - smoothstep(start, start + cfg.cutoffSoft, tanV));
  const lateral = tanH >= 0
    ? 1 - smoothstep(cfg.coreRight, cfg.edgeRight, tanH)
    : 1 - smoothstep(cfg.coreLeft, cfg.edgeLeft, -tanH);
  // Road-plane footprint (metres). Edge and softness grow with distance so the
  // far field degrades to an angular fade (curve tolerance, no cookie banding).
  const plane = height / Math.max(-tanV, cfg.horizonTan);
  const x = tanH * plane;
  const edge = (x >= 0 ? cfg.vergeKerb : cfg.vergeFar) + cfg.vergeGrow * plane;
  const soft = cfg.vergeSoft + cfg.vergeSoftGrow * plane;
  const verge = lerp(cfg.vergeFloor, 1, 1 - smoothstep(edge, edge + soft, Math.abs(x)));
  return reach * cut * lateral * verge;
}

/**
 * Projected spot map. three.js maps it through the spot's shadow camera
 * (aspect 1, half fov = angle, up = world +Y): u → right, v → up.
 * Half floats keep the 30:1 near/far ramp free of 8-bit banding.
 */
export function createHeadlightCookie(cfg = V.headlight) {
  const width = cfg.cookieWidth, height = cfg.cookieHeight;
  const span = Math.tan(cfg.angle), lampHeight = headlightHeight(cfg);
  const data = new Uint16Array(width * height * 4);
  const one = THREE.DataUtils.toHalfFloat(1);
  for (let j = 0; j < height; j++) {
    const tanV = ((j + 0.5) / height * 2 - 1) * span;
    for (let i = 0; i < width; i++) {
      const tanH = ((i + 0.5) / width * 2 - 1) * span;
      const value = THREE.DataUtils.toHalfFloat(headlightCookieValue(tanH, tanV, cfg, lampHeight));
      const at = (j * width + i) * 4;
      data[at] = value; data[at + 1] = value; data[at + 2] = value; data[at + 3] = one;
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.name = 'vehicle-headlight-cookie';
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Low-beam SpotLight aimed level along the vehicle's +Z axis. */
export function createHeadlight(cfg = V.headlight) {
  const light = new THREE.SpotLight(0xfff0d4, 0, cfg.distance, cfg.angle, cfg.penumbra, cfg.decay);
  light.name = 'vehicle-headlight';
  light.map = createHeadlightCookie(cfg);
  // Points nearer than the projection's near plane would skip the cookie.
  light.shadow.camera.near = 0.05;
  placeHeadlight(light, V.bodyLength / 2 - 0.08, cfg);
  return light;
}

export function placeHeadlight(light, z, cfg = V.headlight) {
  light.position.set(0, cfg.mountY, z);
  // Level aim: the cookie's elevation axis assumes a horizontal beam axis.
  light.target.position.set(0, cfg.mountY, z + 30);
}

export function createTailSpill(cfg = V.tailLight) {
  const light = new THREE.PointLight(cfg.color, 0, cfg.distance, 2);
  light.name = 'vehicle-tail-spill';
  light.position.fromArray(cfg.position);
  return light;
}

// Model-space boxes of the supplied Model Y lamp parts (authored +Z forward,
// metres). Lens and internals of front and rear lamps share meshes, so each
// triangle is classified by its centroid.
export function lampRole(x, y, z) {
  if (z < -1.8 && y > 0.95) return 'tail';
  if (z > 1.8 && y > 0.68) return 'head';
  return null;
}

/**
 * Reorder a mesh's triangles into contiguous base/<role> runs and return the
 * material group roles in order. `toModel` maps geometry positions to model
 * space; `classify(centroid, normal, firstVertex)` gets model-space vectors and
 * returns one of `roles` or null (base). Returns null when no triangle gets a role.
 */
export function splitTrianglesByRole(geometry, toModel, classify, roles) {
  const position = geometry.attributes.position;
  const source = geometry.index ? geometry.index.array : null;
  const count = source ? source.length : position.count;
  const runs = { base: [] };
  for (const role of roles) runs[role] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let t = 0; t < count; t += 3) {
    const i0 = source ? source[t] : t, i1 = source ? source[t + 1] : t + 1, i2 = source ? source[t + 2] : t + 2;
    a.fromBufferAttribute(position, i0).applyMatrix4(toModel);
    b.fromBufferAttribute(position, i1).applyMatrix4(toModel);
    c.fromBufferAttribute(position, i2).applyMatrix4(toModel);
    e1.subVectors(b, a).cross(e2.subVectors(c, a)).normalize();
    a.add(b).add(c).divideScalar(3);
    runs[classify(a, e1, i0) || 'base'].push(i0, i1, i2);
  }
  if (roles.every(role => !runs[role].length)) return null;
  const ordered = [];
  for (const role of ['base', ...roles]) for (const index of runs[role]) ordered.push(index);
  geometry.setIndex(position.count > 65535 ? new THREE.Uint32BufferAttribute(ordered, 1) : new THREE.Uint16BufferAttribute(ordered, 1));
  geometry.clearGroups();
  const used = [];
  let start = 0;
  for (const role of ['base', ...roles]) {
    const size = runs[role].length;
    if (!size) continue;
    geometry.addGroup(start, size, used.length);
    used.push(role);
    start += size;
  }
  return used;
}

/** Lamp split: base/tail/head runs (see lampRole). */
export function splitLampGeometry(geometry, toModel) {
  return splitTrianglesByRole(geometry, toModel, centre => lampRole(centre.x, centre.y, centre.z), ['tail', 'head']);
}

/** Emissive copy of a converted lamp material; intensity is driven per frame. */
export function lampMaterial(base, role) {
  const material = base.clone();
  material.name = `${base.name}_${role === 'tail' ? 'TailLamp' : 'HeadLamp'}`;
  if (role === 'tail') {
    material.emissive.set(V.tailLight.color);
    // Smoked lens reads dark red by day instead of neutral grey.
    if (material.transparent) material.color.multiply(new THREE.Color(1, 0.36, 0.32));
  } else {
    material.emissive.setRGB(1, 0.94, 0.84);
  }
  material.emissiveMap = null;
  material.emissiveIntensity = 0;
  material.userData.lampRole = role;
  return material;
}
