import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const out = flag('--out', '/tmp/slowroad-quality');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${flag('--port', '9421')}`, { timeout: 20000 });
const report = { cases: {}, errors: [] };
let context;
fs.mkdirSync(out, { recursive: true });
const save = () => fs.writeFileSync(path.join(out, 'quality-check.json'), JSON.stringify(report, null, 2));
try {
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  for (const mode of ['high', 'auto']) {
    await page.goto(`${process.env.GAUNTLET_URL || 'http://127.0.0.1:5190'}/?seed=7&km=6&paused=1&quality=${mode}`, { timeout: 20000 });
    await page.evaluate(async () => { await __rig.ready(); __rig.snap(); await __rig.ready({ frames: 5 }); });
    report.cases[mode] = await page.evaluate(async mode => {
      const app = __app, frame = app.frame, samples = [];
      let cpu = 0;
      app.frame = function (...args) {
        const t = performance.now();
        try { return frame.apply(this, args); } finally { cpu = performance.now() - t; }
      };
      const start = performance.now(), lod = app.quality.lodHeight;
      __rig.resume();
      try {
        while (performance.now() - start < (mode === 'auto' ? 30000 : 10000)) {
          const t = performance.now(); await app.nextFrame();
          samples.push({ ms: performance.now() - t, cpu, dpr: app.renderer.getPixelRatio(),
            lod: app.quality.lodHeight, triangles: app.renderer.info.render.triangles });
        }
      } finally { __rig.pause(); app.frame = frame; }
      const summarize = frames => {
        const times = frames.map(frame => frame.ms).sort((a, b) => a - b);
        return { frames: frames.length, fps: 1000 * frames.length / times.reduce((a, b) => a + b, 0),
          p95: times[Math.floor(times.length * 0.95)], cpu: frames.reduce((sum, frame) => sum + frame.cpu, 0) / frames.length };
      };
      return { whole: summarize(samples), settled: summarize(samples.slice(Math.floor(samples.length / 2))),
        ratios: [...new Set(samples.map(frame => frame.dpr))], lodUnchanged: samples.every(frame => frame.lod === lod),
        lod, parameters: __rig.params(), samples, error: __rig.error() };
    }, mode);
    await page.screenshot({ path: path.join(out, `quality-${mode}.png`), timeout: 20000 });
    save();
    if (report.cases[mode].error || !report.cases[mode].lodUnchanged) throw new Error('quality control changed plant LOD or failed');
  }
  const auto = report.cases.auto, high = report.cases.high;
  if (high.ratios.some(ratio => ratio !== 1.5) || high.lod !== 1620 || auto.lod !== 1080) throw new Error('quality lock or CSS LOD contract failed');
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(async () => { await __rig.ready({ frames: 3 }); });
    await page.screenshot({ path: path.join(out, `quality-${viewport.width}.png`), timeout: 20000 });
  }
  if (report.errors.length) throw new Error('browser errors during quality check');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push(String(error.stack || error)); process.exitCode = 1;
} finally {
  try { await context?.close(); } finally { await browser.close(); }
  save(); console.log(JSON.stringify({ status: report.status, report: path.join(out, 'quality-check.json') }));
}
