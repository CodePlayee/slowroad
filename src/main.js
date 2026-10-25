// src/main.js — application shell: builds the world, streams it, runs the loop,
// installs the deterministic capture rig.

import * as THREE from 'three';
import { World } from './world/world.js';
import { Atmosphere } from './atmosphere/atmosphere.js';
import { Terrain } from './terrain/terrain.js';
import { WaterSystem } from './water/water.js';
import { RoadMesh } from './road/roadmesh.js';
import { BridgeSystem } from './bridge/bridge.js';
import { VegetationSystem as Vegetation } from './vegetation/system.js';
import { InstanceCuller } from './vegetation/instanceCulling.js';
import { Vehicle } from './vehicle/vehicle.js';
import { CameraRig } from './camera/cameras.js';
import { Scheduler } from './streaming/scheduler.js';
import { Hud } from './ui/hud.js';
import { installRig } from './rig/rig.js';
import { RenderQuality } from './core/renderQuality.js';

const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

function readParams() {
  const q = new URLSearchParams(location.search);
  const num = (k, d) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
  return {
    seed: q.has('seed') ? (Number.isFinite(Number(q.get('seed'))) ? Number(q.get('seed')) : q.get('seed')) : 7,
    t: num('t', 12),
    season: q.get('season') || 'summer',
    weather: q.get('weather') || 'clear',
    cam: q.get('cam') || 'chase',
    // Camera and route inputs are user-controlled; reject non-finite values and
    // keep them in ranges that cannot produce NaN transforms or inverted cameras.
    km: Math.max(0, num('km', 0)),
    dist: Math.min(4, Math.max(0.1, num('dist', 1))),
    ui: q.get('ui') !== '0',
    paused: q.get('paused') === '1',
    pixelRatio: Math.max(0.75, Math.min(2, num('dpr', q.get('paused') === '1' && q.get('quality') !== 'high' ? 1 : Math.min(1.5, window.devicePixelRatio || 1)))),
    fixedRatio: q.has('dpr') || q.get('quality') === 'high' || q.get('paused') === '1' && q.get('quality') !== 'auto',
    lodScale: Math.min(2, Math.max(0.5, num('lod', q.get('quality') === 'high' ? Math.min(1.5, window.devicePixelRatio || 1) : 1))),
  };
}

function showError(e) {
  const el = document.getElementById('err');
  if (!el) return;
  el.style.display = 'block';
  el.textContent += (el.textContent ? '\n' : '') + String(e && e.stack ? e.stack : e);
}

class App {
  constructor() {
    this.opts = readParams();
    this.fatal = null;
    this.frameNo = 0;
    this.paused = this.opts.paused;
    this.forceDrain = false;
    this.loading = true;
    this.presented = false;
    this.stats = { fps: 0, frames: 0, acc: 0 };
    this._waiters = [];
    this._rafId = 0;
    this._backgrounded = typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    // three r185 always requests an alpha drawing buffer. Alpha-to-coverage
    // foliage and feathered road edges write alpha < 1, which then lets the page
    // background show through the canvas. The scene is fully opaque, so own the
    // context and request an opaque buffer.
    const context = canvas.getContext('webgl2', {
      alpha: false, antialias: true, powerPreference: 'high-performance', stencil: false, depth: true,
    });
    this.renderer = new THREE.WebGLRenderer({
      canvas, context, antialias: true, powerPreference: 'high-performance', stencil: false,
    });
    this.quality = new RenderQuality({ deviceRatio: window.devicePixelRatio || 1,
      fixedRatio: this.opts.fixedRatio ? this.opts.pixelRatio : null, lodScale: this.opts.lodScale });
    this.renderer.setPixelRatio(this.quality.resize(window.innerWidth, window.innerHeight));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Keep shadow rendering disabled while the vegetation look is tuned. This
    // also prevents stale shadow-map allocations from making iterative captures
    // compete with the user's desktop GPU.
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    // Leave headroom for simulation and rendering while streaming. Individual
    // builds remain atomic, but a smaller queue slice prevents several tile
    // builds from clustering in the same frame during travel.
    this.scheduler = new Scheduler(6);

    this.world = new World(this.opts.seed).build();
    this.atmo = new Atmosphere(this.scene, this.renderer);
    this.atmo.set({ t: this.opts.t, season: this.opts.season, weather: this.opts.weather });

    this.water = new WaterSystem(this.world, this.atmo);
    this.terrain = new Terrain(this.world, this.atmo, this.scheduler, this.water);
    this.road = new RoadMesh(this.world, this.atmo, this.scheduler, this.terrain);
    this.bridges = new BridgeSystem(this.world, this.atmo, this.scheduler);
    this.veg = new Vegetation(this.world, this.atmo, this.scheduler, this.terrain);
    this.instanceCulling = new InstanceCuller();
    this.terrain.applyPalette();
    this.road.applyPalette();

    this.scene.add(this.terrain.group);
    this.scene.add(this.terrain.waterGroup);
    this.scene.add(this.road.group, this.bridges.group, this.veg.group);

    this.vehicle = new Vehicle(this.world, this.atmo);
    this.scene.add(this.vehicle.group);
    this.cameras = new CameraRig(this.vehicle, this.world);
    this.cameras.setMode(this.opts.cam);
    this.cameras.distScale = this.opts.dist;

    this.hud = new Hud();
    if (!this.opts.ui) this.hud.hide();

    this.requestedS = this.world.route.kmToS(this._validKm(this.opts.km));
    this.vehicle.snapTo(this.requestedS);
    this.cameras.snap();
    this.streamAll();

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.installKeys();

    this.lastT = performance.now();
    this.installLifecyclePause();
    installRig(this);
    this._scheduleFrame();
  }

