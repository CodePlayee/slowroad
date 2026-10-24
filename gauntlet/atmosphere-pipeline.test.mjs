import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  if (url.startsWith(src) && url.endsWith('.js')) return { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
  return next(url, context);
} });
const { fogBeforeOutput, registerFogMaterial } = await import('../src/atmosphere/fog.js');

test('linear HDR fog runs before tone mapping and output encoding on stock materials', () => {
  for (const key of ['physical', 'phong', 'lambert', 'basic']) {
    const source = THREE.ShaderLib[key].fragmentShader;
    const changed = fogBeforeOutput(source);
    assert.ok(changed.indexOf('#include <fog_fragment>') < changed.indexOf('#include <tonemapping_fragment>'), key);
    assert.ok(changed.indexOf('#include <tonemapping_fragment>') < changed.indexOf('#include <colorspace_fragment>'), key);
    assert.equal(changed.match(/#include <fog_fragment>/g)?.length, 1);
    assert.equal(fogBeforeOutput(changed), changed, 'transform must be idempotent');
  }
});

test('water reflection hook and fog both remain before output conversion', () => {
  const mat = new THREE.MeshStandardMaterial();
  mat.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', 'WATER_REFLECTION\n#include <fog_fragment>');
  };
  registerFogMaterial(mat);
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  mat.onBeforeCompile(shader, {});
  assert.ok(shader.fragmentShader.indexOf('WATER_REFLECTION') < shader.fragmentShader.indexOf('#include <fog_fragment>'));
  assert.ok(shader.fragmentShader.indexOf('#include <fog_fragment>') < shader.fragmentShader.indexOf('#include <tonemapping_fragment>'));
  assert.ok(shader.uniforms.uFogColorHigh && shader.uniforms.uHazeA && shader.uniforms.uGradeLook);
});

test('the sky dome keeps its single output transform and no extra fog', () => {
  const source = '#include <tonemapping_fragment>\n#include <colorspace_fragment>';
  assert.equal(fogBeforeOutput(source), source);
});
