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
const { GrassField, createGrassGeometry, grassLodWeights, grassSeedPresence } = await import('../src/vegetation/grassField.js');
const { GRASS_COVERAGE, GRASS_SNOW, GRASS_COVERAGE_GLSL, grassRoadCoverage, grassViewCoverage, grassWinterExposure } = await import('../src/vegetation/grassCoverage.js');
const { InstanceCuller } = await import('../src/vegetation/instanceCulling.js');
const { MEADOW_FIELD_GLSL } = await import('../src/terrain/meadowField.js');

const record = (id, x = 0, z = -20) => Object.freeze({
  id, x, y: 3, z, yaw: 0.6, height: 0.7, width: 0.9,
  rank: 0.35, phase: 2.1, moisture: 0.62, cover: 0.3,
  variant: 1, groundDx: 0.18, groundDz: -0.11,
});
const camera = () => new THREE.PerspectiveCamera(54, 16 / 9, 0.1, 1000);

function shapedVertex(geometry, index, { phase = 0, width = 1, snow = 0, wind = 0, maturity = 1, seedGrowth = 1 } = {}) {
  const positions = geometry.getAttribute('position'), centers = geometry.getAttribute('aBladeCenter');
  const roots = geometry.getAttribute('aBladeRoot'), params = geometry.getAttribute('aBladeParam');
  const center = new THREE.Vector3().fromBufferAttribute(centers, index);
  const root = new THREE.Vector3().fromBufferAttribute(roots, index);
  const role = params.getW(index), coverage = (role > 2.5 ? maturity * seedGrowth : 1) * (role === 1 ? 1 : 1 - snow);
  const point = new THREE.Vector3().fromBufferAttribute(positions, index).sub(center).multiplyScalar(width * coverage).add(center).sub(root);
  const seed = params.getZ(index), variation = Math.sin(phase + seed * 6.2831853);
  const angle = Math.sin(phase * 0.61) * 0.28 + variation * 0.22;
  const length = 0.90 + 0.10 * (0.65 * (0.5 + 0.5 * Math.sin(phase * 0.73))
    + 0.35 * (0.5 + 0.5 * Math.sin(phase * 0.73 + seed * 17.17)));
  const lean = 0.84 + 0.16 * (0.5 + 0.5 * variation), x = point.x, z = point.z;
  point.x = (Math.cos(angle) * x - Math.sin(angle) * z) * lean;
  point.z = (Math.sin(angle) * x + Math.cos(angle) * z) * lean;
  point.y *= length;
  point.add(root);
  point.y *= 1 + ((role < 0.5 ? 0.12 : role < 1.5 ? 0.58 : 0.28) * (0.88 + 0.12 * variation) - 1) * snow;
  const t2 = params.getX(index) ** 2, sway = wind * 0.036 * 1.24 * t2 * (1 - snow * 0.75);
  point.x += 0.56 * snow * 0.04 * t2 + 0.765 * sway;
  point.z += 0.83 * snow * 0.04 * t2 + 0.644 * sway;
  return point;
}

test('cooperative grass build yields through matrices and bounds without changing output', () => {
  const field = new GrassField();
  const records = Array.from({ length: 385 }, (_, i) => ({ ...record(`tuft-${i}`, i / 8, -i / 12), roadDist: 5 + i % 25 }));
  const [expected] = field.build(records);
  const iterator = field.buildSteps(records);
  let step, slices = 0;
  do { step = iterator.next(); if (!step.done) slices++; } while (!step.done);
  const [actual] = step.value;
  assert.ok(slices >= 7, 'matrix population and aggregate bounds must both yield');
  assert.deepEqual(actual.instanceMatrix.array, expected.instanceMatrix.array);
  assert.deepEqual(actual.geometry.getAttribute('iGrassStyle').array, expected.geometry.getAttribute('iGrassStyle').array);
  assert.deepEqual(actual.geometry.getAttribute('iGrassRoad').array, expected.geometry.getAttribute('iGrassRoad').array);
  assert.deepEqual(actual.geometry.getAttribute('iGrassMaturity').array, expected.geometry.getAttribute('iGrassMaturity').array);
  assert.equal(actual.geometry.userData.grassLayout, field.geometry.userData.grassLayout);
  const bounds = actual.boundingSphere.clone();
  actual.computeBoundingSphere();
  assert.deepEqual(actual.boundingSphere, bounds, 'incremental bounds match Three.js exactly');
  field.dispose();
});

test('cancelled and failed grass builders release partial buffers, never shared templates', () => {
  const field = new GrassField();
  const records = Array.from({ length: 256 }, (_, i) => record(`tuft-${i}`));
  let disposed = 0, templateDisposed = 0;
  field.geometry.addEventListener('dispose', () => templateDisposed++);
  const iterator = field.buildSteps(records);
  assert.equal(iterator.next().done, false);
  const partial = [...field.meshes][0];
  partial.addEventListener('dispose', () => disposed++);
  iterator.return(); iterator.return();
  assert.equal(disposed, 1);
  assert.equal(field.meshes.size, 0);
  assert.equal(templateDisposed, 0);
  assert.equal(partial.geometry.index, null);
  assert.equal(partial.geometry.getAttribute('position'), undefined);
  assert.throws(() => field.build([record('good'), null]), TypeError);
  assert.equal(field.meshes.size, 0);
  field.dispose();
  assert.equal(templateDisposed, 1);
});

test('grass replaces two near leaves with a small seed head while retaining 202 nondegenerate triangles', () => {
  const geometry = createGrassGeometry(), layout = geometry.userData.grassLayout;
  const positions = geometry.getAttribute('position'), centers = geometry.getAttribute('aBladeCenter');
  const parameters = geometry.getAttribute('aBladeParam');
  assert.equal(positions.count, 290);
  assert.equal(geometry.index.count / 3, 202);
  assert.equal(layout.bladeCount, 36);
  assert.equal(layout.rootVertexCount, 74);
  assert.equal(layout.seedStemCount, 1);
  assert.equal(layout.basalBladeCount, 12);
  assert.equal(layout.coreMiddleBladeCount, 6);
  assert.equal(layout.structureBladeCount, 6);
  assert.equal(layout.vertexCount, positions.count);
  assert.equal(layout.triangleCount, 202);
  assert.deepEqual(layout.prefixIndices, [360, 480, 606]);
  assert.deepEqual(layout.layers.map(layer => layer.bladeCount), [24, 8, 4]);
  assert.deepEqual(layout.layers.map(layer => layer.verticesPerBlade), [7, 7, 9]);
  assert.ok(layout.triangleCount <= 210 && layout.prefixIndices[0] / 3 <= 120);
  assert.equal(centers.count, positions.count);
  const heights = [[], [], []], widths = [[], [], []], roleHeights = [[], [], []], seeds = new Set();
  let roots = 0;
  for (const layer of layout.layers) {
    assert.equal(layer.prefixCount, layer.indexStart + layer.indexCount);
    for (let i = layer.indexStart; i < layer.prefixCount; i++) {
      assert.equal(parameters.getY(geometry.index.getX(i)), layer.band, 'prefixes may contain only their declared leaf layer');
    }
    for (let blade = 0; blade < layer.bladeCount; blade++) {
      const root = layer.vertexStart + blade * layer.verticesPerBlade, tip = root + layer.verticesPerBlade - 1;
      const peak = Math.max(...Array.from({ length: layer.verticesPerBlade }, (_, vertex) => positions.getY(root + vertex)));
      heights[layer.band].push(peak);
      roleHeights[parameters.getW(root)].push(peak);
      widths[layer.band].push(Math.hypot(positions.getX(root) - positions.getX(root + 1), positions.getZ(root) - positions.getZ(root + 1)));
      seeds.add(parameters.getZ(root));
      for (let vertex = 0; vertex < layer.verticesPerBlade; vertex++) {
        const at = root + vertex;
        assert.equal(parameters.getY(at), layer.band);
        assert.equal(parameters.getZ(at), parameters.getZ(root));
        assert.equal(parameters.getW(at), parameters.getW(root));
        const anchors = geometry.getAttribute('aBladeRoot');
        assert.equal(anchors.getX(at), anchors.getX(root));
        assert.equal(anchors.getZ(at), anchors.getZ(root));
        assert.equal(anchors.getY(at), 0);
        assert.equal(positions.getY(at), centers.getY(at), 'view-based width morph cannot move any vertex vertically');
        if (vertex < 2) {
          assert.equal(parameters.getX(at), 0);
          assert.equal(positions.getY(at), 0);
          roots++;
        }
      }
      const rowWidths = [];
      for (let at = root; at < tip; at += 2) {
        const width = Math.hypot(positions.getX(at) - positions.getX(at + 1), positions.getZ(at) - positions.getZ(at + 1));
        rowWidths.push(width);
        assert.ok(width > 0.001 && width < 0.075, 'narrow roots must open into a leaf body, not a rectangular short card');
      }
      assert.ok(rowWidths[0] / Math.max(...rowWidths) >= 0.2 && rowWidths[0] / Math.max(...rowWidths) <= 0.3);
      const mid = root + 2, t = parameters.getX(mid);
      const straightX = centers.getX(root) + (centers.getX(tip) - centers.getX(root)) * t;
      const straightZ = centers.getZ(root) + (centers.getZ(tip) - centers.getZ(root)) * t;
      assert.ok(Math.hypot(centers.getX(mid) - straightX, centers.getZ(mid) - straightZ) > (parameters.getW(root) === 0 ? 0.018 : 0.025));
      assert.deepEqual(Array.from(positions.array.slice(tip * 3, (tip + 1) * 3)), Array.from(centers.array.slice(tip * 3, (tip + 1) * 3)));
    }
  }
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.equal(roots, 72);
  assert.equal(Array.from({ length: parameters.count }, (_, i) => parameters.getX(i)).filter(t => t === 0).length, 74);
  assert.equal(seeds.size, 36);
  assert.deepEqual(roleHeights.map(values => values.length), [12, 6, 18]);
  assert.ok(Math.min(...roleHeights[1]) >= 0.88);
  assert.equal(Math.max(...heights[0]), 1, 'the tallest structural leaf belongs to the persistent core');
  assert.ok(Math.max(...heights[1], ...heights[2]) < 0.85, 'near detail may not own the plant silhouette');
  assert.ok(mean(widths[0]) > mean(widths[1]));
  assert.ok(mean(widths[1]) > mean(widths[2]));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < geometry.index.count; i += 3) {
    a.fromBufferAttribute(positions, geometry.index.getX(i));
    b.fromBufferAttribute(positions, geometry.index.getX(i + 1));
    c.fromBufferAttribute(positions, geometry.index.getX(i + 2));
    assert.ok(b.sub(a).cross(c.sub(a)).lengthSq() > 1e-10);
  }
  for (const attribute of Object.values(geometry.attributes)) assert.ok(attribute.array.every(Number.isFinite));
  assert.ok(Number.isFinite(geometry.boundingSphere.radius));
  assert.equal(geometry.getAttribute('aGrassInfill'), undefined);
  geometry.dispose();
});


