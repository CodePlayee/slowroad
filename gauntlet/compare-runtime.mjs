// Compare a frozen baseline server with the live candidate, using one isolated
// browser and identical fixtures. This is a technical check, not a visual judge.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (key, fallback) => {
  const index = argv.indexOf(`--${key}`);
  return index < 0 ? fallback : argv[index + 1];
};
const outDir = path.resolve(flag('out', 'gauntlet/shots/runtime-comparison'));
const port = flag('port', '19760');
const name = `runtime-comparison-${process.pid}`;
const manager = path.join(here, 'browser.mjs');
const fixtures = JSON.parse(fs.readFileSync(path.join(here, 'shots.json'), 'utf8')).shots;
const ids = flag('shots', 'chase_summer_noon,season_winter,bridge_approach').split(',');
const sampleMs = Number(flag('ms', '12000'));
const runs = [
  ['baseline', flag('baseline', 'http://127.0.0.1:5189')],
  ['candidate', flag('candidate', 'http://127.0.0.1:5188')],
];
fs.mkdirSync(outDir, { recursive: true });
const results = [];
let browser;
const watchdog = setTimeout(() => {
  try { execFileSync(process.execPath, [manager, 'down', name]); } catch {}
  process.exit(1);
}, 240000);
try {
  execFileSync(process.execPath, [manager, 'up', name, '--port', port]);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
  for (const [revision, base] of runs) {
    for (const id of ids) {
      if (!fixtures[id]) throw new Error(`Unknown shot: ${id}`);
      const page = await browser.contexts()[0].newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', msg => {
        if (msg.type() === 'error' && !msg.text().includes('404')) errors.push(msg.text());
      });
      try {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.goto(`${base}/?${fixtures[id].params}&paused=1`, { timeout: 20000, waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!window.__rig, null, { timeout: 20000 });
        const start = await page.evaluate(async () => {
          __rig.pause();
          await __rig.ready({ timeoutMs: 90000 });
          __rig.hideUI(); __rig.snap();
          await __rig.ready({ frames: 3 });
          return __rig.stats();
        });
        const shot = path.join(outDir, `${revision}_${id}.png`);
        await page.screenshot({ path: shot, timeout: 20000 });
        const perf = id === ids[0] ? await page.evaluate(async (ms) => {
          const app = __app;
          const durations = [], work = [];
          __rig.resume();
          const started = performance.now(), km = __rig.stats().km;
          let last = started;
          while (performance.now() - started < ms) {
            await app.nextFrame();
            const now = performance.now();
            durations.push(now - last); last = now;
            work.push(app.scheduler.lastDrainMs);
          }
          __rig.pause();
          const sorted = durations.slice().sort((a, b) => a - b);
          const pct = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
          return {
            fps: durations.length * 1000 / (last - started), frames: durations.length,
            p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), worst: Math.max(...durations),
            hitches33: durations.filter(v => v > 33.4).length,
            maxGenerationMs: Math.max(...work), kmTravelled: __rig.stats().km - km,
          };
        }, sampleMs) : null;
        const row = { revision, id, start, perf, errors, shot };
        results.push(row);
        fs.writeFileSync(path.join(outDir, 'runtime.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify(row));
        if (errors.length || start.residency.pending !== 0) throw new Error(`Runtime failure: ${revision}/${id}`);
      } finally { await page.close(); }
    }
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  execFileSync(process.execPath, [manager, 'down', name]);
  clearTimeout(watchdog);
}
