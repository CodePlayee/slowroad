import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
const { TREE_SPECIES, TREE_SPECIES_NAMES, EXTRA_TREE_SPECIES_NAMES, isEvergreenSpecies, loadTreeSpecies } =
  await import('../src/vegetation/treeSpecies.js');
const { decodeTreeSpecies } = await import('../src/vegetation/treeSpeciesAssets.js');
const assets = new URL('../public/models/woodland/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('species.manifest.json', assets)));
const raw = readFileSync(new URL(manifest.buffer, assets));
const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const dispose = (trees) => {
  for (const tree of Object.values(trees)) for (const geometry of Object.values(tree.near)) geometry.dispose();
};

test('six species have complete immutable metadata and locally available cutout textures', () => {
  assert.deepEqual(TREE_SPECIES_NAMES, ['pine', 'oak', 'birch', 'aspen', 'maple', 'spruce']);
  assert.deepEqual(TREE_SPECIES_NAMES.filter(isEvergreenSpecies), ['pine', 'spruce']);
  for (const metadata of Object.values(TREE_SPECIES)) {
    assert.ok(Object.isFrozen(metadata));
    assert.equal(metadata.barkTint.length, 3);
    assert.equal(metadata.leafTint.length, 3);
    assert.ok(metadata.heightRange[0] > 0 && metadata.heightRange[1] > metadata.heightRange[0]);
    assert.ok(metadata.widthRatio[0] > 0 && metadata.widthRatio[1] > metadata.widthRatio[0]);
    assert.ok(existsSync(new URL(metadata.barkMap, assets)));
    assert.ok(existsSync(new URL(metadata.leafMap, assets)));
  }
  assert.equal(isEvergreenSpecies('unknown'), false);
});

test('population metadata has no eager imports or runtime tree generator', () => {
  const source = readFileSync(new URL('../src/vegetation/treeSpecies.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import\s/m);
  assert.doesNotMatch(source, /@dgreenheck|new THREE|TextureLoader/);
  assert.match(source, /await import\('\.\/treeSpeciesAssets\.js'\)/);
});

test('roadside woodland uses tall species-specific world-space height ranges', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(TREE_SPECIES).map(([name, metadata]) => [name, metadata.heightRange])), {
    pine: [15, 28], oak: [14, 24], birch: [14, 24], aspen: [17, 29], maple: [13, 23], spruce: [17, 30],
  });
  assert.ok(TREE_SPECIES.aspen.widthRatio[1] < TREE_SPECIES.maple.widthRatio[0]);
});

test('new species retain centered roots, normalized crowns, normals, UVs, and bounded topology', () => {
  const trees = decodeTreeSpecies(manifest, buffer);
  try {
    for (const [name, { near }] of Object.entries(trees)) {
      const bounds = new THREE.Box3();
      let triangles = 0;
      for (const geometry of Object.values(near)) {
        bounds.union(geometry.boundingBox);
        triangles += geometry.index.count / 3;
        assert.ok(geometry.boundingSphere.radius > 0 && geometry.boundingSphere.radius < 2);
        assert.ok(geometry.index.array.every(index => index < geometry.attributes.position.count));
        for (const attribute of Object.values(geometry.attributes)) assert.ok(attribute.array.every(Number.isFinite));
        assert.equal(geometry.attributes.position.count, geometry.attributes.normal.count);
        assert.equal(geometry.attributes.position.count, geometry.attributes.uv.count);
      }
      assert.ok(Math.abs(bounds.min.y) < 1e-6, `${name} root must touch ground`);
      assert.ok(Math.abs(bounds.max.y - 1) < 1e-6, `${name} must be unit height`);
      assert.ok(triangles >= 4000 && triangles <= 12000);
      assert.equal(triangles, manifest.trees[name].near.triangles);
      const roots = near.bark.attributes.position;
      let x = 0, z = 0, count = 0;
      for (let i = 0; i < roots.count; i++) if (Math.abs(roots.getY(i)) < 1e-6) {
        x += roots.getX(i); z += roots.getZ(i); count++;
      }
      assert.ok(count >= 6 && Math.hypot(x / count, z / count) < 0.004, `${name} root shifted from its instance origin`);
      assert.ok(near.leaf.boundingBox.max.x - near.leaf.boundingBox.min.x > 0.25);
    }
  } finally { dispose(trees); }
});