test('structural leaves retain descending arches and an upright persistent silhouette', () => {
  const geometry = createGrassGeometry(), layout = geometry.userData.grassLayout;
  const positions = geometry.getAttribute('position'), params = geometry.getAttribute('aBladeParam');
  const layer = layout.layers[0];
  let arched = 0, upright = 0;
  for (let blade = 0; blade < 6; blade++) {
    const root = layer.structureVertexStart + blade * layer.verticesPerBlade;
    const peak = root + 4, tip = root + 6;
    const maximum = Math.max(...Array.from({ length: 7 }, (_, index) => positions.getY(root + index)));
    assert.ok(maximum > 0 && maximum <= 1, 'structural leaf heights are normalized');
    assert.equal(params.getX(peak), 0.75);
    if ([0, 2, 3, 5].includes(blade)) {
      arched++;
      assert.equal(positions.getY(peak), maximum);
      const ratio = positions.getY(tip) / maximum;
      assert.ok(ratio >= 0.80 && ratio <= 0.90);
      assert.ok(positions.getY(tip) < positions.getY(peak), 'the final rendered segment must slope down, not merely bend in xz');
      for (const phase of [0, 1.2, 2.7, 4.9, 6.2]) for (const snow of [0, 1]) {
        const crest = shapedVertex(geometry, peak, { phase, snow, wind: 1 });
        const end = shapedVertex(geometry, tip, { phase, snow, wind: -1 });
        assert.ok(Math.abs(end.y / crest.y - ratio) < 1e-7, 'phase and winter preserve the true vertical arch');
      }
    } else {
      upright++;
      assert.equal(positions.getY(tip), maximum);
    }
  }
  assert.equal(arched, 4); assert.equal(upright, 2);
  assert.equal(geometry.boundingBox.max.y, 1);
  assert.deepEqual(layout.prefixIndices, [360, 480, 606]);
  assert.equal(layout.triangleCount, 202);
  geometry.dispose();
});

test('inner core leaves form rooted arches retained in the persistent draw prefix', () => {
  const geometry = createGrassGeometry(), layout = geometry.userData.grassLayout;
  const positions = geometry.getAttribute('position'), roots = geometry.getAttribute('aBladeRoot'), params = geometry.getAttribute('aBladeParam');
  assert.equal(layout.layers[0].basalVertexStart, 42);
  assert.equal(layout.layers[0].structureVertexStart, 126);
  assert.equal(layout.layers[0].middleBladeCount, 6);
  for (let blade = 0; blade < 6; blade++) {
    const root = blade * 7, peak = root + 4, tip = root + 6;
    const height = positions.getY(peak), ratio = positions.getY(tip) / height;
    assert.equal(params.getX(peak), 0.75);
    assert.ok(height >= 0.65 && height <= 0.82);
    assert.ok(ratio >= 0.82 && ratio <= 0.90);
    assert.ok(Math.hypot(roots.getX(root), roots.getZ(root)) < 0.10, 'middle leaves gather around the clump center');
    for (let vertex = 0; vertex < 7; vertex++) {
      const at = root + vertex;
      assert.equal(params.getY(at), 0, 'middle leaves must survive every nonzero roadside LOD');
      assert.equal(params.getW(at), 2, 'middle filler is buried in winter, unlike persistent structural shoots');
      if (vertex < 2) assert.equal(positions.getY(at), 0);
    }
    for (const phase of [0, 2.1, 4.9]) {
      assert.ok(shapedVertex(geometry, peak, { phase }).y > shapedVertex(geometry, tip, { phase }).y);
      for (let i = blade * 15; i < (blade + 1) * 15; i += 3) {
        const a = shapedVertex(geometry, geometry.index.getX(i), { phase, snow: 1, wind: 1 });
        const b = shapedVertex(geometry, geometry.index.getX(i + 1), { phase, snow: 1, wind: 1 });
        const c = shapedVertex(geometry, geometry.index.getX(i + 2), { phase, snow: 1, wind: 1 });
        assert.equal(b.sub(a).cross(c.sub(a)).lengthSq(), 0);
      }
    }
  }
  geometry.dispose();
});

test('height-clipped leaf area fills the middle half without sacrificing the existing lower layer', () => {
  const geometry = createGrassGeometry(), positions = geometry.getAttribute('position'), params = geometry.getAttribute('aBladeParam');
  const clip = (polygon, y, above) => {
    const out = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const insideA = above ? a.y >= y : a.y <= y, insideB = above ? b.y >= y : b.y <= y;
      if (insideA) out.push(a);
      if (insideA !== insideB) out.push(a.clone().lerp(b, (y - a.y) / (b.y - a.y)));
    }
    return out;
  };
  const area = polygon => {
    let sum = 0;
    for (let i = 1; i + 1 < polygon.length; i++) sum += new THREE.Triangle(polygon[0], polygon[i], polygon[i + 1]).getArea();
    return sum;
  };
  const heights = [0, 0.25, 0.5, 0.75, 1], core = [0, 0, 0, 0], full = [0, 0, 0, 0];
  let total = 0;
  for (let i = 0; i < geometry.index.count; i += 3) {
    const first = geometry.index.getX(i);
    if (params.getW(first) >= 3) continue;
    const triangle = [0, 1, 2].map(vertex => new THREE.Vector3().fromBufferAttribute(positions, geometry.index.getX(i + vertex)));
    total += area(triangle);
    for (let band = 0; band < 4; band++) {
      const value = area(clip(clip(triangle, heights[band], true), heights[band + 1], false));
      full[band] += value;
      if (params.getY(first) === 0) core[band] += value;
    }
  }
  const sum = values => values.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum(full) - total) < 1e-9, 'clipped slabs must account for every non-seed triangle exactly once');
  // Frozen round-09 geometry measured by the same exact horizontal clipping.
  const beforeCore = [0.132074, 0.106790, 0.032749, 0.018531];
  const beforeFull = [0.162349, 0.139629, 0.035833, 0.018531];
  assert.ok(core[2] > beforeCore[2] * 2.2 && full[2] > beforeFull[2] * 2.1);
  assert.ok(core[2] / sum(core) > 0.20 && full[2] / sum(full) > 0.18, 'upper-middle leaf area must no longer be the ten-percent gap');
  assert.ok(core[0] + core[1] >= (beforeCore[0] + beforeCore[1]) * 0.98, 'filling the middle must not hollow out the supporting lower layer');
  assert.equal(geometry.index.count / 3, 202);
  geometry.dispose();
});

test('one narrow panicle uses the replaced two-leaf budget and attaches its spikelets to the bent stem', () => {
  const geometry = createGrassGeometry(), layout = geometry.userData.grassLayout, seed = layout.seedHead;
  const positions = geometry.getAttribute('position'), centers = geometry.getAttribute('aBladeCenter'), params = geometry.getAttribute('aBladeParam');
  assert.deepEqual([seed.vertexStart, seed.vertexCount, seed.indexStart, seed.indexCount], [260, 30, 564, 42]);
  assert.equal(seed.indexCount / 3, 14);
  assert.equal(layout.layers[2].leafIndexCount + seed.indexCount, 126);
  assert.equal(layout.layers[2].leafVertexCount, 36);
  assert.equal(layout.layers[2].seedHead, seed);
  assert.equal(seed.spikeletCount, 7);
  for (let i = seed.vertexStart; i < positions.count; i++) {
    assert.equal(params.getY(i), 2, 'seed geometry belongs exclusively to near detail');
    assert.ok(params.getW(i) === 3 || params.getW(i) === 4);
    assert.ok(positions.getY(i) <= 0.9 + 1e-7);
    assert.equal(params.getZ(i), params.getZ(seed.vertexStart), 'all panicle parts must share a deformation frame');
  }
  assert.equal(params.getX(seed.vertexStart), 0);
  assert.equal(params.getX(seed.vertexStart + 1), 0);
  for (let branch = 0; branch < seed.spikeletCount; branch++) {
    const at = seed.vertexStart + seed.stemVertexCount + branch * 3;
    const baseWidth = Math.hypot(positions.getX(at) - positions.getX(at + 1), positions.getZ(at) - positions.getZ(at + 1));
    assert.ok(baseWidth < 0.0043 && baseWidth > 0.003, 'spikelets are fine branch tips, not broad grains or petals');
    const stem = Array.from({ length: seed.stemVertexCount }, (_, i) => seed.vertexStart + i)
      .find(index => params.getX(index) === params.getX(at));
    assert.notEqual(stem, undefined);
    assert.equal(centers.getX(at), centers.getX(stem));
    assert.equal(centers.getY(at), centers.getY(stem));
    assert.equal(centers.getZ(at), centers.getZ(stem));
    for (const phase of [0, 1.7, 4.9]) for (const snow of [0, 1]) {
      const a = shapedVertex(geometry, at, { phase, snow, width: 0, wind: 1 });
      const b = shapedVertex(geometry, stem, { phase, snow, width: 0, wind: 1 });
      assert.ok(a.distanceTo(b) < 1e-8, 'spikelet roots remain attached under shared phase, wind and winter motion');
    }
  }
  geometry.dispose();
});

