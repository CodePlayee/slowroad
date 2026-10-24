import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Vite treats src/*.js as ES modules despite the legacy package type.
const src = new URL('../src/', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(src) && url.endsWith('.js')) {
      return { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { World } = await import('../src/world/world.js');

test('slope query exposes the ground tangent without extra height samples', () => {
  const world = new World(7);
  let calls = 0;
  const dx = 0.32, dz = -0.19;
  world.ground = (x, z) => { calls++; return 12 + dx * x + dz * z; };
  const x = 42, z = -17, y = world.ground(x, z);
  calls = 0;
  const gradient = {};
  const slope = world.slopeAt(x, z, y, 2.6, gradient);
  assert.equal(calls, 2);
  assert.ok(Math.abs(gradient.dx - dx) < 1e-12);
  assert.ok(Math.abs(gradient.dz - dz) < 1e-12);
  assert.ok(Math.abs(slope - (1 - 1 / Math.hypot(1, dx, dz))) < 1e-12);
  for (const [ox, oz] of [[-1.2, 0.8], [0.5, -0.4], [1.1, 1.2]]) {
    const placedY = y + gradient.dx * ox + gradient.dz * oz;
    assert.ok(Math.abs(placedY - world.ground(x + ox, z + oz)) < 1e-12);
  }
});

test('existing callers can omit the tangent output', () => {
  const world = new World(3);
  world.ground = () => 8;
  assert.equal(world.slopeAt(0, 0, 8), 0);
});
