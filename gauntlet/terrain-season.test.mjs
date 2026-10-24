import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import * as THREE from 'three';
const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(new URL(url), 'utf8'), shortCircuit: true } : next(url, context);
} });
const { Terrain } = await import('../src/terrain/terrain.js');
const { SEASONS } = await import('../src/atmosphere/params.js');

test('terrain snow programs change only across seasonal boundaries, preserving shared uniforms', () => {
  const material = new THREE.MeshStandardMaterial();
  material.defines = { OTHER_FEATURE: 1 };
  const uniforms = Object.fromEntries(['uGrassLush', 'uGrassDry', 'uRock', 'uSand'].map(name => [name, { value: new THREE.Color() }]));
  Object.assign(uniforms, { uSnowAmount: { value: 0 }, uSnowLine: { value: 0 }, uLitterAutumn: { value: 0 } });
  const terrain = { material, uniforms, atmo: { palette: SEASONS.summer, seasonName: 'summer' } };
  Terrain.prototype.applyPalette.call(terrain);
  const version = material.version, sharedSnow = uniforms.uSnowAmount;
  assert.equal(material.defines.TERRAIN_SNOW, 0);
  assert.equal(material.defines.OTHER_FEATURE, 1);
  Terrain.prototype.applyPalette.call(terrain); assert.equal(material.version, version);
  terrain.atmo = { palette: SEASONS.winter, seasonName: 'winter' };
  Terrain.prototype.applyPalette.call(terrain);
  assert.equal(material.defines.TERRAIN_SNOW, 1);
  assert.equal(uniforms.uSnowAmount, sharedSnow);
  assert.ok(sharedSnow.value > 0);
  const winterVersion = material.version;
  Terrain.prototype.applyPalette.call(terrain); assert.equal(material.version, winterVersion);
  terrain.atmo = { palette: SEASONS.autumn, seasonName: 'autumn' };
  Terrain.prototype.applyPalette.call(terrain);
  assert.equal(material.defines.TERRAIN_SNOW, 0);
  assert.equal(sharedSnow.value, 0);
  assert.equal(uniforms.uLitterAutumn.value, 1);
  material.dispose();
});
