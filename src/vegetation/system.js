import * as THREE from 'three';
import { GrassField, GRASS_REVEAL } from './grassField.js';
import { ForestField, FOREST_LOD } from './forestField.js';
import { FlowerField } from './flowerField.js';
import { POPULATION, generatePopulation } from './population.js';
import { PASTURE } from './pasture.js';
import { PopulationPool, populationWorkerCount } from './populationPool.js';
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
// Eye distance at which each ground-cover layer starts to show: the grass view
// fade end and the shrub distance fade end.
const VIEW_RANGE = { grass: GRASS_COVERAGE.viewEnd, pasture: GRASS_COVERAGE.viewEnd, shrub: FOREST_LOD.shrub.fadeEnd };
const COVER_KINDS = ['grass', 'pasture', 'shrub'];
// Ground cover is ranked by when the eye reaches it: tiles inside a layer's
// range by eye distance, tiles ahead by the driving distance until the eye,
// carried along the route, comes within range. Tiles the eye reaches within
// `seconds` (at no less than `minimumSpeed`) are planned even beyond the
// rings, wherever the terrain already plans their supporting ground.
export const STREAM_LEAD = Object.freeze({ seconds: 5, step: 16, minimumSpeed: 10 });

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
    // Roadside grass is by far the most expensive population per tile and must
    // keep pace with the car, so it gets several workers. Grass and pasture are
    // urgent (negative priority); shrubs and trees never occupy the last idle worker.
    this.pool = new PopulationPool({ backgroundPriority: 0,
      size: populationWorkerCount(typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined) });
    this.pool.reset(world);
    this.grass = new GrassField(atmo);
    this.forest = new ForestField(atmo, atmo.renderer);
    this.flowers = new FlowerField(atmo);
    this._streamJobs = [];
    this._streamWant = new Set();
    this._signature = '';
    this._coverageRevision = -1;
    this._clock = performance.now(); this.time = 0;
    // Seconds of presented driving; tiles revealed meanwhile fill in against it.
    this._revealClock = 0; this._revealEnd = 0; this._fadeReveals = false;
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

  _job(kind, i, j, x, z, arrival) {
    const C = LATTICE[kind].tile, pad = PADDING[kind];
    const cx = (i + 0.5) * C, cz = (j + 0.5) * C, d = Math.hypot(cx - x, cz - z);
    const view = this._grassView, range = VIEW_RANGE[kind];
    let priority;
    if (view && range) {
      // Ground cover is generated in the order the eye reaches it, ahead of
      // every tree job: inside a layer's range by eye distance, beyond it by the
      // route distance until the eye comes within range. Tiles wholly behind
      // the eye only matter if the view turns, so they follow the visible band.
      // Ranges normalise the layers: a shrub tile at 220 m ranks with grass at 160 m.
      const gap = Math.hypot(Math.max(0, Math.abs(cx - view.x) - C / 2), Math.max(0, Math.abs(cz - view.z) - C / 2));
      const behind = (cx - view.x) * view.dx + (cz - view.z) * view.dz + C * Math.SQRT1_2 < 0;
      const reach = gap <= range ? gap : Math.min(gap, range + (arrival ?? this._arrival(i, j, C, range)));
      priority = -3000 + 480 * (reach / range + (behind ? 1 : 0));
    } else {
      // Without a camera, prepare the grass guard before distant woodland work.
      priority = kind === 'grass' ? -2000 + d * 3 : kind === 'pasture' ? -1000 + d * 3
        : kind === 'shrub' ? 800 + d * 5 : (d < 600 ? 0 : 3000) + d * 3;
    }
    return { key: `veg:${this.version}:${kind}:${i}:${j}`, kind, i, j, d, priority,
      groundBounds: [i * C - pad, j * C - pad, (i + 1) * C + pad, (j + 1) * C + pad] };
  }

  /**
   * Eye positions over the next STREAM_LEAD.seconds of driving: the current
   * eye carried along the route, its offset from the route turning with it.
   */
  _leadEyes() {
    const view = this._grassView, travel = this._travel, route = this.world?.route;
    if (!view || !travel || typeof route?.at !== 'function') return [];
    const here = route.at(travel.s, {}), heading = Math.atan2(here.tz, here.tx);
    const ox = view.x - here.x, oz = view.z - here.z;
    const distance = Math.max(travel.speed, STREAM_LEAD.minimumSpeed) * STREAM_LEAD.seconds;
    const eyes = [], point = {};
    for (let d = STREAM_LEAD.step; d <= distance + 1e-6; d += STREAM_LEAD.step) {
      route.at(travel.s + d, point);
      const turn = Math.atan2(point.tz, point.tx) - heading, c = Math.cos(turn), s = Math.sin(turn);
      eyes.push({ x: point.x + ox * c - oz * s, z: point.z + ox * s + oz * c, d });
    }
    return eyes;
  }

  /** Metres of driving until a lead eye is within `range` of the tile (Infinity beyond the lead). */
  _arrival(i, j, C, range) {
    for (const eye of this._eyes || []) {
      const gap = Math.hypot(Math.max(0, Math.abs((i + 0.5) * C - eye.x) - C / 2), Math.max(0, Math.abs((j + 0.5) * C - eye.z) - C / 2));
      if (gap <= range) return eye.d;
    }
    return Infinity;
  }

  /** Lead tiles stay within ground the terrain already plans, so they always publish. */
  _groundPlanned(kind, i, j) {
    if (!this.terrain) return true;
    const C = LATTICE[kind].tile, pad = PADDING[kind];
    return this.terrain.plansBounds?.(i * C - pad, j * C - pad, (i + 1) * C + pad, (j + 1) * C + pad, GROUND_LEVEL[kind]) ?? false;
  }

  _inRoadBand(i, j, C) {
    if (!this.world?.route?.nearest) return true;
    // A circumscribed tile bound cannot reject any root in the road band.
    const reach = GRASS_COVERAGE.roadEnd + C * Math.SQRT1_2;
    const road = this.world.route.nearest((i + 0.5) * C, (j + 0.5) * C, reach);
    return Boolean(road) && road.dist <= reach;
  }

  _plan(x, z) {
    // Replan as the car advances a grass tile or its lead grows or shrinks by a step.
    const lead = this._travel && Math.floor(Math.max(this._travel.speed, STREAM_LEAD.minimumSpeed) * STREAM_LEAD.seconds / STREAM_LEAD.step);
    const travel = this._travel && this._grassView ? `;${Math.floor(this._travel.s / POPULATION.grass.tile)},${lead}` : '';
    const terrainPlan = this.terrain?.requests ?? null;
    const signature = KINDS.map(kind => {
      const C = LATTICE[kind].tile;
      return `${Math.floor(x / C)},${Math.floor(z / C)}`;
    }).join(';') + (this._grassView ? `;${Math.floor(Math.atan2(this._grassView.dz, this._grassView.dx) / (Math.PI / 12))}` : '') + travel;
    if (signature === this._signature && terrainPlan === this._terrainPlan) return false;
    this._signature = signature;
    this._terrainPlan = terrainPlan;
    this._eyes = this._leadEyes();
    const jobs = [], planned = new Set();
    // Tile index pair as one number; |j| stays far below 2^20 on any route.
    const tileId = (kind, i, j) => (KINDS.indexOf(kind) * 4194304 + i) * 2097152 + j;
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
        if (kind === 'grass' && !this._inRoadBand(i, j, C)) continue;
        jobs.push(this._job(kind, i, j, x, z));
        planned.add(tileId(kind, i, j));
      }
    }
    // Lead: cover the eye will reach soon, wherever its ground is planned.
    for (const kind of this._eyes.length ? COVER_KINDS : []) {
      const C = LATTICE[kind].tile, range = VIEW_RANGE[kind];
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const eye of this._eyes) {
        x0 = Math.min(x0, eye.x); z0 = Math.min(z0, eye.z); x1 = Math.max(x1, eye.x); z1 = Math.max(z1, eye.z);
      }
      for (let j = Math.floor((z0 - range) / C); j <= Math.floor((z1 + range) / C); j++) {
        for (let i = Math.floor((x0 - range) / C); i <= Math.floor((x1 + range) / C); i++) {
          if (planned.has(tileId(kind, i, j))) continue;
          const arrival = this._arrival(i, j, C, range);
          if (arrival === Infinity) continue;
          if (kind === 'grass' && !this._inRoadBand(i, j, C)) continue;
          if (!this._groundPlanned(kind, i, j)) continue;
          jobs.push(this._job(kind, i, j, x, z, arrival));
        }
      }
    }
    jobs.sort((a, b) => a.priority - b.priority);
    this._streamJobs = jobs;
    this._streamWant = new Set(jobs.map(job => job.key));
    const now = performance.now();
    for (const [key, entry] of this.tiles) if (!this._streamWant.has(key)) {
      for (const mesh of entry.meshes) mesh.visible = false;
      entry.shown = false;
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
    if (entry.groundReady && !entry.shown && this._fadeReveals) this._fadeIn(entry);
    entry.shown = entry.groundReady;
    if (entry.groundReady !== wasReady && this.tiles.has(entry.job.key)) {
      this.terrain?.plantContactChanged?.(entry, !entry.groundReady);
    }
  }

  /** A ground-cover tile appearing in a presented, moving scene fills in instead of popping. */
  _fadeIn(entry) {
    if (!COVER_KINDS.includes(entry.job.kind)) return;
    for (const mesh of entry.meshes) {
      const field = mesh.userData.field === 'grass' ? this.grass : mesh.userData.field === 'flowers' ? this.flowers : this.forest;
      field?.reveal(mesh, this._revealClock);
    }
    this._revealEnd = this._revealClock + GRASS_REVEAL.seconds;
  }

  /** Fades advance only in presented, moving time; any hold completes them, keeping captures exact. */
  _advanceReveal(app, dt) {
    if (!app) return;
    this._fadeReveals = Boolean(app.presented) && !app.paused && !app.forceDrain && !app.loading && !app._backgrounded;
    this._revealClock = this._fadeReveals ? this._revealClock + dt : Math.max(this._revealClock, this._revealEnd);
    this.grass.setRevealClock(this._revealClock);
    this.flowers.setRevealClock(this._revealClock);
    this.forest.setRevealClock(this._revealClock);
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
    this._advanceReveal(app, dt);
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
    const vehicle = app?.vehicle;
    this._travel = vehicle && Number.isFinite(vehicle.s)
      ? { s: vehicle.s, speed: Number.isFinite(vehicle.speed) ? Math.abs(vehicle.speed) : 0 } : null;
    // Streaming is centered between car and camera, while grass fades from the
    // camera. Include that offset and the whole cell before revealing a scene.
    this._grassReadyRadius = GRASS_COVERAGE.viewEnd + POPULATION.grass.tile * Math.SQRT1_2
      + Math.hypot((camera?.position.x ?? x) - x, (camera?.position.z ?? z) - z);
    if (camera) {
      const height = app.quality?.lodHeight ?? this.atmo.renderer.domElement.height;
      this.grass.update(camera, this.time, this.seasonName, height);
      this.forest.update(camera, this.time, this.seasonName, height);
    }
    const moved = this._plan(x, z);
    this._cancelBuilds(key => !this.scheduler.has(key));
    this.refreshVisibility(moved);
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

  /**
   * Re-test ground support when terrain coverage changed (or `force`), e.g.
   * once the frame's scheduled terrain work has run, so grass appears with its
   * ground. Planning, worker polling and publication run once per frame in update().
   */
  refreshVisibility(force = false) {
    const revision = this.terrain?.coverageRevision ?? 0;
    if (!force && revision === this._coverageRevision) return;
    for (const entry of this.tiles.values()) this._visibility(entry);
    this._coverageRevision = revision;
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
