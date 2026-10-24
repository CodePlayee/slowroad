#!/usr/bin/env node
// Observe normal-budget intermediate frames, never forceDrain/rig.ready().
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const name = flag('--browser', 'terrain-streamcheck');
const port = flag('--port', '9419');
const dir = flag('--out', '/tmp/slowroad-streamcheck');
fs.mkdirSync(dir, { recursive: true });
execFileSync(process.execPath, [path.join(here, 'browser.mjs'), 'up', name, '--port', port]);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = await browser.contexts()[0].newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
const rows = [];
try {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('http://localhost:5188/?seed=7&km=6&paused=1', { waitUntil: 'domcontentloaded' });
  rows.push(await page.evaluate(async () => {
    const app = __app, start = performance.now();
    let revealed = null, frames = 0, badGround = 0;
    while (!app.residencyOk() && performance.now() - start < 60000) {
      await app.nextFrame(); frames++;
      if (document.getElementById('boot').classList.contains('gone')) {
        if (!revealed) revealed = { ms: Math.round(performance.now() - start), terrain: app.terrain.resident, required: app.terrain.required };
        if (!app.terrain.coverageReady) badGround++;
      }
      for (const tile of app.veg.tiles.values()) {
        if (tile.groundReady === false && tile.meshes.some(m => m.visible)) badGround++;
      }
    }
    return { name: 'normal-budget startup', ok: !!revealed && badGround === 0 && app.residencyOk() && !app.forceDrain,
      revealed, frames, badGround, workers: app.terrain.workerPool.available, report: app.residencyReport() };
  }));
  await page.screenshot({ path: path.join(dir, 'desktop.png') });
  rows.push(await page.evaluate(async () => {
    const app = __app, terrain = app.terrain;
    const poll = terrain.workerPool.poll;
    let delayed = true, transitions = 0, holes = 0, unsupported = 0;
    let previous = terrain._anchor;
    terrain.workerPool.poll = function(key) { return delayed ? null : poll.call(this, key); };
    try {
      for (let i = 0; i < 220; i++) {
        if (i === 80) delayed = false;
        app.vehicle.snapTo(app.vehicle.s + 1.5);
        if (i === 110) app.cameras.setMode('vista');
        if (i === 160) app.cameras.setMode('cockpit');
        app.cameras.snap();
        await app.nextFrame();
        if (terrain._anchor !== previous) { transitions++; previous = terrain._anchor; }
        const { x, z } = app.vehicle.pos;
        if (!terrain.coversBounds(x - 1500, z - 1500, x + 1500, z + 1500)) holes++;
        for (const tile of app.veg.tiles.values()) if (!tile.groundReady && tile.meshes.some(m => m.visible)) unsupported++;
      }
    } finally { terrain.workerPool.poll = poll; }
    app.cameras.setMode('chase'); app.cameras.snap();
    return { name: 'driving + delayed tiles + cameras', ok: transitions > 0 && holes === 0 && unsupported === 0,
      transitions, holes, unsupported, budgetMs: app.scheduler.budgetMs, cached: terrain.chunks.size };
  }));
  rows.push(await page.evaluate(async () => {
    const app = __app, before = app.terrain.version;
    await app.applySettings({ season: 'winter' });
    await app.nextFrame();
    const pos = app.vehicle.pos;
    return { name: 'season preserves terrain', ok: app.terrain.version === before &&
      app.terrain.coversBounds(pos.x - 500, pos.z - 500, pos.x + 500, pos.z + 500) };
  }));
  rows.push(await page.evaluate(async () => {
    const app = __app, start = performance.now();
    app.teleport(20);
    const held = app.loading && app.presented;
    while (app.loading && performance.now() - start < 60000) await app.nextFrame();
    return { name: 'teleport holds complete frame', ok: held && !app.loading && app.terrain.coverageReady,
      ms: Math.round(performance.now() - start) };
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => {
    const start = performance.now();
    while (!__app.residencyOk() && performance.now() - start < 60000) await __app.nextFrame();
  });
  const pixels = await page.evaluate(() => {
    __app.renderer.render(__app.scene, __app.cameras.camera);
    const gl = __app.renderer.getContext(), p = new Uint8Array(4);
    let min = 255, max = 0;
    for (let y = 1; y < 8; y++) for (let x = 1; x < 8; x++) {
      gl.readPixels(Math.floor(gl.drawingBufferWidth * x / 8), Math.floor(gl.drawingBufferHeight * y / 8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
      const v = (p[0] + p[1] + p[2]) / 3; min = Math.min(min, v); max = Math.max(max, v);
    }
    return { min, max, error: __rig.error() };
  });
  rows.push({ name: 'mobile canvas', ok: pixels.max - pixels.min > 30 && !pixels.error, ...pixels });
  await page.screenshot({ path: path.join(dir, 'mobile.png') });
  rows.push({ name: 'runtime errors', ok: errors.length === 0, errors });
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(rows, null, 2));
  for (const row of rows) console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.name}: ${JSON.stringify(row)}`);
  process.exitCode = rows.every(row => row.ok) ? 0 : 1;
} finally {
  await page.close();
  await browser.close();
  execFileSync(process.execPath, [path.join(here, 'browser.mjs'), 'down', name]);
}
