#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2), options = { port: 9223, url: process.env.GAUNTLET_URL || 'http://localhost:5188', out: 'gauntlet/startup' };
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].slice(2), value = args[i + 1];
  if (!args[i].startsWith('--') || !Object.hasOwn(options, key) || !value || value.startsWith('--')) throw new Error(`Invalid option: ${args[i]}`);
  options[key] = key === 'port' ? Number(value) : value;
}
if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid CDP port');
const out = path.resolve(options.out), url = new URL(options.url);
for (const [key, value] of Object.entries({ seed: '7', km: '6', t: '12', season: 'summer', weather: 'clear', cam: 'chase', paused: '1', dpr: '1' })) url.searchParams.set(key, value);
fs.mkdirSync(out, { recursive: true });
const report = { schema: 'gauntlet.startup.v1', startedAt: new Date().toISOString(), url: url.href,
  viewport: [1920, 1080], status: 'running', phases: {}, pageErrors: [] };
const write = () => fs.writeFileSync(path.join(out, 'startup.json'), JSON.stringify(report, null, 2) + '\n');
write();
let browser, context, page;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${options.port}`, { timeout: 20000 });
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  context.setDefaultTimeout(20000);
  page = await context.newPage();
  page.on('pageerror', error => { report.pageErrors.push(error.message); write(); });
  await page.addInitScript(() => {
    const boot = setInterval(() => {
      const app = window.__app;
      if (!app) return;
      clearInterval(boot);
      const hooks = [];
      let phase;
      const reset = (name, start = performance.now()) => {
        phase = { name, start, milestones: {}, samples: [], cpu: { frameCPU: [], buildQueue: [] } };
      };
      reset('startup', 0);
      const sample = () => {
        const veg = app.veg, pool = veg.pool, workers = { queued: 0, running: 0, complete: 0 };
        for (const job of pool?._jobs?.values() || []) if (Object.hasOwn(workers, job.state)) workers[job.state]++;
        const ms = performance.now() - phase.start;
        const milestones = { assetReady: veg.assetReady, minimumReady: veg.minimumReady,
          loadingFinished: !app.loading, populationDrained: veg.required > 0 && pool?.available && !workers.queued && !workers.running,
          fullResidency: veg.required > 0 && app.residencyOk() };
        for (const [key, ready] of Object.entries(milestones)) if (ready && phase.milestones[key] === undefined) phase.milestones[key] = ms;
        const previous = phase.samples.at(-1);
        if (!previous || ms - previous.ms >= 95 || milestones.fullResidency && !previous.fullResidency) {
          phase.samples.push({ ms, frame: app.frameNo, tiles: veg.resident, required: veg.required,
            cpuReady: veg.cpuReady.size, builds: veg._builds.size, workers, schedulerPending: app.scheduler.pending,
            terrainPending: app.terrain.pending, loading: app.loading, fullResidency: milestones.fullResidency,
            forceDrain: app.forceDrain, schedulerBudget: app.scheduler.budgetMs });
        }
      };
      for (const [object, method, label] of [[app, 'frame', 'frameCPU'], [app.scheduler, 'run', 'buildQueue']]) {
        const original = object[method], descriptor = Object.getOwnPropertyDescriptor(object, method);
        object[method] = function(...args) {
          const start = performance.now();
          try { return original.apply(this, args); }
          finally {
            phase.cpu[label].push(performance.now() - start);
            if (label === 'frameCPU') sample();
          }
        };
        hooks.push(() => { if (descriptor) Object.defineProperty(object, method, descriptor); else delete object[method]; });
      }
      window.__startupProbe = {
        snapshot() {
          sample();
          const summary = values => {
            const sorted = [...values].sort((a, b) => a - b);
            return { count: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
              p50: sorted[Math.floor(sorted.length * 0.5)] ?? null, p95: sorted[Math.floor(sorted.length * 0.95)] ?? null,
              max: sorted.at(-1) ?? null };
          };
          return { name: phase.name, elapsedMs: performance.now() - phase.start, milestones: phase.milestones,
            samples: phase.samples, cpuMs: Object.fromEntries(Object.entries(phase.cpu).map(([key, values]) => [key, summary(values)])),
            error: app.fatal || app.scheduler.error || app.veg.assetError || app.terrain.assetError || app.vehicle.assetError || null,
            population: app.veg.stats() };
        },
        teleport() { reset('teleport'); app.teleport(11.5); },
        restore() { for (const restore of hooks.reverse()) restore(); delete window.__startupProbe; },
      };
    }, 5);
  });
  await page.goto(url.href, { timeout: 20000, waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__startupProbe), null, { timeout: 20000 });
  for (const name of ['startup', 'teleport']) {
    if (name === 'teleport') await page.evaluate(() => window.__startupProbe.teleport());
    const deadline = Date.now() + 90000;
    for (;;) {
      const data = await page.evaluate(() => window.__startupProbe.snapshot());
      report.phases[name] = data; write();
      if (data.error) throw new Error(data.error);
      if (report.pageErrors.length) throw new Error(report.pageErrors.join('; '));
      if (data.samples.some(sample => sample.forceDrain)) throw new Error('Startup probe must not force-drain the scheduler');
      if (data.milestones.fullResidency !== undefined) break;
      if (data.elapsedMs > 90000 || Date.now() >= deadline) throw new Error(`${name} residency timed out after 90 seconds`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (name === 'startup') await page.screenshot({ path: path.join(out, 'startup.png'), timeout: 20000 });
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack || error); process.exitCode = 1;
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => window.__startupProbe?.restore()).catch(() => {});
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  report.finishedAt = new Date().toISOString(); write();
}
console.log(JSON.stringify({ status: report.status, out, phases: Object.fromEntries(Object.entries(report.phases)
  .map(([name, phase]) => [name, { milestones: phase.milestones, cpuMs: phase.cpuMs }])), error: report.error }, null, 2));