test('seed presence selects a stable thirty-percent subset without changing canonical instance data', () => {
  let mature = 0;
  for (let i = 0; i < 10000; i++) mature += grassSeedPresence((i + 0.5) / 10000 * Math.PI * 2);
  assert.equal(mature, 3000);
  for (const phase of [0, 1, 2.1, 4.9, 5.5]) {
    assert.equal(grassSeedPresence(phase), grassSeedPresence(phase + Math.PI * 2));
    assert.equal(grassSeedPresence(phase), grassSeedPresence(phase - Math.PI * 2));
  }
  assert.equal(grassSeedPresence(Infinity), 0); assert.equal(grassSeedPresence(NaN), 0);
  const field = new GrassField(), population = [1, 4.9, 2.1, 5.5].map((phase, i) => ({ ...record(`mature-${i}`), phase }));
  const [mesh] = field.build(population), maturity = mesh.geometry.getAttribute('iGrassMaturity');
  assert.ok(maturity.isInstancedBufferAttribute); assert.equal(maturity.itemSize, 1);
  assert.deepEqual(Array.from(maturity.array), [0, 1, 0, 1]);
  const matrix = mesh.instanceMatrix.array.slice(), style = mesh.geometry.getAttribute('iGrassStyle').array.slice();
  const ids = mesh.userData.population.ids.slice(), flags = maturity.array.slice(), view = camera();
  for (const [time, season] of [[0, 'spring'], [100, 'summer'], [1000, 'autumn'], [2000, 'winter'], [5000, 'summer']]) {
    field.update(view, time, season, 1080);
    assert.deepEqual(maturity.array, flags);
    assert.deepEqual(mesh.instanceMatrix.array, matrix);
    assert.deepEqual(mesh.geometry.getAttribute('iGrassStyle').array, style);
    assert.deepEqual(mesh.userData.population.ids, ids);
  }
  field.dispose();
});

test('seed heads collapse exactly when immature, winter-hidden or outside near LOD without removing main leaves', () => {
  const geometry = createGrassGeometry(), seed = geometry.userData.grassLayout.seedHead;
  const area = options => {
    let sum = 0;
    for (let i = seed.indexStart; i < seed.indexStart + seed.indexCount; i += 3) {
      const a = shapedVertex(geometry, geometry.index.getX(i), options);
      const b = shapedVertex(geometry, geometry.index.getX(i + 1), options);
      const c = shapedVertex(geometry, geometry.index.getX(i + 2), options);
      sum += b.sub(a).cross(c.sub(a)).length() * 0.5;
    }
    return sum;
  };
  for (const phase of [0, 2.1, 4.9]) {
    assert.equal(area({ phase, maturity: 0, wind: 1 }), 0);
    assert.equal(area({ phase, seedGrowth: 0, snow: 1, wind: -1 }), 0);
    assert.equal(area({ phase, width: grassLodWeights(16, 40).near }), 0);
    const summer = area({ phase, maturity: 1, seedGrowth: 1 });
    const spring = area({ phase, maturity: 1, seedGrowth: 0.35 });
    assert.ok(summer > 0 && spring > 0 && spring < summer * 0.5);
    for (const distance of [20, 40, 60]) {
      const weights = grassLodWeights(0.6 * 900 / distance, distance);
      const width = weights.near * weights.width * weights.compensation;
      assert.equal(area({ phase, width, maturity: 0 }), 0);
      if (weights.near === 0) assert.equal(area({ phase, width, maturity: 1 }), 0);
    }
  }
  const field = new GrassField(), [mesh] = field.build([{ ...record('seed-far', 0, -60), phase: 5, height: 0.3 }]), view = camera();
  view.position.y = 3; view.updateMatrixWorld(); mesh.updateMatrixWorld();
  mesh.onBeforeRender(null, null, view, mesh.geometry);
  assert.equal(mesh.geometry.drawRange.count, 360);
  assert.ok(mesh.geometry.drawRange.count < seed.indexStart);
  assert.equal(mesh.geometry.index.count, 606);
  field.dispose(); geometry.dispose();
});

test('seed palettes express green spring growth, pale summer seed and dry autumn without changing leaf albedo', () => {
  const field = new GrassField(), view = camera(), material = field.material;
  const tint = field.uniforms.uGrassSeedTint.value, key = material.customProgramCacheKey();
  const leafSummer = field.uniforms.uGrassLush.value.toArray();
  field.update(view, 0, 'spring', 1080);
  assert.equal(field.uniforms.uGrassSeedGrowth.value, 0.35);
  assert.ok(tint.g > tint.r && tint.r > tint.b);
  field.update(view, 0, 'summer', 1080);
  assert.equal(field.uniforms.uGrassSeedGrowth.value, 1);
  assert.deepEqual(field.uniforms.uGrassLush.value.toArray(), leafSummer);
  const summerRatio = tint.r / tint.g;
  assert.ok(tint.r > tint.g && tint.g > tint.b);
  field.update(view, 0, 'autumn', 1080);
  assert.equal(field.uniforms.uGrassSeedGrowth.value, 1);
  assert.ok(tint.r / tint.g > summerRatio + 0.2);
  field.update(view, 0, 'winter', 1080);
  assert.equal(field.uniforms.uGrassSeedGrowth.value, 0);
  field.update(view, 0, 'summer', 1080);
  assert.equal(field.uniforms.uGrassSeedGrowth.value, 1);
  assert.equal(field.uniforms.uGrassSeedTint.value, tint);
  assert.equal(field.material, material);
  assert.equal(material.customProgramCacheKey(), key);
  assert.equal(material.emissive.getHex(), 0);
  assert.equal(material.alphaTest, 0); assert.equal(material.transparent, false);
  field.dispose();
});

test('packed grass maturity flags follow instance selection and restore without creating extra plant instances', () => {
  const field = new GrassField(), culler = new InstanceCuller(), scene = new THREE.Scene(), view = camera();
  const population = [
    { ...record('offscreen-seeded', 1000, -20), phase: 5 },
    { ...record('near-unseeded', 0, -20), phase: 1 },
    { ...record('near-seeded', 2, -25), phase: 5.5 },
  ];
  const [mesh] = field.build(population), canonical = mesh.geometry, maturity = canonical.getAttribute('iGrassMaturity');
  const flags = maturity.array.slice(), ids = mesh.userData.population.ids.slice(), matrices = mesh.instanceMatrix;
  assert.deepEqual(Array.from(flags), [1, 0, 1]);
  scene.add(mesh); view.position.y = 3;
  culler.prepare(scene, view);
  assert.equal(mesh.count, 2);
  assert.notEqual(mesh.geometry, canonical);
  assert.deepEqual(Array.from(mesh.geometry.getAttribute('iGrassMaturity').array.slice(0, mesh.count)), [0, 1]);
  assert.equal(mesh.geometry.getAttribute('iGrassStyle').getW(0), 1);
  assert.equal(mesh.geometry.getAttribute('iGrassStyle').getW(1), 5.5);
  assert.equal(mesh.instanceMatrix.array[12], population[1].x);
  assert.equal(mesh.instanceMatrix.array[28], population[2].x);
  culler.restore();
  assert.equal(mesh.count, population.length);
  assert.equal(mesh.geometry, canonical); assert.equal(mesh.instanceMatrix, matrices);
  assert.equal(mesh.geometry.getAttribute('iGrassMaturity'), maturity);
  assert.deepEqual(maturity.array, flags); assert.deepEqual(mesh.userData.population.ids, ids);
  culler.dispose(); field.dispose();
});

test('layered grass is reproducible with darker roots and wider shaded basal leaves', () => {
  const first = createGrassGeometry(), second = createGrassGeometry();
  for (const name of Object.keys(first.attributes)) assert.deepEqual(first.attributes[name].array, second.attributes[name].array);
  assert.deepEqual(first.index.array, second.index.array);
  const colors = first.getAttribute('color'), normals = first.getAttribute('normal'), rootMeans = [];
  for (const layer of first.userData.grassLayout.layers) {
    let roots = 0;
    for (let blade = 0; blade < layer.bladeCount; blade++) {
      const root = layer.vertexStart + blade * layer.verticesPerBlade, tip = root + layer.verticesPerBlade - 1;
      roots += colors.getY(root);
      assert.ok(colors.getY(tip) / colors.getY(root) > 1.9, 'deep roots separate from the sunlit leaf body');
      assert.ok(colors.getY(tip) - colors.getY(root) > 0.33);
      assert.ok(colors.getY(root) < colors.getY(root + 1));
    }
    rootMeans.push(roots / layer.bladeCount);
  }
  assert.ok(rootMeans[0] < rootMeans[1] && rootMeans[1] < rootMeans[2], 'the basal mat is darker than exposed shoots');
  for (let i = 0; i < normals.count; i++) {
    assert.ok(Math.abs(Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i)) - 1) < 1e-6);
    assert.ok(normals.getY(i) > 0.6);
    assert.ok(Number.isFinite(colors.getY(i)) && colors.getY(i) > 0, 'root colours remain finite and nonblack');
  }
  first.dispose(); second.dispose();
});

test('support leaves have nonzero surface area and remain narrow relative to their height', () => {
  const geometry = createGrassGeometry(), positions = geometry.getAttribute('position');
  const params = geometry.getAttribute('aBladeParam');
  const areas = [0, 0, 0, 0, 0], widths = [[], [], [], []];
  const group = at => params.getW(at) === 0 ? 0 : params.getW(at) === 1 ? 2
    : params.getW(at) === 2 ? (params.getY(at) === 0 ? 1 : 3) : 4;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < geometry.index.count; i += 3) {
    const at = geometry.index.getX(i);
    a.fromBufferAttribute(positions, at);
    b.fromBufferAttribute(positions, geometry.index.getX(i + 1));
    c.fromBufferAttribute(positions, geometry.index.getX(i + 2));
    areas[group(at)] += b.sub(a).cross(c.sub(a)).length() * 0.5;
  }
  for (const layer of geometry.userData.grassLayout.layers) for (let blade = 0; blade < layer.bladeCount; blade++) {
    const root = layer.vertexStart + blade * layer.verticesPerBlade, tip = root + layer.verticesPerBlade - 1;
    const category = group(root), rowWidths = [];
    for (let i = root; i < tip; i += 2) {
      rowWidths.push(Math.hypot(positions.getX(i) - positions.getX(i + 1), positions.getZ(i) - positions.getZ(i + 1)));
    }
    const width = Math.max(...rowWidths); widths[category].push(width);
    if (category < 2) {
      const height = Math.max(...Array.from({ length: layer.verticesPerBlade }, (_, vertex) => positions.getY(root + vertex)));
      assert.ok(width / height < 0.17, 'both support layers remain narrow grass leaves rather than petals');
    }
  }
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.deepEqual(widths.map(values => values.length), [12, 6, 6, 12]);
  assert.ok(areas.every(area => Number.isFinite(area) && area > 0));
  assert.ok(mean(widths[0]) > mean(widths[2]) * 1.4 && mean(widths[1]) > mean(widths[2]) * 1.4);
  assert.ok(mean(widths[2]) > mean(widths[3]) * 1.4);
  assert.equal(geometry.getAttribute('position').count, 290);
  assert.equal(geometry.index.count / 3, 202);
  geometry.dispose();
});

