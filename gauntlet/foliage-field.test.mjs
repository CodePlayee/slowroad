import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import * as THREE from 'three';

const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith(src) && url.endsWith('.js')) return { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
  return nextLoad(url, context, nextLoad);
} });
const { alphaCoverage, buildCoverageMips, buildAtlasCoverageMips, createCoverageTexture, unpremultiplyResolvedPixels,
  buildNormalMips, createNormalTexture } = await import('../src/vegetation/coverageMips.js');
const { IMPOSTOR, impostorBounds, withRendererState } = await import('../src/vegetation/foliageAssets.js');
const { ForestField, FOREST_LOD, foliageCoverage, foliageTemplateKey, projectedPlantHeight, foliageRidgeOffset,
  makeFoliageMaterial } = await import('../src/vegetation/forestField.js');
const { TERRAIN } = await import('../src/terrain/params.js');

test('coverage mips retain cutout coverage without introducing transparent-edge color', () => {
  const pixels = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const i = (y * 16 + x) * 4;
    pixels.set(x < 8 ? [24, 180, 42, 255] : [255, 0, 0, 0], i);
  }
  const mips = buildCoverageMips(pixels, 16, 16);
  assert.deepEqual(mips.map(m => [m.width, m.height]), [[16, 16], [8, 8], [4, 4], [2, 2], [1, 1]]);
  for (const level of mips.slice(1, -1)) assert.equal(alphaCoverage(level.data), 0.5);
  const last = mips.at(-1).data;
  assert.ok(last[0] < 26 && last[1] >= 179 && last[2] <= 43, 'transparent red must not contaminate the foliage');
  assert.ok(last[3] > 0);
});

test('coverage mip downsampling works for odd/non-square images and validates input', () => {
  const pixels = new Uint8Array(7 * 3 * 4).fill(255);
  const levels = buildCoverageMips(pixels, 7, 3);
  assert.deepEqual(levels.map(m => [m.width, m.height]), [[7, 3], [3, 1], [1, 1]]);
  assert.ok(levels.every(m => m.data.every(value => value === 255)));
  assert.throws(() => buildCoverageMips(new Uint8Array(3), 1, 1), /dimensions/);
});

test('foliage textures use explicit sRGB coverage mips, not automatic box mips', () => {
  const texture = createCoverageTexture(new Uint8Array(8 * 8 * 4).fill(255), 8, 8, { flipY: true });
  assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
  assert.equal(texture.generateMipmaps, false);
  assert.equal(texture.flipY, true);
  assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(texture.mipmaps.length, 4);
  texture.dispose();
});

test('atlas coverage is preserved per view without cross-cell color contamination', () => {
  const pixels = new Uint8Array(16 * 8 * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) {
    const red = x < 8;
    pixels.set(red ? [240, 10, 20, y < 4 ? 255 : 0] : [20, 220, 30, y < 2 ? 255 : 0], (y * 16 + x) * 4);
  }
  const levels = buildAtlasCoverageMips(pixels, 16, 8, 2, 1);
  assert.deepEqual(levels.map(m => [m.width, m.height]), [[16, 8], [8, 4], [4, 2], [2, 1], [1, 1]]);
  for (let i = 1; i <= 3; i++) {
    const level = levels[i], right = level.width / 2 * 4;
    assert.ok(level.data[0] >= 239 && level.data[1] <= 11, 'red view stays red');
    assert.ok(level.data[right] <= 21 && level.data[right + 1] >= 219, 'green view stays green');
  }
});

test('MSAA transparent edge RGB is unpremultiplied in linear light exactly once', () => {
  const result = unpremultiplyResolvedPixels(new Uint8Array([137, 0, 0, 64, 180, 200, 120, 255, 0, 0, 0, 0]));
  assert.ok(result[0] >= 254, 'quarter coverage of full linear red restores red, not a dark fringe');
  assert.equal(result[3], 64);
  assert.deepEqual([...result.slice(4)], [180, 200, 120, 255, 0, 0, 0, 0]);
});

