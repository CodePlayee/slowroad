import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const src = new URL('../src/', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(src) && url.endsWith('.js')) {
      return { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { buildTerrainData, buildTerrainTileData, serializeWorld, hydrateWorld, addQuadrantSkirts } = await import('../src/terrain/mesh-data.js');
const { TerrainWorkerPool } = await import('../src/terrain/worker-pool.js');
const { World } = await import('../src/world/world.js');
const { Route } = await import('../src/road/route.js');
const { partitionIndices } = await import('../src/terrain/coverage.js');
const { Ray, Vector3 } = await import('three');

const tile = { x0: 0, z0: 0, C: 128, l: 0 };
const options = { resolution: 8, skirtDepth: 20 };
const arrays = ['positions', 'normals', 'surface', 'roadDistances', 'ecology', 'indices', 'heights'];

function finish(generator) {
  let step;
  do { step = generator.next(); } while (!step.done);
  return step.value;
}

function makeWorld() {
  const world = new World('terrain-worker-test');
  const points = Array.from({ length: 100 }, (_, i) => ({
    x: i * 4 - 100, z: 16, y: 38 + i * 0.01, bridge: 0,
  }));
  world.route._finalise(points);
  world.route._index();
  return world;
}

test('mesh buffers preserve the sampled surface, border normals and skirt winding', () => {
  const world = {
    ground: (x, z) => 12 + x / 4 - z / 8,
    sample(x, z, out) {
      Object.assign(out, { y: this.ground(x, z), moisture: 0.6, rockiness: 0.5,
        riverDist: 100, channelHalf: 2, waterY: 0, roadDist: Infinity });
    },
  };
  const data = finish(buildTerrainData(world, tile, options));
  const N = options.resolution, count = (N + 1) ** 2, S = N + 3;
  assert.equal(data.positions.length, (count + 4 * (N + 1)) * 3);
  assert.equal(data.indices.length, (N * N + 4 * N) * 6);
  assert.equal(data.heights.length, S * S);
  assert.equal(data.minY, -4);
  assert.equal(data.maxY, 44);
  const length = Math.hypot(-0.25, 1, 0.125);
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const k = j * (N + 1) + i, x = i * 16, z = j * 16;
      assert.deepEqual(Array.from(data.positions.slice(k * 3, k * 3 + 3)), [x - 64, world.ground(x, z), z - 64]);
      assert.ok(Math.abs(data.normals[k * 3] + 0.25 / length) < 1e-7);
      assert.ok(Math.abs(data.normals[k * 3 + 1] - 1 / length) < 1e-7);
      assert.ok(Math.abs(data.normals[k * 3 + 2] - 0.125 / length) < 1e-7);
      assert.equal(data.surface[k * 4 + 3], world.ground(x, z));
      assert.equal(data.roadDistances[k], 255);
    }
  }
  assert.deepEqual(Array.from(data.indices.slice(0, 6)), [0, 9, 1, 1, 9, 10]);
  const edges = [(i) => i, (i) => N * (N + 1) + i, (i) => i * (N + 1), (i) => i * (N + 1) + N];
  for (let side = 0; side < edges.length; side++) {
    for (let i = 0; i <= N; i++) {
      const source = edges[side](i), skirt = count + side * (N + 1) + i;
      assert.equal(data.positions[skirt * 3 + 1], data.positions[source * 3 + 1] - options.skirtDepth);
      assert.equal(data.positions[skirt * 3], data.positions[source * 3]);
      assert.equal(data.positions[skirt * 3 + 2], data.positions[source * 3 + 2]);
      assert.deepEqual(data.surface.slice(skirt * 4, skirt * 4 + 4), data.surface.slice(source * 4, source * 4 + 4));
      assert.deepEqual(data.ecology.slice(skirt * 2, skirt * 2 + 2), data.ecology.slice(source * 2, source * 2 + 2));
    }
  }
  assert.ok(data.indices.every((index) => index < data.positions.length / 3));
});

test('adjacent terrain tiles share exact border heights and normals', () => {
  const world = makeWorld();
  const first = finish(buildTerrainData(world, tile, options));
  const second = finish(buildTerrainData(world, { ...tile, x0: 128 }, options));
  const N = options.resolution;
  for (let j = 0; j <= N; j++) {
    const a = j * (N + 1) + N, b = j * (N + 1);
    assert.equal(first.positions[a * 3 + 1], second.positions[b * 3 + 1]);
    assert.deepEqual(first.normals.slice(a * 3, a * 3 + 3), second.normals.slice(b * 3, b * 3 + 3));
  }
});

