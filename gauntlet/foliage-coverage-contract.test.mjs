import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true }
    : next(url, context);
} });
const { foliageCoverageContract } = await import('./foliage-coverage-contract.mjs');
const manifest = JSON.parse(readFileSync(new URL('../public/models/woodland/manifest.json', import.meta.url)));
const source = readFileSync(new URL('../public/models/woodland/understory.bin', import.meta.url));
const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
const fern = manifest.templates.find(template => template.growthForm === 'fern');

function geometry(descriptor) {
  const attribute = value => ({ count: value.count, itemSize: value.itemSize,
    array: new (value.type === 'uint16' ? Uint16Array : value.type === 'uint32' ? Uint32Array : Float32Array)(
      buffer, value.offset, value.count * value.itemSize).slice() });
  const attributes = Object.fromEntries(Object.entries(descriptor.attributes).map(([name, value]) => [name, attribute(value)]));
  return { getAttribute(name) { return attributes[name]; }, index: descriptor.index ? attribute(descriptor.index) : null };
}

const texture = name => ({ name, isDataTexture: true, generateMipmaps: false, anisotropy: 4, colorSpace: 'srgb',
  image: { width: 4, height: 4 }, mipmaps: [{ width: 4, height: 4 }, { width: 2, height: 2 }, { width: 1, height: 1 }] });
const atlas = (name, bare = false) => ({ texture: texture(`${name}-${bare ? 'bare-' : ''}same-source-impostor`), views: 8, columns: 4, rows: 2 });
function fixture() {
  return ['pine', 'oak', 'birch', 'aspen', 'maple', 'spruce', 'shrub-0', 'shrub-1'].map((name, index) => ({
    name, species: index < 6 ? name : 'oak', kind: index < 6 ? 'tree' : 'shrub',
    maps: { leaf: index === 7 ? null : texture(`${name}-leaf`) }, impostor: atlas(name),
    ...(!['pine', 'spruce'].includes(name) ? { bareImpostor: atlas(name, true) } : {}),
    ...(index === 7 ? { growthForm: 'fern', tints: { leaf: [0.15, 0.30, 0.055] },
      parts: { bark: geometry(fern.bark), leaf: geometry(fern.leaf) } } : {}),
  }));
}

test('real fern geometry may omit a leaf map while the other seven retain coverage textures', () => {
  const result = foliageCoverageContract(fixture());
  assert.equal(result.ok, true);
  assert.equal(result.texturedLeaves, 7);
  assert.equal(result.ferns, 1);
  assert.deepEqual(result.issues, []);
});

test('missing or invalid non-fern leaf textures never receive the fern exception', () => {
  for (let i = 0; i < 7; i++) {
    const templates = fixture(); templates[i].maps.leaf = null;
    const result = foliageCoverageContract(templates);
    assert.equal(result.ok, false); assert.equal(result.mips, false);
    assert.ok(result.issues.some(issue => issue.includes(`${templates[i].name}.leaf`)));
  }
  const templates = fixture(); templates[0].maps.leaf.generateMipmaps = true;
  assert.equal(foliageCoverageContract(templates).ok, false);
});

test('every impostor and required bare atlas retains the strict mip and same-source contract', () => {
  for (let i = 0; i < 8; i++) {
    const templates = fixture(); templates[i].impostor = null;
    assert.equal(foliageCoverageContract(templates).ok, false);
  }
  for (const i of [1, 2, 3, 4, 6, 7]) {
    const missing = fixture(); delete missing[i].bareImpostor;
    assert.equal(foliageCoverageContract(missing).ok, false);
    const invalid = fixture(); invalid[i].bareImpostor.texture.mipmaps = [{ width: 1, height: 1 }];
    assert.equal(foliageCoverageContract(invalid).mips, false);
  }
  const named = fixture(); named[7].impostor.texture.name = 'unrelated-atlas';
  assert.equal(foliageCoverageContract(named).sourceNames, false);
});

test('a fern tag cannot hide absent or degenerate geometry, invalid color, or a malformed texture', () => {
  const missing = fixture(); delete missing[7].parts.leaf;
  assert.equal(foliageCoverageContract(missing).fernGeometry, false);
  const degenerate = fixture(); degenerate[7].parts.leaf.getAttribute('position').array.fill(0);
  assert.equal(foliageCoverageContract(degenerate).ok, false);
  const black = fixture(); black[7].tints.leaf = [0, 0, 0];
  assert.equal(foliageCoverageContract(black).fernColor, false);
  const wrongKind = fixture(); wrongKind[7].kind = 'tree';
  assert.equal(foliageCoverageContract(wrongKind).ok, false);
  const invalidMap = fixture(); invalidMap[7].maps.leaf = texture('fern-leaf'); invalidMap[7].maps.leaf.anisotropy = 1;
  assert.equal(foliageCoverageContract(invalidMap).ok, false);
});
