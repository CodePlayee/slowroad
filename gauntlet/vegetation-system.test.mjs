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
const { VegetationSystem } = await import('../src/vegetation/system.js');
const { Scheduler } = await import('../src/streaming/scheduler.js');
const { POPULATION, generatePopulation } = await import('../src/vegetation/population.js');
const { GrassField } = await import('../src/vegetation/grassField.js');
const { GRASS_COVERAGE } = await import('../src/vegetation/grassCoverage.js');

class ControlledPool {
  constructor() { this.available = true; this.jobs = new Map(); this.requests = []; this.resets = 0; }
  get pending() { return this.jobs.size; }
  request(key, job, priority) {
    if (!this.available) return false;
    if (!this.jobs.has(key)) {
      this.jobs.set(key, { job, priority, result: null });
      this.requests.push(key);
    } else this.jobs.get(key).priority = priority;
    return true;
  }
  has(key) { return this.jobs.has(key); }
  complete(key, records) { this.jobs.get(key).result = { records }; }
  fail(key) { this.jobs.get(key).result = { error: 'synthetic worker failure' }; }
  poll(key) {
    const entry = this.jobs.get(key);
    if (!entry?.result) return null;
    this.jobs.delete(key);
    return entry.result;
  }
  cancelExcept(keys) { for (const key of this.jobs.keys()) if (!keys.has(key)) this.jobs.delete(key); }
  reset() { this.resets++; this.jobs.clear(); }
  dispose() { this.available = false; this.jobs.clear(); }
}

function field(name) {
  return {
    builds: [], disposed: [], updates: [],
    build(records, kind) {
      this.builds.push({ records, kind });
      if (!records.length) return [];
      const mesh = new THREE.Object3D();
      mesh.name = name;
      mesh.userData.ids = records.map(record => record.id);
      return [mesh];
    },
    update(...args) { this.updates.push(args); },
    disposeMesh(mesh) { mesh.removeFromParent(); this.disposed.push(mesh); },
    dispose() { this.wasDisposed = true; },
  };
}

function fixture(t) {
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const world = {
    seed: 7,
    sample(x, z, out) { Object.assign(out, { y: 40, waterY: 0, roadDist: 12, moisture: 0.8, riverDist: 100, channelHalf: 5 }); },
    slopeAt(x, z, y, e, out) { out.dx = 0.02; out.dz = -0.01; return 0.01; },
  };
  const terrain = {
    ready: true, coverageRevision: 0, calls: [],
    coversBounds(...bounds) { this.calls.push(bounds); return this.ready; },
    setReady(value) { this.ready = value; this.coverageRevision++; },
  };
  const system = Object.assign(Object.create(VegetationSystem.prototype), {
    generation: 2, seasonInShader: true, world, seed: 7 ^ 0x2b7c1f03, version: 0,
    atmo: { seasonName: 'summer', renderer: { domElement: { height: 720 } } }, terrain,
    scheduler: new Scheduler(3), pool: new ControlledPool(), group: new THREE.Group(),
    grass: field('grass'), forest: field('forest'), flowers: field('flowers'),
    tiles: new Map(), cache: new Map(), cpuReady: new Map(), _streamJobs: [], _streamWant: new Set(),
    _signature: '', _coverageRevision: -1, _clock: now, time: 0,
    _publishFrame: -1, _published: 0, required: 0, fallbacks: 0,
    assetReady: true, assetError: null, seasonName: 'summer',
  });
  t.after(() => system.dispose());
  return {
    system, terrain,
    advance(ms = 16) { now += ms; },
    update(x = 16, z = 16, newFrame = true) { if (newFrame) now += 16; system.update(x, z); },
  };
}

