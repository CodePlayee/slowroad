import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true } : next(url, context);
} });
const { hash2i } = await import('../src/core/rng.js');
const { SURFACE_HASH_GLSL } = await import('../src/core/shaderNoise.js');

test('integer material hash retains fine variation far along positive and negative routes', () => {
  for (const offset of [0, 6000 * 133, 26000 * 133, -26000 * 133]) {
    const values = [];
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) values.push((hash2i(offset + x, offset + y) >>> 8) / 16777216);
    assert.ok(new Set(values).size > 1000);
    assert.ok(Math.min(...values) < 0.01 && Math.max(...values) > 0.99);
    assert.ok(values.every(value => value >= 0 && value < 1));
  }
  assert.match(SURFACE_HASH_GLSL, /uvec2\(ivec2\(p\)\)/);
  assert.doesNotMatch(SURFACE_HASH_GLSL, /fract\(/);
});

test('terrain injects the precision-safe material hash without altering world generation', () => {
  const terrain = readFileSync(new URL('../src/terrain/terrain.js', import.meta.url), 'utf8');
  assert.ok(terrain.includes('${SURFACE_HASH_GLSL}'));
  assert.match(terrain, /float thash\( vec2 p \) \{ return surfaceHash\(p\); \}/);
  assert.doesNotMatch(readFileSync(new URL('../src/terrain/heightfield.js', import.meta.url), 'utf8'), /SURFACE_HASH_GLSL/);
});
