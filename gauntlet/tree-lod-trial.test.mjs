import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { createTreeLodTrial, parseTreeLodBands, populationFingerprint, comparePopulationFingerprints,
  captureTreeSelection, compareTreeSelections, treeSubmissionTotals } from './tree-lod-trial-helper.mjs';
import { parseTreeLodTrialArgs, recordTreeLodSnapshot, runTreeLodTrial } from './tree-lod-trial.mjs';

const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true }
    : next(url, context);
} });

function fixture() {
  const treeRange = { low: 110, high: 200, fadeStart: 1800, fadeEnd: 2000 };
  const terrain = { farRidgeAmp: 104, farRidgeNear: 680, farRidgeFar: 5200 };
  const material = (kind = 'tree', values = [110, 200, 1800, 2000]) => {
    const uniform = { value: Object.fromEntries(['x', 'y', 'z', 'w'].map((key, i) => [key, values[i]])) };
    return { uniform, userData: { foliageTemplate: { kind }, foliageLodRange: treeRange, foliageLodUniform: uniform },
      onBeforeCompile(shader) { shader.uniforms.uFoliageLod = uniform; } };
  };
  const mesh = (kind = 'tree', level = 'near') => ({ userData: { foliageKind: kind, foliageLevel: level,
    foliageMaximumHeight: 40, instanceVisibilityVersion: 4, worldBoundsPadding: 123 } });
  const tree = material(), shrub = material('shrub', [60, 110, 190, 220]);
  const near = mesh(), far = mesh('tree', 'far'), shrubMesh = mesh('shrub');
  const forest = { pixelScale: 4000, materials: new Map([['tree', { bark: tree }], ['shrub', { leaf: shrub }]]),
    meshes: new Set([near, far, shrubMesh]) };
  return { treeRange, terrain, forest, tree, shrub, near, far, shrubMesh, material, mesh };
}

test('band and CLI validation rejects invalid or non-earlier trials without starting a browser', () => {
  assert.deepEqual(parseTreeLodBands('140:230,160:260'), [{ low: 140, high: 230 }, { low: 160, high: 260 }]);
  for (const value of ['', '0:200', '260:160', 'NaN:260', '160:', '160:260:300', '1:2,3:4,5:6', '160:260,160:260']) assert.throws(() => parseTreeLodBands(value));
  assert.throws(() => parseTreeLodTrialArgs([]), /private --port/);
  assert.throws(() => parseTreeLodTrialArgs(['--port', '9421', '--bands', '100:200']), /earlier/);
  const options = parseTreeLodTrialArgs(['--port', '9421', '--bands', '160:260', '--dry-run']);
  assert.equal(options.dryRun, true); assert.equal(options.driveMs, 6000);
  assert.deepEqual(options.viewport, { width: 1920, height: 1080 });
  assert.match(options.query, /paused=1/); assert.match(options.query, /dpr=1/);
});

test('a tree-only trial changes CPU and the same live GPU uniform while leaving shrubs untouched', () => {
  const fx = fixture(), trial = createTreeLodTrial(fx);
  const shrubBefore = structuredClone(fx.shrub.uniform.value), shrubMeshBefore = structuredClone(fx.shrubMesh.userData);
  const result = trial.apply({ low: 160, high: 260 });
  assert.equal(fx.treeRange.low, 160); assert.equal(fx.treeRange.high, 260);
  assert.deepEqual(fx.tree.uniform.value, { x: 160, y: 260, z: 1800, w: 2000 });
  assert.equal(result.treeMaterials, 1); assert.equal(result.meshes, 2);
  assert.equal(fx.near.userData.instanceVisibilityVersion, 5);
  assert.deepEqual(fx.shrub.uniform.value, shrubBefore); assert.deepEqual(fx.shrubMesh.userData, shrubMeshBefore);
  trial.restore();
  assert.deepEqual(fx.treeRange, { low: 110, high: 200, fadeStart: 1800, fadeEnd: 2000 });
  assert.deepEqual(fx.tree.uniform.value, { x: 110, y: 200, z: 1800, w: 2000 });
  assert.equal(fx.near.userData.instanceVisibilityVersion, 6);
});

