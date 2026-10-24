import assert from 'node:assert/strict';
import test from 'node:test';
import { auditRouteVegetation, auditQueuedPriority } from './route-vegetation-audit.mjs';

const { POPULATION, auditRoadsideTreeCover } = await import('../src/vegetation/population.js');
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

test('approaching an already queued tree tile refreshes its worker priority', () => {
  const probe = auditQueuedPriority();
  assert.ok(probe.initialPriority > probe.desiredPriorityAfterApproach);
  assert.equal(probe.actualQueuedPriorityAfterApproach, probe.desiredPriorityAfterApproach);
  assert.equal(probe.stale, false);
});
