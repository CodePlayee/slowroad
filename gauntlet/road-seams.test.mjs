import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as THREE from 'three';

const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true }
    : next(url, context);
} });
const { RoadMesh } = await import('../src/road/roadmesh.js');
const { World } = await import('../src/world/world.js');
const { ROAD } = await import('../src/road/params.js');

function roadFixture(world, t) {
  const road = new RoadMesh(world, { register() {} }, { drop() {} }, { uniforms: {} });
  t.after(() => {
    road.rebuildAll();
    road.material.dispose();
    road.fenceMaterial.dispose();
  });
  return road;
}

function build(road, index) {
  const key = `road:${road.version}:${index}`;
  if (!road.segments.has(key)) road._build(key, index);
  road.group.updateMatrixWorld(true);
  return road.segments.get(key).children[0];
}

function row(mesh, last = false) {
  const position = mesh.geometry.attributes.position;
  const along = mesh.geometry.attributes.aRoad;
  const offset = last ? position.count - 13 : 0;
  return Array.from({ length: 13 }, (_, k) => ({
    point: mesh.localToWorld(new THREE.Vector3().fromBufferAttribute(position, offset + k)),
    s: along.getY(offset + k),
    lateral: along.getX(offset + k),
  }));
}

test('neighboring road ribbons share all endpoint vertices and leave no exposed transverse strip', t => {
  for (const seed of [7, 12, 31]) {
    const world = new World(seed).build();
    const road = roadFixture(world, t);
    for (const index of [0, 1, 12, 24, 80]) {
      const left = build(road, index), right = build(road, index + 1);
      const end = row(left, true), start = row(right);
      const boundary = (index + 1) * road.segLen;
      for (let k = 0; k < end.length; k++) {
        assert.equal(end[k].s, boundary, `seed ${seed}, segment ${index} ends before its boundary`);
        assert.equal(start[k].s, boundary);
        assert.equal(end[k].lateral, start[k].lateral);
        assert.ok(end[k].point.distanceTo(start[k].point) < 0.0001, 'shared edge must meet in world space');
      }
      for (const ds of [-1.4, -0.75, -0.1, 0.1]) {
        const p = world.route.at(boundary + ds);
        for (const lat of [-3, 0, 3]) {
          const ray = new THREE.Raycaster(new THREE.Vector3(p.x - p.tz * lat, p.y + 100, p.z + p.tx * lat),
            new THREE.Vector3(0, -1, 0), 0, 200);
          assert.ok(ray.intersectObjects([left, right], false).length > 0,
            `asphalt missing at seed ${seed}, s ${boundary + ds}, lateral ${lat}`);
        }
      }
    }
  }
});

test('short final road segments reach the endpoint with positive longitudinal steps', t => {
  for (const remaining of [1, ROAD.resample, 258.5, 260]) {
    const length = 260 + remaining;
    const world = {
      ground: () => 0,
      route: { length, ds: ROAD.resample, at(s, out = {}) {
        return Object.assign(out, { x: s, y: 0, z: 0, tx: 1, tz: 0, bridge: 0 });
      } },
    };
    const road = roadFixture(world, t), mesh = build(road, 1);
    assert.ok(mesh, `a ${remaining}m remainder must not be skipped`);
    assert.equal(row(mesh)[0].s, 260);
    assert.equal(row(mesh, true)[0].s, length);
    const along = mesh.geometry.attributes.aRoad;
    for (let i = 13; i < along.count; i += 13) {
      const step = along.getY(i) - along.getY(i - 13);
      assert.ok(step > 0 && step <= ROAD.resample);
    }
  }
});