test('finally restoration includes materials and meshes created during driving and recomputes baseline padding', () => {
  const fx = fixture(), trial = createTreeLodTrial(fx);
  let newMaterial, newMesh, trialPadding;
  assert.throws(() => {
    try {
      trial.apply({ low: 160, high: 260 });
      newMaterial = fx.material('tree', [160, 260, 1800, 2000]); newMesh = fx.mesh();
      fx.forest.materials.set('new-tree', { leaf: newMaterial }); fx.forest.meshes.add(newMesh);
      trial.apply({ low: 160, high: 260 });
      trialPadding = newMesh.userData.worldBoundsPadding;
      fx.forest.pixelScale = 4200;
      throw new Error('synthetic screenshot failure');
    } finally { trial.restore(); }
  }, /screenshot failure/);
  assert.deepEqual(newMaterial.uniform.value, { x: 110, y: 200, z: 1800, w: 2000 });
  assert.equal(fx.treeRange.low, 110);
  const distance = Math.min(2000, 40 * 4200 / 110), t = (distance - 680) / (5200 - 680);
  assert.equal(newMesh.userData.worldBoundsPadding, 104 * (t * t * (3 - 2 * t)));
  assert.ok(newMesh.userData.worldBoundsPadding > trialPadding);
  assert.ok(newMesh.userData.instanceVisibilityVersion > 4);
});

test('invalid bands and unstable material hooks cannot silently create a CPU-only override', () => {
  const fx = fixture(), trial = createTreeLodTrial(fx);
  assert.throws(() => trial.apply({ low: 300, high: 200 }));
  assert.equal(fx.treeRange.low, 110); assert.equal(fx.tree.uniform.value.x, 110);
  const other = fixture();
  other.tree.onBeforeCompile = shader => { shader.uniforms.uFoliageLod = { value: { x: 110, y: 200, z: 1800, w: 2000 } }; };
  assert.throws(() => createTreeLodTrial(other), /compile hook/);
  assert.equal(other.treeRange.low, 110);
});

test('an equal-valued module-copy range is rejected instead of being mistaken for the live CPU object', () => {
  const fx = fixture(), copiedModuleRange = { ...fx.treeRange };
  assert.throws(() => createTreeLodTrial({ ...fx, treeRange: copiedModuleRange }), /not the live CPU range object/);
  assert.deepEqual(copiedModuleRange, fx.treeRange);
  const trial = createTreeLodTrial({ forest: fx.forest, terrain: fx.terrain });
  try {
    assert.equal(trial.isLiveRange(copiedModuleRange), false);
    assert.equal(trial.isLiveRange(fx.treeRange), true);
    trial.apply({ low: 160, high: 260 });
    assert.equal(fx.treeRange.low, 160); assert.equal(copiedModuleRange.low, 110);
    assert.equal(fx.tree.uniform.value.x, 160);
  } finally { trial.restore(); }
});

test('a late material born during the trial cannot keep candidate uniforms after a repeated restore', () => {
  const fx = fixture(), trial = createTreeLodTrial(fx);
  trial.apply({ low: 160, high: 260 });
  const late = fx.material('tree', [160, 260, 1800, 2000]);
  trial.restore();
  fx.forest.materials.set('late', { bark: late });
  trial.restore();
  assert.deepEqual(late.uniform.value, { x: 110, y: 200, z: 1800, w: 2000 });
});

test('population fingerprints are order-stable but detect changed canonical roots or counts', () => {
  const a = ['a', { job: { kind: 'tree' }, records: [{ id: 'a:1', x: 1, y: 2, z: 3, height: 20, width: 8 }] }];
  const b = ['b', { job: { kind: 'shrub' }, records: [{ id: 'b:1', x: 4, y: 5, z: 6, height: 1, width: 1 }] }];
  const baseline = populationFingerprint(new Map([a, b]));
  assert.deepEqual(populationFingerprint(new Map([b, a])), baseline);
  b[1].records[0].x += 0.01;
  assert.notEqual(populationFingerprint(new Map([a, b])).hash, baseline.hash);
  assert.notEqual(populationFingerprint(new Map([a])).records, baseline.records);
});

