import assert from 'node:assert/strict';
import test from 'node:test';
import { auditRouteVegetation, auditQueuedPriority } from './route-vegetation-audit.mjs';
const { roadsideTreeCover: auditRoadsideTreeCover } = await import('../src/vegetation/biome.js');

const { roadsideOpening } = await import('../src/vegetation/biome.js');
const report = auditRouteVegetation({ seeds: [7, 12, 31], stepKm: 2, otherStepKm: 4 });

for (const route of report.routes) test(`seed ${route.seed} audits accepted roadside populations across the whole route`, () => {
  assert.ok(route.stations.length >= Math.floor(route.routeKm / (route.seed === 7 ? 2 : 4)) + 1);
  assert.ok(route.routeKm - route.stations.at(-1).km <= 0.5);
  assert.ok(route.stations.some(station => station.accepted > 0));
  for (const station of route.stations) {
    assert.ok(station.candidates > 0 && station.accepted <= station.candidates);
    if (station.accepted) {
      assert.ok(Number.isFinite(station.acceptedHeight.mean) && station.acceptedHeight.min > 0);
      assert.ok(station.tallTreeFraction >= 0 && station.tallTreeFraction <= 1);
    }
    assert.equal(Object.values(station.reasons).reduce((sum, count) => sum + count, 0), station.candidates);
    assert.equal(station.bySide.left.accepted + station.bySide.right.accepted, station.accepted);
  }
});

test('roadside cover is continuous, bounded and leaves distant ambient woodland unchanged', () => {
  const seed = 7 ^ 0x2b7c1f03;
  let changed = 0;
  for (let x = 0; x < 4000; x += 25) {
    for (const ambient of [0, 0.25, 1]) {
      let previous = auditRoadsideTreeCover({}, x, 0, 0, ambient, seed);
      for (let distance = 1; distance <= 149; distance++) {
        const cover = auditRoadsideTreeCover({}, x, 0, distance, ambient, seed);
        assert.ok(Number.isFinite(cover) && cover >= 0 && cover <= 1);
        assert.ok(Math.abs(cover - previous) < 0.1, 'stand edge must fade, not jump');
        if (cover !== ambient) changed++;
        previous = cover;
      }
      assert.equal(auditRoadsideTreeCover({}, x, 0, 150, ambient, seed), ambient);
      assert.equal(auditRoadsideTreeCover({}, x, 0, Infinity, ambient, seed), ambient);
    }
  }
  assert.ok(changed > 0, 'the roadside field must affect some stands');
  let queries = 0;
  const world = { route: { nearest() { queries++; return { dist: 120 }; } } };
  assert.equal(auditRoadsideTreeCover(world, 0, 0, Infinity, 0, seed), auditRoadsideTreeCover({}, 0, 0, 120, 0, seed));
  assert.equal(queries, 1);
  assert.equal(auditRoadsideTreeCover(world, 0, 0, Infinity, 0.25, seed, false), 0.25);
  assert.equal(queries, 1, 'far tiles must avoid unnecessary per-candidate road queries');
});

test('roadside openings alternate between independent road sides and stay within the roadside band', () => {
  for (const routeSeed of [7, 12, 31]) {
    const seed = routeSeed ^ 0x2b7c1f03;
    let samples = 0, left = 0, right = 0, different = 0;
    for (let s = 0; s < 30000; s += 10) {
      const l = roadsideOpening(s, -1, s, -40, 40, seed), r = roadsideOpening(s, 1, s, 40, 40, seed);
      samples++; left += l > 0.5; right += r > 0.5; different += Math.abs(l - r) > 0.1;
      assert.ok(Number.isFinite(l) && l >= 0 && l <= 1);
      assert.ok(Number.isFinite(r) && r >= 0 && r <= 1);
      assert.equal(roadsideOpening(s, -1, s, -150, 150, seed), 0);
      assert.equal(roadsideOpening(s, 1, s, 150, 150, seed), 0);
    }
    for (const count of [left, right]) assert.ok(count > 0 && count < samples, `${routeSeed} each side has stands and openings`);
    assert.ok(different > 0, `${routeSeed} the two sides must not mirror each other`);
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
