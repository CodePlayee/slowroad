import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as THREE from 'three';

const src = new URL('../src/', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(src) && url.endsWith('.js')) {
      return { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
if (!globalThis.document) globalThis.document = { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {} }) };

const { loadUnderstory, groundUnderstory } = await import('../src/vegetation/understory.js');
THREE.TextureLoader.prototype.loadAsync = async function (url) {
  const texture = new THREE.Texture();
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.userData.sourceUrl = url;
  texture.needsUpdate = true;
  return texture;
};
const assetRoot = join(process.cwd(), 'public/models/woodland');
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const file = String(url).endsWith('understory.bin') ? 'understory.bin' : 'manifest.json';
  return new Response(readFileSync(join(assetRoot, file)), { status: 200 });
};

test('understory templates retain branch hierarchy, scale, and grounded roots', async () => {
  const loaded = await loadUnderstory();
  try {
    assert.deepEqual(loaded.templates.map(t => t.name), ['bush-1', 'bracken-1']);
    assert.deepEqual(loaded.templates.map(t => t.growthForm), ['woody', 'fern']);
    for (const template of loaded.templates) {
      const fern = template.growthForm === 'fern';
      assert.ok(template.barkTriangles > 0 && template.leafTriangles > 0);
      assert.ok(template.barkTriangles + template.leafTriangles >= (fern ? 300 : 1000));
      assert.ok(template.barkTriangles + template.leafTriangles <= (fern ? 800 : 4000));
      assert.ok(Math.abs(template.bark.boundingBox.min.y) < 1e-6);
      if (!fern) {
        assert.ok(template.leaf.boundingBox.min.y > -0.4 && template.leaf.boundingBox.min.y < 0);
        assert.equal(template.bounds.min.y, template.leaf.boundingBox.min.y);
      }
      assert.ok(Math.abs(template.bounds.max.y - 1.5) < 1e-4);
      const size = template.bounds.getSize(new THREE.Vector3());
      assert.ok(Math.max(size.x, size.z) > 1.8 && Math.max(size.x, size.z) < 2.2);
      assert.ok(template.bark.getAttribute('normal'));
      assert.ok(template.leaf.getAttribute('uv'));
      if (fern) continue;
      const leaves = template.leaf.getAttribute('position');
      const heights = Array.from({ length: leaves.count }, (_, i) => leaves.getY(i)).sort((a, b) => a - b);
      assert.ok(heights[Math.floor(heights.length * 0.1)] < 0.2, 'foliage must approach the ground instead of forming an elevated ball');
      assert.ok(heights.filter(y => y < 0.3).length > heights.length * 0.25);
      const wood = template.bark.getAttribute('position'), lowBranches = new Set();
      for (let i = 0; i < wood.count; i++) if (wood.getY(i) > 0.03 && wood.getY(i) < 0.3 && Math.hypot(wood.getX(i), wood.getZ(i)) > 0.08) {
        lowBranches.add(Math.floor((Math.atan2(wood.getZ(i), wood.getX(i)) + Math.PI) / (Math.PI / 4)) % 8);
      }
      assert.ok(lowBranches.size >= 4, 'several low woody stems must support the broad shrub');
    }
  } finally {
    loaded.dispose();
  }
});

test('adding the fern does not rebake different vertices into the first bush slot', () => {
  const manifest = JSON.parse(readFileSync(join(assetRoot, 'manifest.json'))), bytes = readFileSync(join(assetRoot, 'understory.bin'));
  for (const [part, hash] of [['bark', '1cde2863e33b2f92bb955224149233c0d862a20b9befbe9584b3ebb2b3f05922'],
    ['leaf', 'd22bd306b6eb0a729972da71af694a56e6db9dc92e54a6b2fcdd40d44ec84421']]) {
    const descriptor = manifest.templates[0][part].attributes.position;
    assert.equal(createHash('sha256').update(bytes.subarray(descriptor.offset,
      descriptor.offset + descriptor.count * descriptor.itemSize * 4)).digest('hex'), hash);
  }
});

test('fern geometry has seven grounded arching rachises and folded pointed leaflets rather than cards', async () => {
  const loaded = await loadUnderstory();
  try {
    const fern = loaded.templates[1], stems = fern.bark.getAttribute('position'), leaves = fern.leaf.getAttribute('position');
    assert.equal(fern.barkTriangles + fern.leafTriangles, 672);
    assert.equal(stems.count, 7 * 24);
    assert.equal(leaves.count, 7 * 13 * 5);
    for (let frond = 0; frond < 7; frond++) {
      const heights = Array.from({ length: 24 }, (_, i) => stems.getY(frond * 24 + i));
      assert.ok(Math.min(...heights) < 0.001);
      assert.ok(heights.slice(-3).every(y => y < Math.max(...heights) * 0.55), 'frond ends must visibly droop after the arch');
    }
    const root = new THREE.Vector3(), side = new THREE.Vector3(), tip = new THREE.Vector3(), ridge = new THREE.Vector3();
    for (let i = 0; i < leaves.count; i += 5) {
      root.fromBufferAttribute(leaves, i); side.fromBufferAttribute(leaves, i + 1);
      tip.fromBufferAttribute(leaves, i + 2); ridge.fromBufferAttribute(leaves, i + 4);
      const normal = side.sub(root).cross(tip.sub(root)).normalize();
      assert.ok(Math.abs(normal.dot(ridge.sub(root))) > 1e-5, 'each leaflet has a real central fold');
    }
    for (const geometry of [fern.bark, fern.leaf]) {
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = geometry.attributes.position;
      for (let i = 0; i < geometry.index.count; i += 3) {
        a.fromBufferAttribute(p, geometry.index.getX(i)); b.fromBufferAttribute(p, geometry.index.getX(i + 1)); c.fromBufferAttribute(p, geometry.index.getX(i + 2));
        assert.ok(b.sub(a).cross(c.sub(a)).lengthSq() > 1e-16);
      }
      for (const attribute of Object.values(geometry.attributes)) assert.ok(attribute.array.every(Number.isFinite));
    }
  } finally { loaded.dispose(); }
});

