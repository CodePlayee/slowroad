import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
const root = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(root) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(new URL(url), 'utf8'), shortCircuit: true } : next(url, context);
} });
const { World } = await import('../src/world/world.js');
const { POPULATION, generatePopulation } = await import('../src/vegetation/population.js');
const finish = it => { let step; do { step = it.next(); } while (!step.done); return step.value; };
const config = { ...POPULATION.tree };
const report = { config, stations: [], bands: Array.from({ length: 4 }, () => ({ before: 0, after: 0 })), before: 0, after: 0 };
try {
  for (const seed of [7, 12, 31]) {
    const world = new World(seed).build();
    for (const km of [0, 6, 18]) {
      const point = world.route.at(world.route.kmToS(Math.min(km, world.route.maxKm)));
      const ci = Math.floor(point.x / config.tile), cj = Math.floor(point.z / config.tile);
      const station = { seed, km, before: 0, after: 0 };
      for (let j = -9; j <= 9; j += 3) for (let i = -9; i <= 9; i += 3) {
        Object.assign(POPULATION.tree, { density: 1, roadDensityNear: 1, roadDensityFar: 1 });
        const before = finish(generatePopulation(world, 'tree', ci + i, cj + j));
        Object.assign(POPULATION.tree, config);
        const after = finish(generatePopulation(world, 'tree', ci + i, cj + j));
        const original = new Map(before.map(tree => [tree.id, tree]));
        for (const tree of after) assert.deepEqual(tree, original.get(tree.id), 'retained trees must not move or change species');
        const retained = new Set(after.map(tree => tree.id));
        for (const tree of before) {
          const distance = world.route.nearest(tree.x, tree.z, 320)?.dist ?? Infinity;
          const band = report.bands[distance <= 32 ? 0 : distance <= 160 ? 1 : distance <= 320 ? 2 : 3];
          band.before++; if (retained.has(tree.id)) band.after++;
        }
        station.before += before.length; station.after += after.length;
      }
      station.retained = station.after / station.before;
      report.stations.push(station);
      report.before += station.before; report.after += station.after;
    }
  }
} finally { Object.assign(POPULATION.tree, config); }
report.retained = report.after / report.before;
assert.ok(report.retained > 0.4 && report.retained < 0.6, `expected about half the trees, got ${report.retained}`);
report.status = 'passed';
const out = process.argv[2] || '/tmp/slowroad-tree-distribution.json';
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
