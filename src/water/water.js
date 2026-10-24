// src/water/water.js — river surface meshes, built per terrain chunk.
// Owned by the WATER builder agent.

import * as THREE from 'three';
import { WATER as W } from './params.js';
import { buildWaterData } from './mesh-data.js';

function rippleTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const h = new Float32Array(size * size);
  // sum of a few sine ripples, tileable
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * Math.PI * 2, v = (y / size) * Math.PI * 2;
      h[y * size + x] =
        Math.sin(u * 3 + Math.cos(v * 2) * 1.2) * 0.5 +
        Math.sin(v * 5 - u * 2) * 0.32 +
        Math.sin(u * 9 + v * 7) * 0.16;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x + size - 1) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const d = h[((y + size - 1) % size) * size + x];
      const uu = h[((y + 1) % size) * size + x];
      let nx = (l - r) * 1.2, nz = (d - uu) * 1.2, ny = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 2] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

export class WaterSystem {
  constructor(world, atmo) {
    this.world = world;
    this.atmo = atmo;
    this.ripple = rippleTexture();
    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      roughness: W.roughness,
      metalness: 0.02,
      side: THREE.DoubleSide,
      normalMap: this.ripple,
      normalScale: new THREE.Vector2(W.rippleStrength, W.rippleStrength),
      depthWrite: false,
    });
    this.material.name = 'water';
    // grazing-angle sky reflection: without it a river reads as flat pale plastic.
    // vFogWorldPos comes from our global fog chunk, so no extra varying is needed.
    this.material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <fog_fragment>',
        /* glsl */`
  {
    vec3 wv = normalize( cameraPosition - vFogWorldPos );
    vec3 wn = normalize( vNormal );
    if ( wn.y < 0.0 ) wn = -wn;
    float fres = pow( 1.0 - clamp( dot( wn, wv ), 0.0, 1.0 ), 4.0 );
    fres = min( fres, 0.82 );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, uFogColorHigh * 0.86 + uFogColorLow * 0.14, fres * 0.72 );
    gl_FragColor.a = mix( gl_FragColor.a, 1.0, fres * 0.9 );
  }
#include <fog_fragment>`
      );
    };
    this.material.customProgramCacheKey = () => 'water';
    atmo.register(this.material);
    this.time = 0;
  }

  update(dt) {
    this.time += dt;
    this.ripple.offset.set(this.time * W.flowSpeed, this.time * W.flowSpeed * 0.6);
  }

  /**
   * Build a water surface patch for the square [ox,ox+size) x [oz,oz+size).
   * Returns null when this patch has no water in it.
   */
  buildGeometry(ox, oz, size, res, groundAt) {
    const iterator = buildWaterData(this.world, ox, oz, size, res, groundAt);
    let step;
    do { step = iterator.next(); } while (!step.done);
    return this.geometryFromData(step.value);
  }

  geometryFromData(data) {
    if (!data) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(data.colors, 4));
    g.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(data.indices, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}
