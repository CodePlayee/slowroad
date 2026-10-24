import * as THREE from 'three';
import { makeRng } from '../core/rng.js';
import { tuftGrassMaterial } from './tuftGrass.js';

// Each leaf is a curved, folded ribbon, not a crossed image plane. A shallow
// central ridge keeps the leaf visible edge-on without duplicating its shape.
export function buildMeadowGeometry(blades = 22) {
  const rng = makeRng(0x4ea0d);
  const positions = [], colors = [], indices = [];
  for (let blade = 0; blade < blades; blade++) {
    const angle = blade * 2.399963 + rng() * 0.7;
    const radius = Math.sqrt(rng()) * 0.44;
    const height = 0.62 + rng() * 0.56 - radius * 0.35;
    const lean = 0.40 + rng() * 0.75;
    const width = 0.022 + rng() * 0.024;
    const rootX = Math.cos(angle) * radius, rootZ = Math.sin(angle) * radius;
    const bendAngle = angle + (rng() - 0.5) * 0.6;
    const bx = Math.cos(bendAngle), bz = Math.sin(bendAngle);
    const value = 0.84 + rng() * 0.32;
    const start = positions.length / 3;
    for (let row = 0; row < 3; row++) {
      const t = row / 3;
      const bend = lean * height * t * t;
      const twist = bendAngle + 0.35 * t;
      const sx = -Math.sin(twist), sz = Math.cos(twist);
      const w = width * (1 - t * t);
      for (let side = -1; side <= 1; side++) {
        const ridge = side === 0 ? w * 0.30 * Math.sin(t * Math.PI) : 0;
        positions.push(rootX + bx * bend + sx * w * side,
          height * (t - 0.14 * t * t) + ridge, rootZ + bz * bend + sz * w * side);
        const light = (0.50 + 0.76 * Math.sqrt(t)) * value * (side === 0 ? 1.08 : 0.94);
        colors.push(light, light, light * (0.90 + t * 0.10));
      }
    }
    positions.push(rootX + bx * lean * height, height * 0.86, rootZ + bz * lean * height);
    colors.push(value * 1.32, value * 1.32, value * 1.26);
    for (let row = 0; row < 2; row++) for (let side = 0; side < 2; side++) {
      const a = start + row * 3 + side, b = a + 3;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
    indices.push(start + 6, start + 7, start + 9, start + 7, start + 8, start + 9);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const normals = geometry.getAttribute('normal');
  const normal = new THREE.Vector3();
  for (let i = 0; i < normals.count; i++) {
    normal.fromBufferAttribute(normals, i);
    normal.set(normal.x * 0.55, 0.7 + Math.abs(normal.y) * 0.45, normal.z * 0.55).normalize();
    normals.setXYZ(i, normal.x, normal.y, normal.z);
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.boundingSphere.radius += 0.12;
  return geometry;
}

export function meadowGrassMaterial(far = false) {
  const material = tuftGrassMaterial(far);
  material.customProgramCacheKey = () => 'meadow-folded-leaf-v2';
  return material;
}
