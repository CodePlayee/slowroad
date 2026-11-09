import * as THREE from 'three';
import { GrassField } from './grassField.js';
import { ForestField } from './forestField.js';
import { FlowerField } from './flowerField.js';
import { POPULATION, generatePopulation } from './population.js';
import { PASTURE } from './pasture.js';
import { PopulationPool } from './populationPool.js';
import { GRASS_COVERAGE } from './grassCoverage.js';
import { groupFoliage } from './cullingGroup.js';
import { TERRAIN } from '../terrain/params.js';

const KINDS = ['grass', 'pasture', 'shrub', 'tree'];
const LATTICE = { ...POPULATION, pasture: PASTURE };
const GROUND_LEVEL = { grass: 0, pasture: 0, shrub: 1, tree: 4 };
const PADDING = { grass: 2, pasture: 2, shrub: 3, tree: 30 };
// Pasture tiles are kept while any part lies within the grass view range of
// the camera, plus the movement allowed before the next replan (one grass tile),
// and only where the level-0 terrain ring (chunks around the focus chunk) is
// guaranteed to settle: their roots sit on L0 triangles.
const PASTURE_REACH = GRASS_COVERAGE.viewEnd + POPULATION.grass.tile * Math.SQRT2;
const PASTURE_GROUND = TERRAIN.chunkSize * TERRAIN.ringRadius - PADDING.pasture;
const CACHE_SECONDS = 10;
const CACHE_CELLS = 760;

export class VegetationSystem {
  constructor(world, atmo, scheduler, terrain = null) {
    this.generation = 2;
    this.seasonInShader = true;
    this.world = world; this.atmo = atmo; this.scheduler = scheduler; this.terrain = terrain;
    this.seed = world.seed ^ 0x2b7c1f03;
    this.version = 0;
    this.group = new THREE.Group(); this.group.name = 'vegetation';
    this.tiles = new Map();
    this.cache = new Map();
    this.cpuReady = new Map();
    this._builds = new Map();
    this.pool = new PopulationPool(); this.pool.reset(world);
    this.grass = new GrassField(atmo);
    this.forest = new ForestField(atmo, atmo.renderer);
    this.flowers = new FlowerField(atmo);
    this._streamJobs = [];
    this._streamWant = new Set();
    this._signature = '';
    this._coverageRevision = -1;
    this._clock = performance.now(); this.time = 0;
    this._publishFrame = -1; this._published = 0;
    this.required = 0; this.fallbacks = 0;
    this.assetReady = false; this.assetError = null;
    this.seasonName = atmo.seasonName;
    this.flowers.update(this.seasonName);
    this.assetPromise = Promise.all([this.forest.assetPromise, this.flowers.assetPromise]).then(() => {
      this.assetError = this.forest.assetError || this.flowers.assetError || null;
      this.assetReady = true;
    });
  }

  setSeason(name) {
    if (!['spring', 'summer', 'autumn', 'winter'].includes(name)) return false;
    const changed = name !== this.seasonName;
    this.seasonName = name;
    this.flowers.update(name);
    if (changed) for (const entry of this.tiles.values()) this._visibility(entry);
    return changed;
  }

  _job(kind, i, j, x, z) {
    const C = LATTICE[kind].tile, pad = PADDING[kind];
    const d = Math.hypot((i + 0.5) * C - x, (j + 0.5) * C - z);
    // Prepare the entire grass guard before distant woodland work can occupy
    // the shared population worker. Waiting until viewEnd defeats prefetching.
    // Pasture tiles are cheap (a coarse ecology grid) and follow the grass.
    const priority = kind === 'grass' ? -2000 + d * 3 : kind === 'pasture' ? -1000 + d * 3
      : kind === 'shrub' ? 800 + d * 5 : (d < 600 ? 0 : 3000) + d * 3;
    return { key: `veg:${this.version}:${kind}:${i}:${j}`, kind, i, j, d, priority,
      groundBounds: [i * C - pad, j * C - pad, (i + 1) * C + pad, (j + 1) * C + pad] };
  }

