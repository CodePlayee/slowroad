import * as THREE from 'three';
import { makeRng } from '../core/rng.js';

export function buildTuftGeometry(blades = 8, segments = 3) {
  const rng = makeRng(0x471ffe);
  const positions = [], colors = [], indices = [];
  for (let blade = 0; blade < blades; blade++) {
    const angle = blade * 2.399963 + rng() * 0.45;
    const height = 0.48 + rng() * 0.50;
    const lean = 0.25 + rng() * 0.55;
    const width = 0.032 + rng() * 0.038;
    const radius = Math.sqrt(rng()) * 0.24;
    const rootX = Math.cos(angle) * radius, rootZ = Math.sin(angle) * radius;
    for (let plane = 0; plane < 2; plane++) {
      const direction = angle + plane * Math.PI * 0.5;
      const bendX = Math.cos(direction + 0.45), bendZ = Math.sin(direction + 0.45);
      const sideX = -Math.sin(direction), sideZ = Math.cos(direction);
      const start = positions.length / 3;
      const point = (t, side) => {
        const bend = lean * t * t * height;
        const half = width * (1 - t) * side;
        positions.push(rootX + bendX * bend + sideX * half, height * t, rootZ + bendZ * bend + sideZ * half);
        const light = 0.83 + 0.42 * t + (blade % 3) * 0.025;
        colors.push(light, light, light);
      };
      for (let j = 0; j < segments; j++) { point(j / segments, -0.5); point(j / segments, 0.5); }
      point(1, 0);
      for (let j = 0; j < segments - 1; j++) {
        const a = start + j * 2;
        indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
      indices.push(start + (segments - 1) * 2, start + (segments - 1) * 2 + 1, start + segments * 2);
    }
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
    normal.set(normal.x * 0.35, 0.8 + Math.abs(normal.y) * 0.3, normal.z * 0.35).normalize();
    normals.setXYZ(i, normal.x, normal.y, normal.z);
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.boundingSphere.radius += 0.12;
  return geometry;
}

export function tuftGrassMaterial(far = false) {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, side: THREE.DoubleSide });
  material.userData.uniforms = {
    uWind: { value: new THREE.Vector4(0, Math.cos(0.7), Math.sin(0.7), 0) },
    uFocus: { value: new THREE.Vector2() },
    uBand: { value: new THREE.Vector2(far ? 1 : 0, far ? 285 : 85) },
  };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, material.userData.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 iTint;
        attribute float iShape;
        uniform vec4 uWind;
        uniform vec2 uFocus;
        uniform vec2 uBand;`)
      .replace('#include <color_vertex>', '#include <color_vertex>\nvColor.rgb *= iTint;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float phase = iShape * 6.2831853 + instanceMatrix[3][0] * 0.017 + instanceMatrix[3][2] * 0.021;
        float wave = sin(uWind.x + phase) * 0.07;
        transformed.xz += uWind.yz * wave * position.y * position.y;
        float distanceToFocus = length(instanceMatrix[3].xz - uFocus);
        float nearCoverage = 1.0 - smoothstep(62.0, 85.0, distanceToFocus);
        float coverage = uBand.x < 0.5 ? nearCoverage : (1.0 - nearCoverage) * (1.0 - smoothstep(240.0, 285.0, distanceToFocus));
        transformed *= smoothstep(0.0, 0.18, coverage - fract(iShape * 31.73) + 0.18);
      `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
  };
  material.customProgramCacheKey = () => 'meadow-tuft-v1';
  return material;
}
