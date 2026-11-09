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
const { ForestField, FOREST_LOD, MIDSTORY, foliageRenderDimensions, projectedPlantHeight } = await import('../src/vegetation/forestField.js');
const { prepareShrubParts, impostorBounds } = await import('../src/vegetation/foliageAssets.js');
const { InstanceCuller } = await import('../src/vegetation/instanceCulling.js');
const { TREE_SPECIES } = await import('../src/vegetation/treeSpecies.js');
const { POPULATION, generatePopulation } = await import('../src/vegetation/population.js');

const manifest = JSON.parse(readFileSync(new URL('../public/models/woodland/manifest.json', import.meta.url), 'utf8'));
const file = readFileSync(new URL('../public/models/woodland/understory.bin', import.meta.url));
const bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);

function decodeGeometry(descriptor) {
  const attribute = value => new THREE.BufferAttribute(new (value.type === 'uint16' ? Uint16Array
    : value.type === 'uint32' ? Uint32Array : Float32Array)(bytes, value.offset, value.count * value.itemSize).slice(), value.itemSize);
  const geometry = new THREE.BufferGeometry();
  for (const [name, value] of Object.entries(descriptor.attributes)) geometry.setAttribute(name, attribute(value));
  geometry.setIndex(attribute(descriptor.index));
  return geometry;
}

function shrubTemplate(growthForm) {
  const source = manifest.templates.find(template => template.growthForm === growthForm);
  const original = { bark: decodeGeometry(source.bark), leaf: decodeGeometry(source.leaf) };
  const parts = prepareShrubParts(original);
  for (const geometry of Object.values(original)) geometry.dispose();
  const name = growthForm === 'fern' ? 'shrub-1' : 'shrub-0';
  const shape = impostorBounds(parts);
  return { name, species: 'oak', kind: 'shrub', growthForm, parts,
    ...(growthForm === 'fern' ? { heightScale: 0.68 } : {}), maps: { bark: null, leaf: null },
    impostor: { shape, texture: new THREE.Texture(), normalTexture: new THREE.Texture() },
    bareImpostor: { shape, texture: new THREE.Texture(), normalTexture: new THREE.Texture() } };
}

function disposeTemplates(templates) {
  const owned = new Set();
  for (const template of templates.values()) {
    for (const geometry of Object.values(template.parts)) owned.add(geometry);
    for (const image of [template.impostor, template.bareImpostor]) {
      if (image?.texture) owned.add(image.texture);
      if (image?.normalTexture) owned.add(image.normalTexture);
    }
  }
  for (const resource of owned) resource.dispose();
}

async function fixture(t) {
  const templates = new Map([['shrub-0', shrubTemplate('woody')], ['shrub-1', shrubTemplate('fern')]]);
  const scene = new THREE.Scene(), calls = [];
  let releases = 0;
  const assets = { templates, dispose() { releases++; disposeTemplates(templates); } };
  const renderer = { async compileAsync(group, camera, target) { calls.push({ group, camera, target, count: group.children.length }); } };
  const field = new ForestField({ scene, register() {} }, renderer, { loadAssets: async () => assets });
  await field.assetPromise;
  assert.equal(field.assetError, null);
  t.after(() => field.dispose());
  return { field, templates, scene, calls, releaseCount: () => releases };
}

const shrub = (id, values = {}) => Object.freeze({ id, kind: 'shrub', variant: 0, x: 7, y: 2, z: -30,
  height: 1.15, width: 1.05, yaw: 0.4, phase: 1.2, rank: 0.1, cover: 0.6, ...values });

test('midstory selection is stable, approximately one third and restricted to known woody shrubs', () => {
  const woody = shrubTemplate('woody'), fern = shrubTemplate('fern');
  try {
    for (const [cover, expected] of [[0, 300], [0.5, 330], [1, 360]]) {
      let selected = 0;
      for (let i = 0; i < 1000; i++) {
        const record = shrub(`selection-${i}`, { rank: (i + 0.5) / 1000, cover });
        const dimensions = foliageRenderDimensions(record, woody);
        selected += dimensions.midstory;
        assert.deepEqual(dimensions, foliageRenderDimensions({ ...record, x: -500, z: 800, phase: 40 }, woody));
      }
      assert.equal(selected, expected);
    }
    assert.equal(foliageRenderDimensions(shrub('edge', { rank: 0.34, cover: 0 }), woody).midstory, false);
    assert.equal(foliageRenderDimensions(shrub('edge', { rank: 0.34, cover: 1 }), woody).midstory, true);
    for (const record of [shrub('missing', { cover: undefined }), shrub('missing-rank', { rank: undefined }),
      shrub('invalid', { rank: NaN }), shrub('negative', { rank: -0.1 })]) {
      assert.deepEqual(foliageRenderDimensions(record, woody), { height: record.height, width: record.width, midstory: false });
    }
    for (const [name, settings] of Object.entries(TREE_SPECIES)) for (const height of settings.heightRange) {
      const record = shrub(`tree-${name}`, { kind: 'tree', species: name, height, width: height * 0.6, rank: 0, cover: 1 });
      const template = { ...woody, kind: 'tree', name, species: name };
      assert.deepEqual(foliageRenderDimensions(record, template), { height, width: record.width, midstory: false });
      assert.equal(foliageRenderDimensions(record, woody).midstory, false, 'a mature tree record cannot be promoted accidentally');
    }
    for (const height of [0.65, 1.15, 1.65]) {
      const record = shrub('fern', { variant: 1, height, rank: 0, cover: 1 });
      assert.deepEqual(foliageRenderDimensions(record, fern), { height: height * 0.68, width: record.width, midstory: false });
    }
  } finally { disposeTemplates(new Map([['woody', woody], ['fern', fern]])); }
});