  _plan(x, z) {
    const signature = KINDS.map(kind => {
      const C = LATTICE[kind].tile;
      return `${Math.floor(x / C)},${Math.floor(z / C)}`;
    }).join(';') + (this._grassView ? `;${Math.floor(Math.atan2(this._grassView.dz, this._grassView.dx) / (Math.PI / 12))}` : '');
    if (signature === this._signature) return false;
    this._signature = signature;
    const jobs = [];
    for (const kind of KINDS) {
      // Pasture coverage is defined by distance from the camera; without one
      // there is no range to fill.
      if (kind === 'pasture' && !this._grassView) continue;
      const { tile: C, radius: R } = LATTICE[kind];
      const ci = Math.floor(x / C), cj = Math.floor(z / C);
      for (let j = cj - R; j <= cj + R; j++) for (let i = ci - R; i <= ci + R; i++) {
        if ((kind === 'grass' || kind === 'pasture') && this._grassView) {
          const view = this._grassView;
          const forward = ((i + 0.5) * C - view.x) * view.dx + ((j + 0.5) * C - view.z) * view.dz;
          // The road-following camera looks ahead. Keep two tiles behind it as
          // a turning/cache guard, rather than generate the entire rear ring.
          if (forward + C * Math.SQRT1_2 < -64) continue;
        }
        if (kind === 'pasture') {
          const view = this._grassView;
          const gapX = Math.max(0, Math.abs((i + 0.5) * C - view.x) - C / 2);
          const gapZ = Math.max(0, Math.abs((j + 0.5) * C - view.z) - C / 2);
          if (Math.hypot(gapX, gapZ) > PASTURE_REACH) continue;
          if (Math.max(Math.abs((i + 0.5) * C - x), Math.abs((j + 0.5) * C - z)) + C / 2 > PASTURE_GROUND) continue;
        }
        if (kind === 'grass' && this.world?.route?.nearest) {
          // A circumscribed tile bound cannot reject any root in the road band.
          const reach = GRASS_COVERAGE.roadEnd + C * Math.SQRT1_2;
          const road = this.world.route.nearest((i + 0.5) * C, (j + 0.5) * C, reach);
          if (!road || road.dist > reach) continue;
        }
        jobs.push(this._job(kind, i, j, x, z));
      }
    }
    jobs.sort((a, b) => a.priority - b.priority);
    this._streamJobs = jobs;
    this._streamWant = new Set(jobs.map(job => job.key));
    const now = performance.now();
    for (const [key, entry] of this.tiles) if (!this._streamWant.has(key)) {
      for (const mesh of entry.meshes) mesh.visible = false;
      if (entry.renderGroup) entry.renderGroup.visible = false;
      this.tiles.delete(key); entry.lastUsed = now; this.cache.set(key, entry);
      this.terrain?.plantContactChanged?.(entry, true, { reason: 'stream-eviction', focus: { x, z } });
    }
    // Retained jobs approach the car too: their old distant priority is stale.
    const priorities = new Map(jobs.map(job => [job.key, 200000 + job.priority]));
    for (const job of jobs) if (this.pool.has(job.key)) this.pool.request(job.key, job, job.priority);
    this.pool.cancelExcept(this._streamWant);
    this._cancelBuilds(key => !this._streamWant.has(key));
    this.scheduler.drop(key => key.startsWith('veg:') && !this._streamWant.has(key));
    this.scheduler.reprioritise((key, priority) => priorities.get(key) ?? priority);
    for (const key of this.cpuReady.keys()) if (!this._streamWant.has(key)) this.cpuReady.delete(key);
    this.required = jobs.length;
    return true;
  }

  _groundReady(job) {
    return !this.terrain || this.terrain.coversBounds(...job.groundBounds, GROUND_LEVEL[job.kind]);
  }

  _visibility(entry) {
    const wasReady = entry.groundReady;
    entry.groundReady = this._groundReady(entry.job);
    if (entry.renderGroup) entry.renderGroup.visible = entry.groundReady;
    for (const mesh of entry.meshes) {
      mesh.visible = entry.groundReady && !(mesh.userData.field === 'flowers' && this.seasonName === 'winter');
    }
    if (entry.groundReady !== wasReady && this.tiles.has(entry.job.key)) {
      this.terrain?.plantContactChanged?.(entry, !entry.groundReady);
    }
  }

