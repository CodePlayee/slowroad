#!/usr/bin/env node
// gauntlet/xray.mjs — capture variants with layers toggled, to isolate what is missing.
import { chromium } from 'playwright';
import fs from 'node:fs';

const qs = process.argv[2] || 'seed=7&t=12&season=summer';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 15000 });
const ctx = browser.contexts()[0] || (await browser.newContext());
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.setViewportSize({ width: 1280, height: 720 });
await page.goto(`http://localhost:5188/?${qs}`, { timeout: 25000, waitUntil: 'domcontentloaded' });
const r = await page.evaluate(async () => {
  const t = Date.now();
  while (!window.__rig && Date.now() - t < 15000) await new Promise((x) => setTimeout(x, 50));
  window.__rig.pause();
  await window.__rig.ready({ timeoutMs: 150000 });
  window.__rig.hideUI();
  return true;
});
fs.mkdirSync('/tmp/xray', { recursive: true });

const variants = {
  all: () => {},
  noveg: () => { window.__app.veg.group.visible = false; },
  noveg_noterr: () => { window.__app.veg.group.visible = false; window.__app.terrain.group.visible = false; },
  roadonly: () => {
    const a = window.__app;
    a.veg.group.visible = false; a.terrain.group.visible = false;
    a.terrain.waterGroup.visible = false; a.vehicle.group.visible = false;
    a.road.material.color.set(0xff00ff);
  },
  wire: () => {
    const a = window.__app;
    a.veg.group.visible = true; a.terrain.group.visible = true;
    a.terrain.waterGroup.visible = true; a.vehicle.group.visible = true;
    a.road.material.color.set(0xff00ff);
  },
};
for (const [name, fn] of Object.entries(variants)) {
  await page.evaluate(`(${fn.toString()})()`);
  await page.evaluate(async () => { for (let i = 0; i < 4; i++) await window.__app.nextFrame(); });
  await page.screenshot({ path: `/tmp/xray/${name}.png`, timeout: 20000 });
  console.log('wrote', name);
}
console.log(logs.join('\n'));
await page.close();
process.exit(0);