test('normal mips average linear object-space vectors using alpha weights and renormalize', () => {
  const data = new Uint8Array([255, 128, 128, 255, 128, 255, 128, 255, 128, 128, 0, 0, 128, 255, 128, 255]);
  const levels = buildNormalMips(data, 2, 2);
  const vector = [...levels.at(-1).data.slice(0, 3)].map(value => value / 127.5 - 1);
  assert.ok(Math.abs(vector[0] - 1 / Math.sqrt(5)) < 0.012);
  assert.ok(Math.abs(vector[1] - 2 / Math.sqrt(5)) < 0.012);
  assert.ok(Math.abs(vector[2]) < 0.012, 'zero-alpha back-facing texel cannot influence the normal');
  assert.ok(Math.abs(Math.hypot(...vector) - 1) < 0.012);
  const texture = createNormalTexture(data, 2, 2);
  assert.equal(texture.colorSpace, THREE.NoColorSpace);
  assert.equal(texture.generateMipmaps, false);
  texture.dispose();
});

test('normal resolve unpremultiply is linear rather than applying the sRGB transfer', () => {
  const result = unpremultiplyResolvedPixels(new Uint8Array([128, 64, 64, 128]), { linear: true });
  assert.deepEqual([...result], [255, 128, 128, 128]);
});

test('LOD has no coverage hole, random discard, or hard identity switch', () => {
  for (const kind of ['tree', 'shrub']) {
    const { low, high } = FOREST_LOD[kind];
    assert.deepEqual(foliageCoverage(low, kind), { near: 0, far: 1 });
    assert.deepEqual(foliageCoverage(high, kind), { near: 1, far: 0 });
    let previous = foliageCoverage(0, kind);
    for (let pixels = 0.1; pixels <= high + 10; pixels += 0.1) {
      const next = foliageCoverage(pixels, kind);
      assert.equal(Math.max(next.near, next.far), 1, 'one representation remains fully opaque');
      assert.ok(next.near >= previous.near && next.far <= previous.far);
      assert.ok(Math.abs(next.near - previous.near) < 0.02 && Math.abs(next.far - previous.far) < 0.02);
      previous = next;
    }
  }
});

test('template choice and projected LOD depend on identity/size, not distance rank', () => {
  const record = { species: 'pine', variant: 1, x: 0, y: 0, z: 100, height: 10 };
  const camera = new THREE.PerspectiveCamera(54);
  camera.position.y = 5;
  assert.equal(projectedPlantHeight(record, camera, 1000), 100);
  assert.equal(foliageTemplateKey(record), 'pine');
  assert.equal(foliageTemplateKey(record, 'shrub'), 'shrub-1');
  assert.equal(foliageTemplateKey({ ...record, z: 2, rank: 0.999 }), 'pine');
});

test('impostor bounds retain the source root and enclose every view', () => {
  const geometry = new THREE.BoxGeometry(0.7, 1, 0.5).translate(0.05, 0.5, -0.02);
  const shape = impostorBounds({ bark: geometry });
  assert.ok(shape.bottom < 0 && shape.top > 1);
  assert.ok(shape.radius >= Math.hypot(0.4, -0.27));
  assert.ok(Math.abs(shape.width - 0.7) < 1e-6);
  assert.equal(IMPOSTOR.views, IMPOSTOR.columns * IMPOSTOR.rows);
  geometry.dispose();
});

test('atlas bake transaction restores every renderer state even when rendering fails', () => {
  const renderer = {
    target: { name: 'live-pass' }, face: 2, mip: 1, viewport: new THREE.Vector4(1, 2, 400, 300),
    scissor: new THREE.Vector4(3, 4, 200, 100), scissorTest: true, clear: new THREE.Color(0.2, 0.3, 0.4), clearAlpha: 0.7,
    autoClear: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.7, outputColorSpace: THREE.SRGBColorSpace,
    xr: { enabled: true },
    getRenderTarget() { return this.target; }, getActiveCubeFace() { return this.face; }, getActiveMipmapLevel() { return this.mip; },
    getViewport(target) { return target.copy(this.viewport); }, getScissor(target) { return target.copy(this.scissor); },
    getScissorTest() { return this.scissorTest; }, getClearColor(target) { return target.copy(this.clear); }, getClearAlpha() { return this.clearAlpha; },
    setRenderTarget(target, face, mip) { Object.assign(this, { target, face, mip }); },
    setViewport(value) { this.viewport.copy(value); }, setScissor(value) { this.scissor.copy(value); },
    setScissorTest(value) { this.scissorTest = value; }, setClearColor(value, alpha) { this.clear.copy(value); this.clearAlpha = alpha; },
  };
  const original = JSON.stringify(renderer);
  assert.throws(() => withRendererState(renderer, () => {
    renderer.target = null; renderer.face = 0; renderer.mip = 0; renderer.viewport.set(0, 0, 512, 512);
    renderer.scissor.set(0, 0, 512, 512); renderer.scissorTest = false; renderer.clear.set(0); renderer.clearAlpha = 0;
    renderer.autoClear = false; renderer.toneMapping = THREE.NoToneMapping; renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace; renderer.xr.enabled = false;
    throw new Error('failed render');
  }), /failed render/);
  assert.equal(JSON.stringify(renderer), original);
});

