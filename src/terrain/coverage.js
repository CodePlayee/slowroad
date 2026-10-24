export function tileKey(version, l, i, j) {
  return `terr:${version}:${l}:${i}:${j}`;
}

export function makeTile(version, l, i, j, chunkSize = 128) {
  const C = chunkSize * 2 ** l;
  return { key: tileKey(version, l, i, j), l, i, j, x0: i * C, z0: j * C, C };
}

export function childTile(parent, q) {
  if (parent.l === 0) return null;
  return makeTile(parent.key.split(':')[1], parent.l - 1,
    parent.i * 2 + (q & 1), parent.j * 2 + (q >> 1), parent.C / 2 ** parent.l);
}

export function parentTile(tile) {
  return makeTile(tile.key.split(':')[1], tile.l + 1,
    Math.floor(tile.i / 2), Math.floor(tile.j / 2), tile.C / 2 ** tile.l);
}

// The regular grid must contain both local midlines, so triangles do not cross
// quadrant boundaries. Skirt triangles retain the quadrant of their outer edge.
export function partitionIndices(positions, indices) {
  if (indices.length % 3 !== 0) throw new RangeError('Triangle indices must be a multiple of three');
  const quadrants = new Uint8Array(indices.length / 3);
  const counts = [0, 0, 0, 0];
  for (let t = 0; t < quadrants.length; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const x = positions[a] + positions[b] + positions[c];
    const z = positions[a + 2] + positions[b + 2] + positions[c + 2];
    const q = (x >= 0 ? 1 : 0) + (z >= 0 ? 2 : 0);
    quadrants[t] = q;
    counts[q] += 3;
  }
  let start = 0;
  const ranges = counts.map((count) => {
    const range = { start, count };
    start += count;
    return range;
  });
  const offsets = ranges.map((range) => range.start);
  const grouped = new indices.constructor(indices.length);
  for (let t = 0; t < quadrants.length; t++) {
    const offset = offsets[quadrants[t]];
    grouped[offset] = indices[t * 3];
    grouped[offset + 1] = indices[t * 3 + 1];
    grouped[offset + 2] = indices[t * 3 + 2];
    offsets[quadrants[t]] += 3;
  }
  return { indices: grouped, ranges };
}

export function selectCoverage(roots, residentMap, wantedSet) {
  const selected = new Map();
  if (!roots.length || !residentMap.size) return selected;
  const maxLevel = Math.max(...roots.map((tile) => tile.l));
  const rootKeys = new Set(roots.map((tile) => tile.key));
  const occupied = new Set();
  for (const { tile } of residentMap.values()) {
    let ancestor = tile;
    while (ancestor.l <= maxLevel) {
      if (occupied.has(ancestor.key)) break;
      occupied.add(ancestor.key);
      ancestor = parentTile(ancestor);
    }
  }

  function visit(tile) {
    if (!occupied.has(tile.key)) return;
    if (!residentMap.has(tile.key)) {
      // During coarsening, old detail remains visible until its parent arrives,
      // even when those descendants are no longer in the desired render set.
      if (tile.l > 0) for (let q = 0; q < 4; q++) visit(childTile(tile, q));
      return;
    }
    let mask = 15;
    if (tile.l > 0) {
      for (let q = 0; q < 4; q++) {
        const child = childTile(tile, q);
        if (!wantedSet.has(child.key) || !residentMap.has(child.key)) continue;
        visit(child);
        mask &= ~(1 << q);
      }
    }
    if (mask) selected.set(tile.key, mask);
  }

  for (const root of roots) {
    let ancestor = root;
    let coveredByRoot = false;
    while (ancestor.l < maxLevel) {
      ancestor = parentTile(ancestor);
      if (rootKeys.has(ancestor.key)) { coveredByRoot = true; break; }
    }
    if (!coveredByRoot) visit(root);
  }
  return selected;
}
