#!/usr/bin/env node
// gauntlet/imgdiff.mjs — compare two images pixel-for-pixel (determinism + A/B checks).
//
//   node gauntlet/imgdiff.mjs a.png b.png [--out diff.png] [--tol 2] [--browser ours]
//
// Prints JSON: {w,h,identical,diffPixels,diffFrac,meanAbs,maxAbs,worst:[x,y]}
// `--tol N` ignores per-channel differences <= N (8-bit). `--out` writes an
// amplified difference map (red = changed) so you can *see* where drift happens.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) { argv.splice(i, 1); return true; }
  argv.splice(i, 2);
  return v;
}
const outPath = flag('out', null);
const tol = Number(flag('tol', 0));
const browserName = flag('browser', 'ours');
const portArg = flag('port', null);
const [aPath, bPath] = argv.filter((x) => !x.startsWith('--'));
if (!aPath || !bPath) { console.error('usage: imgdiff.mjs a.png b.png [--out diff.png] [--tol 2]'); process.exit(1); }
for (const p of [aPath, bPath]) if (!fs.existsSync(p)) { console.error('missing file: ' + p); process.exit(1); }

const KNOWN_PORTS = { ours: 9223 };
const port = Number(portArg) || KNOWN_PORTS[browserName] || 9300 + (browserName.length % 50);
const upArgs = ['up', browserName];
if (!KNOWN_PORTS[browserName] || portArg) upArgs.push('--port', String(port));
execFileSync(process.execPath, [path.join(HERE, 'browser.mjs'), ...upArgs], { stdio: 'pipe' });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
const ctx = browser.contexts()[0] || (await browser.newContext());
const page = await ctx.newPage();
await page.goto('about:blank', { timeout: 15000 });

const toDataUrl = (p) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');

const res = await page.evaluate(async ({ a, b, tol, wantOut }) => {
  const load = (src) => new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i); i.onerror = () => rej(new Error('decode failed'));
    i.src = src;
  });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  if (ia.width !== ib.width || ia.height !== ib.height) {
    return { err: `size mismatch ${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
  }
  const w = ia.width, h = ia.height;
  const grab = (img) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, w, h).data;
  };
  const da = grab(ia), db = grab(ib);
  let diffPixels = 0, sum = 0, maxAbs = 0, worst = [0, 0];
  const out = wantOut ? new Uint8ClampedArray(w * h * 4) : null;
  for (let i = 0, px = 0; i < da.length; i += 4, px++) {
    const d0 = Math.abs(da[i] - db[i]), d1 = Math.abs(da[i + 1] - db[i + 1]), d2 = Math.abs(da[i + 2] - db[i + 2]);
    const m = Math.max(d0, d1, d2);
    sum += (d0 + d1 + d2) / 3;
    if (m > maxAbs) { maxAbs = m; worst = [px % w, (px / w) | 0]; }
    if (m > tol) diffPixels++;
    if (out) {
      const amp = Math.min(255, m * 16);
      const base = m > tol ? 40 : (da[i] * 0.25) | 0;
      out[i] = Math.min(255, base + amp); out[i + 1] = base; out[i + 2] = base; out[i + 3] = 255;
    }
  }
  let png = null;
  if (out) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
    png = c.toDataURL('image/png');
  }
  return { w, h, diffPixels, diffFrac: diffPixels / (w * h), meanAbs: sum / (w * h), maxAbs, worst, png };
}, { a: toDataUrl(aPath), b: toDataUrl(bPath), tol, wantOut: !!outPath });

await page.close();
if (res.err) { console.error('IMGDIFF FAILED: ' + res.err); process.exit(1); }
if (outPath && res.png) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), Buffer.from(res.png.split(',')[1], 'base64'));
}
delete res.png;
console.log(JSON.stringify({ a: aPath, b: bPath, tol, identical: res.diffPixels === 0, ...res }, null, 1));
process.exit(0);
