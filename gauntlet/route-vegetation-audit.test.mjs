import assert from 'node:assert/strict';
import test from 'node:test';
import { auditRouteVegetation, auditQueuedPriority } from './route-vegetation-audit.mjs';

const { POPULATION, auditRoadsideTreeCover } = await import('../src/vegetation/population.js');
const { roadsideOpening } = await import('../src/vegetation/biome.js');
const report = auditRouteVegetation({ seeds: [7, 12, 31], stepKm: 2, otherStepKm: 4 });

for (const route of report.routes) test(`seed ${route.seed} retains tall roadside woodland across the whole route`, () => {
  assert.equal(POPULATION.tree.candidates, 1280, 'roadside continuity must not inflate the candidate budget');
  assert.equal(POPULATION.tree.density, 0.5);
  assert.ok(route.stations.length >= Math.floor(route.routeKm / (route.seed === 7 ? 2 : 4)) + 1);
  assert.ok(route.routeKm - route.stations.at(-1).km <= 0.5);
  assert.ok(route.stations.filter(station => station.treesPer100m >= 60).length >= route.stations.length * 0.8,
    'reduced woodland must still frame at least 80 percent of sampled road segments');
  for (const station of route.stations) {
    assert.ok(station.acceptedHeight.mean >= 15, `${station.km}km mean tree height`);
    assert.ok(station.tallTreeFraction >= 0.8, `${station.km}km proportion at least 15m tall`);
    assert.equal(Object.values(station.reasons).reduce((sum, count) => sum + count, 0), station.candidates);
    assert.equal(station.bySide.left.accepted + station.bySide.right.accepted, station.accepted);
    assert.ok(station.bySide.left.accepted > 0 && station.bySide.right.accepted > 0);
  }
});

test('roadside cover extends beyond terrain carving and fades without moving or flattening the world', () => {
  const seed = 7 ^ 0x2b7c1f03;
  let x = 0;
  while (x < 2000 && auditRoadsideTreeCover({}, x, 0, 10, 0, seed) < 0.65) x += 25;
  const core = auditRoadsideTreeCover({}, x, 0, 10, 0, seed);
  assert.ok(core >= 0.65 && core <= 0.86);
  assert.equal(auditRoadsideTreeCover({}, x, 0, 62, 0, seed), core);
  assert.equal(auditRoadsideTreeCover({}, x, 0, 90, 0, seed), core);
  assert.equal(auditRoadsideTreeCover({}, x, 0, 120, 0, seed), core * 0.5);
  assert.equal(auditRoadsideTreeCover({}, x, 0, 150, 0, seed), 0);
  assert.equal(auditRoadsideTreeCover({}, x, 0, 300, 0.25, seed), 0.25);
  assert.equal(auditRoadsideTreeCover({}, x, 0, 10, 1, seed), 1);
  let queries = 0;
  const world = { route: { nearest(px, z, distance) {
    queries++; assert.equal(px, x); assert.equal(z, 0); assert.equal(distance, 150);
    return { dist: 120 };
  } } };
  assert.equal(auditRoadsideTreeCover(world, x, 0, Infinity, 0, seed), core * 0.5);
  assert.equal(queries, 1);
  assert.equal(auditRoadsideTreeCover(world, x, 0, Infinity, 0.25, seed, false), 0.25);
  assert.equal(queries, 1, 'far tiles must avoid unnecessary per-candidate road queries');
});

test('roadside openings alternate between independent road sides and stay within the roadside band', () => {
  for (const routeSeed of [7, 12, 31]) {
    const seed = routeSeed ^ 0x2b7c1f03;
    let samples = 0, left = 0, right = 0, both = 0, one = 0, sl = 0, sr = 0, slr = 0, sll = 0, srr = 0;
    for (let s = 0; s < 30000; s += 10) {
      const l = roadsideOpening(s, -1, s, -40, 40, seed), r = roadsideOpening(s, 1, s, 40, 40, seed);
      samples++; left += l > 0.5; right += r > 0.5; both += l > 0.5 && r > 0.5; one += (l > 0.5) !== (r > 0.5);
      sl += l; sr += r; slr += l * r; sll += l * l; srr += r * r;
      assert.equal(roadsideOpening(s, -1, s, -150, 150, seed), 0);
      assert.equal(roadsideOpening(s, 1, s, 150, 150, seed), 0);
    }
    for (const fraction of [left / samples, right / samples]) assert.ok(fraction > 0.2 && fraction < 0.65, `${routeSeed} side open ${fraction}`);
    assert.ok(one > both * 2.5, `${routeSeed} one-sided openings must dominate (${one} vs ${both})`);
    const covariance = slr / samples - sl / samples * sr / samples;
    assert.ok(covariance < 0, `${routeSeed} the two sides must not mirror each other`);
  }
  const seed = 7 ^ 0x2b7c1f03;
  let cleared = 0;
  for (let s = 0; s < 4000; s += 25) for (const side of [-1, 1]) {
    const x = s, z = side * 40, closed = auditRoadsideTreeCover({}, x, z, 40, 0.9, seed);
    const world = { route: { nearest: () => ({ dist: 40, s, side }) } };
    const cover = auditRoadsideTreeCover(world, x, z, 40, 0.9, seed);
    assert.ok(cover >= 0 && cover <= closed, 'an opening may only remove roadside woodland');
    if (cover < closed * 0.5) cleared++;
  }
  assert.ok(cleared > 0, 'openings must clear dense ambient forest, not only the roadside floor');
});

test('approaching an already queued tree tile refreshes its worker priority', () => {
  const probe = auditQueuedPriority();
  assert.ok(probe.initialPriority > probe.desiredPriorityAfterApproach);
  assert.equal(probe.actualQueuedPriorityAfterApproach, probe.desiredPriorityAfterApproach);
  assert.equal(probe.stale, false);
});