test('midstory dimensions respond to ecology and retain a yaw-plus-wind radius below ground padding', () => {
  const template = shrubTemplate('woody'), shape = template.impostor.shape;
  try {
    for (const height of [0.65, 1.15, 1.65, 4]) {
      const record = shrub('dimensions', { height, width: Math.min(height, 1.65) * 1.1 });
      const dimensions = foliageRenderDimensions(record, template);
      const dry = foliageRenderDimensions({ ...record, cover: 0, moisture: 0 }, template);
      const wet = foliageRenderDimensions({ ...record, cover: 1, moisture: 1 }, template);
      assert.ok(dry.height < wet.height && dry.width <= wet.width);
      assert.ok(dimensions.height >= dry.height && dimensions.height <= wet.height);
      assert.ok(wet.height <= MIDSTORY.maximumHeight);
      assert.ok(dimensions.width > record.width);
      assert.ok((shape.radius + 0.012 * Math.max(1, shape.top) ** 2) * dimensions.width / shape.width <= MIDSTORY.maximumRadius + 1e-10);
      assert.ok(record.height === height && record.width === Math.min(height, 1.65) * 1.1);
    }
    const leaf = new THREE.BoxGeometry(1, 1, 1).translate(0.45, 0.5, 0.2);
    const skewed = { ...template, parts: { bark: leaf, leaf }, impostor: { ...template.impostor, shape: impostorBounds({ leaf }) } };
    try {
      assert.ok(skewed.impostor.shape.radius > skewed.impostor.shape.width / 2 * 1.5, 'fixture must defeat width/2 radius assumptions');
      const record = shrub('road-edge', { x: 7, y: 0, height: 1.65, width: 2.145 });
      const dimensions = foliageRenderDimensions(record, skewed), shape = skewed.impostor.shape;
      const scale = dimensions.width / shape.width;
      const billboard = new THREE.PlaneGeometry(shape.radius * 2, shape.top - shape.bottom)
        .translate(0, (shape.top + shape.bottom) * 0.5, 0);
      try {
        const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), point = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
        for (let yaw = 0; yaw < Math.PI * 2; yaw += Math.PI / 8) {
          matrix.compose(new THREE.Vector3(record.x, record.y, record.z), rotation.setFromAxisAngle(up, yaw), new THREE.Vector3(scale, dimensions.height, scale));
          for (const source of [leaf, billboard]) for (let view = 0; view < 8; view++) for (const wind of [-1, 1]) {
            const positions = source.getAttribute('position');
            for (let i = 0; i < positions.count; i++) {
              point.fromBufferAttribute(positions, i);
              if (source === billboard) point.applyAxisAngle(up, view * Math.PI / 4);
              point.x += wind * 0.012 * Math.max(point.y, 0) ** 2;
              point.applyMatrix4(matrix);
              assert.ok(Math.hypot(point.x - record.x, point.z - record.z) <= 2.75 + 1e-6);
              assert.ok(point.x >= 4.25 - 1e-6, '7m root clearance must leave space before the 4.08m paved edge');
              assert.ok(Math.abs(point.x - record.x) < 3 && Math.abs(point.z - record.z) < 3);
            }
          }
        }
      } finally { billboard.dispose(); }
    } finally { leaf.dispose(); }
  } finally { disposeTemplates(new Map([['woody', template]])); }
});

