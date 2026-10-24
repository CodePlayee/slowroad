import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const src = new URL('../src/', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(src) && url.endsWith('.js')) {
      return { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { tileKey, makeTile, childTile, parentTile, partitionIndices, selectCoverage } =
  await import('../src/terrain/coverage.js');

const resident = (...tiles) => new Map(tiles.map((tile) => [tile.key, { tile }]));
const wanted = (...tiles) => new Set(tiles.map((tile) => tile.key));
const children = (tile) => [0, 1, 2, 3].map((q) => childTile(tile, q));

function assertCoverage(selection, residents, expectedArea) {
  const rectangles = [];
  let area = 0;
  for (const [key, mask] of selection) {
    const { tile } = residents.get(key);
    assert.ok(mask > 0 && mask < 16);
    const half = tile.C / 2;
    for (let q = 0; q < 4; q++) {
      if (!(mask & (1 << q))) continue;
      const x0 = tile.x0 + (q & 1) * half, z0 = tile.z0 + (q >> 1) * half;
      rectangles.push({ x0, z0, x1: x0 + half, z1: z0 + half });
      area += half * half;
    }
  }
  assert.equal(area, expectedArea);
  for (let a = 0; a < rectangles.length; a++) {
    for (let b = a + 1; b < rectangles.length; b++) {
      const r = rectangles[a], s = rectangles[b];
      const overlapX = Math.min(r.x1, s.x1) - Math.max(r.x0, s.x0);
      const overlapZ = Math.min(r.z1, s.z1) - Math.max(r.z0, s.z0);
      assert.ok(overlapX <= 0 || overlapZ <= 0, 'selected quadrants overlap in positive area');
    }
  }
}

test('tile coordinates and keys preserve the terrain key convention', () => {
  assert.equal(tileKey(7, 0, -2, 3), 'terr:7:0:-2:3');
  assert.deepEqual(makeTile(7, 0, -2, 3), {
    key: 'terr:7:0:-2:3', l: 0, i: -2, j: 3, x0: -256, z0: 384, C: 128,
  });
  assert.equal(childTile(makeTile(7, 0, 0, 0), 0), null);
});

test('parents and children round-trip across negative coordinates and custom chunk sizes', () => {
  for (const i of [-3, -1, 0, 2]) {
    for (const j of [-3, -1, 0, 2]) {
      const tile = makeTile('seed-v2', 3, i, j, 96);
      for (let q = 0; q < 4; q++) {
        const child = childTile(tile, q);
        assert.deepEqual(parentTile(child), tile);
        assert.equal(child.x0, tile.x0 + (q & 1) * tile.C / 2);
        assert.equal(child.z0, tile.z0 + (q >> 1) * tile.C / 2);
      }
    }
  }
  assert.equal(parentTile(makeTile(1, 0, -1, -3)).i, -1);
  assert.equal(parentTile(makeTile(1, 0, -1, -3)).j, -2);
});

test('a resident coarse tile provides complete coverage while all requested children load', () => {
  const root = makeTile(1, 1, 0, 0), cs = children(root);
  const residents = resident(root);
  const selection = selectCoverage([root], residents, wanted(root, ...cs));
  assert.deepEqual(selection, new Map([[root.key, 15]]));
  assertCoverage(selection, residents, root.C ** 2);
});

test('each ready child replaces only its parent quadrant without waiting for siblings', () => {
  const root = makeTile(1, 1, -1, -1), cs = children(root);
  for (let readyMask = 0; readyMask < 16; readyMask++) {
    const ready = cs.filter((_, q) => readyMask & (1 << q));
    const residents = resident(root, ...ready);
    const selection = selectCoverage([root], residents, wanted(root, ...cs));
    assert.equal(selection.get(root.key) ?? 0, 15 ^ readyMask);
    for (const child of ready) assert.equal(selection.get(child.key), 15);
    assertCoverage(selection, residents, root.C ** 2);
  }
});

test('local replacement continues independently at multiple depths', () => {
  const root = makeTile(1, 2, 0, -1), cs = children(root), gs = children(cs[2]);
  const residents = resident(root, cs[0], cs[2], gs[1], gs[3]);
  const selection = selectCoverage([root], residents, wanted(root, ...cs, ...gs));
  assert.equal(selection.get(root.key), 10);
  assert.equal(selection.get(cs[2].key), 5);
  assert.equal(selection.get(gs[1].key), 15);
  assertCoverage(selection, residents, root.C ** 2);
});

test('an unready intermediate tile cannot remove its ready parent quadrant', () => {
  const root = makeTile(1, 2, 0, 0), child = childTile(root, 1), gs = children(child);
  const residents = resident(root, ...gs);
  const selection = selectCoverage([root], residents, wanted(root, child, ...gs));
  assert.deepEqual(selection, new Map([[root.key, 15]]));
  assertCoverage(selection, residents, root.C ** 2);
});

test('coarsening immediately uses a ready parent instead of unwanted resident children', () => {
  const root = makeTile(1, 1, 0, 0), cs = children(root);
  const residents = resident(root, ...cs);
  const selection = selectCoverage([root], residents, wanted(root));
  assert.deepEqual(selection, new Map([[root.key, 15]]));
  assertCoverage(selection, residents, root.C ** 2);
});

test('coarsening preserves unwanted descendants when their replacement parent is missing', () => {
  const root = makeTile(1, 2, -1, 1), cs = children(root), gs = children(cs[2]);
  const residents = resident(cs[0], cs[1], cs[3], ...gs);
  const selection = selectCoverage([root], residents, wanted(root));
  assert.equal(selection.size, 7);
  for (const mask of selection.values()) assert.equal(mask, 15);
  assertCoverage(selection, residents, root.C ** 2);
});

test('missing parents preserve available partial coverage without inventing missing tiles', () => {
  const root = makeTile(1, 3, 0, 0);
  const leaf = childTile(childTile(childTile(root, 2), 3), 1);
  const residents = resident(leaf);
  const selection = selectCoverage([root], residents, wanted(root));
  assert.deepEqual(selection, new Map([[leaf.key, 15]]));
  assertCoverage(selection, residents, leaf.C ** 2);
});

test('multiple roots remain disjoint, including duplicate and nested root requests', () => {
  const a = makeTile(1, 2, -1, 0), b = makeTile(1, 2, 0, 0), child = childTile(a, 0);
  const residents = resident(a, b, child);
  const selection = selectCoverage([a, b, a, child], residents, wanted(a, b, child));
  assertCoverage(selection, residents, a.C ** 2 + b.C ** 2);
});

test('coverage never borrows descendants from another world generation', () => {
  const root = makeTile(2, 1, 0, 0), stale = makeTile(1, 0, 0, 0);
  assert.equal(selectCoverage([root], resident(stale), wanted(root)).size, 0);
  assert.equal(selectCoverage([], resident(stale), wanted(root)).size, 0);
  assert.equal(selectCoverage([root], new Map(), wanted(root)).size, 0);
});

function gridWithSkirts() {
  const positions = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) positions.push(i - 1, i + j, j - 1);
  const indices = [];
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const a = j * 3 + i, b = a + 1, c = a + 3, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  for (const edge of [[0, 1, 2], [6, 7, 8], [0, 3, 6], [2, 5, 8]]) {
    const first = positions.length / 3;
    for (const vertex of edge) positions.push(positions[vertex * 3], positions[vertex * 3 + 1] - 10, positions[vertex * 3 + 2]);
    for (let i = 0; i < 2; i++) indices.push(edge[i], first + i, edge[i + 1], edge[i + 1], first + i, first + i + 1);
  }
  return { positions: new Float32Array(positions), indices };
}

test('partitioning preserves every triangle, winding, and skirt in contiguous quadrant ranges', () => {
  const mesh = gridWithSkirts();
  for (const Type of [Uint16Array, Uint32Array]) {
    const input = new Type(mesh.indices), original = input.slice();
    const { indices, ranges } = partitionIndices(mesh.positions, input);
    assert.ok(indices instanceof Type);
    assert.notEqual(indices, input);
    assert.deepEqual(input, original);
    const triangles = (array) => Array.from({ length: array.length / 3 }, (_, i) => Array.from(array.slice(i * 3, i * 3 + 3)).join(',')).sort();
    assert.deepEqual(triangles(indices), triangles(input));
    let end = 0;
    for (let q = 0; q < 4; q++) {
      const { start, count } = ranges[q];
      assert.equal(start, end);
      assert.equal(count, 18);
      let skirts = 0;
      for (let k = start; k < start + count; k += 3) {
        let x = 0, z = 0;
        for (let v = 0; v < 3; v++) {
          x += mesh.positions[indices[k + v] * 3];
          z += mesh.positions[indices[k + v] * 3 + 2];
        }
        assert.equal((x >= 0 ? 1 : 0) + (z >= 0 ? 2 : 0), q);
        if (indices[k] >= 9 || indices[k + 1] >= 9 || indices[k + 2] >= 9) skirts++;
      }
      assert.equal(skirts, 4);
      end = start + count;
    }
    assert.equal(end, input.length);
  }
});

test('partitioning assigns exact centroid midlines to positive quadrants and handles empty meshes', () => {
  const positions = new Float32Array([-1, 0, -1, 1, 0, -1, 0, 1, 2]);
  const { indices, ranges } = partitionIndices(positions, new Uint16Array([0, 1, 2]));
  assert.deepEqual(Array.from(indices), [0, 1, 2]);
  assert.deepEqual(ranges, [{ start: 0, count: 0 }, { start: 0, count: 0 }, { start: 0, count: 0 }, { start: 0, count: 3 }]);
  const empty = partitionIndices(new Float32Array(), new Uint32Array());
  assert.equal(empty.indices.length, 0);
  assert.deepEqual(empty.ranges, Array.from({ length: 4 }, () => ({ start: 0, count: 0 })));
  assert.throws(() => partitionIndices(positions, new Uint32Array([0, 1])), RangeError);
});