function fakeField() {
  const field = Object.create(ForestField.prototype);
  const source = new THREE.BoxGeometry(0.7, 1, 0.5).translate(0, 0.5, 0);
  const template = { name: 'pine', species: 'pine', kind: 'tree', parts: { bark: source, leaf: source },
    maps: { bark: null, leaf: null }, impostor: { shape: impostorBounds({ source }), texture: new THREE.Texture(), normalTexture: new THREE.Texture() } };
  field.assets = { templates: new Map([['pine', template]]), dispose() {} };
  field.materials = new Map([['pine', { bark: new THREE.MeshStandardMaterial(), leaf: new THREE.MeshStandardMaterial(), impostor: new THREE.MeshStandardMaterial() }]]);
  field.materials.get('pine').impostor.userData = { foliageTemplate: template, foliageNormalMap: { value: template.impostor.normalTexture } };
  field.billboards = new Map([['pine', new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0)]]);
  field.meshes = new Set(); field.pixelScale = 1000;
  field.uniforms = { uFoliageBare: { value: 0 }, uFoliageTime: { value: 0 }, uFoliagePixelScale: { value: 1000 },
    uFoliageTint: { value: new THREE.Color() }, uFoliageSnow: { value: 0 }, uFoliageAutumn: { value: 0 } };
  return { field, source, template };
}

test('fine geometry and impostors share every canonical root and stable population ID', () => {
  const { field, source } = fakeField();
  const records = [0, 1, 2].map(i => ({ id: `pine-${i}`, species: 'pine', x: i * 30, y: 2, z: 80, height: 10,
    width: 7, yaw: i * 0.7, rank: 1 - i * 0.2, phase: i }));
  const meshes = field.build(records);
  assert.equal(meshes.length, 3);
  const matrix = new THREE.Matrix4();
  for (const mesh of meshes) {
    assert.deepEqual(mesh.userData.population.map(r => r.id), records.map(r => r.id));
    for (let index = 0; index < records.length; index++) {
      mesh.getMatrixAt(index, matrix);
      assert.deepEqual(matrix.elements.slice(12, 15), [records[index].x, records[index].y, records[index].z]);
    }
  }
  const camera = new THREE.PerspectiveCamera(54);
  camera.position.set(0, 7, -1000);
  assert.equal(meshes[0].userData.batchVisible(camera), false);
  assert.equal(meshes[2].userData.batchVisible(camera), true);
  for (const mesh of meshes) field.disposeMesh(mesh);
  assert.equal(field.meshes.size, 0);
  assert.ok(source.index && source.getAttribute('position'), 'cell disposal must retain shared authored buffers');
  field.dispose(); source.dispose();
});

test('cooperative forest builders retain identical matrices and release every cancelled representation', () => {
  const { field, source } = fakeField();
  const records = Array.from({ length: 160 }, (_, i) => ({ id: `pine-${i}`, species: 'pine',
    x: i * 3, y: 2, z: 80, height: 10, width: 7, yaw: i * 0.7, rank: 0.5, phase: i }));
  const expected = field.build(records);
  const iterator = field.buildSteps(records);
  let step, slices = 0;
  do { step = iterator.next(); if (!step.done) slices++; } while (!step.done);
  assert.ok(slices >= 8);
  step.value.forEach((mesh, i) => {
    assert.deepEqual(mesh.instanceMatrix.array, expected[i].instanceMatrix.array);
    assert.deepEqual(mesh.geometry.getAttribute('iFoliage').array, expected[i].geometry.getAttribute('iFoliage').array);
  });
  for (const mesh of [...field.meshes]) field.disposeMesh(mesh);
  const partial = field.buildSteps(records);
  while (field.meshes.size < 2) assert.equal(partial.next().done, false);
  let disposed = 0;
  for (const mesh of field.meshes) mesh.addEventListener('dispose', () => disposed++);
  partial.return(); partial.return();
  assert.equal(disposed, 2);
  assert.equal(field.meshes.size, 0);
  assert.ok(source.getAttribute('position') && source.index);
  field.dispose(); source.dispose();
});

