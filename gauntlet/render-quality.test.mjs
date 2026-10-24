import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(new URL(url), 'utf8'), shortCircuit: true } : next(url, context);
} });
const { RenderQuality } = await import('../src/core/renderQuality.js');

test('pixel budget scales raster resolution independently of plant LOD', () => {
  const quality = new RenderQuality({ deviceRatio: 2 });
  quality.resize(1920, 1080);
  assert.ok(1920 * 1080 * quality.pixelRatio ** 2 <= 2100001);
  assert.equal(quality.lodHeight, 1080);
  const start = quality.pixelRatio;
  for (let i = 0; i < 180; i++) quality.sample(33, 8);
  assert.ok(quality.pixelRatio < start);
  assert.equal(quality.lodHeight, 1080);
  assert.ok(quality.changes <= 3);
});

test('quality locks and inactive or CPU-limited frames never reduce image quality', () => {
  const fixed = new RenderQuality({ fixedRatio: 1.5, lodScale: 1.5 });
  fixed.resize(1920, 1080);
  for (let i = 0; i < 500; i++) fixed.sample(40, 8);
  assert.equal(fixed.pixelRatio, 1.5); assert.equal(fixed.lodHeight, 1620);
  const quality = new RenderQuality({ deviceRatio: 2 }); quality.resize(1920, 1080);
  const initial = quality.pixelRatio;
  for (let i = 0; i < 500; i++) quality.sample(50, 40);
  for (let i = 0; i < 500; i++) quality.sample(50, 4, false);
  for (const value of [NaN, Infinity, 0, -1, 500]) quality.sample(value, 4);
  assert.equal(quality.pixelRatio, initial);
});

test('stable travel never probes a higher ratio; resizing starts a fresh viewport budget', () => {
  const quality = new RenderQuality({ deviceRatio: 2 }); quality.resize(1920, 1080);
  for (let i = 0; i < 120; i++) quality.sample(40, 8);
  quality.reset();
  const lower = quality.pixelRatio;
  for (let i = 0; i < 300; i++) quality.sample(16.7, 8);
  assert.equal(quality.pixelRatio, lower);
  for (let i = 0; i < 1500; i++) quality.sample(16.7, 8);
  assert.equal(quality.pixelRatio, lower);
  quality.resize(390, 844);
  assert.equal(quality.pixelRatio, 1.5); assert.equal(quality.lodHeight, 844);
});

test('short/long RAF jitter and isolated CPU stalls do not trigger expensive canvas resizes', () => {
  const quality = new RenderQuality({ deviceRatio: 2 }); quality.resize(1920, 1080);
  const initial = quality.pixelRatio;
  for (let i = 0; i < 1800; i++) quality.sample(i % 60 === 0 ? 28 : i % 2 ? 19 : 14, i % 60 === 0 ? 26 : 9);
  assert.equal(quality.pixelRatio, initial);
  assert.equal(quality.changes, 0);
});

test('frequent missed frames with CPU headroom still reduce raster cost', () => {
  const quality = new RenderQuality({ deviceRatio: 2 }); quality.resize(1920, 1080);
  const initial = quality.pixelRatio;
  for (let i = 0; i < 300; i++) quality.sample(i % 5 === 0 ? 33.3 : 16.7, 10);
  assert.ok(quality.pixelRatio < initial);
});

test('isolated slow windows do not resize, sustained overload still does', () => {
  const quality = new RenderQuality({ deviceRatio: 2 }); quality.resize(1920, 1080);
  const initial = quality.pixelRatio;
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < 100; i++) quality.sample(20, 10);
    for (let i = 0; i < 125; i++) quality.sample(16, 10);
  }
  assert.equal(quality.pixelRatio, initial);
  for (let i = 0; i < 200; i++) quality.sample(20, 10);
  assert.ok(quality.pixelRatio < initial);
});