  _fallback(job) {
    const world = this.world, version = this.version;
    const iterator = generatePopulation(world, job.kind, job.i, job.j);
    const advance = () => {
      if (version !== this.version || !this._streamWant.has(job.key)) { iterator.return(); return; }
      const step = iterator.next();
      if (!step.done) return advance;
      this.cpuReady.set(job.key, step.value);
    };
    return advance;
  }

  _publish(job, records) {
    const iterator = this._publishSteps(job, records);
    while (!iterator.next().done) { /* Preserve synchronous diagnostic callers. */ }
  }

  _cancelBuilds(predicate) {
    for (const [key, build] of this._builds || []) if (predicate(key)) build.cancel();
  }

  _publishTask(job, records) {
    const builds = this._builds || (this._builds = new Map());
    builds.get(job.key)?.cancel();
    const version = this.version, world = this.world;
    let iterator = null, cancelled = false;
    const build = { cancel: () => {
      cancelled = true;
      iterator?.return();
      if (builds.get(job.key) === build) builds.delete(job.key);
    } };
    builds.set(job.key, build);
    const advance = () => {
      if (cancelled || version !== this.version || world !== this.world || !this._streamWant.has(job.key)) {
        build.cancel(); return;
      }
      try {
        iterator ||= this._publishSteps(job, records);
        if (!iterator.next().done) return advance;
        builds.delete(job.key);
      } catch (error) {
        build.cancel(); throw error;
      }
    };
    return advance;
  }

  *_publishSteps(job, records) {
    if (!this._streamWant.has(job.key) || this.tiles.has(job.key)) return;
    const meshes = [];
    let published = false;
    try {
      const grassKind = job.kind === 'grass' || job.kind === 'pasture';
      const field = grassKind ? this.grass : this.forest;
      const built = grassKind && field.cellRendering && field.buildCellsSteps
        ? yield* field.buildCellsSteps(records, job.kind === 'pasture')
        : field.buildSteps ? yield* field.buildSteps(records, job.kind) : field.build(records, job.kind);
      for (const mesh of built) { mesh.userData.field = grassKind ? 'grass' : 'forest'; meshes.push(mesh); }
      if (job.kind === 'grass') {
        for (const mesh of this.flowers.build(records)) { mesh.userData.field = 'flowers'; meshes.push(mesh); }
      }
      const renderGroup = grassKind ? null : groupFoliage(meshes);
      const entry = { job, records, meshes, renderGroup, lastUsed: performance.now(), groundReady: false };
      this._visibility(entry);
      if (renderGroup) this.group.add(renderGroup);
      else if (meshes.length) this.group.add(...meshes);
      this.tiles.set(job.key, entry);
      if (entry.groundReady) this.terrain?.plantContactChanged?.(entry);
      published = true;
    } finally {
      if (!published) this._dispose({ meshes });
    }
  }