test('near and far shaders share ridge lift, coherent wind and post-cutout coverage', () => {
  const { template, source, field } = fakeField();
  const atmo = { register() {} };
  for (const part of ['bark', 'leaf', 'impostor']) {
    const material = makeFoliageMaterial(template, part, {}, atmo);
    const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} };
    material.onBeforeCompile(shader);
    assert.match(shader.vertexShader, /foliageRoot\.y \+= foliageLift/);
    assert.match(shader.vertexShader, /transformed\.y \+= foliageLift/);
    assert.match(shader.vertexShader, /foliageSway/);
    assert.ok(shader.fragmentShader.indexOf('diffuseColor.a *= vFoliageCoverage') > shader.fragmentShader.indexOf('#include <alphatest_fragment>'));
    assert.doesNotMatch(shader.fragmentShader.replace(/#include <[^>]+>/g, ''), /random|hash|discard/);
    assert.equal(material.alphaHash, false);
    assert.equal(material.alphaToCoverage, true);
    if (part === 'impostor') {
      assert.match(shader.fragmentShader, /textureGrad\(uFoliageNormalMap/);
      assert.match(shader.vertexShader, /vFoliageNormalTransform = normalMatrix \* mat3/);
      assert.match(shader.fragmentShader, /normal = normalize\(vFoliageNormalTransform \* foliageObjectNormal\)/);
      assert.equal(shader.uniforms.uFoliageNormalMap.value, template.impostor.normalTexture);
    }
    material.dispose();
  }
  assert.equal(foliageRidgeOffset(100, 200, 100, 200), 0);
  assert.equal(foliageRidgeOffset(500, 0, 0, 0), 0);
  assert.ok(Math.abs(foliageRidgeOffset(1500, 200, 0, 0)) > 0.001);
  field.dispose(); source.dispose();
});

test('oak and evergreen leaf shaders cannot share their seasonal GPU program', () => {
  const { template, field, source } = fakeField();
  const pine = makeFoliageMaterial(template, 'leaf', {}, { register() {} });
  const oak = makeFoliageMaterial({ ...template, species: 'oak' }, 'leaf', {}, { register() {} });
  assert.notEqual(pine.customProgramCacheKey(), oak.customProgramCacheKey());
  const shader = () => ({ vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} });
  const pineShader = shader(), oakShader = shader();
  pine.onBeforeCompile(pineShader); oak.onBeforeCompile(oakShader);
  assert.doesNotMatch(pineShader.fragmentShader, /diffuseColor\.a \*= 1.0 - uFoliageBare/);
  assert.match(oakShader.fragmentShader, /diffuseColor\.a \*= 1.0 - uFoliageBare/);
  pine.dispose(); oak.dispose(); field.dispose(); source.dispose();
});

test('plant roots darken locally and winter snow respects leaf orientation after normal decoding', () => {
  const { template, field, source } = fakeField();
  for (const part of ['bark', 'leaf', 'impostor']) {
    const material = makeFoliageMaterial(template, part, {}, { register() {} });
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    material.onBeforeCompile(shader);
    assert.match(shader.vertexShader, /vFoliageGroundHeight = position\.y \* iFoliage\.x/);
    assert.match(shader.fragmentShader, /smoothstep\(0\.0, 0\.85, vFoliageGroundHeight\)/);
    assert.match(shader.fragmentShader, /foliageRootSnow = clamp\(uFoliageSnow \* 1\.6, 0\.0, 1\.0\)/);
    assert.match(shader.fragmentShader, /1\.0 - smoothstep\(0\.12, 0\.45, vFoliageGroundHeight\)/);
    assert.match(shader.fragmentShader, /smoothstep\(0\.15, 0\.75, foliageWorldNormal\.y\)/);
    if (part !== 'bark') {
      const snow = shader.fragmentShader.indexOf('float foliageSnowCover');
      assert.ok(snow > shader.fragmentShader.indexOf('#include <normal_fragment_maps>'));
      assert.ok(snow < shader.fragmentShader.indexOf('#include <lights_physical_fragment>'));
      assert.match(shader.fragmentShader, /abs\(foliageWorldNormal\.y\)/, 'card side cannot flip snow exposure');
      assert.match(shader.fragmentShader, /uFoliageSnow \* foliageLeafSignal/);
      if (part === 'impostor') assert.ok(snow > shader.fragmentShader.indexOf('normal = normalize(vFoliageNormalTransform'));
    } else assert.doesNotMatch(shader.fragmentShader, /float foliageSnowCover/);
    material.dispose();
  }
  field.dispose(); source.dispose();
});

