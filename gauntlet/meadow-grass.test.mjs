import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import test from 'node:test';

const src = new URL('../src/', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(src) && url.endsWith('.js')) {
      return { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
    }
    return nextLoad(url, context, nextLoad);
  },
});

const { buildMeadowGeometry, meadowGrassMaterial } = await import('../src/vegetation/meadowGrass.js');

function finiteGeometry(geometry) {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  assert.ok(position && normal && geometry.index);
  for (let i = 0; i < position.count; i++) {
    for (let axis = 0; axis < 3; axis++) assert.ok(Number.isFinite(position.getComponent(i, axis)));
    const nx = normal.getX(i), ny = normal.getY(i), nz = normal.getZ(i);
    assert.ok(Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz));
    assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 2e-5, `normal ${i} is not normalized`);
  }
  assert.ok(Number.isFinite(geometry.boundingSphere.radius) && geometry.boundingSphere.radius > 0);
  for (const vector of [geometry.boundingBox.min, geometry.boundingBox.max]) {
    for (const value of vector.toArray()) assert.ok(Number.isFinite(value));
  }
  const index = geometry.index.array;
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i], b = index[i + 1], c = index[i + 2];
    const ax = position.getX(a), ay = position.getY(a), az = position.getZ(a);
    const abx = position.getX(b) - ax, aby = position.getY(b) - ay, abz = position.getZ(b) - az;
    const acx = position.getX(c) - ax, acy = position.getY(c) - ay, acz = position.getZ(c) - az;
    const cx = aby * acz - abz * acy, cy = abz * acx - abx * acz, cz = abx * acy - aby * acx;
    assert.ok(Math.hypot(cx, cy, cz) * 0.5 > 1e-12, `triangle ${i / 3} is degenerate`);
  }
}

test('folded meadow templates are grounded, curved, and non-degenerate', () => {
  const near = buildMeadowGeometry(22);
  const far = buildMeadowGeometry(14);
  for (const [geometry, blades] of [[near, 22], [far, 14]]) {
    assert.equal(geometry.getAttribute('position').count, blades * 10);
    assert.equal(geometry.getAttribute('color').count, blades * 10);
    assert.equal(geometry.index.count, blades * 30);
    finiteGeometry(geometry);
    const p = geometry.getAttribute('position');
    for (let blade = 0; blade < blades; blade++) {
      const base = blade * 10;
      assert.ok(Math.abs(p.getY(base)) < 1e-7 && Math.abs(p.getY(base + 1)) < 1e-7 && Math.abs(p.getY(base + 2)) < 1e-7,
        `blade ${blade} is not rooted at y=0`);
      // The centre ridge bends in xz as it rises, rather than repeating a flat card.
      const x0 = p.getX(base + 1), z0 = p.getZ(base + 1);
      const x1 = p.getX(base + 4), z1 = p.getZ(base + 4);
      const x2 = p.getX(base + 7), z2 = p.getZ(base + 7);
      assert.ok(Math.hypot(x1 - x0, z1 - z0) > 1e-4 || Math.hypot(x2 - x1, z2 - z1) > 1e-4,
        `blade ${blade} has no bend`);
      // At the middle row the ridge is offset from the two side vertices.
      const my = (p.getY(base + 3) + p.getY(base + 5)) * 0.5;
      assert.ok(Math.abs(p.getY(base + 4) - my) > 1e-5,
        `blade ${blade} has no folded cross-section`);
    }
  }
});

test('far 14-blade template is the deterministic prefix of near 22-blade template', () => {
  const far = buildMeadowGeometry(14);
  const near = buildMeadowGeometry(22);
  for (const name of ['position', 'color', 'normal']) {
    const a = far.getAttribute(name).array;
    assert.deepEqual(Array.from(a), Array.from(near.getAttribute(name).array.slice(0, a.length)), `${name} prefix changed`);
  }
  assert.deepEqual(Array.from(far.index.array), Array.from(near.index.array.slice(0, far.index.array.length)));
});

test('near and far materials have independent distance fades and no alpha texture', () => {
  const near = meadowGrassMaterial(false);
  const far = meadowGrassMaterial(true);
  assert.notStrictEqual(near, far);
  assert.equal(near.customProgramCacheKey(), far.customProgramCacheKey());
  assert.equal(near.alphaMap, null);
  assert.equal(far.alphaMap, null);
  assert.deepEqual(near.userData.uniforms.uBand.value.toArray(), [0, 85]);
  assert.deepEqual(far.userData.uniforms.uBand.value.toArray(), [1, 285]);
  assert.notStrictEqual(near.userData.uniforms.uBand.value, far.userData.uniforms.uBand.value);
});
