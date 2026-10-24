#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2), flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const out = flag('--out', '/tmp/slowroad-ground-contact'), report = {
  method: 'Actual restored instance roots against settled terrain triangles; bladeOrigins samples template blade roots, including detail bands.',
  scenes: [], errors: [],
};
let browser, context;
fs.mkdirSync(out, { recursive: true });
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${flag('--port', '9421')}`, { timeout: 20000 });
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`${process.env.GAUNTLET_URL || 'http://127.0.0.1:5189'}/?seed=7&km=6&t=12&season=summer&paused=1`, { timeout: 20000 });
  await page.waitForFunction(() => Boolean(globalThis.__rig), null, { timeout: 20000 });
  for (const [seed, km] of [[7, 6], [7, 26], [12, 5.5]]) {
    const result = await page.evaluate(async ({ seed, km }) => {
      await __rig.set({ seed, km, t: 12, season: 'summer', cam: 'chase' });
      await __rig.ready({ timeoutMs: 120000 });
      const terrain = __app.terrain, car = __app.vehicle.pos;
      const regions = terrain.regions.filter(region => region.settled).sort((a, b) => a.l - b.l);
      const groundAt = (x, z) => {
        const region = regions.find(r => x >= r.x0 && x < r.x0 + r.C && z >= r.z0 && z < r.z0 + r.C);
        if (!region) return null;
        const { tile, data } = terrain.chunks.get(region.key), n = data.resolution, stride = data.gridSize;
        const u = (x - tile.x0) / tile.C * n, v = (z - tile.z0) / tile.C * n;
        const i = Math.min(n - 1, Math.max(0, Math.floor(u))), j = Math.min(n - 1, Math.max(0, Math.floor(v)));
        const tx = u - i, tz = v - j, at = (j + 1) * stride + i + 1;
        const a = data.heights[at], b = data.heights[at + 1], c = data.heights[at + stride], d = data.heights[at + stride + 1];
        const y = tx + tz <= 1 ? a + (b - a) * tx + (c - a) * tz
          : d + (b - d) * (1 - tz) + (c - d) * (1 - tx);
        return { y, level: region.l, cell: tile.C / n };
      };
      const transform = (a, offset, point) => ({
        x: a[offset] * point.x + a[offset + 4] * point.y + a[offset + 8] * point.z + a[offset + 12],
        y: a[offset + 1] * point.x + a[offset + 5] * point.y + a[offset + 9] * point.z + a[offset + 13],
        z: a[offset + 2] * point.x + a[offset + 6] * point.y + a[offset + 10] * point.z + a[offset + 14],
      });
      const actualPoint = (mesh, index, point = { x: 0, y: 0, z: 0 }) =>
        transform(mesh.matrixWorld.elements, 0, transform(mesh.instanceMatrix.array, index * 16, point));
      const groups = { grass: [], shrub: [], tree: [], flower: [] }, bladeOrigins = [];
      for (const entry of __app.veg.tiles.values()) if (entry.groundReady) {
        const records = new Map(entry.records.map(record => [record.id, record]));
        for (const mesh of entry.meshes) {
          const isGrass = mesh.userData.field === 'grass';
          const isFlower = mesh.material.name === 'field-flowerStem';
          if (!isGrass && !isFlower && mesh.material.userData.foliagePart !== 'bark') continue;
          const ids = Array.isArray(mesh.userData.population) ? mesh.userData.population.map(r => r.id) : mesh.userData.population.ids;
          for (let index = 0; index < mesh.count; index++) {
            const id = ids[index], record = records.get(isFlower ? id.replace(/:flower$/, '') : id);
            if (!record) throw new Error(`Missing canonical record: ${id}`);
            const p = actualPoint(mesh, index), distance = Math.hypot(p.x - car.x, p.z - car.z);
            if (distance > (isGrass || isFlower ? 76 : 250)) continue;
            const ground = groundAt(p.x, p.z);
            if (!ground) continue;
            const kind = isFlower ? 'flower' : entry.job.kind;
            groups[kind].push({ id, ...p, canonicalY: record.y, height: record.height,
              delta: p.y - ground.y, canonicalDelta: record.y - ground.y, groundY: ground.y,
              level: ground.level, cell: ground.cell, distance });
            if (isGrass && (index % 200 === 0 || Math.abs(record.y - ground.y) > 0.70)) {
              const roots = mesh.geometry.getAttribute('aBladeRoot'), params = mesh.geometry.getAttribute('aBladeParam');
              for (let vertex = 0; vertex < roots.count; vertex++) if (params.getX(vertex) === 0) {
                const root = actualPoint(mesh, index, { x: roots.getX(vertex), y: roots.getY(vertex), z: roots.getZ(vertex) });
                const surface = groundAt(root.x, root.z);
                if (surface) bladeOrigins.push({ id, ...root, delta: root.y - surface.y, height: record.height,
                  level: surface.level, cell: surface.cell, distance });
                vertex++;
              }
            }
          }
        }
      }
      const summary = rows => {
        const sorted = rows.map(r => r.delta).sort((a, b) => a - b), n = rows.length;
        const absolute = sorted.map(Math.abs).sort((a, b) => a - b);
        return { count: n, p05: sorted[Math.floor(n * 0.05)], p50: sorted[Math.floor(n * 0.5)],
          p95: sorted[Math.floor(n * 0.95)], absoluteP95: absolute[Math.floor(n * 0.95)],
          floatingOver4cm: rows.filter(r => r.delta > 0.04).length,
          buriedOver4cm: rows.filter(r => r.delta < -0.04).length,
          buriedOver15percentHeight: rows.filter(r => r.delta < -Math.max(0.02, r.height * 0.15)).length,
          worst: [...rows].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 6) };
      };
      return { seed, km, settled: terrain.settled, stats: Object.fromEntries(Object.entries(groups).map(([kind, rows]) => [kind, summary(rows)])),
        bladeOrigins: summary(bladeOrigins) };
    }, { seed, km });
    report.scenes.push(result);
    fs.writeFileSync(path.join(out, 'ground-contact.json'), JSON.stringify(report, null, 2));
  }
} catch (error) {
  report.errors.push(String(error.stack || error)); process.exitCode = 1;
} finally {
  try { await context?.close(); } finally { await browser?.close(); }
  fs.writeFileSync(path.join(out, 'ground-contact.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