test('new species retain their own template keys, bark tints and evergreen winter behavior', () => {
  const { template, field, source } = fakeField();
  for (const species of ['pine', 'oak', 'birch', 'aspen', 'maple', 'spruce']) {
    assert.equal(foliageTemplateKey({ species }), species);
    const typed = { ...template, name: species, species, tints: { bark: [0.8, 0.9, 1], leaf: [0.9, 1, 0.8] } };
    const bark = makeFoliageMaterial(typed, 'bark', {}, { register() {} });
    const leaf = makeFoliageMaterial(typed, 'leaf', {}, { register() {} });
    const far = makeFoliageMaterial(typed, 'impostor', {}, { register() {} });
    assert.deepEqual(bark.color.toArray(), typed.tints.bark);
    assert.deepEqual(leaf.color.toArray(), typed.tints.leaf);
    assert.deepEqual(far.color.toArray(), [1, 1, 1], 'baked colors must not be tinted twice');
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    leaf.onBeforeCompile(shader);
    assert.equal(shader.fragmentShader.includes('diffuseColor.a *= 1.0 - uFoliageBare'), !['pine', 'spruce'].includes(species));
    for (const material of [bark, leaf, far]) material.dispose();
  }
  assert.equal(foliageTemplateKey({ species: 'constructor' }), 'oak');
  field.dispose(); source.dispose();
});

test('deciduous autumn replaces green pigment rather than tinting bark or evergreen needles orange', () => {
  const { template, field, source } = fakeField();
  for (const species of ['oak', 'birch', 'aspen', 'maple', 'pine', 'spruce']) {
    for (const part of ['bark', 'leaf', 'impostor']) {
      const material = makeFoliageMaterial({ ...template, species }, part, {}, { register() {} });
      const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
        fragmentShader: THREE.ShaderLib.standard.fragmentShader };
      material.onBeforeCompile(shader);
      assert.match(shader.fragmentShader, /foliageRootSnow/);
      if (part !== 'bark' && !['pine', 'spruce'].includes(species)) {
        assert.match(shader.fragmentShader, /uFoliageAutumn \* foliagePigmentMask/);
        assert.match(shader.fragmentShader, /clamp\(foliageLuma \* 5\.0/);
        if (part === 'impostor') assert.match(shader.fragmentShader, /foliagePigmentMask = smoothstep/);
      } else assert.doesNotMatch(shader.fragmentShader, /vec3 foliageAutumnColor/);
      material.dispose();
    }
  }
  const camera = new THREE.PerspectiveCamera();
  field.update(camera, 0, 'autumn'); assert.equal(field.uniforms.uFoliageAutumn.value, 1);
  field.update(camera, 0, 'summer'); assert.equal(field.uniforms.uFoliageAutumn.value, 0);
  field.dispose(); source.dispose();
});

