#!/usr/bin/env node
// gauntlet/cpu-capture.mjs — canonical-shot capture for machines WITHOUT a GPU.
//
//   PLAYWRIGHT_BROWSERS_PATH=~/.local/ms-playwright \
//     node gauntlet/cpu-capture.mjs <outDir> <shotId> [<shotId> ...]
//
// Same __rig contract as gauntlet/shoot.mjs (pause, snap, ready, hideUI), but tuned
// for SwiftShader (software WebGL), where a 1080p frame costs 20-35 s:
// - every loading frame renders into a tiny drawing buffer (pixel ratio 0.04).
//   LOD follows quality.lodHeight (viewport height), not the pixel ratio, so the
//   resident world is identical to a 1080p GPU run;
// - after residency, the rAF loop is stopped and exactly one 1920x1080 frame is
//   rendered and read back in the same task;
// - the canvas is composited over the page background exactly as the browser
//   presents it (a raw WebGL toDataURL would un-premultiply any alpha < 1);
// - Vite's HMR socket is stubbed so concurrent edits cannot reload the page.
// One shot takes ~45-75 min on an 8-core Xeon. Needs the dev server on :5188.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [outDir, ...ids] = process.argv.slice(2);
if (!outDir || !ids.length) {
  console.error('usage: cpu-capture.mjs <outDir> <shotId> [<shotId> ...]');
  process.exit(2);
}
const shots = JSON.parse(fs.readFileSync(path.join(HERE, 'shots.json'), 'utf8')).shots;
const jobs = ids.map((id) => {
  if (!shots[id]) throw new Error(`unknown shot id "${id}"`);
  return { id, query: shots[id].params };
});
const base = process.env.GAUNTLET_URL || 'http://localhost:5188';
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync('/tmp/gauntlet-browsers', { recursive: true, mode: 0o700 });
const profile = fs.mkdtempSync('/tmp/gauntlet-browsers/cpu-');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, timeout: 20000,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-watchdog',
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
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
const results = [];
try {
  for (const job of jobs) {
    const out = path.join(outDir, job.id + '.png');
    if (fs.existsSync(out)) { log(job.id, 'exists, skip'); continue; }
    const t0 = Date.now();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
    try {
      await page.goto(`${base}/?${job.query}&paused=1&dpr=1`, { timeout: 20000, waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__rig && window.__app, null, { timeout: 20000 });
      const res = await page.evaluate(async () => {
        const app = window.__app, rig = window.__rig;
        const tiny = (on) => {
          app.quality.pixelRatio = on ? 0.04 : app.quality.maximumRatio;
          app.renderer.setPixelRatio(app.quality.pixelRatio);
        };
        try {
          tiny(true);
          rig.pause(); rig.snap();
          await rig.ready({ timeoutMs: 3 * 3600e3, frames: 22 });
          rig.hideUI();
          rig.snap();
          await rig.ready({ timeoutMs: 3600e3, frames: 6 });
          app._backgrounded = true;
          if (app._rafId) cancelAnimationFrame(app._rafId);
          app._rafId = 0;
          tiny(false);
          app.frame();
          const gl = app.renderer.domElement, c2 = document.createElement('canvas');
          c2.width = gl.width; c2.height = gl.height;
          const g2 = c2.getContext('2d');
          g2.fillStyle = getComputedStyle(document.body).backgroundColor; g2.fillRect(0, 0, c2.width, c2.height);
          g2.drawImage(gl, 0, 0);
          return {
            png: c2.toDataURL('image/png'),
            alpha: app.renderer.getContext().getContextAttributes().alpha,
            stats: rig.stats(),
            canvas: [gl.width, gl.height],
          };
        } catch (e) { return { err: String(e && e.message || e) }; }
      }, null, { timeout: 0 });
      if (res.err) throw new Error(res.err);
      if (res.stats.residency.pending !== 0) throw new Error('not resident ' + JSON.stringify(res.stats.residency));
      if (res.canvas[0] !== 1920 || res.canvas[1] !== 1080) throw new Error('canvas not full-res ' + res.canvas);
      fs.writeFileSync(out, Buffer.from(res.png.split(',')[1], 'base64'));
      const sec = Math.round((Date.now() - t0) / 1000);
      results.push({ id: job.id, query: job.query, ok: true, alpha: res.alpha, sec, stats: res.stats, errors });
      log(job.id, 'OK', sec + 's', JSON.stringify(res.stats.residency));
    } catch (e) {
      results.push({ id: job.id, query: job.query, ok: false, err: e.message, errors });
      log(job.id, 'FAIL', e.message, errors.slice(0, 3).join(' | '));
    } finally { await page.close().catch(() => {}); }
  }
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
  const manifest = path.join(outDir, 'capture.json');
  const prev = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : [];
  fs.writeFileSync(manifest, JSON.stringify([...prev, ...results], null, 1));
  log('done; profile removed', profile);
}
if (results.some((r) => !r.ok)) process.exitCode = 1;
