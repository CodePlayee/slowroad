#!/usr/bin/env node
// gauntlet/frame-bench.mjs — repeatable headless per-frame cost benchmark.
//
//   PLAYWRIGHT_BROWSERS_PATH=~/.local/ms-playwright \
//     node gauntlet/frame-bench.mjs --url http://127.0.0.1:5194 --out /tmp/bench.json \
//       [--width 1280 --height 720] [--cases chase,cockpit,...] [--drive-frames 300]
//       [--gpu-frames 2] [--profile]
//
// For every case the page boots paused at DPR 1, settles residency with the
// main-scene draw skipped (as cpu-capture.mjs does), then stops the rAF loop and
// drives App.frame() manually:
// - static: paused frames, draw calls stubbed out, CPU time per subsystem;
// - gpu: real frames finished by a 1-pixel readPixels, a rough SwiftShader
//   total-frame proxy (vertex + raster work in the GPU process);
// - drive: unpaused frames at a fixed 1/60 s step, paced to 16.7 ms wall time
//   so streaming workers keep their real share, draws stubbed.
// WebGL draw entry points are stubbed only for CPU stages; three.js still does
// all state, uniform and buffer work and counts renderer.info as usual.
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const base = flag('--url', process.env.GAUNTLET_URL || 'http://127.0.0.1:5188').replace(/\/$/, '');
const out = flag('--out', null);
const width = Number(flag('--width', '1280')), height = Number(flag('--height', '720'));
const staticFrames = Number(flag('--static-frames', '30'));
const driveFrames = Number(flag('--drive-frames', '300'));
const gpuFrames = Number(flag('--gpu-frames', '2'));
const profile = args.includes('--profile');
const CASES = {
  chase: 'seed=7&t=12&season=summer&weather=clear&cam=chase&km=6.0',
  cockpit: 'seed=7&t=11.2&season=summer&weather=clear&cam=cockpit&km=5.2',
  cine: 'seed=7&t=16.5&season=summer&weather=clear&cam=cine&km=12.1',
  vista: 'seed=31&t=17.2&season=summer&weather=hazy&cam=vista&km=8.0',
  forest: 'seed=12&t=13.5&season=summer&weather=clear&cam=chase&km=5.5',
};
const caseNames = flag('--cases', Object.keys(CASES).join(',')).split(',');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Serialized into the page.
async function benchPage({ staticFrames, driveFrames, gpuFrames }) {
  const app = window.__app, rig = window.__rig, renderer = app.renderer, gl = renderer.getContext();
  const stats = (v) => {
    const s = v.slice().sort((a, b) => a - b), n = s.length || 1;
    return { mean: +(s.reduce((a, b) => a + b, 0) / n).toFixed(3), p50: +(s[Math.floor(n * 0.5)] ?? 0).toFixed(3),
      p95: +(s[Math.floor(n * 0.95)] ?? 0).toFixed(3), max: +(s[s.length - 1] ?? 0).toFixed(3) };
  };
  let cpu = {}, collecting = false;
  const trace = (object, method, label) => {
    const original = object[method];
    object[method] = function (...a) {
      const t = performance.now();
      try { return original.apply(this, a); } finally { if (collecting) (cpu[label] ||= []).push(performance.now() - t); }
    };
  };
  const drawNames = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'];
  const realDraw = Object.fromEntries(drawNames.map((n) => [n, gl[n]]));
  const stubDraws = (on) => { for (const n of drawNames) gl[n] = on ? () => {} : realDraw[n]; };
  const tiny = (on) => {
    app.quality.pixelRatio = on ? 0.04 : app.quality.maximumRatio;
    renderer.setPixelRatio(app.quality.pixelRatio);
  };
  const render = renderer.render;
  let skipMain = true;
  renderer.render = function (scene, camera) { if (skipMain && scene === app.scene) return; return render.call(this, scene, camera); };
  tiny(true);
  rig.pause(); rig.snap();
  const t0 = performance.now();
  await rig.ready({ timeoutMs: 3600e3, frames: 22 });
  rig.hideUI(); rig.snap();
  await rig.ready({ timeoutMs: 3600e3, frames: 6 });
  const settleMs = performance.now() - t0;
  // Stop the rAF loop; frames are driven manually below. Clearing the
  // backgrounded flag again keeps dt live while unpaused.
  app._backgrounded = true;
  if (app._rafId) cancelAnimationFrame(app._rafId);
  app._rafId = 0;
  app._backgrounded = false;
  tiny(false);
  skipMain = false;
  window.__benchMeasuring = true;
  trace(app.vehicle, 'update', 'vehicle');
  trace(app.cameras, 'update', 'cameras');
  trace(app, 'streamAll', 'streamAll');
  trace(app.terrain, 'update', 'streamAll.terrain');
  trace(app.road, 'update', 'streamAll.road');
  trace(app.scheduler, 'run', 'scheduler');
  trace(app.terrain, 'refreshCoverage', 'coverage');
  trace(app.veg, 'update', 'veg.update(all)');
  trace(app.water, 'update', 'water');
  trace(app.atmo, 'update', 'atmosphere');
  trace(app.instanceCulling, 'prepare', 'instanceCulling');
  trace(app.instanceCulling, 'restore', 'cullRestore');
  trace(renderer, 'render', 'render');
  trace(app.hud, 'update', 'hud');
  trace(app, 'frame', 'frame');
  const info = () => {
    const r = renderer.info;
    return { calls: r.render.calls, triangles: r.render.triangles, points: r.render.points, lines: r.render.lines,
      programs: r.programs?.length ?? 0, geometries: r.memory.geometries, textures: r.memory.textures };
  };
  const yieldTask = () => new Promise((res) => { const c = new MessageChannel(); c.port1.onmessage = () => res(); c.port2.postMessage(0); });
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const step = () => { app.lastT = performance.now() - 1000 / 60; app.frame(); };
  const result = { settleMs, viewport: [innerWidth, innerHeight], dpr: renderer.getPixelRatio() };
  // Warm programs and caches with one real frame; compilation does not depend
  // on resolution, so keep the raster cost of this frame negligible.
  tiny(true);
  step();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  tiny(false);
  // Static CPU.
  stubDraws(true);
  for (let i = 0; i < 5; i++) { step(); await yieldTask(); }
  cpu = {}; collecting = true;
  const infos = [];
  for (let i = 0; i < staticFrames; i++) { step(); infos.push(info()); await yieldTask(); }
  collecting = false;
  result.static = { cpu: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, stats(v)])), info: infos[infos.length - 1] };
  stubDraws(false);
  // GPU proxy.
  const px = new Uint8Array(4), gpu = [];
  for (let i = 0; i < gpuFrames; i++) {
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t = performance.now();
    step();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gpu.push(performance.now() - t);
  }
  result.gpuFrameMs = stats(gpu);
  // Driving.
  if (driveFrames > 0) {
    stubDraws(true);
    rig.resume();
    const startKm = app.vehicle.km;
    cpu = {}; collecting = true;
    const di = [];
    const heap0 = performance.memory?.usedJSHeapSize ?? 0;
    for (let i = 0; i < driveFrames; i++) {
      const t = performance.now();
      step();
      di.push(info());
      const left = 1000 / 60 - (performance.now() - t);
      if (left > 1) await sleep(left); else await yieldTask();
    }
    collecting = false;
    rig.pause();
    stubDraws(false);
    const sum = (k) => di.reduce((a, x) => a + x[k], 0) / di.length;
    result.drive = { startKm, endKm: app.vehicle.km, frames: driveFrames,
      cpu: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, stats(v)])),
      info: { calls: +sum('calls').toFixed(1), triangles: Math.round(sum('triangles')), programs: di[di.length - 1].programs,
        geometries: di[di.length - 1].geometries, textures: di[di.length - 1].textures },
      heapDeltaMB: +(((performance.memory?.usedJSHeapSize ?? 0) - heap0) / 1048576).toFixed(1) };
  }
  result.error = rig.error();
  return result;
}