test('promoted woody shrubs share actual dimensions across meshes, GPU attributes, bounds and CPU LOD', async t => {
  const { field, templates } = await fixture(t), template = templates.get('shrub-0');
  const record = shrub('promoted'), dimensions = foliageRenderDimensions(record, template), snapshot = structuredClone(record);
  const meshes = field.build([record], 'shrub'), matrix = new THREE.Matrix4(), point = new THREE.Vector3();
  const sourceIndices = Object.fromEntries(Object.entries(template.parts).map(([part, geometry]) => [part, geometry.index.count]));
  assert.equal(meshes.length, 3);
  for (const mesh of meshes) {
    assert.equal(mesh.count, 1);
    assert.equal(mesh.userData.population[0], record);
    assert.equal(mesh.userData.foliageMaximumHeight, dimensions.height);
    assert.ok(Math.abs(mesh.geometry.getAttribute('iFoliage').getX(0) - dimensions.height) < 1e-6);
    mesh.getMatrixAt(0, matrix);
    assert.deepEqual(matrix.elements.slice(12, 15), [record.x, record.y, record.z]);
    assert.ok(Math.abs(new THREE.Vector3().setFromMatrixColumn(matrix, 1).length() - dimensions.height) < 1e-6);
    assert.ok(Math.abs(new THREE.Vector3().setFromMatrixColumn(matrix, 0).length() - dimensions.width / template.impostor.shape.width) < 1e-6);
    mesh.computeBoundingSphere();
    for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
      point.fromBufferAttribute(mesh.geometry.attributes.position, i).applyMatrix4(matrix);
      assert.ok(mesh.boundingSphere.distanceToPoint(point) < 1e-6);
    }
  }
  assert.deepEqual(meshes[0].instanceMatrix.array, meshes[1].instanceMatrix.array);
  assert.deepEqual(meshes[0].instanceMatrix.array, meshes[2].instanceMatrix.array);
  const camera = new THREE.PerspectiveCamera(54), range = FOREST_LOD.shrub;
  for (let frame = 0; frame < 24; frame++) {
    camera.position.set(record.x + frame % 3 * 3, record.y + frame % 5, record.z + 12 + frame * 10);
    camera.fov = 40 + frame % 4 * 10;
    field.update(camera, frame, 'summer', 720 + frame % 3 * 240);
    const pixels = projectedPlantHeight(record, camera, field.pixelScale, template);
    const gpuDistance = Math.hypot(record.x - camera.position.x, record.y + dimensions.height * 0.5 - camera.position.y, record.z - camera.position.z);
    assert.ok(Math.abs(pixels - dimensions.height * field.pixelScale / gpuDistance) < 1e-10);
    for (const mesh of meshes) {
      const far = mesh.userData.foliageLevel === 'far';
      const expected = !(far ? pixels > range.high + 0.01 : pixels < range.low - 0.01)
        && gpuDistance <= range.fadeEnd + 1;
      assert.equal(mesh.userData.instanceVisible(0, camera), expected);
      if (expected) assert.equal(mesh.userData.batchVisible(camera), true, 'batch rejection cannot use the original shorter height');
    }
  }
  assert.deepEqual(record, snapshot);
  assert.deepEqual(Object.fromEntries(Object.entries(template.parts).map(([part, geometry]) => [part, geometry.index.count])), sourceIndices);
});

test('midstory dimensions survive seasonal changes, cooperative building and packed instance restoration', async t => {
  const { field, templates, scene } = await fixture(t);
  const records = [shrub('offscreen', { x: 1000, rank: 0.8 }), shrub('midstory', { x: 0, height: 1.65 }),
    shrub('low-bush', { x: 2, rank: 0.9 }), shrub('fern', { x: 3, variant: 1, rank: 0, cover: 1 })];
  const snapshot = structuredClone(records), meshes = field.build(records, 'shrub');
  const iterator = field.buildSteps(records, 'shrub'); let step;
  do { step = iterator.next(); } while (!step.done);
  step.value.forEach((mesh, i) => {
    assert.deepEqual(mesh.instanceMatrix.array, meshes[i].instanceMatrix.array);
    assert.deepEqual(mesh.geometry.getAttribute('iFoliage').array, meshes[i].geometry.getAttribute('iFoliage').array);
    field.disposeMesh(mesh);
  });
  scene.add(...meshes);
  const originals = meshes.map(mesh => ({ mesh, geometry: mesh.geometry, matrix: mesh.instanceMatrix,
    matrices: mesh.instanceMatrix.array.slice(), foliage: mesh.geometry.getAttribute('iFoliage').array.slice() }));
  const camera = new THREE.PerspectiveCamera(54, 16 / 9); camera.position.set(0, 4, 0);
  const culler = new InstanceCuller();
  for (const season of ['summer', 'autumn', 'winter', 'spring']) {
    field.update(camera, 20, season, 1080);
    culler.prepare(scene, camera);
    for (const mesh of meshes) if (mesh.visible) {
      for (let i = 0; i < mesh.count; i++) {
        const at = i * 16, yScale = Math.hypot(mesh.instanceMatrix.array[at + 4], mesh.instanceMatrix.array[at + 5], mesh.instanceMatrix.array[at + 6]);
        assert.ok(Math.abs(yScale - mesh.geometry.getAttribute('iFoliage').getX(i)) < 1e-6);
        assert.ok(mesh.instanceMatrix.array[at + 12] < 100, 'packed draws contain only selected canonical locations');
      }
    }
    culler.restore();
    for (const original of originals) {
      assert.equal(original.mesh.geometry, original.geometry); assert.equal(original.mesh.instanceMatrix, original.matrix);
      assert.deepEqual(original.matrix.array, original.matrices);
      assert.deepEqual(original.geometry.getAttribute('iFoliage').array, original.foliage);
    }
  }
  assert.deepEqual(records, snapshot);
  const fern = meshes.find(mesh => mesh.name === 'field-shrub-shrub-1-bark');
  assert.ok(Math.abs(fern.geometry.getAttribute('iFoliage').getX(0) - records[3].height * 0.68) < 1e-6);
  assert.equal(foliageRenderDimensions(records[2], templates.get('shrub-0')).height, records[2].height);
  culler.dispose();
});

