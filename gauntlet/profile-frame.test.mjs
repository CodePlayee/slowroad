import assert from 'node:assert/strict';
import test from 'node:test';
import { profileScene } from './profile-frame.mjs';

function fixture(t, { legacy = false, timer = true, available = true, disjoint = false, failRender } = {}) {
  const noop = () => {};
  const queries = new Set(), ratios = [], extension = { TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2 };
  const gl = {
    RENDERER: 3, QUERY_RESULT_AVAILABLE: 4, QUERY_RESULT: 5,
    getExtension(name) { return name === 'EXT_disjoint_timer_query_webgl2' && timer ? extension : null; },
    getParameter(key) { return key === extension.GPU_DISJOINT_EXT ? disjoint : 'mock GPU'; },
    createQuery() { const q = {}; queries.add(q); return q; },
    beginQuery: noop, endQuery: noop,
    getQueryParameter(q, key) { return key === this.QUERY_RESULT_AVAILABLE ? available : 2e6; },
    deleteQuery(q) { queries.delete(q); },
  };
  const mesh = (name, triangles, userData = {}, visible = true) => Object.assign(Object.create({ onBeforeRender: noop }), {
    isMesh: true, visible, material: { name }, userData, triangles,
    geometry: { index: { count: triangles * 3 }, attributes: {} },
  });
  const meshes = legacy ? [
    mesh('veg-meadow', 3), mesh('understory-leaf', 5), mesh('woodland-oak', 7), mesh('veg-flowerBlossom', 11),
  ] : [
    mesh('field-grass', 3, { field: 'grass' }), mesh('field-shrub-hazel-leaf', 5, { field: 'forest', foliageKind: 'shrub' }),
    mesh('field-tree-oak-leaf', 7, { field: 'forest', foliageKind: 'tree' }), mesh('field-flowerBlossom', 11, { field: 'flowers' }),
  ];
  meshes.push(mesh('terrain', 13), mesh('vehicle', 17), mesh('field-grass', 19, { field: 'grass' }, false));
  const scene = { traverse(fn) { for (const object of meshes) fn(object); } };
  let ratio = 2, renderCalls = 0, restores = 0, paused = true;
  const renderer = {
    info: { render: {} }, getContext: () => gl, getPixelRatio: () => ratio,
    setPixelRatio(value) { ratio = value; ratios.push(value); },
    render() {
      renderCalls++;
      if (failRender?.({ renderCalls, ratio, meshes })) throw new Error('synthetic render failure');
      let triangles = 0, calls = 0;
      for (const object of meshes) {
        if (!object.visible) continue;
        object.onBeforeRender(renderer, scene, {}, object.geometry, object.material);
        triangles += object.triangles; calls++;
      }
      this.info.render = { triangles, calls };
    },
  };
  const veg = legacy ? { woodland: { sync: noop } } : {
    generation: 2, grass: { update: noop }, forest: { update: noop }, flowers: { update: noop },
  };
  veg.update = function() { this.woodland?.sync(); this.grass?.update(); this.forest?.update(); this.flowers?.update(); };
  const app = {
    veg, renderer, scene, cameras: { camera: {} },
    scheduler: { run: noop }, terrain: { update: noop, refreshCoverage: noop }, road: { update: noop }, bridges: { update: noop },
    instanceCulling: { prepare: noop, restore() { restores++; } },
    frame() {
      this.scheduler.run(); this.terrain.update(); this.terrain.refreshCoverage(); this.veg.update();
      this.road.update(); this.bridges.update(); this.instanceCulling.prepare(); renderer.render();
    },
    async nextFrame() { this.frame(); },
  };
  const originalMethods = [app, veg, renderer, app.scheduler, app.terrain, app.road, app.bridges, app.instanceCulling,
    veg.woodland, veg.grass, veg.forest, veg.flowers].filter(Boolean).map(object => [object, Object.getOwnPropertyDescriptors(object)]);
  for (const [key, value] of Object.entries({ __app: app, __rig: { pause() { paused = true; }, resume() { paused = false; } }, innerWidth: 800, innerHeight: 600 })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  return {
    app, meshes, ratios,
    assertRestored() {
      for (const [object, descriptors] of originalMethods) {
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (typeof descriptor.value === 'function') assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), descriptor);
        }
      }
      assert.ok(meshes.every(object => !Object.hasOwn(object, 'onBeforeRender')));
      assert.deepEqual(meshes.map(object => object.visible), [true, true, true, true, true, true, false]);
      assert.equal(renderer.getPixelRatio(), 2);
      assert.equal(queries.size, 0);
      assert.ok(restores > 0);
      assert.equal(paused, true);
    },
  };
}

