#!/usr/bin/env node
// gauntlet/ab.mjs — build a BLIND side-by-side comparison.
//
//   node gauntlet/ab.mjs <ours.png> <bar.jpg> <out.png> [--label-key <key.json>]
//
// Writes <out.png>: the two frames side by side, letterboxed to a common height,
// labelled only "A" and "B" in randomised order. The mapping is written to a key
// file (default <out>.key.json) which the critic must NOT open until it has made
// its call. Print your A/B decision first, then read the key.
//
// Also supports a stacked layout for wide frames: --stack
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const has = (f) => process.argv.includes('--' + f);
const opt = (f, d) => {
  const i = process.argv.indexOf('--' + f);
  return i < 0 ? d : process.argv[i + 1];
};
const [ours, bar, out] = args;
if (!ours || !bar || !out) {
  console.error('usage: ab.mjs <ours.png> <bar.jpg> <out.png> [--stack] [--key <file>] [--browser <name>] [--port <n>]');
  process.exit(2);
}
for (const f of [ours, bar]) {
  if (!fs.existsSync(path.resolve(ROOT, f))) { console.error('missing input:', f); process.exit(2); }
}

const keyFile = opt('key', out + '.key.json');
const stack = has('stack');
const browserName = opt('browser', 'ab');
const port = Number(opt('port', 9250));

// randomise which side is ours
const oursFirst = Math.random() < 0.5;
const left = oursFirst ? ours : bar;
const right = oursFirst ? bar : ours;

execFileSync('node', [path.join(HERE, 'browser.mjs'), 'up', browserName, '--port', String(port)], { stdio: 'ignore' });
const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = await b.contexts()[0].newPage();

const W = stack ? 1500 : 2000;
const H = stack ? 1740 : 620;
await page.setViewportSize({ width: W, height: H });

const toUrl = (f) => 'data:image/' + (f.endsWith('.jpg') || f.endsWith('.jpeg') ? 'jpeg' : 'png') + ';base64,' +
  fs.readFileSync(path.resolve(ROOT, f)).toString('base64');

await page.setContent(`<!doctype html><html><body style="margin:0;background:#0b0b0d;font:600 26px/1 ui-monospace,monospace;color:#fff">
<div style="display:${stack ? 'block' : 'flex'};gap:8px;padding:8px">
  <div style="position:relative;flex:1">
    <img src="${toUrl(left)}" style="width:100%;display:block">
    <div style="position:absolute;top:10px;left:10px;background:#000a;padding:6px 12px;border-radius:4px">A</div>
  </div>
  <div style="position:relative;flex:1;${stack ? 'margin-top:8px' : ''}">
    <img src="${toUrl(right)}" style="width:100%;display:block">
    <div style="position:absolute;top:10px;left:10px;background:#000a;padding:6px 12px;border-radius:4px">B</div>
  </div>
</div></body></html>`, { timeout: 20000 });

await page.waitForTimeout(600);
await page.screenshot({ path: path.resolve(ROOT, out), fullPage: true, timeout: 20000 });
fs.writeFileSync(path.resolve(ROOT, keyFile), JSON.stringify({
  A: oursFirst ? 'ours' : 'bar',
  B: oursFirst ? 'bar' : 'ours',
  ours, bar, out, created: new Date().toISOString(),
}, null, 1));

console.log(JSON.stringify({ out, key: keyFile, note: 'decide A vs B BEFORE reading the key file' }));
process.exit(0);