test('core and mid LOD keep at least 85 percent of the full plant silhouette through the view fade', () => {
  const geometry = createGrassGeometry(), layout = geometry.userData.grassLayout;
  const bounds = (lastBand, phase, snow, weights, actualLod) => {
    const box = new THREE.Box3();
    for (const layer of layout.layers) {
      if (layer.band > lastBand) continue;
      const detail = actualLod ? layer.band === 0 ? 1 : layer.band === 1 ? weights.mid : weights.near : 1;
      if (detail <= 0 || weights.width <= 0) continue;
      for (let i = layer.vertexStart; i < layer.vertexStart + layer.vertexCount; i++) {
        if (snow === 1 && geometry.getAttribute('aBladeParam').getW(i) !== 1) continue;
        box.expandByPoint(shapedVertex(geometry, i, { phase, snow, width: detail * weights.compensation * weights.width }));
      }
    }
    return box;
  };
  const size = new THREE.Vector3(), fullSize = new THREE.Vector3();
  for (const distance of [20, 40, 60, GRASS_COVERAGE.viewEnd - 0.01]) {
    for (const recordHeight of [0.2, 0.6, 1]) for (const focal of [450, 900]) {
      const projected = recordHeight * focal / distance;
      const weights = grassLodWeights(projected, distance);
      if (projected <= 1.1) {
        assert.equal(weights.width, 0, 'only subpixel plants can vanish before the distance limit');
        continue;
      }
      assert.ok(weights.width > 0);
      for (const phase of [0, 1.2, 2.7, 4.9, 6.2]) for (const snow of [0, 1]) {
        const full = bounds(2, phase, snow, weights, false); full.getSize(fullSize);
        for (const prefix of [0, 1, 2]) {
          const visible = bounds(prefix, phase, snow, weights, true); visible.getSize(size);
          assert.ok(visible.max.y / full.max.y >= 0.85, 'LOD may remove details, never the highest structural leaves');
          assert.ok(size.x / fullSize.x >= 0.85 && size.z / fullSize.z >= 0.85,
            'persistent low leaves must also retain the horizontal silhouette');
          if (snow === 0) assert.ok(visible.max.y >= 0.85, 'core height remains at least 85 percent of normalized template height');
        }
      }
    }
  }
  const field = new GrassField(), params = geometry.getAttribute('aBladeParam');
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  field.material.onBeforeCompile(shader);
  assert.match(shader.vertexShader, /detail = aBladeParam\.y < 0\.5 \? 1\.0/);
  for (let i = 0; i < params.count; i++) if (params.getW(i) === 1) assert.equal(params.getY(i), 0);
  field.dispose(); geometry.dispose();
});

test('persistent core joins outward-curving low leaves to a central full-height structure', () => {
  const geometry = createGrassGeometry(), positions = geometry.getAttribute('position');
  const parameters = geometry.getAttribute('aBladeParam'), bandArea = [0, 0, 0];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < geometry.index.count; i += 3) {
    const at = geometry.index.getX(i);
    a.fromBufferAttribute(positions, at);
    b.fromBufferAttribute(positions, geometry.index.getX(i + 1));
    c.fromBufferAttribute(positions, geometry.index.getX(i + 2));
    bandArea[parameters.getY(at)] += b.sub(a).cross(c.sub(a)).length() * 0.5;
  }
  const layout = geometry.userData.grassLayout, roots = geometry.getAttribute('aBladeRoot');
  const radii = [], quadrants = [0, 0, 0, 0];
  let downturned = 0;
  for (let blade = 0; blade < layout.basalBladeCount; blade++) {
    const index = layout.layers[0].basalVertexStart + blade * layout.layers[0].verticesPerBlade;
    const tip = index + layout.layers[0].verticesPerBlade - 1;
    radii.push(Math.hypot(roots.getX(index), roots.getZ(index)));
    quadrants[(roots.getX(index) >= 0 ? 1 : 0) + (roots.getZ(index) >= 0 ? 2 : 0)]++;
    assert.ok(Math.hypot(positions.getX(tip) - roots.getX(index), positions.getZ(tip) - roots.getZ(index)) > 0.07,
      'low blades must bend visibly away from their narrow rooted base');
    if (positions.getY(tip - 2) > positions.getY(tip)) downturned++;
  }
  assert.ok(Math.min(...radii) > Math.hypot(roots.getX(0), roots.getZ(0)), 'basal leaves surround the inner root cluster');
  assert.ok(Math.hypot(roots.getX(0), roots.getZ(0)) < 0.08, 'middle foliage now supplies the compact inner root cluster');
  let footprint = 0;
  for (let vertex = 0; vertex < positions.count; vertex++) if (parameters.getW(vertex) === 0) {
    footprint = Math.max(footprint, Math.hypot(positions.getX(vertex), positions.getZ(vertex)));
  }
  assert.ok(footprint > 0.49, 'broader bending leaves still cover the complete normalized tuft footprint');
  assert.ok(quadrants.every(count => count >= 2));
  assert.ok(downturned >= 3, 'some basal leaf tips must arch downward instead of all ending as upright rectangles');
  assert.ok(bandArea[0] > 0.09, 'short leaf mass must not be replaced by empty root positions');
  const far = grassLodWeights(5, 40);
  assert.equal(far.near, 0); assert.equal(far.mid, 0); assert.ok(far.width > 0);
  for (let i = 0; i < layout.prefixIndices[0]; i++) assert.equal(parameters.getY(geometry.index.getX(i)), 0,
    'both the low leaves and the six structural leaves remain in the persistent draw prefix');
  geometry.dispose();
});

test('record height and width are actual world metres on tilted ground', () => {
  const field = new GrassField({ register() {} });
  const r = { ...record('sized'), height: 1.3, width: 0.8 };
  const [mesh] = field.build([r]);
  const matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix);
  const positions = field.geometry.getAttribute('position'), point = new THREE.Vector3();
  const root = new THREE.Vector3(r.x, r.y, r.z);
  const up = new THREE.Vector3(-r.groundDx, 1, -r.groundDz).normalize();
  let maxHeight = 0, minHeight = Infinity, maxRadius = 0, localRadius = 0;
  for (let i = 0; i < positions.count; i++) {
    localRadius = Math.max(localRadius, Math.hypot(positions.getX(i), positions.getZ(i)));
    point.fromBufferAttribute(positions, i).applyMatrix4(matrix).sub(root);
    const h = point.dot(up);
    maxHeight = Math.max(maxHeight, h); minHeight = Math.min(minHeight, h);
    maxRadius = Math.max(maxRadius, point.addScaledVector(up, -h).length());
  }
  assert.ok(Math.abs(field.geometry.boundingBox.max.y - 1) < 1e-6);
  assert.equal(field.geometry.boundingBox.min.y, 0);
  assert.ok(Math.abs(localRadius * 2 - 1) < 1e-6);
  assert.ok(Math.abs(maxHeight - r.height) < 1e-6);
  assert.ok(Math.abs(minHeight) < 1e-6);
  assert.ok(Math.abs(maxRadius * 2 - r.width) < 1e-6);
  assert.equal(mesh.userData.cullerPadding, 0.16);
  field.dispose();
});

test('grass roots follow rendered two-metre cut/fill triangles instead of the analytic height', () => {
  const field = new GrassField(), triangles = [
    new THREE.Triangle(new THREE.Vector3(0, 0, -22), new THREE.Vector3(0, 1.54, -20), new THREE.Vector3(2, 0, -22)),
    new THREE.Triangle(new THREE.Vector3(3, 1.54, -22), new THREE.Vector3(3, 0, -20), new THREE.Vector3(5, 1.54, -22)),
    new THREE.Triangle(new THREE.Vector3(6, 1, -22), new THREE.Vector3(6, 1.5, -20), new THREE.Vector3(8, 2.25, -22)),
  ];
  const population = triangles.map((triangle, i) => {
    const point = triangle.a.clone().multiplyScalar(0.25).addScaledVector(triangle.b, 0.5).addScaledVector(triangle.c, 0.25);
    const normal = triangle.getNormal(new THREE.Vector3());
    return Object.freeze({ ...record(`surface-${i}`, point.x, point.z), y: [0, 1.54, 2.3][i],
      surfaceY: point.y, surfaceDx: -normal.x / normal.y, surfaceDz: -normal.z / normal.y });
  });
  const snapshot = structuredClone(population), [mesh] = field.build(population);
  const legacy = population.map(({ surfaceY, surfaceDx, surfaceDz, ...rest }) => rest), [original] = field.build(legacy);
  const matrix = new THREE.Matrix4(), point = new THREE.Vector3(), up = new THREE.Vector3();
  const positions = field.geometry.getAttribute('position'), params = field.geometry.getAttribute('aBladeParam');
  assert.equal(Math.abs(population[0].surfaceY - population[0].y), 0.77);
  assert.equal(Math.abs(population[1].surfaceY - population[1].y), 0.77);
  for (let i = 0; i < population.length; i++) {
    const r = population[i]; mesh.getMatrixAt(i, matrix);
    assert.ok(Math.abs(matrix.elements[13] - r.surfaceY) < 1e-6);
    up.setFromMatrixColumn(matrix, 1).normalize();
    assert.ok(up.distanceTo(new THREE.Vector3(-r.surfaceDx, 1, -r.surfaceDz).normalize()) < 1e-6);
    for (let vertex = 0; vertex < positions.count; vertex++) if (params.getX(vertex) === 0) {
      point.fromBufferAttribute(positions, vertex).applyMatrix4(matrix);
      const surfaceY = r.surfaceY + r.surfaceDx * (point.x - r.x) + r.surfaceDz * (point.z - r.z);
      assert.ok(Math.abs(point.y - surfaceY) < 2e-6, 'every blade root lies on the rendered triangle tangent plane');
      assert.ok(mesh.boundingSphere.containsPoint(point));
    }
  }
  assert.deepEqual(population, snapshot);
  assert.deepEqual(mesh.userData.population.ids, original.userData.population.ids);
  assert.deepEqual(mesh.geometry.getAttribute('iGrassStyle').array, original.geometry.getAttribute('iGrassStyle').array);
  assert.deepEqual(mesh.geometry.getAttribute('iGrassRoad').array, original.geometry.getAttribute('iGrassRoad').array);
  assert.equal(field.geometry.userData.grassLayout.triangleCount, 202);
  field.dispose();
});

