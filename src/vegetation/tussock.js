// src/vegetation/tussock.js — procedural dry tussock for the verge planting:
// a fountain of long arching blades, green at the base and straw at the tips,
// distinct in form and colour from the fine grass sward around it.
import * as THREE from 'three';
import { makeRng } from '../core/rng.js';

const BLADES = 72;
const SEGMENTS = 4;

/** Unit-height { bark, leaf } source geometry (root at y = 0) for prepareShrubParts. */
export function createTussockSource() {
  const rng = makeRng(0x7a55c0c);
  const positions = [], colors = [], normals = [], indices = [];
  // Linear albedo: the forest shader's root and crown occlusion darken these further.
  const base = new THREE.Color(0.30, 0.33, 0.09), mid = new THREE.Color(0.70, 0.54, 0.20), tip = new THREE.Color(0.92, 0.76, 0.42);
  const c = new THREE.Color();
  for (let b = 0; b < BLADES; b++) {
    const azimuth = (b / BLADES) * Math.PI * 2 + rng() * 0.5;
    const rootR = rng() * 0.10;
    const ax = Math.cos(azimuth), az = Math.sin(azimuth);
    const length = 0.62 + rng() * 0.42;
    // Inner blades stand upright, outer ones splay and arch over.
    const lean = 0.12 + rng() * 0.62, bend = 0.25 + rng() * 0.95;
    const width = 0.018 + rng() * 0.016;
    // Blade faces perpendicular to its lean plane, so the arch shows its width.
    const sx = -az, sz = ax;
    let x = ax * rootR, y = 0, z = az * rootR;
    const first = positions.length / 3;
    const straw = 0.55 + rng() * 0.45;
    for (let k = 0; k <= SEGMENTS; k++) {
      const t = k / SEGMENTS;
      const w = width * (1 - t * 0.92);
      positions.push(x - sx * w, y, z - sz * w, x + sx * w, y, z + sz * w);
      c.copy(base).lerp(mid, Math.min(1, t * 1.6)).lerp(tip, Math.max(0, t * 1.4 - 0.4) * straw);
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
      // Sward-style lighting: blades shade as an up-and-out facing canopy
      // rather than as edge-on cards, so the tussock reads sunlit like the grass.
      const nl = Math.hypot(ax * 0.45, 1, az * 0.45);
      normals.push(ax * 0.45 / nl, 1 / nl, az * 0.45 / nl, ax * 0.45 / nl, 1 / nl, az * 0.45 / nl);
      const angle = lean + bend * t * t;
      const step = length / SEGMENTS;
      x += ax * Math.sin(angle) * step; z += az * Math.sin(angle) * step; y += Math.cos(angle) * step;
    }
    // Both windings with shared up-facing normals: drawn single-sided, each
    // view sees one copy, so the far side of a blade is never shaded as a
    // downward-facing (dark) back face.
    for (let k = 0; k < SEGMENTS; k++) {
      const a = first + k * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2, a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const leaf = new THREE.BufferGeometry();
  leaf.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  leaf.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  leaf.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  leaf.setIndex(indices);
  // A low thatch crown seats the blades in the ground.
  const bark = new THREE.ConeGeometry(0.16, 0.10, 7, 1, true);
  bark.translate(0, 0.05, 0);
  bark.deleteAttribute('uv');
  const crown = new Float32Array(bark.getAttribute('position').count * 3);
  for (let i = 0; i < crown.length; i += 3) crown.set([base.r, base.g, base.b], i);
  bark.setAttribute('color', new THREE.BufferAttribute(crown, 3));
  return { bark, leaf };
}