test('numeric fingerprint tags distinguish missing, undefined, NaN, infinities and finite values without rounding', () => {
  const record = { id: 'tree:1', x: 1, y: 2, z: 3, height: 20, width: 8 };
  const fingerprint = value => populationFingerprint(new Map([['tile', { job: { kind: 'tree' }, records: [value] }]]));
  const cases = [record, ...[undefined, NaN, Infinity, -Infinity, null, 0, -0, 1, 1 + Number.EPSILON, '1']
    .map(value => ({ ...record, surfaceY: value }))];
  const results = cases.map(fingerprint);
  assert.equal(new Set(results.map(result => result.hash)).size, cases.length);
  assert.equal(results[0].legacyHash, results[1].legacyHash, 'the legacy hash conflated missing and explicit undefined');
  assert.equal(results[0].numeric.surfaceY.missing, 1);
  assert.equal(results[1].numeric.surfaceY.undefined, 1);
  assert.equal(results[2].numeric.surfaceY.nan, 1);
  assert.equal(results[7].numeric.surfaceY.negativeZero, 1);
  assert.notEqual(results[8].hash, results[9].hash, 'finite values retain every Float64 bit');
  assert.equal(comparePopulationFingerprints(results[0], results[1]).equal, false);
});

test('NaN payloads remain observable in legacy diagnostics but cannot change a typed canonical fingerprint', () => {
  const make = payload => {
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(0, payload, true); view.setUint32(4, 0x7ff80000, true);
    const record = { id: 'tree:1', x: 1, y: 2, z: 3, height: 20, width: 8 };
    Object.defineProperty(record, 'surfaceY', { enumerable: true, get: () => view.getFloat64(0, true) });
    return populationFingerprint(new Map([['tile', { job: { kind: 'tree' }, records: [record] }]]));
  };
  const a = make(1), b = make(2), comparison = comparePopulationFingerprints(a, b);
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.legacyHash, b.legacyHash);
  assert.equal(comparison.equal, true); assert.equal(comparison.legacyEqual, false);
  assert.equal(comparison.classification, 'legacy-nan-representation-only');
  assert.equal(a.legacyNaNBits['7ff8000000000001'], 1);
  assert.equal(b.legacyNaNBits['7ff8000000000002'], 1);
});

test('per-tile differences separate membership changes from real canonical field changes', () => {
  const tile = { job: { kind: 'tree' }, records: [{ id: 'tree:1', x: 1, y: 2, z: 3, height: 20, width: 8 }] };
  const baseline = populationFingerprint(new Map([['a', tile]]));
  const moved = structuredClone(tile); moved.records[0].x += 0.01;
  const changed = comparePopulationFingerprints(baseline, populationFingerprint(new Map([['a', moved]])));
  assert.equal(changed.equal, false); assert.equal(changed.classification, 'canonical-record-difference');
  assert.deepEqual(changed.changedTiles[0].changedFields, ['x']);
  assert.equal(changed.changedTiles[0].idsChanged, false);
  const shifted = comparePopulationFingerprints(baseline, populationFingerprint(new Map([['b', tile]])));
  assert.equal(shifted.equal, false); assert.equal(shifted.classification, 'tile-set-difference');
  assert.deepEqual(shifted.addedTiles, ['b']); assert.deepEqual(shifted.removedTiles, ['a']);
});

test('an incomparable candidate snapshot and detailed difference are on disk before failure propagates', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'slowroad-lod-snapshot-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tile = { job: { kind: 'tree' }, records: [{ id: 'tree:1', x: 1, y: 2, z: 3, height: 20, width: 8 }] };
  const snapshot = (entry, low, high) => ({ population: populationFingerprint(new Map([['tile', entry]])),
    pose: { seed: 7, s: 6400, camera: [0, 1, 2] }, streaming: { vegetationSignature: 'same', terrainAnchor: 'same' },
    cpuProbe: { ok: true }, treeSelection: { ok: true, treeTriangles: low === 110 ? 100 : 60,
      byPart: { bark: { batches: 1, instances: low === 110 ? 2 : 1, triangles: low === 110 ? 100 : 60 } } },
    lod: { range: { low, high, fadeStart: 1800, fadeEnd: 2000 }, uniforms: [[low, high, 1800, 2000]] } });
  const report = { status: 'running', stages: [] }, baseline = snapshot(tile, 110, 200);
  recordTreeLodSnapshot(report, { name: 'baseline', band: { low: 110, high: 200 } }, baseline, baseline, directory);
  const moved = structuredClone(tile); moved.records[0].x = 1.01;
  assert.throws(() => recordTreeLodSnapshot(report, { name: 'trial-160-260', band: { low: 160, high: 260 } },
    snapshot(moved, 160, 260), baseline, directory), /not comparable/);
  const saved = JSON.parse(readFileSync(path.join(directory, 'tree-lod-trial-160-260.snapshot.json'), 'utf8'));
  assert.equal(saved.status, 'incomparable');
  assert.equal(saved.snapshot.population.tiles[0].numeric.x.min, 1.01);
  assert.deepEqual(saved.comparison.population.changedTiles[0].changedFields, ['x']);
  assert.deepEqual(saved.invariants, { population: false, pose: true, cpuPredicate: true, treeSelection: true, cpuGpuLod: true });
  const final = JSON.parse(readFileSync(path.join(directory, 'tree-lod-trial.json'), 'utf8'));
  assert.equal(final.status, 'failed'); assert.equal(final.stages.length, 2);
});

