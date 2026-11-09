import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as THREE from 'three';

const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true }
    : next(url, context);
} });
const { PlantContactTexture } = await import('../src/terrain/plantContact.js');
const tree = (x = 0.5, z = 0.5, width = 16) => ({ id: `tree:${x}:${z}`, kind: 'tree', x, y: 50, z, width });
const shrub = (x = 0.5, z = 0.5, width = 3) => ({ id: `shrub:${x}:${z}`, kind: 'shrub', x, y: 50, z, width });

function fixture(t, options = {}) {
  const field = new PlantContactTexture({ radius: 16, resolution: 32, anchorStep: 4, texelsPerStep: 32, ...options });
  t.after(() => field.dispose());
  return field;
}

function finish(field) {
  let steps = 0;
  while (field.pending) {
    field.step();
    assert.ok(field.lastStep.texelsVisited <= field.texelsPerStep);
    assert.ok(field.lastStep.publishedTexels <= field.resolution ** 2);
    assert.ok(++steps < 10000, 'contact raster did not finish within its finite work bound');
  }
  return steps;
}

test('defaults define a bounded linear data texture on a one-metre world lattice', t => {
  const field = new PlantContactTexture();
  t.after(() => field.dispose());
  assert.equal(field.radius, 256);
  assert.equal(field.resolution, 512);
  assert.equal(field.texelSize, 1);
  assert.equal(field.anchorStep, 16);
  assert.equal(field.maxRecords, 8192);
  assert.equal(field.texelsPerStep, 16384);
  assert.equal(field.texture.image.data, field.data);
  assert.equal(field.texture.format, THREE.RedFormat);
  assert.equal(field.texture.type, THREE.UnsignedByteType);
  assert.equal(field.texture.colorSpace, THREE.NoColorSpace);
  assert.equal(field.texture.minFilter, THREE.LinearFilter);
  assert.equal(field.texture.magFilter, THREE.LinearFilter);
  assert.equal(field.texture.wrapS, THREE.ClampToEdgeWrapping);
  assert.equal(field.texture.wrapT, THREE.ClampToEdgeWrapping);
  assert.equal(field.texture.generateMipmaps, false);
  assert.equal(field.texture.unpackAlignment, 1);
});

test('actual tree roots produce smooth bounded peaks and width controls their support', t => {
  const field = fixture(t), records = [tree()];
  const before = structuredClone(records);
  field.update(records, { x: 0, z: 0 });
  assert.equal(field.pending, true);
  assert.equal(field.sampleWorld(0.5, 0.5), 0, 'partial stamps stay unpublished');
  finish(field);
  const peak = field.sampleWorld(0.5, 0.5), middle = field.sampleWorld(1.5, 0.5);
  assert.equal(peak, Math.round(255 * 0.55) / 255);
  assert.ok(peak > middle && middle > field.sampleWorld(2.5, 0.5));
  assert.equal(field.sampleWorld(5.5, 0.5), 0);
  assert.deepEqual(records, before, 'contact raster must not mutate population records');
  const small = fixture(t);
  small.update([tree(0.5, 0.5, 2)], { x: 0, z: 0 }); finish(small);
  assert.ok(field.data.filter(Boolean).length > small.data.filter(Boolean).length);
});

test('shrubs are supported and overlap cannot accumulate a black circular spot', t => {
  const field = fixture(t);
  field.update([shrub()], { x: 0, z: 0 }); finish(field);
  assert.equal(field.sampleWorld(0.5, 0.5), Math.round(255 * 0.30) / 255);
  field.update([tree(), tree(), shrub()], { x: 0, z: 0 }); finish(field);
  assert.equal(field.sampleWorld(0.5, 0.5), Math.round(255 * 0.55) / 255);
});