function flatTile(y = 20) {
  const world = {
    ground: () => y,
    sample(x, z, out) {
      Object.assign(out, { y, moisture: 0.6, rockiness: 0.5,
        riverDist: 100, channelHalf: 2, waterY: 0, roadDist: 100 });
    },
  };
  return finish(buildTerrainData(world, tile, { resolution: 4, skirtDepth: 20 }));
}

test('quadrant skirts preserve original buffers and surface bounds with per-vertex depths', () => {
  const original = flatTile();
  const data = addQuadrantSkirts(original, 85);
  const baseCount = (original.resolution + 1) ** 2;
  const originalCount = original.positions.length / 3, count = data.positions.length / 3;
  assert.equal(original.skirtDepth, 20);
  assert.equal(count, originalCount + (original.resolution + 1) * 4);
  assert.equal(data.normals.length, count * 3);
  assert.equal(data.surface.length, count * 4);
  assert.equal(data.roadDistances.length, count);
  assert.equal(data.ecology.length, count * 2);
  assert.equal(data.skirtDepths.length, count);
  assert.equal(data.indices.length, original.indices.length + original.resolution * 4 * 6);
  for (const key of arrays) {
    assert.deepEqual(data[key].subarray(0, original[key].length), original[key]);
  }
  assert.equal(data.heights, original.heights);
  assert.equal(data.minY, original.minY);
  assert.equal(data.maxY, original.maxY);
  assert.ok(data.skirtDepths.subarray(0, baseCount).every((value) => value === 0));
  assert.ok(data.skirtDepths.subarray(baseCount, originalCount).every((value) => value === 20));
  assert.ok(data.skirtDepths.subarray(originalCount).every((value) => value === 85));
  assert.ok(data.positions.filter((_, i) => i >= original.positions.length && i % 3 === 1).every((value) => value === -65));
  assert.ok(data.indices.every((index) => index < count));
  const stride = original.resolution + 1, half = original.resolution / 2;
  const sources = [j => j * stride + half, j => j * stride + half, i => half * stride + i, i => half * stride + i];
  for (const [side, source] of sources.entries()) for (let i = 0; i < stride; i++) {
    const vertex = originalCount + side * stride + i;
    assert.deepEqual(data.ecology.slice(vertex * 2, vertex * 2 + 2), original.ecology.slice(source(i) * 2, source(i) * 2 + 2));
  }
  assert.throws(() => addQuadrantSkirts({ ...original, resolution: 3 }, 60), /even/);
  assert.throws(() => addQuadrantSkirts(original, 0), /depth/);
});

test('each parent quadrant has outward-facing nondegenerate skirts on both internal edges', () => {
  const original = flatTile(), data = addQuadrantSkirts(original, 80);
  const { indices, ranges } = partitionIndices(data.positions, data.indices);
  const firstInternal = original.positions.length / 3;
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), normal = new Vector3();
  for (let q = 0; q < 4; q++) {
    let alongX = 0, alongZ = 0;
    const range = ranges[q];
    for (let offset = range.start; offset < range.start + range.count; offset += 3) {
      const ids = [indices[offset], indices[offset + 1], indices[offset + 2]];
      if (!ids.some((index) => index >= firstInternal)) continue;
      a.fromArray(data.positions, ids[0] * 3);
      b.fromArray(data.positions, ids[1] * 3);
      c.fromArray(data.positions, ids[2] * 3);
      normal.crossVectors(b.clone().sub(a), c.clone().sub(a));
      assert.ok(normal.lengthSq() > 1);
      if (Math.abs(normal.x) > Math.abs(normal.z)) {
        assert.equal(Math.sign(normal.x), q & 1 ? -1 : 1);
        alongX++;
      } else {
        assert.equal(Math.sign(normal.z), q & 2 ? -1 : 1);
        alongZ++;
      }
    }
    assert.equal(alongX, original.resolution);
    assert.equal(alongZ, original.resolution);
  }
});

test('a higher parent closes the 3D gap toward a lower child on every cut boundary', () => {
  const data = addQuadrantSkirts(flatTile(20), 80);
  const { indices, ranges } = partitionIndices(data.positions, data.indices);
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), hit = new Vector3();
  const hits = (quadrant, origin, direction) => {
    const ray = new Ray(new Vector3(...origin), new Vector3(...direction));
    const range = ranges[quadrant];
    for (let offset = range.start; offset < range.start + range.count; offset += 3) {
      a.fromArray(data.positions, indices[offset] * 3);
      b.fromArray(data.positions, indices[offset + 1] * 3);
      c.fromArray(data.positions, indices[offset + 2] * 3);
      if (ray.intersectTriangle(a, b, c, true, hit) && ray.origin.distanceTo(hit) < 11) return true;
    }
    return false;
  };
  for (const y of [1, 10, 19]) {
    for (let q = 0; q < 4; q++) {
      const positiveX = Boolean(q & 1), positiveZ = Boolean(q & 2);
      assert.ok(hits(q, [positiveX ? -10 : 10, y, positiveZ ? 32 : -32], [positiveX ? 1 : -1, 0, 0]));
      assert.ok(hits(q, [positiveX ? 32 : -32, y, positiveZ ? -10 : 10], [0, 0, positiveZ ? 1 : -1]));
    }
  }
});