fs.mkdirSync('/tmp/gauntlet-browsers', { recursive: true, mode: 0o700 });
const profileDir = fs.mkdtempSync('/tmp/gauntlet-browsers/bench-');
const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: true, viewport: { width, height }, deviceScaleFactor: 1, timeout: 20000,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-watchdog',
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--enable-precise-memory-info'],
});
await ctx.addInitScript(() => {
  const Native = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (String(protocols).includes('vite')) {
      const fake = new EventTarget();
      fake.readyState = 0; fake.send = () => {}; fake.close = () => {};
      return fake;
    }
    return new Native(url, protocols);
  };
  Object.assign(window.WebSocket, Native);
});
const results = { base, width, height, cases: {} };
try {
  for (const name of caseNames) {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
    try {
      await page.goto(`${base}/?${CASES[name]}&paused=1&dpr=1`, { timeout: 30000, waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__rig && window.__app, null, { timeout: 30000 });
      let cdp = null;
      if (profile) {
        cdp = await ctx.newCDPSession(page);
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      }
      const run = page.evaluate(benchPage, { staticFrames, driveFrames, gpuFrames });
      let res;
      if (cdp) {
        // Profile only the measured part: wait until the frame loop has stopped.
        await page.waitForFunction(() => window.__benchMeasuring, null, { timeout: 0, polling: 200 });
        await cdp.send('Profiler.start');
        res = await run;
        const { profile: p } = await cdp.send('Profiler.stop');
        res.hot = summarize(p);
      } else res = await run;
      res.errors = errors;
      results.cases[name] = res;
      log(name, JSON.stringify({ static: res.static?.info, gpu: res.gpuFrameMs, frame: res.static?.cpu.frame, drive: res.drive?.cpu.frame, km: [res.drive?.startKm, res.drive?.endKm] }));
    } catch (e) {
      results.cases[name] = { err: String(e.message), errors };
      log(name, 'FAIL', e.message);
    } finally { await page.close().catch(() => {}); }
    if (out) fs.writeFileSync(out, JSON.stringify(results, null, 1));
  }
} finally {
  await ctx.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
}

function summarize(p) {
  const self = new Map(), byId = new Map(p.nodes.map((n) => [n.id, n]));
  const dt = new Map();
  for (let i = 0; i < p.samples.length; i++) dt.set(p.samples[i], (dt.get(p.samples[i]) || 0) + (p.timeDeltas[i] || 0));
  for (const [id, us] of dt) {
    const f = byId.get(id).callFrame;
    const key = `${f.functionName || '(anon)'} ${f.url.replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '')}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + us / 1000);
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  return { totalMs: Math.round(total), top: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, ms]) => [k, Math.round(ms)]) };
}
