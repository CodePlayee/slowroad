import test from 'node:test';
import assert from 'node:assert/strict';
import { maskPixels, packageBlind } from './package-blind.mjs';

test('blind preprocessing masks only declared identical HUD pixels without mutating inputs', () => {
  const source = { width: 4, height: 3, data: Buffer.from(Array.from({ length: 48 }, (_, i) => i)) };
  const before = Buffer.from(source.data), output = maskPixels(source, [[1, 1, 2, 1]]);
  assert.deepEqual(source.data, before);
  for (let i = 0; i < 12; i++) {
    assert.deepEqual(output.data.subarray(i * 4, i * 4 + 4), i === 5 || i === 6
      ? Buffer.from([20, 20, 20, 255]) : before.subarray(i * 4, i * 4 + 4));
  }
  assert.throws(() => maskPixels(source, [[0, 0, 5, 1]]), /outside/);
  assert.equal(typeof packageBlind, 'function');
});