test('ridge factorization retains the original equations and exact near-zero branch', () => {
  const smoothstep = (a, b, value) => { const t = Math.max(0, Math.min(1, (value - a) / (b - a))); return t * t * (3 - 2 * t); };
  const original = (x, z, cameraX, cameraZ) => {
    const distance = Math.hypot(x - cameraX, z - cameraZ);
    if (distance <= TERRAIN.farRidgeNear) return 0;
    const a = 1 - Math.abs(Math.sin(x * 0.00016 + z * 0.000095 + Math.sin(x * 0.000047) * 1.7 + Math.sin(z * 0.000031) * 0.8));
    const b = 1 - Math.abs(Math.sin(x * -0.000071 + z * 0.00019 + Math.sin(z * 0.000061) * 1.4 + Math.sin(x * 0.000022) * 0.9));
    const c = 1 - Math.abs(Math.sin(x * 0.00031 - z * 0.00022 + Math.sin(x * 0.00009 + z * 0.00013) * 0.55));
    const ca = 0.5 + 0.5 * Math.sin(x * 0.000043 - z * 0.000027 + Math.sin(x * 0.000019 + z * 0.000013) * 1.2);
    const cb = 0.5 + 0.5 * Math.cos(x * -0.000021 + z * 0.000036 + Math.sin(z * 0.000016) * 0.9);
    const shape = smoothstep(0.16, 0.86, a) * (0.38 + ca * 0.18) + smoothstep(0.18, 0.84, b) * (0.24 + cb * 0.16)
      + smoothstep(0.22, 0.82, c) * 0.18 - 0.34;
    const shoulder = smoothstep(0.34, 0.72, a * (0.46 + ca * 0.16) + b * (0.30 + cb * 0.08));
    return (shape * TERRAIN.farRidgeAmp + (shoulder - 0.42) * TERRAIN.farRidgeAmp * 0.34)
      * smoothstep(TERRAIN.farRidgeNear, TERRAIN.farRidgeFar, distance);
  };
  for (const distance of [0, TERRAIN.farRidgeNear - 1e-8, TERRAIN.farRidgeNear, TERRAIN.farRidgeNear + 1e-8, 1500, 5200, 10000]) {
    for (const [x, z] of [[0, 0], [1530, -920], [-8700, 3420]]) {
      assert.equal(foliageRidgeOffset(x, z, x + distance, z), original(x, z, x + distance, z));
    }
  }
});

test('representations share lazy LOD calculations and reuse ridge shape after camera and viewport changes', () => {
  const { field, source } = fakeField();
  const records = [1500, 100].map((z, i) => Object.freeze({ id: `pine-${i}`, species: 'pine', x: 0, y: 0, z,
    height: 10, width: 7, yaw: 0, rank: 0.5, phase: 0 }));
  const meshes = field.build(records), camera = new THREE.PerspectiveCamera(54);
  camera.position.y = 5;
  const sin = Math.sin, cos = Math.cos, hypot = Math.hypot, sqrt = Math.sqrt;
  let trigonometry = 0, distances = 0, squareRoots = 0;
  Math.sin = (...args) => { trigonometry++; return sin(...args); };
  Math.cos = (...args) => { trigonometry++; return cos(...args); };
  Math.hypot = (...args) => { distances++; return hypot(...args); };
  Math.sqrt = (...args) => { squareRoots++; return sqrt(...args); };
  try {
    meshes[0].userData.instanceVisible(0, camera);
    const first = { trigonometry, distances, squareRoots };
    assert.ok(trigonometry > 0);
    for (const mesh of meshes) {
      mesh.userData.instanceVisible(0, camera);
      mesh.userData.batchVisible(camera);
    }
    assert.deepEqual({ trigonometry, distances, squareRoots }, first);
    meshes[0].userData.instanceVisible(1, camera);
    assert.equal(trigonometry, first.trigonometry, 'near records must not evaluate ridge trigonometry');
    const beforeMove = distances;
    camera.position.x = 10;
    meshes[2].userData.instanceVisible(0, camera);
    assert.ok(distances > beforeMove);
    assert.equal(trigonometry, first.trigonometry);
    const beforeResize = distances;
    field.update(camera, 1, 'summer', 1440);
    meshes[2].userData.instanceVisible(0, camera);
    assert.ok(distances > beforeResize);
    assert.equal(trigonometry, first.trigonometry, 'ridge shape depends on position, not camera or pixel scale');
  } finally {
    Math.sin = sin; Math.cos = cos; Math.hypot = hypot; Math.sqrt = sqrt;
    field.dispose(); source.dispose();
  }
});

test('cached LOD predicates exactly match uncached calculations across camera motion and resizing', () => {
  const { field, source } = fakeField();
  const records = [40, 80, 100, 300, 679.99, 680, 680.01, 1500, 1999, 2001, 2300].map((z, i) =>
    Object.freeze({ id: `pine-${i}`, species: 'pine', x: (i % 3 - 1) * 20, y: i * 2, z,
      height: 8 + i, width: 7, yaw: i * 0.4, rank: 0.5, phase: 0 }));
  const meshes = field.build(records), camera = new THREE.PerspectiveCamera(54), range = FOREST_LOD.tree;
  try {
    for (let frame = 0; frame < 32; frame++) {
      camera.position.set(Math.sin(frame) * 30, frame % 7 * 10, Math.cos(frame * 0.4) * 90);
      camera.fov = 40 + frame % 4 * 12;
      field.update(camera, frame, frame % 2 ? 'winter' : 'summer', 600 + frame % 5 * 240);
      for (const mesh of [...meshes].reverse()) {
        const far = mesh.userData.foliageLevel === 'far';
        const expected = records.map(record => {
          const pixels = projectedPlantHeight(record, camera, field.pixelScale);
          if (far ? pixels > range.high + 0.01 : pixels < range.low - 0.01) return false;
          return record.height * field.pixelScale / Math.max(pixels, 1e-8) <= range.fadeEnd + 1;
        });
        assert.deepEqual(records.map((_, index) => mesh.userData.instanceVisible(index, camera)), expected);
        if (!mesh.userData.batchVisible(camera)) assert.ok(expected.every(visible => !visible));
      }
    }
  } finally { field.dispose(); source.dispose(); }
});