test('wood rather than transparent leaf corners defines the understory root', () => {
  const bark = new THREE.BoxGeometry(0.1, 1, 0.1).translate(0, 0.7, 0);
  const leaf = new THREE.BoxGeometry(0.8, 1.5, 0.8).translate(0, 0.7, 0);
  try {
    const bounds = groundUnderstory(bark, leaf);
    assert.ok(Math.abs(bark.boundingBox.min.y) < 1e-6);
    assert.ok(leaf.boundingBox.min.y < -0.2);
    assert.equal(bounds.min.y, leaf.boundingBox.min.y);
    assert.ok(Math.abs(bark.boundingBox.max.y - 1) < 1e-6);
  } finally { bark.dispose(); leaf.dispose(); }
});

test('understory materials are opaque white and support standard instance colors', async () => {
  const loaded = await loadUnderstory();
  try {
    for (const material of Object.values(loaded.materials)) {
      assert.equal(material.color.getHex(), 0xffffff);
      assert.equal(material.vertexColors, false);
      assert.equal(material.transparent, false);
      assert.equal(material.depthWrite, true);
    }
    const mesh = new THREE.InstancedMesh(loaded.templates[0].leaf, loaded.materials.leaf, 1);
    mesh.setColorAt(0, new THREE.Color(0.2, 0.8, 0.3));
    assert.ok(mesh.instanceColor);
    mesh.dispose?.();
  } finally {
    loaded.dispose();
  }
});

test('understory dispose releases geometry and material resources idempotently', async () => {
  const loaded = await loadUnderstory();
  const resources = [...loaded.templates.flatMap(t => [t.bark, t.leaf]), ...Object.values(loaded.materials)];
  let disposed = 0;
  for (const resource of resources) resource.addEventListener('dispose', () => disposed++);
  loaded.dispose();
  loaded.dispose();
  assert.equal(disposed, resources.length);
});

test('understory load failure disposes resources acquired before the failure', async () => {
  const original = THREE.TextureLoader.prototype.loadAsync;
  let firstTexture;
  let calls = 0;
  THREE.TextureLoader.prototype.loadAsync = async function () {
    calls++;
    if (calls === 1) {
      firstTexture = new THREE.Texture();
      firstTexture.addEventListener('dispose', () => disposed++);
      firstTexture.needsUpdate = true;
      return firstTexture;
    }
    throw new Error('synthetic texture failure');
  };
  let disposed = 0;
  firstTexture = null;
  try {
    await assert.rejects(loadUnderstory, /synthetic texture failure/);
    assert.equal(disposed, 1);
  } finally {
    THREE.TextureLoader.prototype.loadAsync = original;
  }
});

test('understory baked-asset failure disposes textures acquired before the request', async () => {
  const originalFetchForFailure = globalThis.fetch;
  const originalLoader = THREE.TextureLoader.prototype.loadAsync;
  let disposed = 0;
  THREE.TextureLoader.prototype.loadAsync = async function (url) {
    const texture = new THREE.Texture();
    texture.addEventListener('dispose', () => disposed++);
    texture.userData.sourceUrl = url;
    return texture;
  };
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('understory.bin')) throw new Error('synthetic baked asset failure');
    return originalFetchForFailure(url);
  };
  try {
    await assert.rejects(loadUnderstory, /synthetic baked asset failure/);
    assert.equal(disposed, 2);
  } finally {
    globalThis.fetch = originalFetchForFailure;
    THREE.TextureLoader.prototype.loadAsync = originalLoader;
  }
});

test('partially decoded understory failures release completed and failing geometries exactly once', async (t) => {
  const previousFetch = globalThis.fetch, dispose = THREE.BufferGeometry.prototype.dispose;
  const disposed = new Map();
  t.mock.method(THREE.BufferGeometry.prototype, 'dispose', function() {
    disposed.set(this, (disposed.get(this) || 0) + 1); return dispose.call(this);
  });
  globalThis.fetch = async url => {
    if (!String(url).endsWith('manifest.json')) return previousFetch(url);
    const manifest = JSON.parse(readFileSync(join(assetRoot, 'manifest.json')));
    manifest.templates[1].leaf.attributes.position.offset = manifest.byteLength + 4;
    return new Response(JSON.stringify(manifest), { status: 200 });
  };
  try {
    await assert.rejects(loadUnderstory, /length|offset|bounds|buffer/i);
    assert.equal(disposed.size, 4);
    assert.ok([...disposed.values()].every(count => count === 1));
  } finally { globalThis.fetch = previousFetch; }
});

test.after(() => { globalThis.fetch = originalFetch; });
