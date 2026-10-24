#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function parseProbeArgs(args) {
  const options = { port: 9223, url: process.env.GAUNTLET_URL || 'http://127.0.0.1:5189',
    out: 'gauntlet/terrain-material-probe', shots: 'forest_dense,chase_summer_noon', points: null };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2), value = args[i + 1];
    if (!args[i].startsWith('--') || !Object.hasOwn(options, key) || !value || value.startsWith('--')) throw new Error(`Invalid option ${args[i]}`);
    options[key] = key === 'port' ? Number(value) : value;
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid CDP port');
  options.shots = options.shots.split(',').map(value => value.trim()).filter(Boolean);
  if (!options.shots.length) throw new Error('No probe shots selected');
  return options;
}

export async function runTerrainMaterialProbe(options) {
  const shots = JSON.parse(fs.readFileSync(path.join(HERE, 'shots.json'), 'utf8')).shots;
  for (const id of options.shots) if (!shots[id]) throw new Error(`Unknown shot ${id}`);
  const points = options.points ? JSON.parse(fs.readFileSync(options.points, 'utf8')) : undefined;
  const out = path.resolve(options.out);
  fs.mkdirSync(out, { recursive: true });
  const report = { schema: 'gauntlet.terrain-material-probe.v1', startedAt: new Date().toISOString(),
    diagnosticOnly: true, status: 'running', url: options.url, scenes: [], pageErrors: [] };
  const write = () => fs.writeFileSync(path.join(out, 'terrain-material-probe.json'), JSON.stringify(report, null, 2) + '\n');
  write();
  let browser, context;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${options.port}`, { timeout: 20000 });
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    context.setDefaultTimeout(20000);
    const page = await context.newPage();
    page.on('pageerror', error => { report.pageErrors.push(error.message); write(); });
    page.on('console', message => {
      if (message.type() === 'error') { report.pageErrors.push(message.text()); write(); }
    });
    for (const id of options.shots) {
      const url = new URL(options.url);
      url.search = new URLSearchParams(shots[id].params).toString();
      url.searchParams.set('paused', '1'); url.searchParams.set('dpr', '1');
      await page.goto(url.href, { timeout: 20000, waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => Boolean(window.__rig), null, { timeout: 20000 });
      const scene = await page.evaluate(async ({ points }) => {
        window.__rig.pause();
        const ready = await window.__rig.ready({ timeoutMs: 120000 });
        const { probeTerrainMaterials } = await import('/gauntlet/terrain-material-probe-runtime.mjs');
        const before = window.__rig.params();
        const result = probeTerrainMaterials(window.__app, { width: 1920, height: 1080, ...(points ? { points } : {}) });
        return { ready, params: before, ...result, error: window.__rig.error() };
      }, { points });
      report.scenes.push({ id, ...scene }); write();
      if (scene.error) throw new Error(scene.error);
      if (report.pageErrors.length) throw new Error(report.pageErrors.join('; '));
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack || error);
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    report.finishedAt = new Date().toISOString(); write();
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = await runTerrainMaterialProbe(parseProbeArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