test('horizontal group rejection remains conservative for long thin populations and camera changes', () => {
  const { field, source } = fakeField();
  const records = [-1000, 0, 1000].map((z, i) => ({ id: `pine-${i}`, species: 'pine', x: 300, y: 0, z,
    height: 10, width: 7, yaw: 0, rank: 0.5, phase: 0 }));
  const meshes = field.build(records), camera = new THREE.PerspectiveCamera(54);
  camera.position.y = 5;
  try {
    assert.equal(meshes[0].userData.batchVisible(camera), false);
    assert.equal(meshes[1].userData.batchVisible(camera), false);
    assert.equal(meshes[2].userData.batchVisible(camera), true);
    assert.ok(records.every((_, index) => !meshes[0].userData.instanceVisible(index, camera)));
    camera.position.x = 250;
    assert.equal(meshes[0].userData.batchVisible(camera), true);
    assert.equal(meshes[0].userData.instanceVisible(1, camera), true);
    camera.position.x = -1800;
    for (const mesh of meshes) {
      assert.equal(mesh.userData.batchVisible(camera), false);
      assert.ok(records.every((_, index) => !mesh.userData.instanceVisible(index, camera)));
    }
  } finally { field.dispose(); source.dispose(); }
});

test('forest matrices are composed once per record while representation buffers remain independently owned', () => {
  const { field, source, template } = fakeField();
  const records = Array.from({ length: 160 }, (_, i) => ({ id: `pine-${i}`, species: 'pine', x: i * 2, y: i % 3, z: 80,
    height: 8 + i % 5, width: 5 + i % 4, yaw: i * 0.7, rank: 0.5, phase: i }));
  const compose = THREE.Matrix4.prototype.compose;
  let compositions = 0, meshes;
  THREE.Matrix4.prototype.compose = function(...args) { compositions++; return compose.apply(this, args); };
  try { meshes = field.build(records); } finally { THREE.Matrix4.prototype.compose = compose; }
  try {
    assert.equal(compositions, records.length);
    const expected = new Float32Array(records.length * 16), matrix = new THREE.Matrix4();
    for (const [index, record] of records.entries()) {
      const width = record.width / template.impostor.shape.width;
      matrix.compose(new THREE.Vector3(record.x, record.y, record.z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), record.yaw),
        new THREE.Vector3(width, record.height, width)).toArray(expected, index * 16);
    }
    for (const mesh of meshes) assert.deepEqual(mesh.instanceMatrix.array, expected);
    assert.equal(new Set(meshes.map(mesh => mesh.instanceMatrix.array.buffer)).size, 3);
    assert.equal(new Set(meshes.map(mesh => mesh.geometry.getAttribute('iFoliage').array.buffer)).size, 3);
    field.disposeMesh(meshes[0]);
    assert.deepEqual(meshes[1].instanceMatrix.array, expected);
  } finally { field.dispose(); source.dispose(); }
});