function records(job, count = 2, seed = 7) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${job.kind}:${seed}:${job.i}:${job.j}:${index}`, kind: job.kind,
    x: (job.i + 0.2 + index * 0.1) * POPULATION[job.kind].tile,
    z: (job.j + 0.3) * POPULATION[job.kind].tile, y: 40,
    height: job.kind === 'tree' ? 14 : 0.7, width: job.kind === 'tree' ? 8 : 0.8,
    yaw: 0.2, phase: 0.4, rank: 0.01, variant: 0, species: 'oak', moisture: 0.8, cover: 0.2,
  }));
}

function originJob(system, kind = 'grass') {
  return system._streamJobs.find(job => job.kind === kind && job.i === 0 && job.j === 0);
}

function drainPublications(system) {
  system.scheduler.run(1000);
  assert.equal(system.scheduler.error, null);
}

function publishResult(fx, job, data = records(job)) {
  fx.system.pool.complete(job.key, data);
  fx.update();
  fx.update();
  drainPublications(fx.system);
  return fx.system.tiles.get(job.key);
}

test('new-system API plans one lattice per category and reports pending cells accurately', (t) => {
  const fx = fixture(t), { system } = fx;
  assert.equal(system.generation, 2);
  assert.equal(system.seasonInShader, true);
  assert.equal(system.minimumReady, false);
  fx.update();
  const expected = Object.values(POPULATION).reduce((n, config) => n + (config.radius * 2 + 1) ** 2, 0);
  assert.equal(system.required, expected);
  assert.equal(system.resident, 0);
  assert.equal(system.pending, expected);
  assert.equal(system.pool.pending, expected);
  assert.equal(new Set(system._streamJobs.map(job => job.key)).size, expected);
  for (const [kind, level, pad] of [['grass', 0, 2], ['shrub', 1, 3], ['tree', 4, 30]]) {
    const job = originJob(system, kind), size = POPULATION[kind].tile;
    system._groundReady(job);
    assert.deepEqual(fx.terrain.calls.at(-1), [-pad, -pad, size + pad, size + pad, level]);
  }
});

test('approaching retained tree jobs refreshes worker and publication priorities without restarting them', t => {
  const fx = fixture(t), { system } = fx;
  fx.update(0, 0);
  const key = 'veg:0:tree:3:0', queued = system.pool.jobs.get(key);
  const originalPriority = queued.priority, requests = system.pool.requests.length;
  const buildKey = 'veg:0:tree:3:1';
  const oldBuild = system._streamJobs.find(job => job.key === buildKey);
  const continuation = () => {};
  system.scheduler.push(buildKey, 200000 + oldBuild.priority, continuation);
  system.scheduler.push('terrain:retained', -40000, () => {});
  fx.update(3.5 * POPULATION.tree.tile, 0.5 * POPULATION.tree.tile);
  const desired = system._streamJobs.find(job => job.key === key);
  assert.equal(system.pool.jobs.get(key), queued, 'the original work item stays queued');
  assert.equal(queued.priority, desired.priority);
  assert.ok(queued.priority < originalPriority);
  assert.equal(system.pool.requests.filter(value => value === key).length, 1);
  assert.ok(system.pool.requests.length >= requests, 'new leading-edge cells may enter');
  const task = system.scheduler.tasks.find(task => task.key === buildKey);
  assert.equal(task.fn, continuation);
  assert.equal(task.priority, 200000 + system._streamJobs.find(job => job.key === buildKey).priority);
  assert.equal(system.scheduler.tasks.find(task => task.key === 'terrain:retained').priority, -40000);
});

test('grass streaming rejects off-road cells but retains every possible diagonal verge intersection', t => {
  const fx = fixture(t), { system } = fx;
  const normal = { x: 0.6, z: -0.8 }, offset = 12;
  system.world.route = { nearest(x, z, reach) {
    const dist = Math.abs(x * normal.x + z * normal.z - offset);
    return dist <= reach ? { dist } : null;
  } };
  for (const [x, z] of [[16, 16], [-50, -70]]) {
    fx.update(x, z);
    const { tile: C, radius: R } = POPULATION.grass;
    const grass = system._streamJobs.filter(job => job.kind === 'grass');
    assert.ok(grass.length > 0 && grass.length < (2 * R + 1) ** 2);
    for (let j = Math.floor(z / C) - R; j <= Math.floor(z / C) + R; j++) {
      for (let i = Math.floor(x / C) - R; i <= Math.floor(x / C) + R; i++) {
        const signed = (i + 0.5) * C * normal.x + (j + 0.5) * C * normal.z - offset;
        const nearest = Math.max(0, Math.abs(signed) - C / 2 * (Math.abs(normal.x) + Math.abs(normal.z)));
        if (nearest < GRASS_COVERAGE.roadEnd) assert.ok(system._streamWant.has(`veg:0:grass:${i}:${j}`));
      }
    }
    for (const kind of ['tree', 'shrub']) assert.equal(system._streamJobs.filter(job => job.kind === kind).length,
      (2 * POPULATION[kind].radius + 1) ** 2, 'other vegetation keeps its independent streaming area');
  }
});

test('stationary worker completions advance to CPU readiness and scene publication without a coverage revision', (t) => {
  const fx = fixture(t), { system } = fx;
  fx.update();
  const signature = system._signature, revision = fx.terrain.coverageRevision;
  const job = originJob(system), data = records(job);
  system.pool.complete(job.key, data);
  fx.update();
  assert.equal(system.cpuReady.get(job.key), data);
  assert.equal(system.scheduler.has(job.key), false);
  assert.equal(system.group.children.length, 0);
  fx.update();
  assert.equal(system.scheduler.has(job.key), true);
  assert.equal(system.group.children.length, 0);
  drainPublications(system);
  assert.equal(system.tiles.get(job.key).records, data);
  assert.ok(system.tiles.get(job.key).meshes.every(mesh => mesh.visible));
  assert.equal(system._signature, signature);
  assert.equal(fx.terrain.coverageRevision, revision);
  assert.equal(system.pool.requests.filter(key => key === job.key).length, 1);
});

test('contact inputs start at supported scene publication, track support loss, and reset with the seed', t => {
  const fx = fixture(t), { system, terrain } = fx, events = [], inputs = [];
  let resets = 0;
  terrain.plantContactChanged = (entry, removed = false) => events.push({ key: entry.job.key, removed,
    published: system.tiles.has(entry.job.key), supported: entry.groundReady });
  terrain.updatePlantContact = tiles => inputs.push([...tiles.keys()]);
  terrain.resetPlantContact = () => resets++;
  fx.update();
  const job = system._streamJobs.find(job => job.kind === 'tree' && job.d < 280);
  system.pool.complete(job.key, records(job));
  fx.update();
  assert.deepEqual(events, []);
  assert.ok(inputs.every(keys => keys.length === 0), 'worker/CPU-ready data may not enter the contact field');
  fx.update();
  assert.deepEqual(events, [], 'queued build is not a published contact');
  drainPublications(system);
  assert.deepEqual(events, [{ key: job.key, removed: false, published: true, supported: true }]);
  terrain.setReady(false); fx.update();
  assert.deepEqual(events.at(-1), { key: job.key, removed: true, published: true, supported: false });
  terrain.setReady(true); fx.update();
  assert.equal(events.at(-1).removed, false);
  const callback = system._publishTask(job, records(job));
  system.rebuildAll();
  assert.equal(resets, 1);
  const count = events.length;
  callback();
  assert.equal(events.length, count, 'cancelled publication must not resurrect a contact');
  assert.equal(system.tiles.size, 0);
});

test('normal shrub-ring eviction identifies streaming and supplies the new contact focus', t => {
  const fx = fixture(t), { system, terrain } = fx, events = [];
  terrain.plantContactChanged = (entry, removed, change) => events.push({ key: entry.job.key, removed, change });
  fx.update(63.9, 0);
  const job = system._streamJobs.find(job => job.kind === 'shrub' && job.i === -4 && job.j === 0);
  assert.ok(job);
  system._publish(job, records(job));
  fx.update(64.1, 0);
  assert.deepEqual(events.find(event => event.key === job.key && event.removed), {
    key: job.key, removed: true, change: { reason: 'stream-eviction', focus: { x: 64.1, z: 0 } },
  });
});

test('completed records wait for assets and ground without starting partially visible field construction', (t) => {
  const fx = fixture(t), { system, terrain } = fx;
  terrain.setReady(false); system.assetReady = false;
  fx.update();
  const job = originJob(system), data = records(job);
  system.pool.complete(job.key, data);
  fx.update(); fx.update();
  assert.equal(system.cpuReady.get(job.key), data);
  assert.equal(system.grass.builds.length, 0);
  assert.equal(system.group.children.length, 0);
  system.assetReady = true;
  fx.update();
  assert.equal(system.scheduler.has(job.key), false);
  terrain.setReady(true);
  fx.update(); drainPublications(system);
  assert.equal(system.tiles.get(job.key).records, data);
  assert.ok(system.tiles.get(job.key).groundReady);
});

test('ground loss between scheduling and publication keeps newly built meshes hidden until support returns', (t) => {
  const fx = fixture(t), { system, terrain } = fx;
  fx.update();
  const job = originJob(system);
  system.pool.complete(job.key, records(job));
  fx.update(); fx.update();
  assert.equal(system.scheduler.has(job.key), true);
  terrain.setReady(false);
  drainPublications(system);
  const entry = system.tiles.get(job.key);
  assert.equal(entry.groundReady, false);
  assert.ok(entry.meshes.every(mesh => !mesh.visible));
  assert.equal(system.minimumReady, false);
  terrain.setReady(true);
  fx.update();
  assert.equal(entry.groundReady, true);
  assert.ok(entry.meshes.every(mesh => mesh.visible));
});

test('publication is capped at two cells per frame even when update runs twice', (t) => {
  const fx = fixture(t), { system } = fx;
  fx.update();
  const jobs = system._streamJobs.slice(0, 5);
  for (const job of jobs) system.pool.complete(job.key, records(job));
  fx.update(); fx.update();
  assert.equal(system.scheduler.pending, 2);
  drainPublications(system);
  fx.update(16, 16, false);
  assert.equal(system.tiles.size, 2);
  assert.equal(system.scheduler.pending, 0);
  fx.update(); drainPublications(system);
  assert.equal(system.tiles.size, 4);
  fx.update(); drainPublications(system);
  assert.equal(system.tiles.size, 5);
});

test('movement and revisit restore the same cached records and meshes without regeneration', (t) => {
  const fx = fixture(t), { system } = fx;
  fx.update();
  const job = originJob(system), entry = publishResult(fx, job);
  const ids = entry.records.map(record => record.id), meshes = [...entry.meshes];
  const requested = system.pool.requests.filter(key => key === job.key).length;
  fx.update(20000, -20000);
  assert.equal(system.tiles.has(job.key), false);
  assert.equal(system.cache.get(job.key), entry);
  assert.ok(meshes.every(mesh => !mesh.visible));
  fx.update();
  assert.equal(system.tiles.get(job.key), entry);
  assert.equal(system.cache.has(job.key), false);
  assert.deepEqual(entry.records.map(record => record.id), ids);
  assert.deepEqual(entry.meshes, meshes);
  assert.ok(meshes.every(mesh => mesh.visible));
  assert.equal(system.pool.requests.filter(key => key === job.key).length, requested);
  assert.equal(system.grass.builds.length, 1);
});

test('season changes update appearance without changing population, generation, requests, or meshes', (t) => {
  const fx = fixture(t), { system } = fx;
  fx.update();
  const job = originJob(system), entry = publishResult(fx, job);
  const requestCount = system.pool.requests.length, generation = system.version;
  for (const season of ['autumn', 'winter', 'spring', 'summer']) {
    assert.equal(system.setSeason(season), true);
    fx.update();
    assert.strictEqual(system.tiles.get(job.key), entry);
    assert.equal(system.version, generation);
    assert.equal(system.pool.requests.length, requestCount);
    assert.equal(system.grass.builds.length, 1);
  }
  assert.equal(system.setSeason('summer'), false);
  assert.equal(system.setSeason('constructor'), false);
  assert.equal(system.seasonName, 'summer');
});

test('flowers published in winter become visible again after a stationary spring change', (t) => {
  const fx = fixture(t), { system } = fx;
  system.setSeason('winter');
  fx.update();
  const entry = publishResult(fx, originJob(system));
  const flower = entry.meshes.find(mesh => mesh.userData.field === 'flowers');
  assert.equal(flower.visible, false);
  const revision = fx.terrain.coverageRevision, signature = system._signature;
  system.setSeason('spring');
  fx.update();
  assert.equal(fx.terrain.coverageRevision, revision);
  assert.equal(system._signature, signature);
  assert.equal(flower.visible, true, 'a winter visibility flag must not survive a shader-only season change');
});

test('rebuild invalidates CPU results, queued publications, and saved fallback continuations', (t) => {
  const fx = fixture(t), { system } = fx;
  fx.update();
  const [queued, ready, fallbackJob] = system._streamJobs.slice(0, 3);
  system.pool.complete(queued.key, records(queued));
  fx.update(); fx.update();
  const publishTask = system.scheduler.tasks.find(task => task.key === queued.key).fn;
  system.cpuReady.set(ready.key, records(ready));
  const fallback = system._fallback(fallbackJob);
  assert.equal(typeof fallback(), 'function');
  const previousVersion = system.version;
  system.world = { ...system.world, seed: 8 };
  system.rebuildAll();
  assert.equal(system.version, previousVersion + 1);
  assert.equal(system.scheduler.pending, 0);
  assert.equal(system.cpuReady.size, 0);
  assert.equal(system.pool.pending, 0);
  assert.equal(system.pool.resets, 1);
  assert.equal(system.minimumReady, false);
  fx.update();
  publishTask(); fallback();
  assert.equal(system.tiles.size, 0);
  assert.equal(system.cpuReady.size, 0);
  assert.ok(system._streamJobs.every(job => job.key.startsWith(`veg:${system.version}:`)));
});

test('moving away drops stale worker jobs, completed CPU results, and queued callbacks', (t) => {
  const fx = fixture(t), { system } = fx;
  fx.update();
  const [queued, ready] = system._streamJobs.slice(0, 2);
  system.pool.complete(queued.key, records(queued));
  fx.update(); fx.update();
  system.cpuReady.set(ready.key, records(ready));
  const saved = system.scheduler.tasks.find(task => task.key === queued.key).fn;
  fx.update(100000, 100000);
  assert.equal(system.scheduler.has(queued.key), false);
  assert.equal(system.cpuReady.has(ready.key), false);
  assert.equal(system.pool.has(ready.key), false);
  saved();
  assert.equal(system.tiles.size, 0);
});

test('worker failure falls back to the identical deterministic records while the focus remains stationary', (t) => {
  const fx = fixture(t), { system } = fx;
  fx.update();
  const job = originJob(system);
  const iterator = generatePopulation(system.world, job.kind, job.i, job.j);
  let step;
  do { step = iterator.next(); } while (!step.done);
  system.pool.fail(job.key);
  fx.update();
  assert.equal(system.fallbacks, 1);
  assert.equal(system.scheduler.has(job.key), true);
  system.scheduler.run(0);
  assert.equal(system.scheduler.has(job.key), true);
  assert.equal(system.tiles.size, 0);
  drainPublications(system);
  assert.deepEqual(system.cpuReady.get(job.key), step.value);
  fx.update(); drainPublications(system);
  assert.deepEqual(system.tiles.get(job.key).records, step.value);
  assert.equal(system.pool.requests.filter(key => key === job.key).length, 1);
});

test('cache pressure releases at most two cells per frame and never touches current residency', (t) => {
  const fx = fixture(t), { system } = fx;
  fx.update();
  const job = originJob(system), current = publishResult(fx, job);
  for (let i = 0; i < 800; i++) {
    const cachedJob = system._job('tree', 1000 + i, 0, 0, 0), mesh = new THREE.Object3D();
    mesh.userData.field = 'forest';
    system.group.add(mesh);
    system.cache.set(cachedJob.key, { job: cachedJob, records: [], meshes: [mesh], lastUsed: performance.now(), groundReady: false });
  }
  for (let i = 0; i < 25; i++) {
    const before = system.cache.size;
    fx.update();
    assert.ok(before - system.cache.size <= 2);
    assert.strictEqual(system.tiles.get(job.key), current);
    assert.ok(current.meshes.every(mesh => mesh.visible));
  }
  assert.ok(system.tiles.size + system.cache.size <= 760);
  assert.equal(system.grass.disposed.length, 0);
  assert.equal(system.flowers.disposed.length, 0);
  const remaining = system.cache.size;
  fx.advance(10001); fx.update();
  assert.equal(system.cache.size, remaining - 2, 'expired cells should retire even below the cache size limit');
});

test('minimumReady waits for assets and every critical supported tile, not all distant cells', (t) => {
  const fx = fixture(t), { system } = fx;
  fx.update();
  const grassRadius = GRASS_COVERAGE.viewEnd + POPULATION.grass.tile * Math.SQRT1_2;
  const critical = system._streamJobs.filter(job => job.d < (job.kind === 'grass' ? grassRadius : job.kind === 'tree' ? 280 : 48));
  assert.ok(critical.length > 0 && critical.length < system.required);
  for (const job of critical) system.pool.complete(job.key, records(job));
  for (let i = 0; i < critical.length + 3; i++) { fx.update(); drainPublications(system); }
  assert.equal(system.minimumReady, true);
  assert.ok(system.pending > 0);
  system.assetReady = false;
  assert.equal(system.minimumReady, false);
  system.assetReady = true;
  const distantGrass = critical.find(job => job.kind === 'grass' && job.d > GRASS_COVERAGE.viewFadeStart);
  assert.ok(distantGrass, 'the boot gate must cover distant grass, not only the old 48m near field');
  system.tiles.get(distantGrass.key).groundReady = false;
  assert.equal(system.minimumReady, false);
  system.tiles.get(distantGrass.key).groundReady = true;
  const one = system.tiles.get(critical[0].key);
  one.groundReady = false;
  assert.equal(system.minimumReady, false);
  one.groundReady = true;
  assert.equal(system.minimumReady, true);
  fx.terrain.plantContactReady = false;
  assert.equal(system.minimumReady, false, 'the loading gate waits for the same contact readiness as terrain.settled');
  fx.terrain.plantContactReady = true;
  assert.equal(system.minimumReady, true);
});

test('grass readiness includes camera offset from the streaming focus', t => {
  const fx = fixture(t), { system } = fx;
  const previous = globalThis.window;
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(50, 0, 16);
  globalThis.window = { __app: { cameras: { camera } } };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
  fx.update(16, 16);
  const oldReach = GRASS_COVERAGE.viewEnd + POPULATION.grass.tile * Math.SQRT1_2;
  const critical = system._streamJobs.filter(job => job.d < (job.kind === 'grass' ? oldReach : job.kind === 'tree' ? 280 : 48));
  for (const job of critical) system.pool.complete(job.key, []);
  for (let i = 0; i < critical.length + 3; i++) { fx.update(); drainPublications(system); }
  assert.equal(system.minimumReady, false, 'grass visible to the offset camera cannot still be waiting at first presentation');
  const extra = system._streamJobs.filter(job => job.kind === 'grass' && job.d >= oldReach && job.d < oldReach + 34);
  assert.ok(extra.length > 0);
  for (const job of extra) system.pool.complete(job.key, []);
  for (let i = 0; i < extra.length + 3; i++) { fx.update(); drainPublications(system); }
  assert.equal(system.minimumReady, true);
});

test('empty population cells are valid residents and do not log invalid scene additions', (t) => {
  const fx = fixture(t), { system } = fx;
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  fx.update();
  const job = originJob(system, 'tree');
  const entry = publishResult(fx, job, []);
  assert.deepEqual(entry.records, []);
  assert.deepEqual(entry.meshes, []);
  assert.equal(entry.groundReady, true);
  assert.equal(system.resident, 1);
  assert.equal(system.pending, system.required - 1);
  assert.deepEqual(system.stats().counts, { grass: 0, shrub: 0, tree: 0 });
  assert.deepEqual(errors, []);
});

test('stats count one persistent population rather than the number of field representation meshes', (t) => {
  const fx = fixture(t), { system } = fx;
  fx.update();
  for (const [kind, count] of [['grass', 3], ['shrub', 2], ['tree', 4]]) {
    const job = originJob(system, kind);
    publishResult(fx, job, records(job, count));
  }
  const stats = system.stats();
  assert.deepEqual(stats.counts, { grass: 3, shrub: 2, tree: 4 });
  assert.equal(stats.cells, 3);
  assert.equal(stats.pending, system.required - 3);
  assert.equal(stats.generation, 2);
  fx.update(20000, 20000);
  assert.deepEqual(system.stats().counts, { grass: 0, shrub: 0, tree: 0 });
  assert.equal(system.stats().cached, 3);
});

test('forest hierarchy follows terrain support, cache reentry and disposal without changing records', t => {
  const fx = fixture(t), { system } = fx;
  const build = system.forest.build;
  system.forest.build = function (...args) {
    const meshes = build.apply(this, args);
    for (const mesh of meshes) {
      mesh.userData.staticCullBox = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
      mesh.userData.staticCullValid = () => true;
      mesh.userData.foliageLevel = 'far';
    }
    return meshes;
  };
  fx.update();
  const job = originJob(system, 'tree'), entry = publishResult(fx, job);
  const records = entry.records, parent = entry.renderGroup;
  assert.ok(parent && parent.parent === system.group);
  assert.notEqual(entry.meshes[0].parent, system.group);
  fx.terrain.setReady(false); fx.update(); assert.equal(parent.visible, false);
  fx.terrain.setReady(true); fx.update(); assert.equal(parent.visible, true);
  fx.update(100000, 100000); assert.equal(parent.visible, false);
  fx.update(); assert.equal(parent.visible, true); assert.equal(entry.records, records);
  system.rebuildAll(); assert.equal(parent.parent, null); assert.equal(system.group.children.length, 0);
});

test('publication failure releases all constructed meshes without exposing a partial tile', (t) => {
  const fx = fixture(t), { system } = fx;
  fx.update();
  const job = originJob(system);
  system.flowers.build = () => { throw new Error('synthetic flower failure'); };
  assert.throws(() => system._publish(job, records(job)), /synthetic flower failure/);
  assert.equal(system.grass.disposed.length, 1);
  assert.equal(system.tiles.size, 0);
  assert.equal(system.group.children.length, 0);
});

test('production publication slices retain the scheduler key and publish only complete cells', t => {
  const fx = fixture(t), { system } = fx;
  system.grass = new GrassField();
  fx.update();
  const job = originJob(system), data = records(job, 384);
  system.cpuReady.set(job.key, data);
  fx.update();
  system.scheduler.run(0);
  for (let i = 0; i < 100 && !system.grass.meshes.size; i++) system.scheduler.run(0);
  assert.equal(system.scheduler.has(job.key), true);
  assert.equal(system.resident, 0);
  assert.equal(system.group.children.length, 0);
  assert.equal(system.grass.meshes.size, 1, 'a partial mesh is privately owned until publication');
  assert.equal(system._builds.size, 1);
  fx.terrain.setReady(false);
  drainPublications(system);
  const entry = system.tiles.get(job.key);
  assert.strictEqual(entry.records, data);
  assert.equal(entry.groundReady, false);
  assert.ok(entry.meshes.every(mesh => !mesh.visible));
  assert.equal(system._builds.size, 0);
  fx.terrain.setReady(true); fx.update();
  assert.ok(entry.meshes.every(mesh => mesh.visible));
});

for (const action of ['move', 'reset', 'drop', 'dispose']) {
  test(`${action} immediately cancels partial V2 meshes and saved continuations cannot resurrect them`, t => {
    const fx = fixture(t), { system } = fx;
    system.grass = new GrassField();
    fx.update();
    const job = originJob(system);
    system.cpuReady.set(job.key, records(job, 384));
    fx.update();
    system.scheduler.run(0);
    for (let i = 0; i < 100 && !system.grass.meshes.size; i++) system.scheduler.run(0);
    const continuation = system.scheduler.tasks.find(task => task.key === job.key).fn;
    const partial = [...system.grass.meshes][0];
    let disposed = 0;
    partial.addEventListener('dispose', () => disposed++);
    if (action === 'move') fx.update(100000, 100000);
    if (action === 'reset') system.rebuildAll();
    if (action === 'drop') { system.scheduler.drop(key => key === job.key); fx.update(); }
    if (action === 'dispose') system.dispose();
    assert.equal(system.grass.meshes.size, 0);
    assert.equal(system._builds.size, 0);
    assert.equal(disposed, 1);
    continuation();
    assert.equal(system.resident, 0);
    assert.equal(system.group.children.length, 0);
  });
}
