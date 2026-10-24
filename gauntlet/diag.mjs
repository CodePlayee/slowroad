#!/usr/bin/env node
// gauntlet/diag.mjs — introspect the live scene: heights, scene graph, road placement.
import { chromium } from 'playwright';

const qs = process.argv[2] || 'seed=7&t=12&season=summer';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 15000 });
const ctx = browser.contexts()[0] || (await browser.newContext());
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 400)}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.setViewportSize({ width: 1280, height: 720 });
await page.goto(`http://localhost:5188/?${qs}`, { timeout: 25000, waitUntil: 'domcontentloaded' });

const out = await Promise.race([
  page.evaluate(async () => {
    const t = Date.now();
    while (!window.__rig && Date.now() - t < 15000) await new Promise((r) => setTimeout(r, 50));
    if (!window.__rig) return { err: 'no rig' };
    if (window.__rig.error && window.__rig.error()) return { err: window.__rig.error() };
    window.__rig.pause();
    try { await window.__rig.ready({ timeoutMs: 120000 }); } catch (e) { return { err: 'ready: ' + e.message }; }
    const app = window.__app;
    const w = app.world, hf = w.hf, rt = w.route;

    // terrain height statistics on a 4 km grid around the car
    const cx = app.vehicle.pos.x, cz = app.vehicle.pos.z;
    let mn = 1e9, mx = -1e9, sum = 0, nn = 0;
    for (let j = -20; j <= 20; j++) for (let i = -20; i <= 20; i++) {
      const h = hf.natural(cx + i * 100, cz + j * 100);
      mn = Math.min(mn, h); mx = Math.max(mx, h); sum += h; nn++;
    }
    // 20 km transect
    let mn2 = 1e9, mx2 = -1e9;
    for (let i = -100; i <= 100; i++) {
      const h = hf.natural(cx + i * 200, cz);
      mn2 = Math.min(mn2, h); mx2 = Math.max(mx2, h);
    }
    const parts = { relief: [], base: [], nat: [] };
    for (let i = 0; i < 8; i++) {
      const x = cx + i * 700, z = cz + i * 400;
      parts.relief.push(+hf.relief(x, z).toFixed(3));
      parts.base.push(Math.round(hf.smoothBase(x, z)));
      parts.nat.push(Math.round(hf.natural(x, z)));
    }

    // road segments: are any near the camera?
    const cam = app.cameras.camera.position;
    const segs = [];
    app.road.group.children.forEach((m) => {
      if (!m.geometry || !m.geometry.boundingSphere) return;
      const c = m.geometry.boundingSphere.center.clone().add(m.position);
      segs.push({ d: Math.round(c.distanceTo(cam)), y: Math.round(c.y * 10) / 10, r: Math.round(m.geometry.boundingSphere.radius), vis: m.visible, tris: m.geometry.index.count / 3 });
    });
    segs.sort((a, b) => a.d - b.d);

    // sample the road surface vs terrain at the car
    const p = rt.at(app.vehicle.s, {});
    const probes = [];
    for (const lat of [0, 2, 3.5, 5, 9.6, 20, 40, 80]) {
      const x = p.x - p.tz * lat, z = p.z + p.tx * lat;
      probes.push({ lat, terr: +w.ground(x, z).toFixed(2), nat: +hf.natural(x, z).toFixed(2), roadY: +(p.y).toFixed(2) });
    }
    const nn2 = rt.nearest(p.x, p.z, 62);

    return {
      grid4km: { min: Math.round(mn), max: Math.round(mx), mean: Math.round(sum / nn), relief: Math.round(mx - mn) },
      transect20km: { min: Math.round(mn2), max: Math.round(mx2), relief: Math.round(mx2 - mn2) },
      parts,
      car: { x: Math.round(cx), z: Math.round(cz), y: +app.vehicle.pos.y.toFixed(2), s: Math.round(app.vehicle.s) },
      cam: { x: Math.round(cam.x), y: +cam.y.toFixed(2), z: Math.round(cam.z) },
      roadSegments: segs.slice(0, 6),
      roadSegCount: app.road.group.children.length,
      probes,
      nearestAtCar: nn2 ? { dist: +nn2.dist.toFixed(2), y: +nn2.y.toFixed(2), bridge: +nn2.bridge.toFixed(2) } : null,
      sceneChildren: app.scene.children.map((c) => c.name || c.type),
      vegCounts: (() => { const o = {}; app.veg.group.children.forEach((m) => { const k = m.material.name; o[k] = (o[k] || 0) + m.count; }); return o; })(),
    };
  }),
  new Promise((r) => setTimeout(() => r({ err: 'timeout' }), 180000)),
]);
console.log(JSON.stringify(out, null, 1));
if (logs.length) console.log('---- console ----\n' + logs.slice(0, 30).join('\n'));
await page.close();
process.exit(0);
