#!/usr/bin/env node
// gauntlet/perf.mjs — measure real steady-state framerate / draw calls / triangles for a
// query, at the reference resolution. Unlike shoot.mjs's `stats.fps` (which is sampled
// right after a forced streaming drain and reads low), this resumes the sim and samples
// over a window so the number means something.
//
//   node gauntlet/perf.mjs "seed=7&t=12&cam=chase&km=6" [--ms 4000] [--width 1920] [--height 1080]
//   node gauntlet/perf.mjs --shot vista_wide
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { plantVariantQuery } from './plant-variant.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function flag(n, d) {
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = argv[i + 1]; argv.splice(i, 2); return v;
}
const browserName = flag('browser', 'ours');
const port = Number(flag('port', browserName === 'ours' ? 9223 : 9300 + (browserName.length % 50)));
const width = Number(flag('width', 1920));
const height = Number(flag('height', 1080));
const sampleMs = Number(flag('ms', 4000));
const shotId = flag('shot', null);
let query = argv.filter((a) => !a.startsWith('--'))[0] || 'seed=7&t=12&cam=chase&km=6';
if (shotId) {
  const shots = JSON.parse(fs.readFileSync(path.join(HERE, 'shots.json'), 'utf8')).shots;
  if (!shots[shotId]) { console.error('unknown shot ' + shotId); process.exit(1); }
  query = shots[shotId].params;
}

query = plantVariantQuery(query);
execFileSync(process.execPath, [path.join(HERE, 'browser.mjs'), 'up', browserName, '--port', String(port)], { stdio: 'pipe' });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
const ctx = browser.contexts()[0] || (await browser.newContext());
const page = await ctx.newPage();
await page.setViewportSize({ width, height });
await page.goto(`${process.env.GAUNTLET_URL || 'http://localhost:5188'}/?${query}&paused=1`, { timeout: 20000, waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async (ms) => {
  const t0 = Date.now();
  while (!window.__rig && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 50));
  const r = window.__rig, app = window.__app;
  if (!r) return { err: 'no rig' };
  r.pause(); r.snap();
  await r.ready({ timeoutMs: 150000 });
  r.hideUI();
  const still = r.stats();

  // ---- static (paused) frame cost: no streaming, no motion ----
  const frames = [];
  for (let i = 0; i < 90; i++) { const a = performance.now(); await app.nextFrame(); frames.push(performance.now() - a); }
  const sorted = frames.slice(10).sort((x, y) => x - y);
  const pct = (p) => Math.round(sorted[Math.floor(sorted.length * p)] * 100) / 100;

  // ---- driving: streaming under load ----
  r.resume();
  const startKm = r.stats().km;
  const t1 = performance.now();
  let n = 0, worst = 0, calls = 0, tris = 0, hitch = 0, worstContext = null;
  const programEvents = [];
  let programs = app.renderer.info.programs.length;
  while (performance.now() - t1 < ms) {
    const a = performance.now();
    await app.nextFrame();
    const d = performance.now() - a;
    const nextPrograms = app.renderer.info.programs.length;
    const context = { frame: n, ms: Math.round(d * 10) / 10, programsBefore: programs, programsAfter: nextPrograms,
      pending: app.scheduler.pending, generationMs: app.scheduler.lastDrainMs ?? null };
    if (d > worst) { worst = d; worstContext = context; }
    if (nextPrograms !== programs && programEvents.length < 100) programEvents.push(context);
    programs = nextPrograms;
    if (d > 33.4) hitch++;
    const s = app.renderer.info.render;
    calls = Math.max(calls, s.calls); tris = Math.max(tris, s.triangles);
    n++;
  }
  const drivenMs = performance.now() - t1;
  const endKm = r.stats().km;
  r.pause();
  return {
    viewport: [window.innerWidth, window.innerHeight],
    cam: still.cam, km: still.km, season: still.season, t: still.t,
    static: { drawCalls: still.drawCalls, triangles: still.triangles, programs: still.programs,
      frameMs_p50: pct(0.5), frameMs_p95: pct(0.95), fps_p50: Math.round(1000 / pct(0.5)) },
    driving: { frames: n, seconds: Math.round(drivenMs) / 1000, fps: Math.round((n * 1000) / drivenMs * 10) / 10,
      worstFrameMs: Math.round(worst * 10) / 10, framesOver33ms: hitch,
      maxDrawCalls: calls, maxTriangles: tris, kmTravelled: Math.round((endKm - startKm) * 1000) / 1000,
      worstContext, programEvents },
  };
}, sampleMs);

await page.close();
console.log(JSON.stringify({ query, ...out }, null, 1));
process.exit(out.err ? 1 : 0);
