#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Self-contained so Playwright can serialize this function into the page.
export async function profileScene({ ablation, warmupFrames = 15, sampleFrames = 90, queryDrainFrames = 10, drivingMs }) {
  if (drivingMs !== undefined && (!Number.isFinite(drivingMs) || drivingMs <= 0)) throw new RangeError('drivingMs must be positive');
  const app = globalThis.__app, rig = globalThis.__rig, renderer = app.renderer, gl = renderer.getContext();
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const hooks = [], pending = [], stages = {}, submissions = {}, submissionCalls = {};
  const originalRender = renderer.render, originalPixelRatio = renderer.getPixelRatio();
  let collecting = false, variant = 'full', cpu = {}, gpuSamples = [], measurement = 0;
  const summary = values => {
    const s = values.slice().sort((a, b) => a - b);
    return { mean: s.reduce((a, b) => a + b, 0) / (s.length || 1), p50: s[Math.floor(s.length * 0.5)] || 0, p95: s[Math.floor(s.length * 0.95)] || 0 };
  };
  const replace = (object, method, replacement) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, method);
    object[method] = replacement;
    hooks.push(() => {
      if (descriptor) Object.defineProperty(object, method, descriptor);
      else delete object[method];
    });
  };
  const trace = (object, method, label) => {
    const original = object?.[method];
    if (typeof original !== 'function') return;
    replace(object, method, function(...args) {
      const start = performance.now();
      try { return original.apply(this, args); }
      finally { if (collecting) (cpu[label] ||= []).push(performance.now() - start); }
    });
  };
  const excluded = (object, kind) => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const field = object.userData?.field, foliageKind = object.userData?.foliageKind;
    return materials.some(material => {
      const name = material?.name || '';
      if (kind === 'understory') return foliageKind === 'shrub' || name.startsWith('field-shrub-') || name.startsWith('understory-');
      if (kind === 'grass') return field === 'grass' || name.startsWith('field-grass') || name.startsWith('veg-meadow') || name === 'veg-grass' || name === 'veg-curve';
      if (kind === 'woodland') return foliageKind === 'tree' || name.startsWith('field-tree-') || name.startsWith('woodland-');
      if (kind === 'terrain') return name === 'terrain';
      return kind === 'vegetation' && (['grass', 'forest', 'flowers'].includes(field) ||
        name.startsWith('field-') || name.startsWith('veg-') || name.startsWith('woodland-') || name.startsWith('understory-'));
    });
  };
  const clearQueries = () => {
    for (const { q } of pending.splice(0)) gl.deleteQuery(q);
  };
  const drainQueries = () => {
    if (!timer) return;
    // A disjoint event invalidates every outstanding timer, not only the first.
    if (gl.getParameter(timer.GPU_DISJOINT_EXT)) { gpuSamples = []; clearQueries(); return; }
    while (pending.length && gl.getQueryParameter(pending[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const p = pending.shift();
      try {
        if (p.measurement === measurement) gpuSamples.push(gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6);
      } finally { gl.deleteQuery(p.q); }
    }
  };
  const measure = async (key, driving = false) => {
    variant = key;
    collecting = false;
    measurement++;
    for (let i = 0; i < warmupFrames; i++) { await app.nextFrame(); drainQueries(); }
    cpu = {}; gpuSamples = [];
    const frames = [];
    collecting = true;
    if (driving) rig.resume();
    const sampleStart = performance.now(), startKm = app.vehicle?.km ?? null;
    for (let i = 0; driving && drivingMs !== undefined ? performance.now() - sampleStart < drivingMs : i < sampleFrames; i++) {
      const start = performance.now();
      await app.nextFrame();
      frames.push(performance.now() - start);
      drainQueries();
    }
    collecting = false;
    rig.pause();
    const elapsedMs = performance.now() - sampleStart, endKm = app.vehicle?.km ?? null;
    const counts = { ...renderer.info.render };
    for (let i = 0; pending.length && i < queryDrainFrames; i++) { await app.nextFrame(); drainQueries(); }
    const wall = summary(frames);
    stages[key] = { frames: frames.length, elapsedMs, startKm, endKm, frameMs: wall, fps: wall.mean ? 1000 / wall.mean : 0,
      gpuMs: timer && gpuSamples.length ? summary(gpuSamples) : null, gpuSamples: gpuSamples.length,
      cpuMs: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, summary(v)])), render: counts };
    clearQueries();
  };
  try {
    trace(app, 'frame', 'frameCPU');
    trace(app.scheduler, 'run', 'buildQueue');
    trace(app.terrain, 'update', 'terrain');
    trace(app.terrain, 'refreshCoverage', 'coverage');
    trace(app.veg, 'update', 'vegetation');
    trace(app.veg?.woodland, 'sync', 'woodland');
    trace(app.veg?.grass, 'update', 'grassField');
    trace(app.veg?.forest, 'update', 'forestField');
    trace(app.veg?.flowers, 'update', 'flowerField');
    trace(app.instanceCulling, 'prepare', 'instanceCulling');
    trace(app.road, 'update', 'road');
    trace(app.bridges, 'update', 'bridges');
    replace(renderer, 'render', function(...args) {
      const hidden = [];
      let q = null, queryStarted = false;
      try {
        if (variant.startsWith('without-')) {
          const kind = variant.slice(8);
          app.scene.traverse(object => {
            if (object.visible && object.isMesh && excluded(object, kind)) {
              hidden.push(object); object.visible = false;
            }
          });
        }
        q = timer && collecting && pending.length < 12 ? gl.createQuery() : null;
        if (q) { gl.beginQuery(timer.TIME_ELAPSED_EXT, q); queryStarted = true; }
        const start = performance.now();
        try { return originalRender.apply(this, args); }
        finally { if (collecting) (cpu.renderSubmit ||= []).push(performance.now() - start); }
      } finally {
        try {
          if (queryStarted) { gl.endQuery(timer.TIME_ELAPSED_EXT); pending.push({ q, measurement }); }
          else if (q) gl.deleteQuery(q);
        } finally { for (const object of hidden) object.visible = true; }
      }
    });
    const meshHooks = [];
    try {
      app.scene.traverse(object => {
        if (!object.isMesh) return;
        const hook = object.onBeforeRender;
        const descriptor = Object.getOwnPropertyDescriptor(object, 'onBeforeRender');
        meshHooks.push(() => {
          if (descriptor) Object.defineProperty(object, 'onBeforeRender', descriptor);
          else delete object.onBeforeRender;
        });
        object.onBeforeRender = function(r, s, c, g, m, group) {
          hook?.call(this, r, s, c, g, m, group);
          const name = m.name || this.parent?.name || 'unnamed';
          const available = g.index?.count ?? g.attributes.position.count;
          const start = Math.max(g.drawRange?.start || 0, group?.start || 0);
          const end = Math.min(available, (g.drawRange?.start || 0) + (g.drawRange?.count ?? Infinity),
            group ? group.start + group.count : Infinity);
          const triangles = Math.max(0, end - start) / 3 * (this.isInstancedMesh ? this.count : 1);
          submissions[name] = (submissions[name] || 0) + triangles;
          submissionCalls[name] = (submissionCalls[name] || 0) + 1;
        };
      });
      try {
        app.instanceCulling?.prepare(app.veg.group, app.cameras.camera);
        originalRender.call(renderer, app.scene, app.cameras.camera);
      } finally { app.instanceCulling?.restore(); }
    } finally { for (const restore of meshHooks.reverse()) restore(); }
    await measure('full');
    if (ablation) {
      for (const key of ['without-understory', 'without-grass', 'without-woodland', 'without-terrain', 'without-vegetation']) await measure(key);
      renderer.setPixelRatio(originalPixelRatio * 0.5);
      await measure('half-resolution');
      renderer.setPixelRatio(originalPixelRatio);
      await measure('full-repeat');
    }
    await measure('driving', true);
    return { gpu, gpuTimer: !!timer, viewport: [innerWidth, innerHeight],
      vegetationGeneration: app.veg?.generation ?? 1,
      submissions: Object.fromEntries(Object.entries(submissions).sort((a, b) => b[1] - a[1])), submissionCalls, stages };
  } finally {
    collecting = false;
    for (const restore of hooks.reverse()) restore();
    clearQueries();
    try { renderer.setPixelRatio(originalPixelRatio); }
    finally { rig.pause(); }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const port = flag('--port', '9421');
  const label = flag('--label', 'baseline');
  const directory = flag('--out', '/tmp/slowroad-performance');
  const baseUrl = flag('--url', process.env.GAUNTLET_URL || 'http://localhost:5188');
  const width = Number(flag('--width', '1920')), height = Number(flag('--height', '1080'));
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
  let context;
  try {
    context = await browser.newContext({ viewport: { width, height } });
    context.setDefaultTimeout(20000);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    fs.mkdirSync(directory, { recursive: true });
    const cases = {
      chase: 'seed=7&t=12&season=summer&cam=chase&km=6',
      forest: 'seed=12&t=13.5&season=summer&cam=chase&km=5.5',
      vista: 'seed=7&t=16.5&season=summer&cam=cine&km=12.1',
    };
    const results = {};
    for (const [name, query] of Object.entries(cases)) {
      await page.goto(`${baseUrl.replace(/\/$/, '')}/?${query}&paused=1`, { timeout: 20000 });
      await page.evaluate(async () => { __rig.pause(); __rig.snap(); await __rig.ready(); __rig.hideUI(); });
      await page.screenshot({ path: path.join(directory, `${label}-${name}.png`), timeout: 20000 });
      const result = await page.evaluate(profileScene, { ablation: name === 'chase' && args.includes('--ablation') });
      results[name] = result;
      fs.writeFileSync(path.join(directory, `${label}.json`), JSON.stringify({ results, errors }, null, 2));
      console.log(name, JSON.stringify(result));
    }
    if (errors.length) { console.error(errors); process.exitCode = 1; }
  } finally {
    try { await context?.close(); }
    finally { await browser.close(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