  update(x, z) {
    this.focusX = x; this.focusZ = z;
    const app = typeof window !== 'undefined' ? window.__app : null;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this._clock) / 1000); this._clock = now;
    if (app?.paused || app?.forceDrain) this.time = 0;
    else if (!app?._backgrounded && !app?.loading) this.time += dt;
    const camera = app?.cameras?.camera;
    if (camera) {
      const direction = this._grassDirection ||= new THREE.Vector3();
      camera.getWorldDirection(direction);
      const length = Math.hypot(direction.x, direction.z);
      if (length > 0.1) {
        const view = this._grassView ||= {};
        Object.assign(view, { x: camera.position.x, z: camera.position.z,
          dx: direction.x / length, dz: direction.z / length });
      } else this._grassView = null;
    } else this._grassView = null;
    // Streaming is centered between car and camera, while grass fades from the
    // camera. Include that offset and the whole cell before revealing a scene.
    this._grassReadyRadius = GRASS_COVERAGE.viewEnd + POPULATION.grass.tile * Math.SQRT1_2
      + Math.hypot((camera?.position.x ?? x) - x, (camera?.position.z ?? z) - z);
    if (camera) {
      const height = app.quality?.lodHeight ?? this.atmo.renderer.domElement.height;
      this.grass.update(camera, this.time, this.seasonName, height);
      this.forest.update(camera, this.time, this.seasonName, height);
    }
    const moved = this._plan(x, z), revision = this.terrain?.coverageRevision ?? 0;
    this._cancelBuilds(key => !this.scheduler.has(key));
    if (moved || revision !== this._coverageRevision) {
      for (const entry of this.tiles.values()) this._visibility(entry);
      this._coverageRevision = revision;
    }
    const frame = app?.frameNo ?? now;
    if (frame !== this._publishFrame) { this._publishFrame = frame; this._published = 0; }
    for (const job of this._streamJobs) {
      if (this.tiles.has(job.key) || this.scheduler.has(job.key)) continue;
      const cached = this.cache.get(job.key);
      if (cached) {
        this.cache.delete(job.key); cached.job = job; cached.lastUsed = now;
        this._visibility(cached); this.tiles.set(job.key, cached);
        if (cached.groundReady) this.terrain?.plantContactChanged?.(cached);
        continue;
      }
      if (this.cpuReady.has(job.key)) {
        if (!this.assetReady || this._published >= 2 || !this._groundReady(job)) continue;
        const records = this.cpuReady.get(job.key);
        this.cpuReady.delete(job.key); this._published++;
        this.scheduler.push(job.key, 200000 + job.priority, this._publishTask(job, records));
        continue;
      }
      if (this.pool.has(job.key)) {
        const result = this.pool.poll(job.key);
        if (result?.records) this.cpuReady.set(job.key, result.records);
        else if (result?.error) { this.fallbacks++; this.scheduler.push(job.key, 200000 + job.priority, this._fallback(job)); }
        continue;
      }
      if (!this.pool.request(job.key, job, job.priority)) this.scheduler.push(job.key, 200000 + job.priority, this._fallback(job));
    }
    let released = 0;
    for (const [key, entry] of this.cache) {
      if (released >= 2) break;
      if (now - entry.lastUsed < CACHE_SECONDS * 1000 && this.cache.size + this.tiles.size <= CACHE_CELLS) continue;
      this._dispose(entry); this.cache.delete(key); released++;
    }
    this.terrain?.updatePlantContact?.(this.tiles, x, z);
  }

  get resident() { return this.tiles.size; }
  get pending() { return Math.max(0, this.required - this.resident); }
  get minimumReady() {
    if (!this.assetReady || this.terrain?.plantContactReady === false) return false;
    // Pasture tiles are cheap and stream right behind the grass; like shrubs,
    // only the near field gates first presentation (residency still waits for all).
    const critical = this._streamJobs.filter(job => job.d <
      (job.kind === 'grass' ? this._grassReadyRadius : job.kind === 'tree' ? 280 : 48));
    return critical.length > 0 && critical.every(job => this.tiles.get(job.key)?.groundReady);
  }

  _dispose(entry) {
    entry.renderGroup?.removeFromParent();
    for (const mesh of entry.meshes) {
      const field = mesh.userData.field === 'grass' ? this.grass : mesh.userData.field === 'flowers' ? this.flowers : this.forest;
      field.disposeMesh(mesh);
    }
  }

  rebuildAll() {
    this.terrain?.resetPlantContact?.();
    this.version++;
    this._cancelBuilds(() => true);
    this.scheduler.drop(key => key.startsWith('veg:'));
    this.pool.reset(this.world);
    for (const entry of this.tiles.values()) this._dispose(entry);
    for (const entry of this.cache.values()) this._dispose(entry);
    this.tiles.clear(); this.cache.clear(); this.cpuReady.clear();
    this._signature = ''; this._streamJobs = []; this._streamWant.clear();
    this.required = 0; this.time = 0;
  }

  stats() {
    const counts = { grass: 0, shrub: 0, tree: 0 };
    let pasture = 0;
    for (const entry of this.tiles.values()) {
      if (entry.job.kind === 'pasture') pasture += entry.records.length;
      else counts[entry.job.kind] += entry.records.length;
    }
    return { generation: this.generation, cells: this.tiles.size, cached: this.cache.size,
      pending: this.pending, workerPending: this.pool.pending, fallbacks: this.fallbacks, counts, pasture,
      contact: this.terrain?.plantContactStats?.() || null };
  }

  dispose() {
    this.rebuildAll(); this.pool.dispose();
    this.grass.dispose(); this.forest.dispose(); this.flowers.dispose();
  }
}