test('ferns use their own green and dry-gold material program and retain the bare winter path', () => {
  const { template, field, source } = fakeField();
  const fern = { ...template, name: 'shrub-1', kind: 'shrub', species: 'oak', growthForm: 'fern', heightScale: 0.68,
    maps: { bark: null, leaf: null }, tints: { bark: [0.26, 0.20, 0.055], leaf: [0.15, 0.30, 0.055] } };
  const bush = { ...fern, name: 'shrub-0', growthForm: 'woody' };
  const materials = [];
  try {
    for (const part of ['bark', 'leaf', 'impostor']) {
      const material = makeFoliageMaterial(fern, part, field.uniforms, { register() {} });
      const other = makeFoliageMaterial(bush, part, field.uniforms, { register() {} });
      materials.push(material, other);
      assert.notEqual(material.customProgramCacheKey(), other.customProgramCacheKey());
      if (part !== 'impostor') {
        assert.equal(material.map, null);
        assert.deepEqual(material.color.toArray(), fern.tints[part]);
      }
      const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
      material.onBeforeCompile(shader);
      if (part === 'leaf' || part === 'impostor') assert.match(shader.fragmentShader, /vec3\(0\.37, 0\.21, 0\.045\)/);
      if (part === 'leaf') assert.match(shader.fragmentShader, /diffuseColor\.a \*= 1\.0 - uFoliageBare/);
      if (part === 'impostor') assert.match(shader.fragmentShader, /if \(uFoliageBare < 0\.5\)/);
    }
  } finally { materials.forEach(material => material.dispose()); field.dispose(); source.dispose(); }
});

test('fern height scaling is shared by instance matrices, GPU height, CPU LOD and bounds exactly once', () => {
  const { field, source, template } = fakeField();
  Object.assign(template, { name: 'shrub-1', species: 'oak', kind: 'shrub', growthForm: 'fern', heightScale: 0.68 });
  template.bareImpostor = { texture: new THREE.Texture(), normalTexture: new THREE.Texture() };
  field.assets.templates = new Map([['shrub-1', template]]);
  field.materials = new Map([['shrub-1', field.materials.get('pine')]]);
  field.billboards = new Map([['shrub-1', field.billboards.get('pine')]]);
  const record = Object.freeze({ id: 'shrub:canonical:1', variant: 1, x: 0, y: 0, z: -18, height: 1.5, width: 1.1, yaw: 0.4, rank: 0.3 });
  const meshes = field.build([record], 'shrub'), height = 1.5 * 0.68;
  const camera = new THREE.PerspectiveCamera(54), matrix = new THREE.Matrix4(), position = new THREE.Vector3();
  camera.position.y = height * 0.5;
  try {
    assert.equal(meshes.length, 3, 'the fern must use the existing three representations, not extra instances');
    for (const mesh of meshes) {
      assert.equal(mesh.count, 1);
      assert.equal(mesh.userData.population[0], record);
      assert.equal(mesh.userData.foliageMaximumHeight, height);
      assert.ok(Math.abs(mesh.geometry.getAttribute('iFoliage').getX(0) - height) < 1e-6);
      mesh.getMatrixAt(0, matrix);
      assert.ok(Math.abs(new THREE.Vector3().setFromMatrixColumn(matrix, 1).length() - height) < 1e-6);
      assert.ok(Math.abs(new THREE.Vector3().setFromMatrixColumn(matrix, 0).length() - record.width / template.impostor.shape.width) < 1e-6);
      assert.deepEqual(matrix.elements.slice(12, 15), [record.x, record.y, record.z]);
      mesh.computeBoundingSphere();
      for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
        position.fromBufferAttribute(mesh.geometry.attributes.position, i).applyMatrix4(matrix);
        assert.ok(position.distanceTo(mesh.boundingSphere.center) <= mesh.boundingSphere.radius + 1e-6);
      }
      assert.ok(Math.abs(mesh.boundingSphere.center.y - height * 0.5) < 1e-6);
    }
    assert.equal(meshes[0].userData.instanceVisible(0, camera), false, 'scaled fern is below the near LOD threshold');
    assert.equal(meshes[0].userData.batchVisible(camera), false);
    assert.equal(meshes[2].userData.instanceVisible(0, camera), true);
    camera.position.z = -4;
    assert.equal(meshes[0].userData.instanceVisible(0, camera), true);
    const before = meshes.map(mesh => mesh.instanceMatrix.array.slice());
    field.update(camera, 1, 'autumn', 1080);
    assert.equal(field.uniforms.uFoliageAutumn.value, 1);
    field.update(camera, 2, 'winter', 1080);
    assert.equal(meshes[1].userData.batchVisible(camera), false);
    assert.equal(field.materials.get('shrub-1').impostor.map, template.bareImpostor.texture);
    meshes.forEach((mesh, i) => assert.deepEqual(mesh.instanceMatrix.array, before[i]));
    assert.equal(record.height, 1.5); assert.equal(record.width, 1.1);
  } finally {
    template.bareImpostor.texture.dispose(); template.bareImpostor.normalTexture.dispose();
    field.dispose(); source.dispose();
  }
});