test('surface zero values override analytic placement while missing surface fields retain legacy matrices', () => {
  const field = new GrassField(), legacy = record('legacy');
  const [before] = field.build([legacy]);
  const [fallback] = field.build([{ ...legacy, surfaceY: null, surfaceDx: undefined, surfaceDz: null }]);
  assert.deepEqual(before.instanceMatrix.array, fallback.instanceMatrix.array);
  const [surface] = field.build([{ ...legacy, surfaceY: 0, surfaceDx: 0, surfaceDz: 0 }]);
  const matrix = new THREE.Matrix4(); surface.getMatrixAt(0, matrix);
  assert.equal(matrix.elements[13], 0);
  assert.ok(new THREE.Vector3().setFromMatrixColumn(matrix, 1).normalize().distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-6);
  field.dispose();
});

test('grass distance and packed selection use the corrected surface root and restore canonical records', () => {
  const field = new GrassField(), view = camera(), culler = new InstanceCuller(), scene = new THREE.Scene();
  const boundaryRecord = { ...record('surface-boundary', 0, 0), y: 0,
    surfaceY: Math.sqrt((GRASS_COVERAGE.viewEnd + 0.006) ** 2 - (GRASS_COVERAGE.viewEnd + 0.002) ** 2),
    surfaceDx: 0, surfaceDz: 0 };
  const [boundary] = field.build([boundaryRecord]); boundary.updateMatrixWorld();
  field.update(view, 0, 'summer', 1080);
  view.position.set(0, 0, GRASS_COVERAGE.viewEnd + 0.002); view.updateMatrixWorld();
  const gpuRoot = new THREE.Vector3(), matrix = new THREE.Matrix4(); boundary.getMatrixAt(0, matrix);
  gpuRoot.setFromMatrixPosition(matrix).applyMatrix4(boundary.matrixWorld);
  assert.ok(gpuRoot.distanceTo(view.position) > GRASS_COVERAGE.viewEnd + 0.005);
  assert.equal(boundary.userData.instanceVisible(0, view), false);
  assert.equal(boundary.userData.batchVisible(view), false);
  view.position.set(0, boundaryRecord.surfaceY, GRASS_COVERAGE.viewEnd - 0.001); view.updateMatrixWorld();
  assert.equal(boundary.userData.instanceVisible(0, view), true);
  assert.equal(boundary.userData.batchVisible(view), true);

  const population = [
    { ...record('analytic-near-surface-far', 0, -20), y: 3, surfaceY: 200 },
    { ...record('analytic-far-surface-near', 0, -25), y: 200, surfaceY: 3 },
    { ...record('offscreen-surface', 1000, -20), surfaceY: 3 },
  ];
  const [mesh] = field.build(population), canonical = mesh.geometry, matrices = mesh.instanceMatrix;
  const originalMatrices = matrices.array.slice(), ids = mesh.userData.population.ids.slice();
  scene.add(mesh); view.position.set(0, 3, 0);
  culler.prepare(scene, view);
  assert.equal(mesh.count, 1);
  assert.notEqual(mesh.geometry, canonical);
  assert.equal(mesh.instanceMatrix.array[13], 3);
  assert.equal(mesh.instanceMatrix.array[14], -25);
  assert.equal(mesh.userData.instanceVisible(0, view), true);
  culler.restore();
  assert.equal(mesh.geometry, canonical);
  assert.equal(mesh.instanceMatrix, matrices);
  assert.deepEqual(mesh.instanceMatrix.array, originalMatrices);
  assert.deepEqual(mesh.userData.population.ids, ids);
  culler.dispose(); field.dispose();
});

test('shape variation is per blade, stable per instance, and keeps all root centers anchored', () => {
  const geometry = createGrassGeometry(), anchors = geometry.getAttribute('aBladeRoot');
  const rotations = [], growthRatios = [];
  for (const layer of geometry.userData.grassLayout.layers) for (let blade = 0; blade < layer.bladeCount; blade++) {
    const root = layer.vertexStart + blade * layer.verticesPerBlade, tip = root + layer.verticesPerBlade - 1;
    const anchor = new THREE.Vector3().fromBufferAttribute(anchors, root);
    const a = shapedVertex(geometry, tip, { phase: 0 }), b = shapedVertex(geometry, tip, { phase: 2.1 });
    assert.deepEqual(shapedVertex(geometry, tip, { phase: 2.1 }), b);
    const angleA = Math.atan2(a.z - anchor.z, a.x - anchor.x), angleB = Math.atan2(b.z - anchor.z, b.x - anchor.x);
    rotations.push(Math.atan2(Math.sin(angleB - angleA), Math.cos(angleB - angleA)));
    growthRatios.push(b.y / a.y);
    for (const phase of [0, 1.2, 2.7, 4.9, 6.2]) {
      for (const snow of [0, 1]) {
        const base = shapedVertex(geometry, root, { phase, snow, wind: 1 })
          .add(shapedVertex(geometry, root + 1, { phase, snow, wind: -1 })).multiplyScalar(0.5);
        assert.ok(base.distanceTo(anchor) < 1e-7, 'static phase variation cannot move leaf root centers');
      }
      for (let at = root; at < tip; at += 2) {
        assert.ok(shapedVertex(geometry, at, { phase, width: 0 }).distanceTo(shapedVertex(geometry, at + 1, { phase, width: 0 })) < 1e-10,
          'camera LOD collapse must remain degenerate after per-blade rotations');
        assert.equal(shapedVertex(geometry, at, { phase, width: 0 }).y, shapedVertex(geometry, at, { phase, width: 1.6 }).y,
          'camera width LOD cannot change the phase-shaped height');
      }
    }
  }
  const rotationSpread = Math.max(...rotations) - Math.min(...rotations);
  assert.ok(rotationSpread > 0.15 && rotationSpread < 0.9, 'per-leaf variation must retain a coherent whole-tuft leaning direction');
  const growthSpread = Math.max(...growthRatios) - Math.min(...growthRatios);
  assert.ok(growthSpread > 0.015 && growthSpread < 0.08, 'small per-leaf growth changes must not dismantle the main silhouette');
  geometry.dispose();
});

test('expanded bounds contain rotated blades, winter flattening, width compensation and wind', () => {
  const geometry = createGrassGeometry(), positions = geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) {
    for (const phase of [0, 1.2, 2.7, 4.9, 6.2]) for (const width of [0, 1, 1.6]) {
      for (const snow of [0, 0.5, 1]) for (const wind of [-1, 1]) {
        assert.ok(geometry.boundingSphere.containsPoint(shapedVertex(geometry, i, { phase, width, snow, wind })),
          'bounds must include the rotated root envelope, not just the original leaf orientation');
      }
    }
  }
  geometry.dispose();
});

test('winter buries basal and detail geometry but retains readable persistent dry shoots', () => {
  const geometry = createGrassGeometry(), params = geometry.getAttribute('aBladeParam'), areas = [0, 0, 0, 0, 0];
  for (let i = 0; i < geometry.index.count; i += 3) {
    const at = geometry.index.getX(i);
    const a = shapedVertex(geometry, at, { snow: 1, maturity: 1, seedGrowth: 1, wind: 1 });
    const b = shapedVertex(geometry, geometry.index.getX(i + 1), { snow: 1, maturity: 1, seedGrowth: 1, wind: 1 });
    const c = shapedVertex(geometry, geometry.index.getX(i + 2), { snow: 1, maturity: 1, seedGrowth: 1, wind: 1 });
    areas[params.getW(at)] += b.sub(a).cross(c.sub(a)).length() * 0.5;
  }
  assert.equal(areas[0], 0, 'buried broad basal leaves must not remain as flat snow-surface fragments');
  assert.ok(areas[1] > 0);
  assert.equal(areas[2], 0); assert.equal(areas[3], 0); assert.equal(areas[4], 0);
  const heights = [];
  for (const layer of geometry.userData.grassLayout.layers) for (let blade = 0; blade < layer.bladeCount; blade++) {
    const tip = layer.vertexStart + (blade + 1) * layer.verticesPerBlade - 1;
    if (params.getW(tip) !== 1) continue;
    assert.equal(layer.band, 0);
    const root = tip - layer.verticesPerBlade + 1;
    for (const phase of [0, 1.2, 2.7, 4.9, 6.2]) {
      const peak = Math.max(...Array.from({ length: layer.verticesPerBlade }, (_, vertex) => shapedVertex(geometry, root + vertex, { phase, snow: 1 }).y));
      heights.push(peak * 0.7);
    }
  }
  assert.equal(heights.length, 30);
  assert.ok(Math.min(...heights) >= 0.24 && Math.max(...heights) <= 0.41,
    'a representative 70 cm tuft keeps roughly 25-40 cm dry stems rather than snow-surface dots');
  geometry.dispose();
});

