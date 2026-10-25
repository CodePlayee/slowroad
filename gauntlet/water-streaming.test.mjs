import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(new URL(url), 'utf8'), shortCircuit: true } : next(url, context);
} });
const { buildWaterData } = await import('../src/water/mesh-data.js');
const { buildTerrainTileData, buildTerrainData } = await import('../src/terrain/mesh-data.js');
const { WaterSystem } = await import('../src/water/water.js');
const { WATER } = await import('../src/water/params.js');
const finish = iterator => { let step; do { step = iterator.next(); } while (!step.done); return step.value; };
const world = {
  seed: 7,
  ground: () => 0,
  hf: { river: () => ({ waterY: 2, channelHalf: 20, dist: 0 }) },
  sample(x, z, out) { Object.assign(out, { y: 0, waterY: 2, channelHalf: 20, riverDist: 0,
    moisture: 1, rockiness: 0, roadDist: Infinity }); },
};

test('water buffers preserve topology, depth colors, normals and world-space UVs', () => {
  const data = finish(buildWaterData(world, 100, 200, 32, 8, world.ground));
  const water = Object.create(WaterSystem.prototype);
  const mesh = water.geometryFromData(data);
  assert.equal(data.positions.length, 81 * 3);
  assert.equal(data.indices.length, 64 * 6);
  assert.deepEqual(Array.from(data.indices.slice(0, 6)), [0, 2, 1, 1, 2, 3]);
  for (let i = 0; i < 81; i++) {
    assert.equal(data.positions[i * 3 + 1], 2);
    assert.deepEqual(Array.from(mesh.attributes.normal.array.slice(i * 3, i * 3 + 3)), [0, 1, 0]);
    assert.ok(Math.abs(data.uvs[i * 2] - (data.positions[i * 3] + 116) / 26) < 1e-6);
    assert.ok(Math.abs(data.uvs[i * 2 + 1] - (data.positions[i * 3 + 2] + 216) / 26) < 1e-6);
    const depthT = 2 / WATER.depthFade;
    assert.ok(Math.abs(data.colors[i * 4 + 3] - (WATER.alphaShallow + (WATER.alphaDeep - WATER.alphaShallow) * depthT)) < 1e-6);
    assert.ok(Math.abs(data.colors[i * 4 + 1] - (WATER.shallow[1] + (WATER.deep[1] - WATER.shallow[1]) * depthT)) < 1e-6);
  }
  const cloned = structuredClone(data, { transfer: Object.values(data).map(a => a.buffer) });
  assert.equal(data.positions.byteLength, 0);
  assert.equal(cloned.indices.length, 384);
  mesh.dispose();
});

test('water fallback yields once per sampling row and can be cancelled without finishing', () => {
  let samples = 0;
  const counting = { hf: { river() { samples++; return world.hf.river(); } } };
  const iterator = buildWaterData(counting, 0, 0, 32, 24, world.ground);
  assert.equal(iterator.next().done, false);
  assert.equal(samples, 25);
  iterator.return();
  assert.equal(iterator.next().done, true);
  assert.equal(samples, 25);
  assert.equal(finish(buildWaterData(world, 0, 0, 32, 8, () => 10)), null);
  for (const res of [NaN, Infinity, 0, -1, 513]) assert.throws(() => finish(buildWaterData(world, 0, 0, 32, res, world.ground)), RangeError);
});

test('prepared tiles reuse the exact terrain height grid and keep water sampling off publication', () => {
  const tile = { x0: 0, z0: 0, C: 128, l: 0 };
  const options = { resolution: 8, skirtDepth: 20, waterResolution: 24 };
  const terrain = finish(buildTerrainData(world, tile, options));
  const prepared = finish(buildTerrainTileData(world, tile, options));
  for (const key of Object.keys(terrain)) assert.deepEqual(prepared[key], terrain[key]);
  assert.deepEqual(prepared.water, finish(buildWaterData(world, 0, 0, 128, 24, () => 0)));
  const withoutWater = finish(buildTerrainTileData(world, tile, { resolution: 8, skirtDepth: 20 }));
  assert.equal(Object.hasOwn(withoutWater, 'water'), false);
});

test('sky reflection uses a world-space normal and a floored Fresnel mix before fog', async () => {
  const THREE = await import('three');
  const { registerFogMaterial } = await import('../src/atmosphere/fog.js');
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {},
  }) }) };
  try {
    const water = new WaterSystem(world, { register: registerFogMaterial });
    const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
    water.material.onBeforeCompile(shader, {});
    const fs = shader.fragmentShader;
    assert.match(fs, /inverseTransformDirection\( normalize\( vNormal \), viewMatrix \)/);
    assert.ok(fs.includes(`mix( ${WATER.reflectFloor.toFixed(3)}, ${WATER.reflectMax.toFixed(3)}, fres )`));
    assert.ok(WATER.reflectFloor >= 0.08 && WATER.reflectFloor <= 0.10);
    assert.ok(fs.indexOf('float refl') < fs.indexOf('#include <fog_fragment>'));
    assert.ok(shader.uniforms.uFogColorHigh && shader.uniforms.uFogColorLow);
    water.ripple.dispose();
    water.material.dispose();
  } finally {
    globalThis.document = previous;
  }
});
