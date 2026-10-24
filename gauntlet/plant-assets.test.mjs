import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const src = new URL('../src/', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(src) && url.endsWith('.js')) {
      return { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { prepareFlowerPair, flowerMaterials } = await import('../src/vegetation/flower.js');
// EZ-Tree's optional texture catalog is imported by the vegetation module. The
// geometry tests do not need image decoding, so provide the tiny ImageLoader
// surface that Three uses when Node has no DOM.
if (!globalThis.document) {
  globalThis.document = { createElementNS: () => ({
    addEventListener() {}, removeEventListener() {}, setAttribute() {},
  }) };
}
const { buildConifer, Vegetation } = await import('../src/vegetation/vegetation.js');
const { createEzTreeTemplates } = await import('../src/vegetation/ezTree.js');
const { buildCurveBladeGeometry, curveGrassMaterial } = await import('../src/vegetation/curveGrass.js');
const { VEG: V, SEASON_HOOKS } = await import('../src/vegetation/params.js');

const flowerData = readFileSync(new URL('../public/models/flower-nature.glb', import.meta.url));
const gltf = await new GLTFLoader().parseAsync(flowerData.buffer.slice(flowerData.byteOffset, flowerData.byteOffset + flowerData.byteLength), '');

test('flower parts retain their shared frame under an authored root translation', () => {
  const original = prepareFlowerPair(gltf);
  gltf.scene.position.set(2, 5, -3);
  const translated = prepareFlowerPair(gltf);
  for (const part of ['stem', 'blossom']) {
    const a = original[part].getAttribute('position').array;
    const b = translated[part].getAttribute('position').array;
    for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 2e-5, `${part} vertex ${i} shifted`);
    assert.ok(translated[part].getAttribute('normal'));
    assert.ok(Number.isFinite(translated[part].boundingSphere.radius));
  }
  assert.ok(Math.abs(translated.stem.boundingBox.min.y) < 1e-6);
  assert.ok(Math.abs(Math.max(translated.stem.boundingBox.max.y, translated.blossom.boundingBox.max.y) - 1) < 1e-6);
});

test('flower materials preserve instance tints and the blossom template center colors', () => {
  for (const [name, material] of Object.entries(flowerMaterials())) {
    assert.equal(material.vertexColors, name === 'flowerBlossom');
    assert.equal(material.color.getHex(), 0xffffff);
    material.dispose();
  }
});

test('wildflower templates have three small folded heads, raised centers and a bounded triangle budget', () => {
  const pair = prepareFlowerPair(gltf), blossom = pair.blossom;
  try {
    const heads = blossom.userData.flowerHeads;
    assert.equal(heads.length, 3);
    assert.equal(new Set(heads.map(head => head.center[1])).size, 3);
    assert.ok(heads.every(head => head.radius > 0.04 && head.radius < 0.10));
    assert.ok(blossom.boundingBox.max.x - blossom.boundingBox.min.x < 0.45);
    assert.ok(pair.stem.boundingBox.max.x - pair.stem.boundingBox.min.x < 0.30);
    assert.ok((pair.stem.index.count + blossom.index.count) / 3 <= 650);
    const position = blossom.getAttribute('position'), color = blossom.getAttribute('color'), normal = blossom.getAttribute('normal');
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < blossom.index.count; i += 3) {
      a.fromBufferAttribute(position, blossom.index.getX(i));
      b.fromBufferAttribute(position, blossom.index.getX(i + 1));
      c.fromBufferAttribute(position, blossom.index.getX(i + 2));
      assert.ok(b.sub(a).cross(c.sub(a)).lengthSq() > 1e-16, `degenerate blossom triangle ${i / 3}`);
    }
    assert.ok([...normal.array].every(Number.isFinite));
    assert.ok(Array.from({ length: normal.count }, (_, i) => normal.getY(i)).some(y => y < -0.6), 'petals retain a real underside');
    const firstPetalHeights = Array.from({ length: 60 }, (_, i) => position.getY(i));
    assert.ok(Math.max(...firstPetalHeights) - Math.min(...firstPetalHeights) > 0.01, 'folds must not collapse to a horizontal polygon');
    for (const head of heads) {
      const center = new THREE.Vector3(...head.center);
      const centerVertices = [];
      for (let i = 0; i < position.count; i++) if (color.getZ(i) < 0.1 && a.fromBufferAttribute(position, i).distanceTo(center) < head.radius * 0.4) {
        centerVertices.push(position.getY(i));
      }
      assert.ok(centerVertices.length >= 24, 'each small flower keeps its own golden center');
      assert.ok(Math.max(...centerVertices) - Math.min(...centerVertices) > 0.01, 'centers are domed, not another flat disc');
    }
  } finally { pair.stem.dispose(); pair.blossom.dispose(); }
});