test('winter exposure is a stable clump patch and CPU culling removes only exact zero exposure', () => {
  const field = new GrassField(), view = camera(); view.position.y = 3; view.updateMatrixWorld();
  const clumps = [0.1, 0.4, GRASS_SNOW.exposureStart - 0.001, GRASS_SNOW.exposureStart,
    GRASS_SNOW.exposureStart + 0.00001, 0.76, GRASS_SNOW.exposureFull, 1];
  const records = clumps.map((clump, i) => ({ ...record(`snow-${i}`, i / 4, -20), clump }));
  const [mesh] = field.build(records); mesh.updateMatrixWorld();
  const matrices = mesh.instanceMatrix.array.slice(), style = mesh.geometry.getAttribute('iGrassStyle');
  const styles = style.array.slice(), ids = mesh.userData.population.ids.slice();
  field.update(view, 0, 'summer', 1080);
  for (let i = 0; i < mesh.count; i++) assert.equal(mesh.userData.instanceVisible(i, view), true);
  field.update(view, 10, 'winter', 1080);
  const version = mesh.userData.instanceVisibilityVersion;
  const expected = clumps.map((_, i) => grassWinterExposure(style.getZ(i)) > 0);
  assert.ok(expected.filter(Boolean).length < records.length);
  assert.equal(mesh.userData.instanceVisible(4, view), true, 'a tiny positive snow exposure tail must not be culled');
  for (const time of [11, 500, 99999]) {
    field.update(view, time, 'winter', 1080);
    assert.equal(mesh.userData.instanceVisibilityVersion, version);
    for (let i = 0; i < mesh.count; i++) assert.equal(mesh.userData.instanceVisible(i, view), expected[i]);
    assert.deepEqual(style.array, styles);
    assert.deepEqual(mesh.instanceMatrix.array, matrices);
    assert.deepEqual(mesh.userData.population.ids, ids);
  }
  const [buried] = field.build([{ ...record('buried'), clump: 0.4 }]); buried.updateMatrixWorld();
  assert.equal(buried.userData.batchVisible(view), false);
  assert.equal(buried.userData.instanceVisible(0, view), false);
  assert.equal(mesh.userData.batchVisible(view), true);
  field.update(view, 100000, 'autumn', 1080);
  assert.ok(mesh.userData.instanceVisibilityVersion > version);
  assert.equal(buried.userData.batchVisible(view), true);
  for (let i = 0; i < mesh.count; i++) assert.equal(mesh.userData.instanceVisible(i, view), true);
  field.dispose();
});

test('winter culler packs exposed clumps and restores all canonical plants on seasonal reentry', () => {
  const field = new GrassField(), culler = new InstanceCuller(), scene = new THREE.Scene(), view = camera();
  const records = [0.2, 0.679, 0.68001, 0.9].map((clump, i) => ({ ...record(`winter-pack-${i}`, i, -20), clump }));
  const [mesh] = field.build(records); scene.add(mesh); view.position.y = 3;
  const canonical = mesh.geometry, matrices = mesh.instanceMatrix, ids = mesh.userData.population.ids.slice();
  field.update(view, 0, 'winter', 1080);
  culler.prepare(scene, view);
  assert.equal(mesh.count, 2);
  assert.notEqual(mesh.geometry, canonical);
  assert.ok(mesh.geometry.getAttribute('iGrassStyle').getZ(0) > GRASS_SNOW.exposureStart);
  assert.equal(mesh.userData.instanceVisible(0, view), true, 'packed exposure must not read the hidden canonical first clump');
  assert.equal(mesh.userData.instanceVisible(1, view), true);
  assert.equal(mesh.instanceMatrix.array[12], records[2].x);
  culler.restore();
  const version = mesh.userData.instanceVisibilityVersion;
  field.update(view, 1, 'summer', 1080);
  assert.ok(mesh.userData.instanceVisibilityVersion > version);
  culler.prepare(scene, view);
  assert.equal(mesh.count, records.length);
  assert.equal(mesh.geometry, canonical);
  assert.equal(mesh.instanceMatrix, matrices);
  assert.deepEqual(mesh.userData.population.ids, ids);
  culler.dispose(); field.dispose();
});

test('detail and far coverage vary continuously without deleting roots or snapping height', () => {
  for (const boundary of [1.1, 3, 4, 6, 12, 15, 16, 34]) {
    const before = grassLodWeights(boundary - 1e-5, 60), after = grassLodWeights(boundary + 1e-5, 60);
    for (const key of Object.keys(before)) assert.ok(Math.abs(before[key] - after[key]) < 1e-4);
  }
  for (const boundary of [GRASS_COVERAGE.viewFadeStart, GRASS_COVERAGE.viewEnd]) {
    assert.ok(Math.abs(grassLodWeights(20, boundary - 1e-5).width - grassLodWeights(20, boundary + 1e-5).width) < 1e-6);
  }
  assert.equal(grassLodWeights(40, 10).near, 1);
  assert.equal(grassLodWeights(40, 10).mid, 1);
  assert.equal(grassLodWeights(5, 60).near, 0);
  assert.equal(grassLodWeights(5, 60).mid, 0);
  assert.ok(grassLodWeights(5, 60).width > 0);
  assert.equal(grassLodWeights(20, GRASS_COVERAGE.viewEnd).width, 0);
  assert.equal(grassLodWeights(20, 1000).width, 0);
  assert.equal(grassLodWeights(3, 30).wind, 0);
});

test('driving does not sweep the old 48-76m disappearance band through readable grass', () => {
  for (const distance of [48, 60, 76, 90]) {
    assert.equal(grassLodWeights(8, distance).width, 1, `grass at ${distance}m must already have full coverage`);
  }
  assert.ok(GRASS_COVERAGE.viewEnd - GRASS_COVERAGE.viewFadeStart >= 60,
    'the distant transition must span at least two seconds at maximum driving speed');
});

test('roadside and camera coverage multiply continuously without altering blade detail or wind', () => {
  // Continuity, not flatness: some boundaries now sit inside a smooth fade whose
  // slope is at most ~0.15 per metre, so a 2e-5 m step may move by ~3e-6.
  for (const boundary of [GRASS_COVERAGE.roadStart, GRASS_COVERAGE.roadFull, GRASS_COVERAGE.roadEndNear, GRASS_COVERAGE.roadEnd]) {
    const before = grassLodWeights(20, 60, grassRoadCoverage(boundary - 1e-5));
    const after = grassLodWeights(20, 60, grassRoadCoverage(boundary + 1e-5));
    assert.ok(Math.abs(before.width - after.width) < 1e-4);
  }
  for (const roadDistance of [0, GRASS_COVERAGE.roadStart, (GRASS_COVERAGE.roadStart + GRASS_COVERAGE.roadFull) / 2, GRASS_COVERAGE.roadFull, 16, 22, 28, Infinity]) {
    const road = grassRoadCoverage(roadDistance), weights = grassLodWeights(20, 60, road);
    const full = grassLodWeights(20, 60);
    assert.equal(weights.width, grassViewCoverage(60) * road);
    for (const key of ['near', 'mid', 'compensation', 'wind']) assert.equal(weights[key], full[key]);
  }
  assert.equal(grassLodWeights(20, 40, grassRoadCoverage(GRASS_COVERAGE.roadStart)).width, 0);
  assert.equal(grassLodWeights(20, 40, grassRoadCoverage(GRASS_COVERAGE.roadFull)).width, 1);
  assert.equal(grassLodWeights(1.1, 40, 1).width, 0);
  assert.equal(grassRoadCoverage(GRASS_COVERAGE.roadEnd, 1), 0);
  for (let distance = GRASS_COVERAGE.roadFull; distance <= GRASS_COVERAGE.roadEnd; distance += 0.1) {
    assert.ok(grassRoadCoverage(distance, 0) <= grassRoadCoverage(distance, 1), 'dense clumps extend the outer edge');
  }
});