test('a GPU-only mutation cannot pass when the real CPU predicate and selected workload did not change', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'slowroad-lod-gpu-only-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const population = populationFingerprint(new Map([['tile', { job: { kind: 'tree' }, records: [{ id: 'a', x: 1, y: 2, z: 3 }] }]]));
  const baseline = { population, pose: { seed: 7 }, cpuProbe: { ok: true },
    treeSelection: { ok: true, treeTriangles: 100, byPart: { bark: { batches: 1, instances: 2, triangles: 100 } } },
    lod: { range: { low: 110, high: 200, fadeStart: 1800, fadeEnd: 2000 }, uniforms: [[110, 200, 1800, 2000]] } };
  const candidate = { ...baseline, cpuProbe: { ok: false, cases: [{ pixels: 111, expectedNear: false, actualNear: true }] },
    lod: { range: { low: 160, high: 260, fadeStart: 1800, fadeEnd: 2000 }, uniforms: [[160, 260, 1800, 2000]] } };
  const report = { status: 'running', stages: [] };
  assert.throws(() => recordTreeLodSnapshot(report, { name: 'trial-160-260', band: { low: 160, high: 260 } }, candidate, baseline, directory), /not comparable/);
  assert.equal(report.stages[0].invariants.cpuGpuLod, true);
  assert.equal(report.stages[0].invariants.cpuPredicate, false);
  assert.equal(report.stages[0].invariants.treeSelection, false);
  assert.equal(report.status, 'failed');
});

test('actual submitted tree triangles and calls are grouped independently of grass and shrub submissions', () => {
  const result = treeSubmissionTotals({ submissions: { 'field-tree-pine-bark': 300, 'field-tree-oak-leaf': 500,
    'field-tree-pine-impostor': 20, 'field-grass': 900, 'field-shrub-shrub-1-leaf': 100 },
  submissionCalls: { 'field-tree-pine-bark': 2, 'field-tree-oak-leaf': 3, 'field-tree-pine-impostor': 4 } });
  assert.equal(result.triangles, 820); assert.equal(result.calls, 9);
  assert.deepEqual(result.byPart.impostor, { triangles: 20, calls: 4 });
});

test('existing trial reports cannot be overwritten by a rerun', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'slowroad-lod-immutable-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(directory, 'tree-lod-trial.json'), '{"status":"failed"}\n');
  await assert.rejects(runTreeLodTrial({ out: directory }), /fresh --out/);
  assert.equal(readFileSync(path.join(directory, 'tree-lod-trial.json'), 'utf8'), '{"status":"failed"}\n');
});

