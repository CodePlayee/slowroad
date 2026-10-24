#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const out = flag('--out', '/tmp/slowroad-route-drive');
const duration = Number(flag('--ms', '120000'));
const base = process.env.GAUNTLET_URL || 'http://127.0.0.1:5189';
const report = { status: 'running', durationMs: duration, samples: [], errors: [] };
let browser, context, video;
fs.mkdirSync(out, { recursive: true });
const write = () => fs.writeFileSync(path.join(out, 'route-drive.json'), JSON.stringify(report, null, 2));
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${flag('--port', '9421')}`, { timeout: 20000 });
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 },
    ...(process.env.GAUNTLET_DRIVE_VIDEO === '1' ? { recordVideo: { dir: out, size: { width: 1280, height: 720 } } } : {}) });
  const page = await context.newPage();
  video = page.video();
  page.on('pageerror', error => report.errors.push(error.message));
  const startKm = Number(process.env.GAUNTLET_DRIVE_KM || 18);
  const query = new URLSearchParams({ seed: '7', km: String(startKm), t: '12', season: 'summer', cam: 'chase', paused: '1' });
  if (process.env.GAUNTLET_DRIVE_QUALITY) query.set('quality', process.env.GAUNTLET_DRIVE_QUALITY);
  await page.goto(`${base}/?${query}`, { timeout: 20000 });
  // Deliberately use ordinary loading, never rig.ready()/forceDrain.
  await page.waitForFunction(() => globalThis.__app && !__app.loading && __app.veg.minimumReady,
    null, { timeout: 20000 });
  await page.waitForFunction(() => getComputedStyle(document.getElementById('boot')).opacity === '0',
    null, { timeout: 20000 });
  await page.evaluate(recordCamera => {
    __rig.hideUI(); __rig.resume();
    const probe = globalThis.__contactDriveProbe = { running: true, frames: 0, zeroFrames: 0,
      maxZeroRun: 0, zeroRun: 0, zeroStarts: [], maxSelected: 0, maxRaster: 0, publications: 0 };
    let version = __app.terrain.plantContact?.version;
    const camera = __app.cameras.camera;
    const previousEye = camera.position.clone(), previousRotation = camera.quaternion.clone();
    const direction = previousEye.clone(), projected = previousEye.clone();
    if (recordCamera) probe.camera = { minBack: Infinity, maxBack: -Infinity, minHeight: Infinity,
      maxHeight: -Infinity, minSide: Infinity, maxSide: -Infinity, minClearance: Infinity,
      minForward: Infinity, maxStep: 0, maxTurn: 0, outside: 0 };
    probe.done = (async () => {
      while (probe.running) {
        await __app.nextFrame();
        if (probe.camera) {
          const metrics = probe.camera, p = __app.vehicle.pos, eye = camera.position;
          const dx = Math.cos(__app.vehicle.heading), dz = Math.sin(__app.vehicle.heading);
          const back = (p.x - eye.x) * dx + (p.z - eye.z) * dz;
          const side = (eye.x - p.x) * -dz + (eye.z - p.z) * dx;
          metrics.minBack = Math.min(metrics.minBack, back); metrics.maxBack = Math.max(metrics.maxBack, back);
          metrics.minHeight = Math.min(metrics.minHeight, eye.y - p.y); metrics.maxHeight = Math.max(metrics.maxHeight, eye.y - p.y);
          metrics.minSide = Math.min(metrics.minSide, side); metrics.maxSide = Math.max(metrics.maxSide, side);
          metrics.minClearance = Math.min(metrics.minClearance, eye.y - __app.world.ground(eye.x, eye.z));
          camera.getWorldDirection(direction);
          metrics.minForward = Math.min(metrics.minForward, direction.x * dx + direction.z * dz);
          metrics.maxStep = Math.max(metrics.maxStep, eye.distanceTo(previousEye));
          metrics.maxTurn = Math.max(metrics.maxTurn, camera.quaternion.angleTo(previousRotation));
          projected.copy(p); projected.y += 0.8; projected.project(camera);
          if (Math.abs(projected.x) >= 1 || Math.abs(projected.y) >= 1 || projected.z >= 1) metrics.outside++;
          previousEye.copy(eye); previousRotation.copy(camera.quaternion);
        }
        const field = __app.terrain.plantContact;
        if (!field) continue;
        probe.frames++;
        if (!field.activeCount) {
          probe.zeroFrames++; probe.zeroRun++;
          if (probe.zeroRun === 1 && probe.zeroStarts.length < 20) probe.zeroStarts.push({
            frame: probe.frames, km: __rig.stats().km, origin: field.origin.toArray(),
            target: __app.terrain._plantContactTarget.toArray(), rasterPending: field.pending,
            selecting: Boolean(__app.terrain._plantContactSelection),
          });
        }
        else probe.zeroRun = 0;
        probe.maxZeroRun = Math.max(probe.maxZeroRun, probe.zeroRun);
        const work = __app.terrain._plantContactWork;
        probe.maxSelected = Math.max(probe.maxSelected, work?.recordsVisited || 0);
        probe.maxRaster = Math.max(probe.maxRaster, work?.rasterChecks || 0);
        if (field.version !== version) { probe.publications++; version = field.version; }
      }
    })();
  }, process.env.GAUNTLET_CAMERA_DRIFT === '1');
  const start = Date.now();
  let nextCapture = 0;
  do {
    const sample = await page.evaluate(async () => {
      const { GRASS_COVERAGE, grassViewCoverage } = await import('/src/vegetation/grassCoverage.js');
      const app = __app, veg = app.veg, p = app.vehicle.pos;
      let closeTrees = 0, tallTrees = 0, grassOutsideBand = 0;
      const eye = app.cameras.camera.position;
      const grassBands = [48, 76, 120, 160].map(end => ({ end, plants: 0, coverage: 0 }));
      for (const entry of veg.tiles.values()) {
        if (entry.job.kind === 'tree' && entry.groundReady) {
          for (const r of entry.records) if (Math.hypot(r.x - p.x, r.z - p.z) < 150) {
            closeTrees++; if (r.height >= 15) tallTrees++;
          }
        } else if (entry.job.kind === 'grass') {
          for (const r of entry.records) {
            if (!(r.roadDist >= GRASS_COVERAGE.roadStart && r.roadDist < GRASS_COVERAGE.roadEnd)) grassOutsideBand++;
            const distance = Math.hypot(r.x - eye.x, (r.surfaceY ?? r.y) - eye.y, r.z - eye.z);
            const band = grassBands.find(band => distance < band.end);
            if (band) { band.plants++; band.coverage += grassViewCoverage(distance); }
          }
        }
      }
      let grassPendingCells = 0, missingGrassCoverage = 0;
      const missingGrass = [];
      for (const job of veg._streamJobs) {
        if (job.kind !== 'grass' || veg.tiles.get(job.key)?.groundReady) continue;
        const [x0, z0, x1, z1] = job.groundBounds;
        const nearest = Math.hypot(Math.max(x0 - eye.x, 0, eye.x - x1), Math.max(z0 - eye.z, 0, eye.z - z1));
        const coverage = grassViewCoverage(nearest);
        if (coverage <= 0.05) continue;
        grassPendingCells++;
        missingGrassCoverage = Math.max(missingGrassCoverage, coverage);
        const view = veg._grassView;
        missingGrass.push({ key: job.key, coverage, bounds: job.groundBounds,
          forward: view ? ((x0 + x1) / 2 - view.x) * view.dx + ((z0 + z1) / 2 - view.z) * view.dz : null,
          ground: veg._groundReady(job), tile: veg.tiles.has(job.key),
          worker: veg.pool.has(job.key), cpuReady: veg.cpuReady.has(job.key), scheduled: app.scheduler.has(job.key) });
      }
      const near = veg._streamJobs.filter(job => job.kind === 'tree' && job.d < 350);
      const pendingNear = near.filter(job => !veg.tiles.get(job.key)?.groundReady).length;
      return { km: __rig.stats().km, closeTrees, tallTrees, nearTreeCells: near.length, pendingNear,
        grassOutsideBand, grassPendingCells, missingGrassCoverage, missingGrass,
        grassBands: grassBands.map(band => ({ ...band, coverage: band.coverage / Math.max(1, band.plants) })),
        grassView: [GRASS_COVERAGE.viewFadeStart, GRASS_COVERAGE.viewEnd],
        pending: veg.pending, forceDrain: app.forceDrain,
        dpr: app.renderer.getPixelRatio(), lodHeight: app.quality?.lodHeight,
        triangles: app.renderer.info.render.triangles, fps: __rig.stats().fps,
        camera: { position: eye.toArray(), height: eye.y - p.y,
          back: (p.x - eye.x) * Math.cos(app.vehicle.heading) + (p.z - eye.z) * Math.sin(app.vehicle.heading),
          side: (eye.x - p.x) * -Math.sin(app.vehicle.heading) + (eye.z - p.z) * Math.cos(app.vehicle.heading) },
        contact: app.terrain.plantContactStats?.() || null,
        error: __rig.error() };
    });
    report.samples.push({ elapsedMs: Date.now() - start, ...sample });
    if (sample.forceDrain || sample.error) throw new Error(`Invalid driving state: ${JSON.stringify(sample)}`);
    write();
    if (Date.now() - start >= nextCapture) {
      await page.screenshot({ path: path.join(out, `drive-${Math.round(nextCapture / 1000)}s.png`), timeout: 20000 });
      nextCapture += Math.min(5000, duration / 2);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() - start < duration);
  report.contact = await page.evaluate(async () => {
    const probe = __contactDriveProbe;
    probe.running = false;
    await probe.done;
    __rig.pause();
    const { done, ...result } = probe;
    return result;
  });
  await page.screenshot({ path: path.join(out, 'drive-end.png'), timeout: 20000 });
  const stable = report.samples.filter(sample => sample.elapsedMs >= 10000);
  report.kmTravelled = report.samples.at(-1).km - report.samples[0].km;
  report.woodedShare = stable.filter(sample => sample.tallTrees >= 40).length / stable.length;
  report.nearReadyShare = stable.filter(sample => sample.pendingNear === 0).length / stable.length;
  report.grassReadyShare = stable.filter(sample => sample.grassPendingCells === 0).length / stable.length;
  if (report.contact.camera) {
    const c = report.contact.camera;
    if (c.maxBack - c.minBack < 4 || c.maxHeight - c.minHeight < 1 || c.minSide > -0.7 || c.maxSide < 0.7 ||
        c.minClearance < 1.399 || c.minForward < 0.7 || c.maxStep > 2.5 || c.maxTurn > 0.05 || c.outside) {
      throw new Error(`Camera drift contract failed: ${JSON.stringify(c)}`);
    }
  }
  if (report.errors.length || report.samples.some(sample => sample.grassOutsideBand) ||
      report.contact.maxSelected > 2048 || report.contact.maxRaster > 16384 ||
      report.samples.some(sample => sample.grassPendingCells > 0) ||
      report.woodedShare < 0.85 || report.nearReadyShare < 0.85 || report.kmTravelled < duration / 1000 * 0.018) {
    throw new Error('Sustained driving coverage did not meet the roadside contract');
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push(String(error.stack || error)); process.exitCode = 1;
} finally {
  try {
    await context?.close();
    if (video) { report.video = path.join(out, 'route-drive.webm'); await video.saveAs(report.video); }
  } finally { await browser?.close(); }
  write();
  console.log(JSON.stringify({ ...report, samples: report.samples.length }));
}