test('road coverage is a stable scalar instance attribute with legacy fallback and finite zero handling', () => {
  const field = new GrassField(), distances = [undefined, null, Infinity, -Infinity, NaN, 0, 4.5, 5.5, 6.5, 16, 22, 27.9, 28, 30];
  const records = distances.map((roadDist, i) => ({ ...record(`road-${i}`), roadDist }));
  const [mesh] = field.build(records), road = mesh.geometry.getAttribute('iGrassRoad');
  assert.ok(road.isInstancedBufferAttribute);
  assert.equal(road.itemSize, 1);
  assert.equal(road.count, records.length);
  assert.deepEqual(road.array, Float32Array.from(distances, distance => distance == null ? 1 : grassRoadCoverage(distance)));
  assert.equal(road.getX(0), 1);
  assert.equal(road.getX(2), 0, 'infinite road distance is outside the roadside band, not a legacy fixture');
  assert.ok(road.array.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  const snapshot = road.array.slice(), matrices = mesh.instanceMatrix.array.slice();
  const view = camera(); field.update(view, 500, 'winter', 720); field.update(view, 700, 'summer', 1080);
  assert.deepEqual(road.array, snapshot);
  assert.deepEqual(mesh.instanceMatrix.array, matrices, 'coverage must not scale height or move roots');
  assert.deepEqual(mesh.userData.population.ids, records.map(record => record.id));
  field.dispose();
});

test('same population keeps exact roots, ids, style and matrices through time and season changes', () => {
  let registered = 0;
  const field = new GrassField({ register: () => registered++, sun: { intensity: 2 }, palette: {
    grassLush: [0.2, 0.4, 0.15], grassDry: [0.4, 0.4, 0.2],
  } });
  const records = [record('a'), record('b', 3, -40)];
  const [first] = field.build(records), view = camera();
  const matrices = first.instanceMatrix.array.slice(), style = first.geometry.getAttribute('iGrassStyle').array.slice();
  field.update(view, 123, 'summer', 1080);
  field.update(view, 456, 'winter', 1080);
  const [second] = field.build(records);
  assert.equal(registered, 1);
  assert.deepEqual(first.userData.population.ids, ['a', 'b']);
  assert.deepEqual(second.instanceMatrix.array, matrices);
  assert.deepEqual(second.geometry.getAttribute('iGrassStyle').array, style);
  assert.deepEqual(first.instanceMatrix.array, matrices);
  assert.equal(first.count, records.length);
  assert.equal(field.uniforms.uGrassSnow.value, 1);
  assert.equal(field.uniforms.uGrassTime.value, 456);
  for (let i = 0; i < records.length; i++) {
    assert.equal(first.instanceMatrix.array[i * 16 + 12], records[i].x);
    assert.equal(first.instanceMatrix.array[i * 16 + 13], records[i].y);
    assert.equal(first.instanceMatrix.array[i * 16 + 14], records[i].z);
  }
  assert.ok(Number.isFinite(first.boundingSphere.radius));
  assert.equal(field.material.name, 'field-grass');
  field.dispose();
});

test('meadow blade palettes remain distinct from ground albedo through updates', () => {
  const atmo = { palette: { grassLush: [0.17, 0.34, 0.09], grassDry: [0.325, 0.325, 0.14] } };
  const field = new GrassField(atmo), view = camera();
  const { uGrassLush: lush, uGrassDry: dry, uGrassTip: tip } = field.uniforms;
  const initial = [lush.value.toArray(), dry.value.toArray(), tip.value.toArray()];
  field.update(view, 0, 'summer', 1080);
  assert.deepEqual([lush.value.toArray(), dry.value.toArray(), tip.value.toArray()], initial,
    'the first frame must not overwrite the chosen meadow palette with terrain colors');
  assert.notDeepEqual(lush.value.toArray(), atmo.palette.grassLush);
  assert.notDeepEqual(dry.value.toArray(), atmo.palette.grassDry);
  assert.ok(lush.value.g / lush.value.r > 3, 'moist blades have richer green chroma than olive ground');
  assert.ok(dry.value.g / dry.value.r > 1.2, 'dry summer blades still retain a green body');
  assert.ok(tip.value.r / tip.value.g > lush.value.r / lush.value.g + 0.5,
    'tips are warmer than the rooted green body, not a uniform brightness boost');
  atmo.palette.grassLush = [1, 0, 1]; atmo.palette.grassDry = [0, 1, 1];
  field.update(view, 200, 'summer', 1080);
  assert.deepEqual([lush.value.toArray(), dry.value.toArray(), tip.value.toArray()], initial,
    'terrain palette changes cannot erase blade-versus-ground separation');
  field.dispose();
});

test('spring, autumn and winter blades use independent seasonal albedos without rebuilding material', () => {
  const field = new GrassField(), view = camera(), material = field.material;
  const { uGrassLush: lush, uGrassDry: dry, uGrassTip: tip } = field.uniforms;
  const values = [lush.value, dry.value, tip.value], summer = values.map(value => value.toArray());
  const cacheKey = material.customProgramCacheKey();
  field.update(view, 0, 'spring', 1080);
  assert.ok(lush.value.g > summer[0][1]);
  assert.ok(lush.value.g > lush.value.r * 3);
  field.update(view, 0, 'autumn', 1080);
  assert.ok(dry.value.r > dry.value.g, 'autumn dry blades become straw rather than summer green');
  assert.ok(tip.value.r > tip.value.g && tip.value.g > tip.value.b);
  assert.ok(lush.value.g > lush.value.r, 'moist autumn pockets retain their green base');
  assert.equal(field.uniforms.uGrassSnow.value, 0);
  field.update(view, 0, 'winter', 1080);
  assert.equal(field.uniforms.uGrassSnow.value, 1);
  assert.ok(lush.value.g - lush.value.r < 0.03, 'winter stalks desaturate underneath frost');
  assert.ok(tip.value.r - tip.value.b < 0.16, 'winter tips do not retain saturated autumn gold');
  for (const color of values) assert.ok(color.toArray().every(value => value > 0 && value < 0.6));
  for (const season of ['unknown', 'constructor', undefined]) {
    field.update(view, 0, season, 1080);
    assert.deepEqual(values.map(value => value.toArray()), summer);
    assert.equal(field.uniforms.uGrassSnow.value, 0);
  }
  assert.equal(field.material, material);
  assert.equal(material.customProgramCacheKey(), cacheKey);
  assert.equal(lush.value, values[0]); assert.equal(dry.value, values[1]); assert.equal(tip.value, values[2]);
  field.dispose();
});

test('grass albedo and wrap remain lit by the scene rather than self-illuminated', () => {
  const atmo = { sun: { intensity: 0 } }, field = new GrassField(atmo), view = camera();
  for (const season of ['spring', 'summer', 'autumn', 'winter']) {
    field.update(view, 0, season, 1080);
    assert.equal(field.uniforms.uGrassWrap.value, 0, 'no additive wrap is allowed without sunlight');
    assert.equal(field.material.emissive.getHex(), 0);
    assert.ok(field.material.isMeshStandardMaterial);
    assert.ok(field.material.roughness >= 0.95);
  }
  atmo.sun.intensity = 100;
  field.update(view, 0, 'summer', 1080);
  assert.equal(field.uniforms.uGrassWrap.value, 0.04, 'wrap remains bounded even with intense lighting');
  field.dispose();
});

test('grass material shares coverage uniforms and remains opaque and depth-writing', () => {
  const field = new GrassField({ register() {} });
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  field.material.onBeforeCompile(shader);
  assert.ok(shader.vertexShader.includes(GRASS_COVERAGE_GLSL), 'CPU and shader must share the same road and view thresholds');
  assert.ok(shader.vertexShader.includes(MEADOW_FIELD_GLSL), 'blades and turf must sample the same meadow patch/lodging field');
  assert.equal(shader.uniforms.uGrassSeedTint, field.uniforms.uGrassSeedTint);
  assert.equal(shader.uniforms.uGrassSeedGrowth, field.uniforms.uGrassSeedGrowth);
  assert.equal(field.material.alphaTest, 0);
  assert.equal(field.material.alphaToCoverage, false);
  assert.equal(field.material.transparent, false);
  assert.equal(field.material.depthWrite, true);
  assert.equal(field.assetPromise, undefined, 'procedural grass cannot add an asset-load dependency');
  assert.equal(shader.uniforms.uGrassFocalPixels, field.uniforms.uGrassFocalPixels);
  assert.equal(shader.uniforms.uGrassTip, field.uniforms.uGrassTip);
  field.dispose();
});

test('visibility predicate removes only fully collapsed tufts and versions viewport changes', () => {
  const field = new GrassField({ register() {} }), view = camera();
  const [mesh] = field.build([record('near', 0, -20),
    record('fading', 0, -(GRASS_COVERAGE.viewFadeStart + GRASS_COVERAGE.viewEnd) / 2),
    record('outside', 0, -GRASS_COVERAGE.viewEnd - 14)]);
  mesh.updateMatrixWorld(); view.updateMatrixWorld();
  field.update(view, 0, 'summer', 1080);
  assert.equal(mesh.userData.instanceVisible(0, view), true);
  assert.equal(mesh.userData.instanceVisible(1, view), true);
  assert.equal(mesh.userData.instanceVisible(2, view), false);
  const version = mesh.userData.instanceVisibilityVersion;
  field.update(view, 10, 'winter', 1080);
  assert.ok(mesh.userData.instanceVisibilityVersion > version, 'snow patch visibility must invalidate the culler selection');
  const winterVersion = mesh.userData.instanceVisibilityVersion;
  field.update(view, 11, 'winter', 1080);
  assert.equal(mesh.userData.instanceVisibilityVersion, winterVersion, 'time does not change the stable snow exposure mask');
  field.update(view, 10, 'winter', 720);
  assert.ok(mesh.userData.instanceVisibilityVersion > winterVersion);
  const next = mesh.userData.instanceVisibilityVersion;
  view.fov = 70; view.updateProjectionMatrix();
  field.update(view, 10, 'winter', 720);
  assert.ok(mesh.userData.instanceVisibilityVersion > next);
  field.dispose();
});

test('batch predicate rejects far and subpixel populations but retains partially visible batches', () => {
  const field = new GrassField({ register() {} }), view = camera();
  view.updateMatrixWorld(); field.update(view, 0, 'summer', 1080);
  const [near] = field.build([record('a', 0, -20), record('b', 0, -180)]);
  const [far] = field.build([record('c', 0, -GRASS_COVERAGE.viewEnd - 24), record('d', 10, -GRASS_COVERAGE.viewEnd - 44)]);
  const [tiny] = field.build([{ ...record('e', 0, -60), height: 0.05 }]);
  for (const mesh of [near, far, tiny]) mesh.updateMatrixWorld();
  assert.equal(near.userData.batchVisible(view), true);
  assert.equal(far.userData.batchVisible(view), false);
  assert.equal(tiny.userData.batchVisible(view), false);
  far.position.z = 50; far.updateMatrixWorld();
  assert.equal(far.userData.batchVisible(view), true);
  tiny.scale.set(1, 4, 1); tiny.updateMatrixWorld();
  assert.equal(tiny.userData.batchVisible(view), true);
  field.dispose();
});

test('roadside culling removes only zero road coverage and respects the conservative view-end margin', () => {
  const field = new GrassField(), view = camera();
  view.position.set(0, 3, 0); view.updateMatrixWorld();
  field.update(view, 0, 'summer', 1080);
  const [empty] = field.build([0, GRASS_COVERAGE.roadStart, GRASS_COVERAGE.roadEnd, Infinity].map((roadDist, i) => ({ ...record(`empty-${i}`), roadDist, clump: 1 })));
  const [mixed] = field.build([0, GRASS_COVERAGE.roadFull, GRASS_COVERAGE.roadEnd - 0.0001].map((roadDist, i) => ({ ...record(`mixed-${i}`), roadDist, clump: 1 })));
  empty.updateMatrixWorld(); mixed.updateMatrixWorld();
  assert.equal(empty.userData.batchVisible(view), false);
  for (let i = 0; i < empty.count; i++) assert.equal(empty.userData.instanceVisible(i, view), false);
  assert.equal(mixed.userData.batchVisible(view), true);
  assert.equal(mixed.userData.instanceVisible(0, view), false);
  assert.equal(mixed.userData.instanceVisible(1, view), true);
  assert.equal(mixed.userData.instanceVisible(2, view), true, 'positive fade-tail widths must not be threshold-culled');
  const [boundary] = field.build([{ ...record('boundary', 0, 0), roadDist: 6.5 }]);
  boundary.updateMatrixWorld();
  for (const [offset, visible] of [[-0.001, true], [0.004, true], [0.006, false]]) {
    view.position.z = GRASS_COVERAGE.viewEnd + offset; view.updateMatrixWorld();
    assert.equal(boundary.userData.batchVisible(view), visible);
    assert.equal(boundary.userData.instanceVisible(0, view), visible);
    if (!visible) assert.equal(grassViewCoverage(view.position.z), 0);
  }
  field.dispose();
});

test('packed roadside weights follow selected instance order and restore the canonical attribute', () => {
  const field = new GrassField(), culler = new InstanceCuller(), scene = new THREE.Scene(), view = camera();
  const records = [
    { ...record('zero-off-screen', 1000, -20), roadDist: 0 },
    { ...record('partial-off-screen', 1000, -25), roadDist: 5.5 },
    { ...record('partial-in-view', 0, -20), roadDist: 22 },
    { ...record('full-in-view', 2, -25), roadDist: 10 },
    { ...record('zero-in-view', 0, -30), roadDist: GRASS_COVERAGE.roadEnd },
  ];
  const [mesh] = field.build(records); scene.add(mesh);
  const canonical = mesh.geometry, road = canonical.getAttribute('iGrassRoad'), original = road.array.slice();
  view.position.set(0, 3, 0);
  culler.prepare(scene, view);
  assert.equal(mesh.count, 2);
  assert.notEqual(mesh.geometry, canonical);
  assert.deepEqual(mesh.geometry.getAttribute('iGrassRoad').array.slice(0, mesh.count), original.slice(2, 4));
  assert.equal(mesh.instanceMatrix.array[12], records[2].x);
  assert.equal(mesh.instanceMatrix.array[28], records[3].x);
  assert.equal(mesh.userData.instanceVisible(0, view), true, 'packed index zero must not read the original zero-coverage record');
  assert.equal(mesh.userData.instanceVisible(1, view), true);
  culler.restore();
  assert.equal(mesh.geometry, canonical);
  assert.equal(mesh.geometry.getAttribute('iGrassRoad'), road);
  assert.deepEqual(road.array, original);
  assert.equal(mesh.count, records.length);
  assert.equal(mesh.userData.instanceVisible(0, view), false);
  culler.dispose(); field.dispose();
});

test('grass draw prefixes omit only fully collapsed bands and restore all indices on approach', () => {
  const field = new GrassField(), view = camera();
  const r = { ...record('range', 0, 0), height: 0.7 };
  const [mesh] = field.build([r]), geometry = mesh.geometry;
  mesh.updateMatrixWorld();
  const index = geometry.index, indices = index.array.slice(), matrices = mesh.instanceMatrix.array.slice();
  const parameters = geometry.getAttribute('aBladeParam');
  const instance = new THREE.Matrix4(); mesh.getMatrixAt(0, instance);
  const actualHeight = new THREE.Vector3().setFromMatrixColumn(instance, 1).length();
  for (const [pixels, prefix] of [[4, 0], [5.98, 0], [5.995, 1], [6.01, 1], [15.98, 1], [15.995, 2], [16.01, 2], [40, 2], [4, 0], [40, 2]]) {
    view.position.set(0, r.y, r.height * field.uniforms.uGrassFocalPixels.value / pixels);
    view.updateMatrixWorld();
    mesh.onBeforeRender(null, null, view, geometry);
    assert.deepEqual(geometry.drawRange, { start: 0, count: geometry.userData.grassLayout.prefixIndices[prefix] }, `${pixels} projected pixels`);
    const weights = grassLodWeights(actualHeight * field.uniforms.uGrassFocalPixels.value / Math.max(view.position.z, 1), view.position.z);
    for (let i = geometry.drawRange.count; i < index.count; i++) {
      const band = parameters.getY(index.getX(i));
      assert.equal(band === 1 ? weights.mid : band === 2 ? weights.near : 1, 0,
        'every omitted vertex belongs to a band with exactly zero shader width');
    }
    assert.equal(geometry.index, index);
    assert.deepEqual(geometry.index.array, indices);
    assert.deepEqual(mesh.instanceMatrix.array, matrices);
    assert.equal(mesh.count, 1);
  }
  assert.deepEqual(field.geometry.drawRange, { start: 0, count: Infinity }, 'the shared template is never shortened');
  field.dispose();
});

test('draw prefixes apply to the culler-provided wrapper and survive packed and canonical reentry', () => {
  const field = new GrassField(), culler = new InstanceCuller(), scene = new THREE.Scene(), view = camera();
  const [mesh] = field.build([{ ...record('in-view', 0, -60), height: 0.3 }, { ...record('off-screen', 1000, -60), height: 0.3 }]);
  scene.add(mesh);
  const canonical = mesh.geometry, index = canonical.index;
  let packed;
  for (const [z, count] of [[0, 360], [-45, 606], [0, 360], [-45, 606]]) {
    view.position.set(0, 3, z);
    culler.prepare(scene, view);
    assert.equal(mesh.count, 1);
    assert.notEqual(mesh.geometry, canonical);
    if (packed) assert.equal(mesh.geometry, packed, 'draw-range changes must not invalidate the packed wrapper');
    packed = mesh.geometry;
    mesh.onBeforeRender(null, scene, view, packed);
    assert.deepEqual(packed.drawRange, { start: 0, count });
    assert.deepEqual(canonical.drawRange, { start: 0, count: Infinity }, 'the saved canonical wrapper is untouched');
    assert.equal(packed.index, index);
    culler.restore();
    assert.equal(mesh.geometry, canonical);
    assert.equal(mesh.count, 2);
  }
  culler.enabled = false;
  for (const [z, count] of [[0, 360], [-45, 606]]) {
    view.position.set(0, 3, z); view.updateMatrixWorld();
    culler.prepare(scene, view);
    mesh.onBeforeRender(null, scene, view, mesh.geometry);
    assert.deepEqual(canonical.drawRange, { start: 0, count });
    assert.equal(canonical.index, index);
    assert.equal(index.count, 606);
  }
  culler.dispose(); field.dispose();
});

test('tile draw-prefix bounds stay conservative for tilted blades and inherited nonuniform shear', () => {
  const field = new GrassField(), parent = new THREE.Group(), view = camera();
  const records = [
    { ...record('tilted-a', -3, -8), height: 0.35, groundDx: 0.7, groundDz: -0.4 },
    { ...record('tilted-b', 4, 6), height: 0.9, groundDx: -0.9, groundDz: 0.6 },
    { ...record('tilted-c', 1, 2), height: 0.6, groundDx: 0.2, groundDz: 0.8 },
  ];
  const [mesh] = field.build(records); parent.add(mesh);
  parent.scale.set(2.8, 0.55, 1.4); parent.rotation.set(0.3, 0.6, -0.2);
  mesh.position.set(2, -1, 3); mesh.scale.set(0.8, 1.9, 0.5); mesh.rotation.set(0.45, 0.2, 0.6);
  parent.updateMatrixWorld(true);
  const matrix = new THREE.Matrix4(), world = new THREE.Matrix4(), root = new THREE.Vector3(), up = new THREE.Vector3();
  const bounds = new THREE.Box3();
  for (let i = 0; i < records.length; i++) {
    mesh.getMatrixAt(i, matrix); world.multiplyMatrices(mesh.matrixWorld, matrix);
    bounds.expandByPoint(root.setFromMatrixPosition(world));
  }
  const center = bounds.getCenter(new THREE.Vector3()), direction = new THREE.Vector3(0.2, 0.3, 1).normalize();
  const selected = new Set(), parameters = mesh.geometry.getAttribute('aBladeParam');
  for (const distance of [8, 60, 300, 1000, 300, 8]) {
    view.position.copy(center).addScaledVector(direction, distance); view.updateMatrixWorld();
    mesh.onBeforeRender(null, null, view, mesh.geometry);
    selected.add(mesh.geometry.drawRange.count);
    for (let i = 0; i < records.length; i++) {
      mesh.getMatrixAt(i, matrix); world.multiplyMatrices(mesh.matrixWorld, matrix);
      root.setFromMatrixPosition(world); up.setFromMatrixColumn(world, 1);
      const d = root.distanceTo(view.position), pixels = up.length() * field.uniforms.uGrassFocalPixels.value / Math.max(d, 1);
      const weights = grassLodWeights(pixels, d);
      for (let j = mesh.geometry.drawRange.count; j < mesh.geometry.index.count; j++) {
        const band = parameters.getY(mesh.geometry.index.getX(j));
        assert.equal(band === 1 ? weights.mid : band === 2 ? weights.near : 1, 0,
          'a transformed tilted blade must never lose nonzero detail');
      }
    }
  }
  assert.deepEqual([...selected].sort((a, b) => a - b), [360, 480, 606]);
  assert.equal(mesh.geometry.index.count, 606);
  field.dispose();
});

test('tile mesh disposal preserves shared geometry until field disposal', () => {
  const field = new GrassField({ register() {} });
  assert.deepEqual(field.build([]), []);
  const [a] = field.build([record('a')]), [b] = field.build([record('b')]);
  const templatePosition = field.geometry.getAttribute('position');
  let templateDisposed = 0, wrapperDisposed = 0;
  field.geometry.addEventListener('dispose', () => templateDisposed++);
  a.geometry.addEventListener('dispose', () => {
    wrapperDisposed++;
    assert.equal(a.geometry.getAttribute('position'), undefined);
    assert.equal(a.geometry.index, null);
    assert.ok(a.geometry.getAttribute('iGrassStyle').isInstancedBufferAttribute);
    assert.ok(a.geometry.getAttribute('iGrassRoad').isInstancedBufferAttribute);
    assert.ok(a.geometry.getAttribute('iGrassMaturity').isInstancedBufferAttribute);
  });
  field.disposeMesh(a);
  assert.equal(wrapperDisposed, 1);
  assert.equal(templateDisposed, 0);
  assert.equal(field.meshes.size, 1);
  assert.equal(b.geometry.getAttribute('position'), templatePosition);
  field.disposeMesh(a);
  field.dispose();
  field.dispose();
  assert.equal(templateDisposed, 1);
  assert.equal(field.meshes.size, 0);
});
