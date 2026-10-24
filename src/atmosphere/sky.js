// src/atmosphere/sky.js — the sky dome. All of the actual colour lives in skylib.js so
// that fog.js can evaluate the identical function; this file is just the carrier mesh.
// Owned by the ATMOSPHERE builder.

import * as THREE from 'three';
import { skyUniforms, SKY_UNIFORM_DECL, SKY_FUNCS, NOISE_FUNCS } from './skylib.js';
import { gradeUniforms } from './tonemap.js';

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize( position );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_Position.z = gl_Position.w;   // pin to the far plane
}`;

const FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;
${SKY_UNIFORM_DECL}
${NOISE_FUNCS}
${SKY_FUNCS}
void main() {
  gl_FragColor = vec4( skyFull( normalize( vDir ) ), 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createSky() {
  const uniforms = Object.assign({}, skyUniforms, gradeUniforms);
  // Alias: main.js's resnap() zeroes `sky.userData.uniforms.uTime` to make repeat
  // captures byte-identical. Point it at the same uniform object so that still works.
  uniforms.uTime = skyUniforms.uSkyTime;
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
  });
  // 32x20 is plenty: nothing is interpolated across the dome, every value is computed
  // per fragment from the direction.
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.name = 'sky';
  mesh.userData.uniforms = uniforms;
  return mesh;
}
