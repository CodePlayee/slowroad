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
const { TERRAIN_PROBE_MODES, probePixel, createTerrainProbeMaterial, probeTerrainMaterials } = await import('./terrain-material-probe-runtime.mjs');
const { parseProbeArgs } = await import('./terrain-material-probe.mjs');

function fixture(t, { failRead = false, floating = true } = {}) {
  const scene = new THREE.Scene(), group = new THREE.Group(), shared = { value: 0.42 };
  const original = new THREE.MeshStandardMaterial();
  original.name = 'terrain';
  original.onBeforeCompile = shader => { shader.uniforms.sharedTerrain = shared; };
  original.customProgramCacheKey = () => 'original-terrain-hook';
  const geometry = new THREE.PlaneGeometry(100, 100).rotateX(-Math.PI / 2);
  geometry.addGroup(0, geometry.index.count, 0);
  const mesh = new THREE.Mesh(geometry, [original]);
  group.add(mesh); scene.add(group);
  const unrelated = new THREE.Object3D(); unrelated.name = 'not-terrain'; scene.add(unrelated);
  const camera = new THREE.PerspectiveCamera(54, 1920 / 1080, 0.1, 1000);
  camera.position.set(0, 5, 10); camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true); scene.updateMatrixWorld(true);
  const tile = { key: 'terr:0:0:0:0', l: 0, C: 128 };
  const chunks = new Map([[tile.key, { tile, mesh, data: { resolution: 1 }, settled: true }]]);
  const diagnostics = { reads: [], modes: [], materials: new Set(), targets: new Set(), materialDisposals: 0, targetDisposals: 0 };
  const renderer = {
    target: { name: 'original-target' }, face: 2, mip: 1,
    viewport: new THREE.Vector4(13, 17, 400, 300), scissor: new THREE.Vector4(3, 4, 200, 100), scissorTest: true,
    clearColor: new THREE.Color(0.2, 0.3, 0.4), clearAlpha: 0.7,
    autoClear: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.7, outputColorSpace: THREE.SRGBColorSpace,
    xr: { enabled: true }, shadowMap: { autoUpdate: true, needsUpdate: true },
    getContext: () => ({ getExtension: () => floating ? {} : null }),
    getRenderTarget() { return this.target; }, getActiveCubeFace() { return this.face; }, getActiveMipmapLevel() { return this.mip; },
    getViewport(out) { return out.copy(this.viewport); }, getScissor(out) { return out.copy(this.scissor); },
    getScissorTest() { return this.scissorTest; }, getClearColor(out) { return out.copy(this.clearColor); }, getClearAlpha() { return this.clearAlpha; },
    setViewport(value) { this.viewport.copy(value); }, setScissor(value) { this.scissor.copy(value); },
    setScissorTest(value) { this.scissorTest = value; },
    setClearColor(value, alpha) { this.clearColor.set(value); this.clearAlpha = alpha; },
    setRenderTarget(target, face = 0, mip = 0) { Object.assign(this, { target, face, mip }); },
    clear(...args) { assert.deepEqual(args, [true, true, true]); },
    render(probeScene, probeCamera) {
      assert.notEqual(probeScene, scene); assert.notEqual(probeCamera, camera);
      assert.equal(probeScene.children.length, 1);
      assert.equal(probeScene.children[0].geometry, geometry);
      assert.notEqual(probeScene.children[0], mesh);
      assert.deepEqual(this.target.viewport.toArray(), [0, 0, 1920, 1080]);
      assert.equal(this.target.scissorTest, false);
      assert.equal(this.xr.enabled, false);
      assert.equal(this.autoClear, false);
      assert.equal(this.shadowMap.autoUpdate, false);
      assert.equal(this.toneMapping, THREE.NoToneMapping);
      const material = probeScene.children[0].material[0];
      if (!diagnostics.materials.has(material)) {
        material.addEventListener('dispose', () => diagnostics.materialDisposals++);
        diagnostics.materials.add(material);
      }
      if (!diagnostics.targets.has(this.target)) {
        this.target.addEventListener('dispose', () => diagnostics.targetDisposals++);
        diagnostics.targets.add(this.target);
      }
      const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
      material.onBeforeCompile(shader, this);
      assert.equal(shader.uniforms.sharedTerrain, shared);
      this.mode = shader.uniforms.uTerrainProbeMode.value;
      diagnostics.modes.push(this.mode);
    },
    readRenderTargetPixels(target, x, y, width, height, buffer) {
      diagnostics.reads.push({ x, y, width, height });
      if (failRead) throw new Error('synthetic raw read failure');
      buffer.set(floating ? [this.mode / 10, 0.25, 0.75, 1] : [this.mode * 10, 64, 192, 255]);
    },
  };
  const state = () => ({ target: renderer.target, face: renderer.face, mip: renderer.mip,
    viewport: renderer.viewport.toArray(), scissor: renderer.scissor.toArray(), scissorTest: renderer.scissorTest,
    clear: renderer.clearColor.toArray(), clearAlpha: renderer.clearAlpha, autoClear: renderer.autoClear,
    toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure, colorSpace: renderer.outputColorSpace,
    xr: renderer.xr.enabled, shadow: { ...renderer.shadowMap } });
  const before = state(), hook = original.onBeforeCompile, material = mesh.material, matrix = mesh.matrixWorld.clone();
  const app = { scene, renderer, cameras: { camera }, residencyOk: () => true,
    terrain: { group, chunks, uniforms: { uFarRidgeNear: { value: 680 } } } };
  t.after(() => { original.dispose(); geometry.dispose(); });
  return { app, diagnostics, assertRestored() {
    assert.deepEqual(state(), before);
    assert.equal(mesh.material, material); assert.equal(original.onBeforeCompile, hook);
    assert.equal(mesh.parent, group); assert.equal(group.parent, scene);
    assert.equal(mesh.visible, true); assert.equal(unrelated.visible, true);
    assert.deepEqual(mesh.matrixWorld, matrix);
    assert.equal(diagnostics.materialDisposals, 1); assert.equal(diagnostics.targetDisposals, 1);
  } };
}