test('conifer sprays have vertical area without increasing the geometry budget', () => {
  const uv = { bark: [0, 0, 0.1, 0.1], needleFir: [0.1, 0.1, 0.2, 0.2], treeFir: [0.3, 0.3, 0.4, 0.4] };
  const layout = {
    trunkR: 0.03, trunkTop: 1, needle: 'needleFir',
    spines: [{ y0: 0.1, y1: 1, w0: 0.24, w1: 0.01, a: 0, sh: [0.5, 1] }],
    plates: [{ y: 0.5, r: 0.2, yaw: 0, tilt: 0, sh: 1 }],
  };
  const geometry = buildConifer(layout, uv, SEASON_HOOKS.summer);
  const pos = geometry.getAttribute('position');
  assert.equal(geometry.index.count / 3, 16);
  const last = pos.count - 4;
  assert.ok(pos.getY(last + 2) - pos.getY(last) > 0.2);
  const core = pos.count - 8;
  assert.ok(Math.abs(geometry.getAttribute('uv').getX(core) - uv.treeFir[0]) < 1e-6);
});

test('EZ-Tree templates are grounded and stay within the streamed tree budget', () => {
  for (const level of ['near', 'mid']) {
    const templates = createEzTreeTemplates(level);
    assert.deepEqual(templates.map(t => t.name), ['pine', 'deciduous', 'aspen']);
    for (const t of templates) {
      assert.ok(t.branchTriangles > 0 && t.leafTriangles > 0);
      assert.ok(t.branchTriangles < 1000 && t.leafTriangles < 1000, `${level}/${t.name}: ${t.branchTriangles}/${t.leafTriangles}`);
      assert.ok(Math.abs(t.branches.boundingBox.min.y) < 1e-5);
      assert.ok(t.leaves.boundingBox.min.y >= -1e-5);
      assert.ok(Number.isFinite(t.height) && t.height > 1);
      assert.ok(t.branchMaterial && t.leafMaterial);
    }
  }
});

test('curve grass has crossed tapered ribbons and a dedicated non-card material', () => {
  const g = buildCurveBladeGeometry(5);
  assert.equal(g.getAttribute('bladePlane').count, 36);
  assert.equal(g.index.count / 3, 30);
  assert.ok(g.boundingSphere.radius > 0.5);
  const m = curveGrassMaterial();
  assert.equal(m.defines.CURVE_GRASS, '');
  assert.equal(m.alphaTest, 0);
  assert.notEqual(m.customProgramCacheKey(), 'veg-card-grass');
});

// Exercise tile instancing without a DOM, renderer, or terrain sampling work.
function tile(layer, amount) {
  const group = new THREE.Group();
  const veg = Object.create(Vegetation.prototype);
  const geometry = new THREE.PlaneGeometry(1, 1);
  Object.assign(veg, {
    group, seed: 7, tiles: new Map(),
    world: {
      hf: {},
      sample(x, z, out) { Object.assign(out, { y: 0, waterY: -10, moisture: 0.7, roadDist: 30 }); },
      slopeAt(x, z, y, e, out) { out.dx = out.dz = 0; return 0; },
    },
    atmo: { palette: { grassDry: [0.2, 0.3, 0.1], grassLush: [0.3, 0.4, 0.2], foliage: [[0.2, 0.3, 0.1]] } },
    cover: () => 0.1, gust: () => 0, grassDensity: () => 1, shrubDensity: () => 1,
    flower: prepareFlowerPair(gltf), mat: { ...flowerMaterials(), grass: new THREE.MeshStandardMaterial(), card: new THREE.MeshStandardMaterial() },
    geo: Object.fromEntries(['grassNear', 'grassFar', 'bush', 'bushDry', 'fern', 'tussock', 'plume'].map(k => [k, geometry])),
    grassTex: { uv: Object.fromEntries(['tall', 'fine', 'dry', 'mass'].map(k => [k, [0, 0, 1, 1]])) },
  });
  V.season.flowerAmount = amount;
  veg._buildTile({ key: 'test', layer, i: 0, j: 0 });
  return group.children;
}

test('flowers do not reroll grass and add at most two close-tile batches; absent in winter/far/shrub', () => {
  const old = V.season.flowerAmount;
  try {
    const withFlowers = tile('grassNear', 1.35);
    const winter = tile('grassNear', 0);
    assert.equal(withFlowers.length, 3);
    assert.equal(winter.length, 1);
    assert.deepEqual(withFlowers[0].instanceMatrix.array, winter[0].instanceMatrix.array);
    assert.deepEqual(withFlowers[1].instanceMatrix.array, withFlowers[2].instanceMatrix.array);
    assert.ok(withFlowers[1].count < 70);
    assert.equal(tile('grassFar', 1.35).length, 1);
    assert.equal(tile('shrub', 1.35).filter(m => m.instanceColor !== null).length, 0);
  } finally { V.season.flowerAmount = old; }
});