test('empty, grass-only, malformed, and far-field records never create invented contacts', t => {
  const field = fixture(t);
  for (const records of [[], [{ ...tree(), kind: 'grass' }], [tree(1000, 1000)], [tree(13.5, 13.5)],
    [tree(NaN, 0)], [tree(0, Infinity)], [tree(0, 0, -1)], [null]]) {
    field.update(records, { x: 0, z: 0 }); finish(field);
    assert.equal(field.data.some(Boolean), false);
  }
  field.update([tree()], { x: 0, z: 0 }); finish(field);
  assert.equal(field.sampleWorld(1000, 1000), 0);
  assert.equal(field.sampleWorld(-1000, 0), 0);
});

test('all texture edges remain zero even for clipped near-boundary roots', t => {
  const field = fixture(t);
  field.update([tree(14.5, 0.5, 30), tree(-14.5, 0.5, 30), tree(0.5, 14.5, 30), tree(0.5, -14.5, 30)], { x: 0, z: 0 });
  finish(field);
  const n = field.resolution;
  assert.ok(field.data.some(Boolean));
  for (let i = 0; i < n; i++) {
    assert.equal(field.data[i], 0);
    assert.equal(field.data[(n - 1) * n + i], 0);
    assert.equal(field.data[i * n], 0);
    assert.equal(field.data[i * n + n - 1], 0);
  }
  assert.equal(field.sampleWorld(field.origin.x, 0), 0);
  assert.equal(field.sampleWorld(field.origin.x + field.span, 0), 0);
});

test('stationary input reuses texture buffers and explicit revisions make unchanged calls constant work', t => {
  const field = fixture(t), records = [tree()], texture = field.texture, data = field.data;
  field.update(records, { x: 0, z: 0 }, { revision: 1 }); finish(field);
  field.markClean();
  const version = field.version, gpuVersion = texture.version;
  assert.equal(field.update(records, { x: 3.9, z: 2.1 }, { revision: 1 }), false);
  assert.equal(field.lastUpdate.recordsVisited, 0);
  assert.equal(field.version, version);
  assert.equal(texture.version, gpuVersion);
  assert.equal(field.dirty, false);
  assert.equal(field.texture, texture);
  assert.equal(field.data, data);
  assert.equal(field.update(records.map(record => ({ ...record })), { x: 3, z: 1 }), false);
  assert.equal(field.lastUpdate.recordsVisited, records.length);
});

test('focus-only rebuilds keep active origin and texture until atomic world-anchored publication', t => {
  const field = fixture(t, { texelsPerStep: 1 }), records = [tree(-2.5, -1.5)];
  field.update(records, { x: -1, z: -1 }, { revision: 1 }); finish(field);
  const oldOrigin = field.origin.toArray(), oldData = field.data.slice(), peak = field.sampleWorld(-2.5, -1.5);
  const samples = [];
  for (let x = -5.5; x <= 0.5; x++) for (let z = -4.5; z <= 1.5; z++) {
    samples.push({ x, z, value: field.sampleWorld(x, z) });
  }
  field.markClean();
  const version = field.version;
  field.update(records, { x: 5, z: 0 }, { revision: 1 });
  assert.equal(field.pending, true);
  field.step();
  assert.deepEqual(field.origin.toArray(), oldOrigin);
  assert.deepEqual(field.data, oldData);
  assert.equal(field.version, version);
  assert.equal(field.dirty, false);
  finish(field);
  assert.deepEqual(field.origin.toArray(), [-12, -16]);
  assert.equal(field.sampleWorld(-2.5, -1.5), peak);
  assert.equal(Math.abs(field.origin.x % field.texelSize), 0);
  assert.equal(Math.abs(field.origin.y % field.texelSize), 0);
  for (const sample of samples) assert.equal(field.sampleWorld(sample.x, sample.z), sample.value);
  assert.equal(field.dirty, true);
  assert.equal(field.version, version + 1);
});