test('the real ForestField closures change together without recompiling materials or modifying records', async () => {
  const { ForestField, FOREST_LOD, makeFoliageMaterial } = await import('../src/vegetation/forestField.js');
  const { InstanceCuller } = await import('../src/vegetation/instanceCulling.js');
  const { TERRAIN } = await import('../src/terrain/params.js');
  const geometry = new THREE.BoxGeometry(0.5, 1, 0.5).translate(0, 0.5, 0);
  const template = { name: 'pine', species: 'pine', kind: 'tree', parts: { bark: geometry, leaf: geometry },
    maps: { bark: null, leaf: null }, impostor: { shape: { width: 0.5 }, texture: null, normalTexture: null } };
  const forest = Object.assign(Object.create(ForestField.prototype), { assets: { templates: new Map([['pine', template]]), dispose() {} },
    meshes: new Set(), pixelScale: 1000, uniforms: { uFoliageBare: { value: 0 } },
    materials: new Map(), billboards: new Map([['pine', new THREE.PlaneGeometry(1, 1)]]) });
  const group = Object.fromEntries(['bark', 'leaf', 'impostor'].map(part => [part, makeFoliageMaterial(template, part, forest.uniforms, { register() {} })]));
  forest.materials.set('pine', group);
  const record = Object.freeze({ id: 'canonical', species: 'pine', x: 0, y: 0, z: 0, height: 10, width: 6, yaw: 0, rank: 0.5 });
  const meshes = forest.build([record]), versions = Object.values(group).map(material => material.version);
  const camera = new THREE.PerspectiveCamera();
  const renderGroup = new THREE.Group(); renderGroup.add(...meshes);
  const app = { veg: { group: renderGroup }, cameras: { camera }, instanceCulling: new InstanceCuller(), renderer: { info: { render: {} } } };
  const trial = createTreeLodTrial({ treeRange: FOREST_LOD.tree, forest, terrain: TERRAIN });
  const candidate = { low: trial.original.low + 50, high: trial.original.high + 60 };
  const bands = [trial.original, candidate];
  const projectedHeight = record.height * forest.pixelScale;
  const nearDistance = projectedHeight / ((trial.original.low + candidate.low) * 0.5);
  const farDistance = projectedHeight / ((trial.original.high + candidate.high) * 0.5);
  camera.position.set(0, record.y + record.height * 0.5, nearDistance);
  try {
    assert.equal(group.bark.userData.foliageLodRange, FOREST_LOD.tree);
    assert.equal(Object.getOwnPropertyDescriptor(group.bark.userData, 'foliageLodRange').writable, false);
    assert.equal(Object.getOwnPropertyDescriptor(group.bark.userData, 'foliageLodUniform').writable, false);
    const baselineProbe = trial.probe(bands), baselineSelection = captureTreeSelection(app);
    assert.equal(baselineProbe.ok, true);
    assert.equal(meshes[0].userData.instanceVisible(0, camera), true);
    camera.position.z = farDistance;
    assert.equal(meshes[2].userData.instanceVisible(0, camera), false);
    trial.apply(candidate);
    assert.equal(meshes[2].userData.instanceVisible(0, camera), true);
    camera.position.z = nearDistance;
    assert.equal(meshes[0].userData.instanceVisible(0, camera), false);
    assert.ok(trial.describe().uniforms.every(values => values[0] === candidate.low && values[1] === candidate.high));
    const probe = trial.probe(bands), selected = captureTreeSelection(app);
    assert.equal(probe.ok, true);
    assert.ok(probe.nearAccepted < baselineProbe.nearAccepted);
    assert.ok(probe.farAccepted > baselineProbe.farAccepted);
    assert.equal(compareTreeSelections(baselineSelection, selected).changed, true);
    assert.ok(selected.byPart.bark.instances < baselineSelection.byPart.bark.instances);
    assert.ok(selected.treeTriangles < baselineSelection.treeTriangles);
    const livePredicate = meshes[0].userData.instanceVisible, staleRange = { ...trial.original };
    try {
      meshes[0].userData.instanceVisible = (_index, view) => {
        const distance = Math.abs(record.y + record.height * 0.5 - view.position.y);
        const pixels = record.height * forest.pixelScale / Math.max(0.5, distance);
        return pixels >= staleRange.low - 0.01 && distance <= staleRange.fadeEnd + 1;
      };
      assert.equal(trial.probe(bands).ok, false, 'correct GPU bindings cannot conceal a CPU callback using a module-copy range');
    } finally { meshes[0].userData.instanceVisible = livePredicate; }
    assert.deepEqual(Object.values(group).map(material => material.version), versions);
    assert.equal(meshes[0].userData.population[0], record);
  } finally { trial.restore(); app.instanceCulling.dispose(); forest.dispose(); geometry.dispose(); }
  assert.deepEqual(FOREST_LOD.tree, trial.original);
});
