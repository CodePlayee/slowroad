import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(new URL(url), 'utf8'), shortCircuit: true } : next(url, context);
} });
const { World } = await import('../src/world/world.js');
const { ROAD } = await import('../src/road/params.js');

// Vertical acceleration of a car at the autodrive's top speed (108 km/h) over
// each profile vertex, in g.
const TOP = 30, G = 9.81;

for (const seed of [7, 12, 31]) {
  test(`route ${seed}: vertical curves, grades and bridge deck clearances`, () => {
    const route = new World(seed).build().route, { Y, ds, n } = route;
    let worst = 0, worstKm = 0;
    for (let i = 1; i < n - 1; i++) {
      const g = Math.abs(TOP * TOP * (Y[i - 1] - 2 * Y[i] + Y[i + 1]) / (ds * ds) / G);
      if (g > worst) { worst = g; worstKm = route.sToKm(i * ds); }
    }
    assert.ok(worst <= 0.2 + 1e-3, `${worst.toFixed(3)} g at km ${worstKm.toFixed(3)}`);
    for (let i = 0; i < n - 1; i++) assert.ok(Math.abs(Y[i + 1] - Y[i]) / ds <= ROAD.maxGrade + 1e-4, `grade at node ${i}`);
    assert.ok(route.bridges.length > 0);
    for (const b of route.bridges) {
      for (let k = b.a0; k <= b.a1; k++) assert.ok(Y[k] >= b.requiredY - 1e-3, `deck clearance at km ${b.km}`);
    }
  });

  test(`route ${seed}: sampled profile stays within grade and bridge clearance limits`, () => {
    const route = new World(seed).build().route, { ds, n } = route;
    const p = {}, before = {}, after = {}, epsilon = 0.01;
    for (let i = 1; i < n - 2; i++) {
      for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        const s = (i + t) * ds;
        route.at(s, p); route.at(s - epsilon, before); route.at(s + epsilon, after);
        assert.ok(Math.abs(p.grade) <= ROAD.maxGrade + 1e-4, `reported grade ${p.grade} at ${s}`);
        const grade = (after.y - before.y) / (2 * epsilon);
        assert.ok(Math.abs(grade) <= ROAD.maxGrade + 1e-4, `surface grade ${grade} at ${s}`);
      }
    }
    for (const bridge of route.bridges) {
      for (let i = bridge.a0; i < bridge.a1; i++) {
        for (const t of [0.25, 0.5, 0.75]) {
          route.at((i + t) * ds, p);
          assert.ok(p.y >= bridge.requiredY - 1e-3, `inter-node deck clearance at ${p.s}`);
        }
      }
    }
  });
}