test('deleting, moving, or resizing records clears obsolete contact before incremental publication', t => {
  const field = fixture(t, { texelsPerStep: 1 }), records = [tree()];
  field.update(records, { x: 0, z: 0 }); finish(field);
  records[0].x = 8.5;
  field.update(records, { x: 0, z: 0 });
  assert.equal(field.sampleWorld(0.5, 0.5), 0, 'moving a root immediately invalidates its old contact');
  finish(field);
  assert.ok(field.sampleWorld(8.5, 0.5) > 0);
  records[0].width = 2;
  assert.equal(field.update(records, { x: 0, z: 0 }), true);
  assert.equal(field.sampleWorld(8.5, 0.5), 0);
  finish(field);
  records.splice(0, 1);
  field.update(records, { x: 0, z: 0 });
  assert.equal(field.pending, false);
  assert.equal(field.data.some(Boolean), false);
});

test('a changed revision catches same-array mutation without keeping the previous active root', t => {
  const field = fixture(t), records = [tree()];
  field.update(records, { x: 0, z: 0 }, { revision: 1 }); finish(field);
  records[0].z = 9.5;
  field.update(records, { x: 0, z: 0 }, { revision: 2 }); finish(field);
  assert.equal(field.sampleWorld(0.5, 0.5), 0);
  assert.ok(field.sampleWorld(0.5, 9.5) > 0);
});

test('additions and deletion of nonactive selection-edge records retain the valid active texture', t => {
  const field = fixture(t, { texelsPerStep: 1 }), first = tree(), far = tree(1000, 1000);
  field.update([first, far], { x: 0, z: 0 }); finish(field);
  const value = field.sampleWorld(0.5, 0.5), version = field.version;
  field.markClean();
  field.update([first, tree(8.5, 0.5)], { x: 0, z: 0 });
  assert.equal(field.sampleWorld(0.5, 0.5), value);
  assert.equal(field.version, version);
  assert.equal(field.dirty, false);
  field.step();
  assert.equal(field.sampleWorld(8.5, 0.5), 0);
  finish(field);
  assert.ok(field.sampleWorld(8.5, 0.5) > 0);
});

test('cancelling pending work keeps active data while a seed reset invalidates it and cancels all work', t => {
  const field = fixture(t, { texelsPerStep: 1 }), records = [tree()];
  field.update(records, { x: 0, z: 0 }); finish(field);
  const before = field.data.slice(), origin = field.origin.toArray();
  field.update(records, { x: 4, z: 0 }); field.step();
  assert.equal(field.cancelPending(), true);
  assert.equal(field.pending, false);
  assert.deepEqual(field.data, before);
  assert.deepEqual(field.origin.toArray(), origin);
  field.update(records, { x: 8, z: 0 });
  assert.equal(field.reset(), true);
  assert.equal(field.pending, false);
  assert.equal(field.activeCount, 0);
  assert.equal(field.data.some(Boolean), false);
  assert.equal(field.step(), true);
  assert.equal(field.reset(), false);
});

test('only explicit retirement of streamed-out exterior roots bypasses active deletion checks', t => {
  const field = fixture(t, { texelsPerStep: 1 }), kept = tree(), edge = shrub(-13.5, 0.5);
  field.update([kept, edge], { x: 0, z: 0 }); finish(field);
  const data = field.data.slice(), value = field.sampleWorld(0.5, 0.5);
  assert.equal(field.retireOutsideWindow([edge], { x: 4, z: 0 }), false);
  assert.deepEqual(field.data, data);
  field.update([kept], { x: 4, z: 0 });
  assert.equal(field.sampleWorld(0.5, 0.5), value);
  field.step();
  assert.equal(field.sampleWorld(0.5, 0.5), value);
  finish(field);
  assert.equal(field.sampleWorld(-13.5, 0.5), 0);
  field.update([kept, edge], { x: 0, z: 0 }); finish(field);
  field.update([kept], { x: 4, z: 0 });
  assert.equal(field.data.some(Boolean), false, 'an unqualified deletion is not a streaming exemption');
});