test('raw probe calls the original material hook, borrows uniforms, and returns before tone/fog output', () => {
  const original = new THREE.MeshStandardMaterial(), shared = { value: 7 }, mode = { value: 3 };
  original.onBeforeCompile = shader => { shader.uniforms.shared = shared; };
  original.customProgramCacheKey = () => 'production';
  const material = createTerrainProbeMaterial(original, mode);
  try {
    const shader = { uniforms: {}, vertexShader: '', fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    material.onBeforeCompile(shader, {});
    assert.equal(shader.uniforms.shared, shared);
    assert.equal(shader.uniforms.uTerrainProbeMode, mode);
    assert.ok(material.customProgramCacheKey().startsWith('production:'));
    for (const entry of TERRAIN_PROBE_MODES) assert.ok(shader.fragmentShader.includes(`vec4(${entry.expression}, 1.0)`));
    assert.match(shader.fragmentShader, /return;\n#include <opaque_fragment>/);
    assert.ok(shader.fragmentShader.indexOf('return;\n#include <opaque_fragment>') < shader.fragmentShader.indexOf('#include <tonemapping_fragment>'));
    assert.equal(material.toneMapped, false);
    assert.equal(original.toneMapped, true);
  } finally { material.dispose(); original.dispose(); }
});

test('pixel-center coordinates agree with screen origin and bottom-left readPixels origin', () => {
  assert.deepEqual(probePixel({ name: 'top-left', x: 0, y: 0 }, 1920, 1080),
    { x: 0, glY: 1079, ndc: [0.5 / 1920 * 2 - 1, 1 - 0.5 / 1080 * 2] });
  assert.equal(probePixel({ x: 1919, y: 1079 }, 1920, 1080).glY, 0);
  assert.throws(() => probePixel({ x: 1920, y: 0 }, 1920, 1080), /outside target/);
});

test('offscreen orchestration reads all five modes and reports the original terrain ray hit', t => {
  const fx = fixture(t);
  const report = probeTerrainMaterials(fx.app, { points: [{ name: 'ground', x: 960, y: 540 }] });
  assert.equal(report.encoding, 'float32-linear-raw');
  assert.deepEqual(fx.diagnostics.modes, [1, 2, 3, 4, 5]);
  assert.equal(fx.diagnostics.reads.length, 5);
  assert.ok(fx.diagnostics.reads.every(read => read.x === 960 && read.y === 539 && read.width === 1 && read.height === 1));
  assert.ok(Math.abs(report.points[0].values.rk - 0.1) < 1e-7);
  assert.equal(report.points[0].hit.lod, 0);
  assert.ok(Math.abs(report.points[0].hit.world[1]) < 1e-6);
  assert.equal(report.points[0].hit.skirt, false);
  assert.equal(report.points[0].hit.shaderDisplacementPossible, false);
  fx.assertRestored();
});

test('renderer state and temporary resources are restored even when GPU readback throws', t => {
  const fx = fixture(t, { failRead: true });
  assert.throws(() => probeTerrainMaterials(fx.app, { points: [{ name: 'ground', x: 960, y: 540 }] }), /synthetic raw read/);
  fx.assertRestored();
});

test('byte fallback reports quantization rather than pretending its values are float readbacks', t => {
  const fx = fixture(t, { floating: false });
  const report = probeTerrainMaterials(fx.app, { points: [{ name: 'ground', x: 960, y: 540 }] });
  assert.equal(report.encoding, 'unorm8-linear-raw');
  assert.equal(report.quantization, 1 / 255);
  assert.equal(report.points[0].values.rk, 10 / 255);
  fx.assertRestored();
});

test('CLI is connect-only and rejects malformed parameters without launching a browser', () => {
  const options = parseProbeArgs(['--port', '9441', '--out', 'tmp-probe', '--shots', 'forest_dense,chase_summer_noon']);
  assert.equal(options.port, 9441);
  assert.deepEqual(options.shots, ['forest_dense', 'chase_summer_noon']);
  assert.throws(() => parseProbeArgs(['--port', 'NaN']), /CDP port/);
  assert.throws(() => parseProbeArgs(['--unexpected', 'x']), /Invalid option/);
  const source = readFileSync(new URL('./terrain-material-probe.mjs', import.meta.url), 'utf8');
  assert.match(source, /connectOverCDP/);
  assert.doesNotMatch(source, /chromium\.launch|browser\.mjs|\.screenshot\(/);
  assert.match(source, /__rig\.ready/);
});