test('world snapshot restores the exact road-aware geometry without rebuilding routes', () => {
  const world = makeWorld();
  const snapshot = structuredClone(serializeWorld(world));
  const originalBuild = Route.prototype.build;
  Route.prototype.build = () => { throw new Error('Route rebuild is forbidden'); };
  let hydrated;
  try { hydrated = hydrateWorld(snapshot); }
  finally { Route.prototype.build = originalBuild; }
  assert.ok(hydrated.route.grid instanceof Map);
  assert.notEqual(hydrated.route.X.buffer, world.route.X.buffer);
  const direct = finish(buildTerrainData(world, tile, options));
  const background = finish(buildTerrainData(hydrated, tile, options));
  for (const key of arrays) assert.deepEqual(background[key], direct[key]);
  assert.deepEqual(hydrated.route.nearest(8, 18), world.route.nearest(8, 18));
  assert.ok(world.route.X.byteLength > 0, 'main-thread route was not detached');
});

class FakeWorker {
  static instances = [];
  constructor() { this.messages = []; this.terminated = false; FakeWorker.instances.push(this); }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  emit(message) { this.onmessage({ data: message }); }
  get builds() { return this.messages.filter((message) => message.type === 'build'); }
}

function makePool(size = 1) {
  FakeWorker.instances.length = 0;
  const pool = new TerrainWorkerPool({ size, WorkerClass: FakeWorker });
  pool.reset(makeWorld());
  return { pool, workers: [...FakeWorker.instances] };
}

test('worker pool bounds concurrent work, orders queued priorities and consumes results', () => {
  const { pool, workers } = makePool(2);
  pool.request('far', tile, options, 500);
  pool.request('near', tile, options, 5);
  pool.request('middle', tile, options, 100);
  for (const worker of workers) worker.emit({ type: 'ready', epoch: pool.epoch });
  assert.equal(workers.reduce((n, worker) => n + worker.builds.length, 0), 2);
  assert.equal(workers[0].builds[0].id, 2);
  assert.equal(workers[1].builds[0].id, 3);
  const near = workers[0].builds[0];
  workers[0].emit({ type: 'built', id: near.id, epoch: near.epoch, data: { value: 'near' } });
  assert.equal(workers[0].builds.length, 2);
  assert.equal(pool.pending, 3);
  assert.deepEqual(pool.poll('near'), { data: { value: 'near' } });
  assert.equal(pool.poll('near'), null);
  assert.equal(pool.pending, 2);
  pool.dispose();
  assert.ok(workers.every((worker) => worker.terminated));
  assert.equal(pool.available, false);
});

test('cancellation discards completed and queued work and rejects late running results', () => {
  const { pool, workers: [worker] } = makePool();
  worker.emit({ type: 'ready', epoch: pool.epoch });
  pool.request('old', tile, options, 0);
  pool.request('queued', tile, options, 0);
  const old = worker.builds[0];
  pool.cancelExcept(new Set());
  assert.equal(pool.pending, 0);
  assert.equal(worker.messages.at(-1).type, 'cancel');
  pool.request('old', tile, options, 0);
  worker.emit({ type: 'built', id: old.id, epoch: old.epoch, data: 'stale' });
  assert.equal(pool.poll('old'), null);
  assert.equal(worker.builds.length, 2);
  const current = worker.builds[1];
  worker.emit({ type: 'built', id: current.id, epoch: current.epoch, data: 'current' });
  pool.cancelExcept(new Set());
  assert.equal(pool.poll('old'), null);
  pool.dispose();
});

test('reset ignores old epochs even when a tile key is reused', () => {
  const { pool, workers: [worker] } = makePool();
  worker.emit({ type: 'ready', epoch: pool.epoch });
  pool.request('same', tile, options);
  const old = worker.builds[0];
  pool.reset(makeWorld());
  pool.request('same', tile, options);
  worker.emit({ type: 'ready', epoch: old.epoch });
  assert.equal(worker.builds.length, 1);
  worker.emit({ type: 'ready', epoch: pool.epoch });
  const current = worker.builds[1];
  worker.emit({ type: 'built', id: old.id, epoch: old.epoch, data: 'stale' });
  assert.equal(pool.poll('same'), null);
  worker.emit({ type: 'built', id: current.id, epoch: current.epoch, data: 'fresh' });
  assert.deepEqual(pool.poll('same'), { data: 'fresh' });
  pool.dispose();
});

