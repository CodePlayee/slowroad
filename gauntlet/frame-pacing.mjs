import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const out = flag('--out', '/tmp/slowroad-pacing');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${flag('--port', '9421')}`, { timeout: 20000 });
const report = { errors: [] };
let context;
let traceSession;
try {
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  const query = process.env.PACING_QUERY || 'seed=7&km=6&paused=1&quality=auto';
  await page.goto(`${process.env.GAUNTLET_URL || 'http://127.0.0.1:5190'}/?${query}`, { timeout: 20000 });
  await page.waitForFunction(() => window.__app && !__app.loading && __app.veg.minimumReady, null, { timeout: 20000 });
  if (process.env.PACING_TRACE === '1') {
    traceSession = await context.newCDPSession(page);
    await traceSession.send('Tracing.start', { categories: 'v8,disabled-by-default-v8.gc,blink.user_timing', transferMode: 'ReturnAsStream' });
  }
  report.run = await page.evaluate(async duration => {
    const app = __app, samples = [], restores = [];
    let current = null;
    const wrap = (object, method, name) => {
      const original = object[method];
      if (typeof original !== 'function') return;
      object[method] = function (...args) {
        if (!current) return original.apply(this, args);
        const start = performance.now();
        try { return original.apply(this, args); }
        finally { current[name] = (current[name] || 0) + performance.now() - start; }
      };
      restores.push(() => { object[method] = original; });
    };
    wrap(app, 'streamAll', 'stream');
    wrap(app.scheduler, 'run', 'queue');
    wrap(app.terrain, '_publish', 'terrainPublish');
    wrap(app.terrain, '_mesh', 'terrainMesh');
    wrap(app.water, 'buildGeometry', 'waterBuild');
    wrap(app.terrain, '_trimCache', 'terrainTrim');
    wrap(app.terrain, 'refreshCoverage', 'coverage');
    wrap(app.veg, 'update', 'vegetation');
    wrap(app.veg, '_plan', 'plan');
    wrap(app.veg, '_dispose', 'vegetationDispose');
    wrap(app.terrain, 'updatePlantContact', 'contact');
    wrap(app.instanceCulling, 'prepare', 'cull');
    wrap(app.renderer, 'render', 'render');
    wrap(app.renderer, 'setPixelRatio', 'resize');
    const original = app.frame;
    const start = performance.now();
    performance.mark('slowroad-pacing-start');
    app.frame = function (...args) {
      const t = performance.now();
      current = { t: t - start, interval: t - app.lastT };
      try { return original.apply(this, args); }
      finally {
        Object.assign(current, { cpu: performance.now() - t, dpr: app.renderer.getPixelRatio(),
          pending: app.scheduler.pending, km: app.vehicle.s / 1000, loading: app.loading,
          programs: app.renderer.info.programs.length });
        samples.push(current); current = null;
      }
    };
    __rig.resume();
    try { await new Promise(resolve => setTimeout(resolve, duration)); }
    finally { __rig.pause(); app.frame = original; for (const restore of restores.reverse()) restore(); }
    return { samples, error: __rig.error(), parameters: __rig.params() };
  }, Number(process.env.PACING_MS || 90000));
  const summarize = frames => {
    const times = frames.map(frame => frame.interval).sort((a, b) => a - b);
    return { frames: frames.length, fps: 1000 * times.length / times.reduce((a, b) => a + b, 0),
      p50: times[Math.floor(times.length * .5)], p95: times[Math.floor(times.length * .95)],
      p99: times[Math.floor(times.length * .99)], max: times.at(-1),
      over20: times.filter(t => t > 20).length, over33: times.filter(t => t > 33.4).length,
      over50: times.filter(t => t > 50).length };
  };
  const samples = report.run.samples;
  report.whole = summarize(samples);
  report.settled = summarize(samples.filter(frame => frame.t > 15000));
  // The interval ending at frame N includes the work submitted by frame N-1.
  report.slow = samples.flatMap((frame, index) => frame.t > 15000 && frame.interval > 25 ?
    [{ interval: frame.interval, previous: samples[index - 1], current: frame }] : []);
  report.ratios = [...new Set(samples.map(frame => frame.dpr))];
  if (traceSession) {
    const complete = new Promise(resolve => traceSession.once('Tracing.tracingComplete', resolve));
    await traceSession.send('Tracing.end');
    const { stream } = await complete;
    let trace = '';
    while (true) {
      const chunk = await traceSession.send('IO.read', { handle: stream });
      trace += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString() : chunk.data;
      if (chunk.eof) break;
    }
    await traceSession.send('IO.close', { handle: stream });
    fs.writeFileSync(path.join(out, 'frame-pacing-trace.json'), trace);
    report.traced = true;
  }
  await page.screenshot({ path: path.join(out, 'frame-pacing.png'), timeout: 20000 });
  if (report.errors.length || report.run.error) throw new Error('frame pacing browser error');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push(String(error.stack || error)); process.exitCode = 1;
} finally {
  try { await context?.close(); } finally { await browser.close(); }
  fs.writeFileSync(path.join(out, 'frame-pacing.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, whole: report.whole, settled: report.settled, ratios: report.ratios }));
}