test('seed reset clears published pixels even when all signatures were retired after cancelling a window', t => {
  const field = fixture(t, { texelsPerStep: 1 }), edge = shrub(-13.5, 0.5);
  field.update([edge], { x: 0, z: 0 }); finish(field);
  field.update([edge], { x: 1, z: 4 });
  field.cancelPending();
  assert.equal(field.retireOutsideWindow([edge], { x: 4, z: 0 }), false);
  assert.equal(field.activeCount, 0);
  assert.ok(field.data.some(Boolean));
  assert.equal(field.reset(), true);
  assert.equal(field.data.some(Boolean), false);
  assert.equal(field.reset(), false);
});

test('superseded focus and record builds cannot publish old roots or the wrong origin', t => {
  const field = fixture(t, { texelsPerStep: 1 }), records = [tree()];
  field.update(records, { x: 0, z: 0 }); finish(field);
  field.update(records, { x: 4, z: 0 }); field.step();
  field.update([tree(16.5, 0.5)], { x: 20, z: 0 }); field.step();
  assert.equal(field.data.some(Boolean), false);
  field.update([tree(24.5, 0.5)], { x: 24, z: 0 }); finish(field);
  assert.deepEqual(field.origin.toArray(), [8, -16]);
  assert.equal(field.sampleWorld(0.5, 0.5), 0);
  assert.equal(field.sampleWorld(16.5, 0.5), 0, 'cancelled root lies beyond the final root contact footprint');
  assert.ok(field.sampleWorld(24.5, 0.5) > 0);
  const fresh = fixture(t, { texelsPerStep: 1 });
  fresh.update([tree(24.5, 0.5)], { x: 24, z: 0 }); finish(fresh);
  assert.deepEqual(field.data, fresh.data, 'superseded work must leave exactly the latest complete raster');
});

test('record and raster budgets are explicit and oversized global populations are rejected intact', t => {
  const field = fixture(t, { maxRecords: 8, texelsPerStep: 7 });
  const records = Array.from({ length: 8 }, (_, i) => tree(i - 3.5, 0.5, 30));
  field.update(records, { x: 0, z: 0 });
  assert.ok(field.lastUpdate.recordsVisited <= 2 * field.maxRecords);
  assert.equal(field.lastUpdate.stampCandidates, records.length);
  assert.ok(field.lastUpdate.clearedTexels <= 2 * field.resolution ** 2);
  assert.ok(finish(field) > 1);
  const data = field.data.slice(), origin = field.origin.toArray(), version = field.version;
  assert.throws(() => field.update([...records, tree()], { x: 4, z: 0 }), /nearby plant tiles/);
  assert.deepEqual(field.data, data);
  assert.deepEqual(field.origin.toArray(), origin);
  assert.equal(field.version, version);
  assert.throws(() => field.step(8), /budget/);
});

test('disposal is idempotent and prevents pending work from resurrecting texture resources', t => {
  const field = fixture(t), texture = field.texture;
  let disposals = 0;
  texture.addEventListener('dispose', () => disposals++);
  field.update([tree()], { x: 0, z: 0 }); field.step(1);
  field.dispose(); field.dispose();
  assert.equal(disposals, 1);
  assert.equal(field.pending, false);
  assert.equal(field.data, null);
  assert.equal(texture.image.data, null);
  assert.equal(field.dirty, false);
  assert.equal(field.update([tree()], { x: 0, z: 0 }), false);
  assert.equal(field.step(), true);
  assert.equal(field.sampleWorld(0.5, 0.5), 0);
});

test('invalid field dimensions and focus values fail before altering valid data', t => {
  for (const options of [{ radius: 0 }, { resolution: 7 }, { resolution: 2048 }, { anchorStep: 0 },
    { maxRecords: 0 }, { texelsPerStep: 0 }]) assert.throws(() => new PlantContactTexture(options), /configuration/);
  const field = fixture(t);
  assert.throws(() => field.update(new Set(), { x: 0, z: 0 }), /bounded array/);
  assert.throws(() => field.update([], { x: NaN, z: 0 }), /focus/);
  assert.equal(field.version, 0);
});