test('worker startup failures expose all pending requests for cooperative fallback', () => {
  const { pool, workers: [worker] } = makePool();
  pool.request('first', tile, options);
  pool.request('second', tile, options);
  worker.onerror({ message: 'Worker blocked' });
  assert.equal(pool.available, false);
  assert.equal(pool.poll('first').error, 'Worker blocked');
  assert.equal(pool.poll('second').error, 'Worker blocked');
  assert.equal(pool.request('third', tile, options), false);
  pool.dispose();
});

test('one failed worker does not stall the remaining worker queue', () => {
  const { pool, workers } = makePool(2);
  for (const worker of workers) worker.emit({ type: 'ready', epoch: pool.epoch });
  pool.request('first', tile, options);
  pool.request('second', tile, options);
  pool.request('third', tile, options);
  workers[0].onerror({ message: 'Lost worker' });
  assert.equal(pool.available, true);
  assert.equal(pool.poll('first').error, 'Lost worker');
  const second = workers[1].builds[0];
  workers[1].emit({ type: 'built', epoch: second.epoch, id: second.id, data: 'second' });
  assert.equal(workers[1].builds.length, 2);
  assert.deepEqual(pool.poll('second'), { data: 'second' });
  pool.dispose();
});

test('worker construction failures disable background work without throwing', () => {
  class BlockedWorker { constructor() { throw new Error('Blocked by policy'); } }
  const pool = new TerrainWorkerPool({ WorkerClass: BlockedWorker });
  assert.equal(pool.available, false);
  pool.reset(makeWorld());
  assert.equal(pool.request('tile', tile, options), false);
  pool.dispose();
});

test('worker protocol transfers complete geometry buffers and reports invalid builds', async () => {
  const messages = [];
  const previous = globalThis.self;
  globalThis.self = {
    postMessage(message, transfer = []) {
      messages.push({ message: structuredClone(message, { transfer }), transferred: transfer.length });
    },
  };
  try {
    await import('../src/terrain/terrain.worker.js');
    await self.onmessage({ data: { type: 'init', epoch: 3, world: serializeWorld(makeWorld()) } });
    await self.onmessage({ data: { type: 'build', epoch: 3, id: 1, tile, options } });
    const built = messages.find((entry) => entry.message.type === 'built');
    assert.equal(built.transferred, 7);
    const expected = finish(buildTerrainData(makeWorld(), tile, options));
    for (const key of arrays) assert.deepEqual(built.message.data[key], expected[key]);
    const wetOptions = { ...options, waterResolution: 24 };
    const wetTile = { ...tile, x0: 128, z0: -512 };
    await self.onmessage({ data: { type: 'build', epoch: 3, id: 6, tile: wetTile, options: wetOptions } });
    const withWater = messages.at(-1);
    const wetExpected = finish(buildTerrainTileData(makeWorld(), wetTile, wetOptions));
    assert.deepEqual(withWater.message.data, wetExpected);
    assert.ok(wetExpected.water?.indices.length > 0);
    assert.equal(withWater.transferred, 11);
    await self.onmessage({ data: { type: 'build', epoch: 3, id: 2, tile, options: { ...options, resolution: 0 } } });
    assert.equal(messages.at(-1).message.type, 'error');
    assert.match(messages.at(-1).message.error, /resolution/);
    await self.onmessage({ data: { type: 'build', epoch: 2, id: 3, tile, options } });
    assert.equal(messages.at(-1).message.type, 'cancelled');
    const cancelled = self.onmessage({ data: { type: 'build', epoch: 3, id: 4, tile,
      options: { ...options, resolution: 256 } } });
    await self.onmessage({ data: { type: 'cancel', epoch: 3, id: 4 } });
    await cancelled;
    assert.equal(messages.at(-1).message.type, 'cancelled');
    assert.equal(messages.at(-1).message.id, 4);
    const replaced = self.onmessage({ data: { type: 'build', epoch: 3, id: 5, tile,
      options: { ...options, resolution: 256 } } });
    await self.onmessage({ data: { type: 'init', epoch: 4, world: serializeWorld(makeWorld()) } });
    await replaced;
    assert.equal(messages.at(-1).message.type, 'cancelled');
    assert.equal(messages.at(-1).message.epoch, 3);
  } finally {
    if (previous === undefined) delete globalThis.self;
    else globalThis.self = previous;
  }
});
