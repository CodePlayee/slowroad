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

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// Sharpest curvature the walk can steer: maxTurnPerStep spread over one step.
const K_WALK = ROAD.maxTurnPerStep / ROAD.step;

for (const seed of [7, 12]) {
  test(`route ${seed}: the plan turns smoothly node to node, never in polyline kinks`, () => {
    const route = new World(seed).build().route, { X, Z, CURV, ds, n } = route;
    let maxTurn = 0, maxJump = 0, straight = 0, prev = null;
    for (let i = 1; i < n - 1; i++) {
      const turn = wrap(Math.atan2(Z[i + 1] - Z[i], X[i + 1] - X[i]) - Math.atan2(Z[i] - Z[i - 1], X[i] - X[i - 1]));
      maxTurn = Math.max(maxTurn, Math.abs(turn));
      if (prev !== null) maxJump = Math.max(maxJump, Math.abs(turn - prev));
      if (Math.abs(turn) < 1e-6) straight++;
      prev = turn;
    }
    // A linearly resampled 22 m polyline puts every turn on one node in four
    // (up to 6 degrees) and none on the others.
    assert.ok(maxTurn <= K_WALK * ds * 1.05, `turn per node ${(maxTurn * 180 / Math.PI).toFixed(2)} deg`);
    assert.ok(maxJump <= 0.25 * K_WALK * ds, `turn change between nodes ${(maxJump * 180 / Math.PI).toFixed(3)} deg`);
    assert.ok(straight < 0.01 * n, `${straight} nodes without turn`);
    for (let i = 0; i < n; i++) assert.ok(Math.abs(CURV[i]) <= K_WALK * 1.05, `curvature ${CURV[i]} at node ${i}`);
  });
}

test('route at(): position, tangent and curvature are continuous and consistent', () => {
  const route = new World(31).build().route, { ds } = route;
  const a = {}, b = {}, c = {};
  let worstHeading = 0, worstPos = 0, worstCurv = 0, worstRate = 0;
  for (let i = 80; i < 2000; i++) {
    const s = i * ds;
    // across every node: no jump in position, heading or curvature
    route.at(s - 1e-6, a); route.at(s + 1e-6, b);
    worstPos = Math.max(worstPos, Math.hypot(b.x - a.x, b.z - a.z) - 2e-6);
    worstHeading = Math.max(worstHeading, Math.abs(wrap(b.heading - a.heading)));
    worstCurv = Math.max(worstCurv, Math.abs(b.curv - a.curv));
    // between nodes: the reported curvature is the turning rate of the reported
    // tangent, and the tangent is the direction of travel
    for (const f of [0.2, 0.5, 0.8]) {
      const h = 0.05, sm = s + f * ds;
      route.at(sm - h, a); route.at(sm, b); route.at(sm + h, c);
      worstRate = Math.max(worstRate, Math.abs(wrap(c.heading - a.heading) / (2 * h) - b.curv));
      const travel = Math.atan2(c.z - a.z, c.x - a.x);
      worstHeading = Math.max(worstHeading, Math.abs(wrap(travel - b.heading)));
    }
  }
  assert.ok(worstPos < 1e-6, `position jump ${worstPos}`);
  assert.ok(worstHeading < 1e-5, `heading mismatch ${worstHeading}`);
  assert.ok(worstCurv < 1e-7, `curvature jump ${worstCurv}`);
  assert.ok(worstRate < 1e-5, `curvature vs turning rate ${worstRate}`);
});

test('route nearest(): the foot lies on the curve at the true lateral distance', () => {
  const route = new World(7).build().route, p = {};
  let worstDist = 0, worstS = 0, checked = 0;
  for (let s = 1000; s < 9000; s += 7.3) {
    route.at(s, p);
    if (Math.abs(p.curv) < 0.5 * K_WALK) continue;
    for (const lat of [-40, -12, -4, 4, 12, 40]) {
      const near = route.nearest(p.x - p.tz * lat, p.z + p.tx * lat, 62);
      assert.ok(near, `no road found ${lat} m off s=${s}`);
      worstDist = Math.max(worstDist, Math.abs(near.dist - Math.abs(lat)));
      worstS = Math.max(worstS, Math.abs(near.s - s));
      assert.equal(near.side, lat > 0 ? -1 : 1);
      checked++;
    }
  }
  assert.ok(checked > 200, `${checked} curved samples`);
  assert.ok(worstDist < 0.005, `distance error ${worstDist.toFixed(4)} m`);
  assert.ok(worstS < 0.01, `arc-length error ${worstS.toFixed(4)} m`);
});

test('route: the smooth centreline passes through the walked plan', () => {
  const route = new World(12).build().route;
  const plan = route._walk();
  route._smoothPlan(plan);
  let worst = 0;
  for (let i = 1; i < plan.length - 1; i++) {
    const near = route.nearest(plan[i].x, plan[i].z, 20);
    assert.ok(near, `plan point ${i} off the road`);
    worst = Math.max(worst, near.dist);
  }
  assert.ok(worst < 0.02, `plan point ${worst.toFixed(3)} m off the centreline`);
});