  _validKm(km) {
    const n = Number(km);
    if (!Number.isFinite(n)) return 0;
    return Math.min(this.world.route.maxKm, Math.max(0, n));
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setPixelRatio(this.quality.resize(w, h));
    this.renderer.setSize(w, h);
    this.cameras.resize(w, h);
  }

  installKeys() {
    const order = ['chase', 'cockpit', 'cine', 'vista'];
    window.addEventListener('keydown', (e) => {
      if (e.key === 'c' || e.key === 'C') {
        this.applySettings({ cam: order[(order.indexOf(this.cameras.mode) + 1) % order.length] });
      } else if (e.key === 'h' || e.key === 'H') this.hud.toggle();
      else if (e.key === '[') this.atmo.set({ t: this.atmo.time - 0.5 });
      else if (e.key === ']') this.atmo.set({ t: this.atmo.time + 0.5 });
      else if (e.key === ',' || e.key === '.') {
        const i = SEASONS.indexOf(this.atmo.seasonName);
        const n = SEASONS[(i + (e.key === '.' ? 1 : 3)) % 4];
        this.applySettings({ season: n });
      } else if (e.key === 'p' || e.key === 'P') this.paused = !this.paused;
    });
  }

  installLifecyclePause() {
    const suspend = () => {
      this._backgrounded = true;
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = 0;
      // Do not let elapsed wall time become a simulation step on resume.
      this.lastT = performance.now();
    };
    const resume = () => {
      if (document.visibilityState === 'hidden') { suspend(); return; }
      this._backgrounded = false;
      this.lastT = performance.now();
      this._scheduleFrame();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') suspend(); else resume();
    });
    window.addEventListener('pagehide', suspend);
    window.addEventListener('pageshow', resume);
  }

  _scheduleFrame() {
    if (this._backgrounded || this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = 0;
      this.tick();
    });
  }

  // ---------------------------------------------------------------- streaming

  streamAll() {
    const c = this.cameras.camera.position;
    const focusX = (c.x + this.vehicle.pos.x) / 2;
    const focusZ = (c.z + this.vehicle.pos.z) / 2;
    const distance = Math.max(40, this.vehicle.speed * this.terrain.prefetchSeconds);
    const ahead = this.world.route.at(this.vehicle.s + distance, {});
    this.terrain._frame = this.frameNo;
    this.terrain.update(focusX, focusZ, ahead);
    this.road.setVehicleContact(this.vehicle);
    this.road.update(this.vehicle.s);
    this.bridges.update(this.vehicle.s);
    this.veg.update(focusX, focusZ);
  }

  residencyReport() {
    return {
      pending: this.scheduler.pending,
      terrainPending: this.terrain.pending,
      terrainWorkers: this.terrain.workerPool.pending,
      terrainCached: this.terrain.chunks.size,
      terrainBytes: this.terrain.cachedBytes || 0,
      surfaceReady: this.terrain.coverageReady,
      terrain: `${this.terrain.resident}/${this.terrain.required ?? 0}`,
      road: `${this.road.resident}/${this.road.required ?? 0}`,
      bridges: `${this.bridges.resident}/${this.bridges.required ?? 0}`,
      vegetation: `${this.veg.resident}/${this.veg.required ?? 0}`,
      frames: this.frameNo,
    };
  }

  residencyOk() {
    return !this.loading && this.scheduler.pending === 0 && this.terrain.pending === 0 && this.terrain.settled &&
      this.terrain.resident >= (this.terrain.required ?? 0) &&
      this.road.resident >= (this.road.required ?? 0) &&
      this.bridges.resident >= (this.bridges.required ?? 0) &&
      this.veg.resident >= (this.veg.required ?? 0);
  }

  nextFrame() {
    return new Promise((res) => {
      let watchdog;
      this._waiters.push(() => { clearTimeout(watchdog); res(); });
      // watchdog: if rAF is being throttled (backgrounded page), tick manually so
      // __rig.ready() can never deadlock.
      const n = this.frameNo;
      watchdog = setTimeout(() => {
        if (this.frameNo === n) { this._rafStarved = (this._rafStarved || 0) + 1; this.tick(true); }
      }, 500);
    });
  }

  // ---------------------------------------------------------------- controls

  async applySettings(opts = {}) {
    let rebuildWorld = false, rebuildVeg = false;
    if (opts.seed !== undefined && String(opts.seed) !== String(this.world.seedInput)) {
      this.beginTransition();
      this.world = new World(opts.seed).build();
      rebuildWorld = true;
    }
    if (opts.t !== undefined || opts.season !== undefined || opts.weather !== undefined) {
      const previousSeason = this.atmo.seasonName;
      this.atmo.set({ t: opts.t, season: opts.season, weather: opts.weather });
      rebuildVeg = this.atmo.seasonName !== previousSeason;
      this.terrain.applyPalette();
      this.road.applyPalette();
    }
    if (opts.season !== undefined) this.veg.setSeason(this.atmo.seasonName, false);
    if (rebuildWorld) {
      for (const sys of [this.terrain, this.road, this.bridges, this.veg]) {
        sys.world = this.world;
        sys.route = this.world.route;
        sys.rebuildAll();
      }
      this.water.world = this.world;
      this.vehicle.world = this.world;
      this.vehicle.route = this.world.route;
      this.cameras.world = this.world;
      this.veg.seed = this.world.seed ^ 0x2b7c1f03;
      this.requestedS = this.world.route.kmToS(this._validKm(opts.km ?? 0));
      this.vehicle.snapTo(this.requestedS);
    } else if (rebuildVeg && !this.veg.seasonInShader) {
      this.veg.rebuildAll();
    }
    if (opts.km !== undefined) {
      this.beginTransition();
      this.requestedS = this.world.route.kmToS(this._validKm(opts.km));
      this.vehicle.snapTo(this.requestedS);
    }
    if (opts.cam !== undefined) {
      if (opts.cam !== this.cameras.mode) this.beginTransition();
      this.cameras.setMode(opts.cam);
    }
    if (opts.dist !== undefined) {
      const d = Number(opts.dist);
      this.cameras.distScale = Number.isFinite(d) ? Math.min(4, Math.max(0.1, d)) : 1;
    }
    this.cameras.snap();
    this.streamAll();
  }

  teleport(km) {
    this.beginTransition();
    this.requestedS = this.world.route.kmToS(this._validKm(km));
    this.vehicle.snapTo(this.requestedS);
    this.cameras.snap();
    this.streamAll();
  }

  /**
   * Return the scene to the exact deterministic state implied by the current
   * logical parameters: car back on its requested arc length, camera snapped with
   * zero smoothing, and every wall-clock-driven animation clock zeroed.
   * Called by __rig.snap(); this is what makes two captures of the same query
   * byte-identical even if the sim ran for a few frames during boot.
   */
  resnap() {
    this.beginTransition();
    if (this.requestedS === undefined) this.requestedS = this.vehicle.s;
    this.vehicle.snapTo(this.requestedS);
    this.water.time = 0;
    this.water.ripple.offset.set(0, 0);
    const su = this.atmo.sky.userData.uniforms;
    if (su && su.uTime) su.uTime.value = 0;
    this.cameras.snap();
    this.streamAll();
    return true;
  }

  beginTransition() {
    // Keep the last complete frame during discontinuous moves, rather than
    // revealing an unprepared destination. Ordinary driving never enters here.
    this.loading = true;
    this.terrain.presented = false;
  }

  paramSnapshot() {
    return {
      seed: this.world.seedInput, t: this.atmo.time, season: this.atmo.seasonName,
      weather: this.atmo.weatherName, cam: this.cameras.mode, dist: this.cameras.distScale,
      km: this.vehicle.km, routeKm: Math.round(this.world.route.maxKm * 10) / 10,
      bridges: this.world.route.bridges.length,
      viewport: [window.innerWidth, window.innerHeight],
      quality: { dpr: this.renderer.getPixelRatio(), lodScale: this.quality.lodScale,
        adaptive: this.quality.adaptive, changes: this.quality.changes },
      routeBuildMs: Math.round(this.world.buildMs),
    };
  }

  // -------------------------------------------------------------------- loop

  tick(manual = false) {
    if (!manual && this._backgrounded) return;
    if (!manual) this._scheduleFrame();
    try { this.frame(); } catch (e) {
      if (!this.fatal) { this.fatal = String(e && e.stack ? e.stack : e); showError(e); console.error(e); }
    }
    const w = this._waiters; this._waiters = [];
    for (const r of w) r();
  }

  frame() {
    const now = performance.now();
    const frameMs = now - this.lastT;
    const qualityEligible = !this.paused && !this.forceDrain && !this._backgrounded && !this.loading;
    // Resize before rendering, never after presenting a completed frame.
    if (!this.loading && this.renderer.getPixelRatio() !== this.quality.pixelRatio) this.renderer.setPixelRatio(this.quality.pixelRatio);
    let dt = Math.min(0.05, frameMs / 1000);
    this.lastT = now;
    if (this.paused || this.forceDrain || this._backgrounded || this.loading) dt = 0;

    // A zero-time update keeps lights and newly loaded assets in sync while paused.
    if (this.vehicle.update(dt)) {
      // A route wrap is a teleport: snap the camera and hold the last complete
      // frame until the starting area is resident, just like an explicit jump.
      this.teleport(0);
      dt = 0;
    }
    this.cameras.update(dt);
    this.streamAll();
    this.scheduler.run(this.forceDrain ? 90 : this.scheduler.budgetMs);
    this.terrain.refreshCoverage();
    this.veg.update(this.terrain.focusX, this.terrain.focusZ);
    this.water.update(dt);
    this.atmo.update(this.cameras.camera, this.vehicle.pos, dt);
    if (this.loading && this.terrain.coverageReady && this.road.resident >= this.road.required &&
        (this.vehicle.assetReady || this.vehicle.assetError) && this.veg.minimumReady) {
      this.loading = false;
    }
    const assetError = this.terrain.assetError || this.vehicle.assetError || this.veg.assetError;
    if (assetError && !this._assetWarning) {
      this._assetWarning = true;
      showError('Some scene assets could not load. Reload to retry.\n' + assetError);
    }
    if (!this.loading || !this.presented) {
      try {
        this.instanceCulling.prepare(this.veg.group, this.cameras.camera);
        this.renderer.render(this.scene, this.cameras.camera);
      } finally { this.instanceCulling.restore(); }
    }
    this.frameNo++;

    const st = this.stats;
    st.frames++;
    if (st.t0 === undefined) st.t0 = now;
    if (now - st.t0 >= 400) {
      st.fps = (st.frames * 1000) / (now - st.t0);
      st.frames = 0; st.t0 = now;
    }
    this.hud.update(Math.max(dt, 0.016), this);
    const cpuMs = performance.now() - now;
    // The interval ending now includes the previous frame's work, not this one.
    this.quality.sample(frameMs, this._qualityCpuMs ?? cpuMs, qualityEligible && !this.loading);
    this._qualityCpuMs = cpuMs;

    if (!this.loading) {
      const b = document.getElementById('boot');
      if (b) b.classList.add('gone');
      this.presented = true;
      this.terrain.presented = true;
    }
  }
}

try {
  window.__app = new App();
} catch (e) {
  showError(e);
  console.error(e);
  window.__rig = { error: () => String(e && e.stack ? e.stack : e), ready: () => Promise.reject(e) };
}
