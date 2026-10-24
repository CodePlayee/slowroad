#!/usr/bin/env node
// gauntlet/bench.mjs — time the pure world build (heightfield + route) in the browser,
// without touching three or the DOM.
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 15000 });
const ctx = browser.contexts()[0] || (await browser.newContext());
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:5188/bench.html', { timeout: 20000, waitUntil: 'domcontentloaded' });

const out = await Promise.race([
  page.evaluate(async () => {
    const t = Date.now();
    while (!window.__bench && Date.now() - t < 15000) await new Promise((r) => setTimeout(r, 100));
    return window.__bench || { err: 'no bench' };
  }),
  new Promise((r) => setTimeout(() => r({ err: 'timeout 60s' }), 60000)),
]);
console.log(JSON.stringify(out, null, 1));
console.log(logs.join('\n'));
await page.close();
process.exit(0);