const options = { ablation: true, warmupFrames: 1, sampleFrames: 2, queryDrainFrames: 1 };

for (const legacy of [false, true]) {
  test(`profiles ${legacy ? 'legacy' : 'generation-2'} vegetation and ablates each field`, async t => {
    const fx = fixture(t, { legacy });
    const result = await profileScene(options);
    assert.equal(result.vegetationGeneration, legacy ? 1 : 2);
    assert.deepEqual(result.viewport, [800, 600]);
    for (const [key, triangles] of Object.entries({ full: 56, 'without-understory': 51, 'without-grass': 53,
      'without-woodland': 49, 'without-terrain': 43, 'without-vegetation': 30, 'full-repeat': 56 })) {
      assert.equal(result.stages[key].render.triangles, triangles, key);
      assert.equal(result.stages[key].gpuMs.mean, 2);
      assert.equal(result.stages[key].gpuSamples, 2);
      assert.ok(result.stages[key].cpuMs[legacy ? 'woodland' : 'forestField']);
    }
    assert.deepEqual(fx.ratios, [1, 2, 2]);
    fx.assertRestored();
  });
}

for (const mode of [{ timer: false }, { available: false }, { disjoint: true }]) {
  test(`does not report absent or invalid GPU samples as zero milliseconds: ${JSON.stringify(mode)}`, async t => {
    const fx = fixture(t, mode), result = await profileScene({ ...options, ablation: false });
    assert.equal(result.stages.full.gpuMs, null);
    assert.equal(result.stages.full.gpuSamples, 0);
    fx.assertRestored();
  });
}

for (const [name, failRender] of [
  ['submission counting', ({ renderCalls }) => renderCalls === 1],
  ['ablation rendering', ({ meshes }) => !meshes[1].visible],
  ['half-resolution rendering', ({ ratio }) => ratio === 1],
]) {
  test(`restores methods, visibility, pixel ratio, mesh hooks, and queries after ${name} fails`, async t => {
    const fx = fixture(t, { failRender });
    await assert.rejects(profileScene(options), /synthetic render failure/);
    fx.assertRestored();
  });
}

test('submission counts respect draw ranges and instanced multiplicity', async t => {
  const fx = fixture(t);
  Object.assign(fx.meshes[0], { isInstancedMesh: true, count: 4 });
  fx.meshes[0].geometry.drawRange = { start: 3, count: 3 };
  const result = await profileScene({ ...options, ablation: false });
  assert.equal(result.submissions['field-grass'], 4);
  assert.equal(result.submissionCalls['field-grass'], 1);
  assert.equal(result.submissionCalls['field-tree-oak-leaf'], 1);
  fx.assertRestored();
});

test('an optional fixed driving duration is independent of the static sample-frame count', async t => {
  const fx = fixture(t), nextFrame = fx.app.nextFrame;
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  fx.app.nextFrame = async function() { now += 20; return nextFrame.call(this); };
  try {
    const result = await profileScene({ ...options, ablation: false, drivingMs: 75 });
    assert.equal(result.stages.full.frames, 2);
    assert.equal(result.stages.driving.frames, 4);
    assert.equal(result.stages.driving.elapsedMs, 80);
  } finally { fx.app.nextFrame = nextFrame; }
  fx.assertRestored();
});