test('crown geometry distinguishes upright aspen, airy birch, spreading maple, and low spruce', () => {
  const trees = decodeTreeSpecies(manifest, buffer);
  try {
    const width = name => trees[name].near.leaf.boundingBox.getSize(new THREE.Vector3()).x;
    assert.ok(width('maple') > width('aspen') * 2.3);
    assert.ok(width('birch') > width('aspen') * 1.8);
    assert.ok(width('birch') < width('maple') * 0.9);
    assert.ok(trees.spruce.near.leaf.boundingBox.min.y < 0.16);
    assert.ok(trees.aspen.near.leaf.boundingBox.min.y > 0.25);
    assert.ok(trees.birch.near.leaf.boundingBox.min.y > 0.2);
    assert.equal(new Set(EXTRA_TREE_SPECIES_NAMES.map(name => trees[name].near.bark.index.count)).size, 4);
  } finally { dispose(trees); }
});

test('summer leaf clusters retain adequate geometric area without increasing triangle budgets', () => {
  const trees = decodeTreeSpecies(manifest, buffer);
  const minimumArea = { birch: 5.5, aspen: 9, maple: 9, spruce: 7.5 };
  const triangles = { birch: 8676, aspen: 8358, maple: 10716, spruce: 9932 };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  try {
    for (const [name, { near }] of Object.entries(trees)) {
      const leaf = near.leaf, positions = leaf.attributes.position;
      let area = 0;
      for (let i = 0; i < leaf.index.count; i += 3) {
        a.fromBufferAttribute(positions, leaf.index.getX(i));
        b.fromBufferAttribute(positions, leaf.index.getX(i + 1));
        c.fromBufferAttribute(positions, leaf.index.getX(i + 2));
        area += b.sub(a).cross(c.sub(a)).length() * 0.5;
      }
      // Triangle area guards leaf-cluster scale, not rendered alpha coverage.
      assert.ok(area >= minimumArea[name], `${name} has undersized summer clusters: ${area}`);
      assert.equal((near.bark.index.count + leaf.index.count) / 3, triangles[name]);
    }
  } finally { dispose(trees); }
});

test('species loader reads the additional manifest and binary without generating trees', async () => {
  const urls = [];
  const trees = await loadTreeSpecies(async url => {
    urls.push(url);
    return { ok: true, json: async () => manifest, arrayBuffer: async () => buffer.slice(0) };
  });
  try {
    assert.deepEqual(Object.keys(trees), EXTRA_TREE_SPECIES_NAMES);
    assert.deepEqual(urls, ['/models/woodland/species.manifest.json', '/models/woodland/species.bin']);
  } finally { dispose(trees); }
  await assert.rejects(loadTreeSpecies(async () => ({ ok: false, status: 503 })), /HTTP 503/);
});

test('species decoder rejects missing, truncated, misaligned, non-finite, and invalid-index assets', () => {
  assert.throws(() => decodeTreeSpecies({}, buffer), /Unknown tree species/);
  const missing = structuredClone(manifest);
  delete missing.trees.birch;
  assert.throws(() => decodeTreeSpecies(missing, buffer), /Missing tree species: birch/);
  assert.throws(() => decodeTreeSpecies(manifest, buffer.slice(0, 64)), /Invalid tree species buffer/);
  const misaligned = structuredClone(manifest);
  misaligned.trees.birch.near.parts.leaf.attributes.normal.byteOffset += 1;
  assert.throws(() => decodeTreeSpecies(misaligned, buffer), /Invalid tree species buffer/);
  const nonFinite = buffer.slice(0);
  new Float32Array(nonFinite, manifest.trees.birch.near.parts.bark.attributes.position.byteOffset, 1)[0] = NaN;
  assert.throws(() => decodeTreeSpecies(manifest, nonFinite), /Non-finite tree species vertex/);
  const badIndex = buffer.slice(0);
  new Uint16Array(badIndex, manifest.trees.birch.near.parts.bark.attributes.index.byteOffset, 1)[0] = 65535;
  assert.throws(() => decodeTreeSpecies(manifest, badIndex), /Invalid tree species topology/);
});

test('failed species decodes dispose earlier geometries instead of leaking them', () => {
  const malformed = structuredClone(manifest);
  delete malformed.trees.maple.near.parts.leaf.attributes.normal;
  const original = THREE.BufferGeometry.prototype.dispose;
  let disposed = 0;
  THREE.BufferGeometry.prototype.dispose = function countedDispose() { disposed++; return original.call(this); };
  try {
    assert.throws(() => decodeTreeSpecies(malformed, buffer), /Invalid tree species buffer/);
    assert.equal(disposed, 6);
  } finally { THREE.BufferGeometry.prototype.dispose = original; }
});
