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
const { prepareShrubParts, createRootedBark, impostorBounds } = await import('../src/vegetation/foliageAssets.js');
const { decodeWoodland } = await import('../src/vegetation/woodland.js');
const { decodeTreeSpecies } = await import('../src/vegetation/treeSpeciesAssets.js');
function sourceTrees(file, decode) {
  const manifest = JSON.parse(readFileSync(new URL(`../public/models/woodland/${file}`, import.meta.url)));
  const bytes = readFileSync(new URL(`../public/models/woodland/${manifest.buffer}`, import.meta.url));
  return decode(manifest, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

test('shrub normalization retains the woody root and permits below-ground leaf-card corners', () => {
  const source = { bark: new THREE.BoxGeometry(0.1, 1, 0.1).translate(0, 0.7, 0),
    leaf: new THREE.BoxGeometry(1, 1.5, 1).translate(0, 0.7, 0) };
  const before = Object.fromEntries(Object.entries(source).map(([part, geometry]) => [part, geometry.attributes.position.array.slice()]));
  const parts = prepareShrubParts(source);
  try {
    assert.ok(Math.abs(parts.bark.boundingBox.min.y) < 1e-6);
    assert.ok(parts.leaf.boundingBox.min.y < -0.1);
    assert.ok(Math.abs(parts.leaf.boundingBox.max.y - 1) < 1e-6);
    assert.ok(Math.abs(parts.bark.boundingBox.getCenter(new THREE.Vector3()).x) < 1e-7);
    for (const part of ['bark', 'leaf']) {
      assert.deepEqual(source[part].attributes.position.array, before[part]);
      assert.notEqual(parts[part].attributes.position, source[part].attributes.position);
    }
    const bounds = impostorBounds(parts);
    assert.ok(bounds.bottom < parts.leaf.boundingBox.min.y);
    assert.ok(bounds.top > 1);
  } finally {
    for (const geometry of [...Object.values(source), ...Object.values(parts)]) geometry.dispose();
  }
});

test('six tree species gain small grounded roots without moving any original vertex or raising the trunk', () => {
  const trees = { ...sourceTrees('trees.manifest.json', decodeWoodland), ...sourceTrees('species.manifest.json', decodeTreeSpecies) };
  try {
    assert.equal(Object.keys(trees).length, 6);
    for (const [variant, [species, levels]] of Object.entries(trees).entries()) {
      const source = levels.near.bark, original = source.attributes.position.array.slice();
      const rooted = createRootedBark(source, variant), again = createRootedBark(source, variant);
      try {
        const info = rooted.userData.rootFlare, position = rooted.attributes.position;
        assert.ok(info.radius > 0.009 && info.radius < 0.023, species);
        assert.equal(info.addedTriangles, 66);
        assert.equal(rooted.index.count, source.index.count + 66 * 3);
        assert.deepEqual(position.array.subarray(0, original.length), original);
        assert.deepEqual(source.attributes.position.array, original);
        assert.deepEqual(position.array, again.attributes.position.array);
        assert.equal(rooted.boundingBox.min.y, 0);
        assert.equal(rooted.boundingBox.max.y, source.boundingBox.max.y);
        let extended = 0, grounded = 0;
        for (let i = info.sourceVertices; i < position.count; i++) {
          const radius = Math.hypot(position.getX(i), position.getZ(i));
          assert.ok(radius <= info.radius * 2 + 1e-7);
          assert.ok(position.getY(i) >= 0 && position.getY(i) <= info.radius * 1.5 + 1e-7);
          if (radius > info.radius * 1.6) extended++;
          if (position.getY(i) === 0) grounded++;
        }
        assert.ok(extended >= 5 && grounded >= 20, species);
        for (const attribute of Object.values(rooted.attributes)) assert.ok(attribute.array.every(Number.isFinite));
        const shape = impostorBounds({ bark: rooted, leaf: levels.near.leaf });
        assert.ok(shape.radius >= info.radius * 2, 'impostor framing must include the same prepared roots');
      } finally { rooted.dispose(); again.dispose(); }
    }
  } finally {
    for (const levels of Object.values(trees)) for (const parts of Object.values(levels)) for (const geometry of Object.values(parts)) geometry.dispose();
  }
});
