#!/usr/bin/env node
// gauntlet/shoot.mjs — THE canonical capture harness. Every builder and critic uses it.
//
//   node gauntlet/shoot.mjs <out.png> "seed=12&t=17.5&season=autumn&km=3.2"
//   node gauntlet/shoot.mjs --all shots/baseline            # renders every id in shots.json
//   node gauntlet/shoot.mjs --shot vista_noon out.png       # one named shot
//
// Flags:
//   --ui                keep the HUD visible
//   --live              do NOT boot paused (motion; breaks byte-determinism)
//   --browser <name>    use a different headless instance (critics run in parallel)
//   --port <n>          explicit CDP port for that instance
//   --width/--height    override the 1920x1080 reference resolution
//   --timeout <ms>      rig.ready budget (default 150000)
//
// It FAILS LOUDLY (exit 1) rather than saving a half-loaded frame.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { plantVariantQuery } from './plant-variant.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VIEW = { width: 1920, height: 1080 };
const KNOWN_PORTS = { ours: 9223 };

const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  argv.splice(i, 2);
  return v;
}
const keepUI = argv.includes('--ui');
const live = argv.includes('--live');
const all = argv.includes('--all');
const browserName = flag('browser', 'ours');
const portArg = flag('port', null);
const width = Number(flag('width', VIEW.width));
const height = Number(flag('height', VIEW.height));
const timeoutMs = Number(flag('timeout', 150000));
const shotId = flag('shot', null);
const positional = argv.filter((a) => !a.startsWith('--'));

const port = Number(portArg) || KNOWN_PORTS[browserName] || 9300 + (browserName.length % 50);

function ensureBrowser() {
  const args = ['up', browserName];
  if (portArg) args.push('--port', String(port));
  else if (!KNOWN_PORTS[browserName]) args.push('--port', String(port));
  execFileSync(process.execPath, [path.join(HERE, 'browser.mjs'), ...args], { stdio: 'pipe' });
}

function loadShots() {
  const p = path.join(HERE, 'shots.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8')).shots || {};
}

function die(msg) {
  console.error('SHOOT FAILED: ' + msg);
  process.exit(1);
}

// ------------------------------------------------------------------ targets

const shots = loadShots();
let jobs = [];
if (all) {
  const dir = positional[0] || 'shots/baseline';
  fs.mkdirSync(path.resolve(ROOT, dir), { recursive: true });
  jobs = Object.entries(shots).map(([id, s]) => ({
    out: path.resolve(ROOT, dir, id + '.png'), query: s.params, id,
  }));
  if (!jobs.length) die('shots.json has no shots');
} else if (shotId) {
  const s = shots[shotId];
  if (!s) die(`unknown shot id "${shotId}"`);
  jobs = [{ out: path.resolve(ROOT, positional[0] || `shots/${shotId}.png`), query: s.params, id: shotId }];
} else {
  const out = positional[0];
  const query = positional[1] || 'seed=7&t=12&season=summer';
  if (!out) die('usage: shoot.mjs <out.png> "<query>"   |   shoot.mjs --all <dir>');
  jobs = [{ out: path.resolve(ROOT, out), query, id: path.basename(out, '.png') }];
}

// ------------------------------------------------------------------- capture

ensureBrowser();
let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
} catch (e) { die(`cannot connect to headless browser "${browserName}" on ${port}: ${e.message}`); }
const ctx = browser.contexts()[0] || (await browser.newContext());

const results = [];
for (const job of jobs) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  let stats = null, fail = null;
  try {
    await page.setViewportSize({ width, height });
    // Boot PAUSED unless --live: the autodrive advances the car (and the water /
    // cloud clocks) during the frames between boot and rig.pause(), which made two
    // captures of the same query differ on ~46% of pixels. See gauntlet/RIG.md.
    let q = plantVariantQuery(job.query);
    if (!live && !/(^|&)paused=/.test(q)) q += (q ? '&' : '') + 'paused=1';
    const url = `${process.env.GAUNTLET_URL || 'http://localhost:5188'}/?${q}`;
    await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });

    const res = await page.evaluate(async ({ tmo, keepUI }) => {
      const t = Date.now();
      while (!window.__rig && Date.now() - t < 15000) await new Promise((r) => setTimeout(r, 50));
      if (!window.__rig) return { err: 'window.__rig never appeared' };
      if (window.__rig.error && window.__rig.error()) return { err: 'boot error: ' + window.__rig.error() };
      try {
        window.__rig.pause();
        if (window.__rig.snap) window.__rig.snap();
        await window.__rig.ready({ timeoutMs: tmo });
        if (!keepUI) window.__rig.hideUI();
        if (window.__rig.snap) window.__rig.snap();
        await window.__rig.ready({ timeoutMs: 20000, frames: 6 });
        return { stats: window.__rig.stats() };
      } catch (e) {
        return { err: String(e && e.message ? e.message : e) };
      }
    }, { tmo: timeoutMs, keepUI });

    if (res.err) throw new Error(res.err);
    stats = res.stats;
    if (!stats || stats.residency.pending !== 0) throw new Error('not fully resident: ' + JSON.stringify(stats && stats.residency));
    fs.mkdirSync(path.dirname(job.out), { recursive: true });
    await page.screenshot({ path: job.out, timeout: 30000 });
    const sz = fs.statSync(job.out).size;
    if (sz < 20000) throw new Error(`screenshot suspiciously small (${sz} bytes) — probably a blank frame`);
  } catch (e) {
    fail = e.message;
  }
  await page.close();
  results.push({ id: job.id, out: job.out, stats, fail, errors: errors.slice(0, 6) });
  if (fail) {
    console.error(`FAILED ${job.id}: ${fail}`);
    if (errors.length) console.error(errors.slice(0, 6).join('\n'));
  } else {
    console.log(`${job.id} -> ${path.relative(ROOT, job.out)}  ${JSON.stringify(stats)}`);
  }
}

const bad = results.filter((r) => r.fail);
if (jobs.length === 1 && !bad.length) console.log(JSON.stringify(results[0].stats, null, 1));
if (bad.length) { console.error(`${bad.length}/${jobs.length} shots FAILED`); process.exit(1); }
process.exit(0);