test('the existing detached shader warmup and late resource ownership need no new templates or programs', async t => {
  const { field, templates, scene, calls, releaseCount } = await fixture(t);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].count, 6);
  assert.equal(calls[0].target, scene);
  assert.equal(calls[0].group.children.length, 0);
  assert.equal(field.meshes.size, 0);
  const keys = [...field.materials.keys()], material = field.materials.get('shrub-0').leaf;
  const meshes = field.build([shrub('promoted'), shrub('ordinary', { rank: 0.9 })], 'shrub');
  assert.equal(meshes.length, 3, 'middle and low woody growth share the same instanced draw groups');
  assert.equal(field.materials.get('shrub-0').leaf, material);
  assert.deepEqual([...field.materials.keys()], keys);
  assert.equal(field.assets.templates, templates);
  field.dispose(); field.dispose();
  assert.equal(releaseCount(), 1);
});

test('seeded populations retain mature trees and ferns while woody promotion leaves records unchanged', () => {
  const woody = shrubTemplate('woody'), fern = shrubTemplate('fern');
  const fixtures = [7, 12, 31].map(seed => ({ name: `seed-${seed}`, seed, x: 0, z: 0 }));
  try {
    for (const fixture of fixtures) {
      const radius = 160, records = [];
      const world = {
        seed: fixture.seed,
        sample(x, z, out) { Object.assign(out, { y: 40, moisture: 0.8, waterY: 0,
          roadDist: Infinity, riverDist: 1000, channelHalf: 10 }); },
        slopeAt(x, z, y, e, out) { out.dx = 0; out.dz = 0; return 0; },
      };
      for (const kind of ['tree', 'shrub']) {
        const C = POPULATION[kind].tile;
        for (let j = Math.floor((fixture.z - radius) / C); j <= Math.floor((fixture.z + radius) / C); j++) {
          for (let i = Math.floor((fixture.x - radius) / C); i <= Math.floor((fixture.x + radius) / C); i++) {
            const iterator = generatePopulation(world, kind, i, j); let step;
            do { step = iterator.next(); } while (!step.done);
            records.push(...step.value.filter(record => Math.hypot(record.x - fixture.x, record.z - fixture.z) <= radius));
          }
        }
      }
      const snapshot = structuredClone(records), results = records.map(record => {
        const template = record.kind === 'tree' ? { kind: 'tree' } : record.variant === 1 ? fern
          : record.variant === 0 ? woody : { kind: 'shrub', growthForm: 'verge' };
        return { record, template, dimensions: foliageRenderDimensions(record, template) };
      });
      const mature = results.filter(result => result.record.kind === 'tree');
      const woodyRecords = results.filter(result => result.template === woody), promoted = woodyRecords.filter(result => result.dimensions.midstory);
      const ferns = results.filter(result => result.template === fern);
      assert.ok(mature.length > 0 && woodyRecords.length > 0 && ferns.length > 0, fixture.name);
      assert.ok(promoted.every(result => result.dimensions.height > 0 && result.dimensions.height <= MIDSTORY.maximumHeight));
      for (const result of mature) assert.deepEqual(result.dimensions, { height: result.record.height, width: result.record.width, midstory: false });
      for (const result of ferns) assert.deepEqual(result.dimensions, { height: result.record.height * 0.68, width: result.record.width, midstory: false });
      assert.deepEqual(records, snapshot);
    }
  } finally { disposeTemplates(new Map([['woody', woody], ['fern', fern]])); }
});
