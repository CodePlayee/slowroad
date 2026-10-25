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
const { RoadMesh, RIBBON_STATIONS } = await import('../src/road/roadmesh.js');
const { ROAD } = await import('../src/road/params.js');
const { SEASONS } = await import('../src/atmosphere/params.js');

// The ribbon used to feather a 0.8 m verge through alpha-to-coverage. A2C quantises
// coverage to the MSAA sample count, so that wide ramp rendered as 3-5 stepped
// translucent bands over the terrain. The ribbon now ends at a crumbled asphalt
// lip whose coverage ramps over one pixel footprint; the terrain draws the rim.
test('road ribbon ends at a crumbled asphalt lip antialiased over one pixel, without changing grading', () => {
  const road = new RoadMesh({ route: {} }, { register() {} }, {}, { uniforms: {} });
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  road.material.onBeforeCompile(shader);
  assert.equal(road.material.transparent, false);
  assert.equal(road.material.depthWrite, true);
  assert.equal(road.material.alphaToCoverage, true);
  assert.equal(ROAD.vergeWidth, 3.8, 'ground grading must not change with the material blend');
  assert.equal(ROAD.shoulderWidth, 0.58, 'ground grading must not change with the material blend');
  assert.equal(RIBBON_STATIONS, 7, 'pavement + shoulder stations only; the verge is terrain-owned');
  assert.doesNotMatch(shader.fragmentShader, /vergeCoverage|uShoulderEdge|uVerge/);
  assert.match(shader.fragmentShader, /float paveEdge = uHalfPave \+ 0\.08 \+ 0\.14 \* edgeBreak/);
  assert.match(shader.fragmentShader, /paveCoverage = clamp\(edgeDist \/ max\(fwidth\(edgeDist\), 0\.0001\) \+ 0\.5, 0\.0, 1\.0\)/);
  assert.ok(shader.fragmentShader.indexOf('diffuseColor.a *= paveCoverage') > shader.fragmentShader.indexOf('#include <alphatest_fragment>'));
  assert.match(shader.fragmentShader, /if \(paveCoverage <= 0\.001\) discard/);
  const halfPave = ROAD.laneWidth * ROAD.lanes / 2;
  for (const noise of [0, 0.5, 1]) for (const pixel of [0.005, 0.03, 0.12]) {
    const coverage = lat => THREE.MathUtils.clamp((halfPave + 0.08 + 0.14 * noise - lat) / pixel + 0.5, 0, 1);
    assert.equal(coverage(halfPave - 0.5), 1, 'asphalt remains fully opaque');
    assert.equal(coverage(halfPave + 0.05 - pixel), 1, 'narrow bridge deck remains intact');
    assert.equal(coverage(halfPave + ROAD.shoulderWidth), 0, 'the shoulder vertex row is terrain rim, not ribbon');
    const edge = halfPave + 0.08 + 0.14 * noise;
    assert.ok(coverage(edge - pixel / 2) > 1 - 1e-9);
    assert.ok(coverage(edge + pixel / 2) < 1e-9, 'no partial coverage wider than one pixel');
  }
  road.material.dispose(); road.fenceMaterial.dispose();
});

test('lip gravel follows the season palette with the same formula as the terrain rim', () => {
  const soil = new THREE.Color(0.30, 0.24, 0.16);
  const road = new RoadMesh({ route: {} }, { register() {}, palette: SEASONS.summer }, {},
    { uniforms: { uSoil: { value: soil } } });
  for (const season of Object.values(SEASONS)) {
    road.atmo.palette = season;
    road.applyPalette();
    const gravel = road.uniforms.uEdgeGravel.value;
    const expected = [soil.r, soil.g, soil.b].map((s, i) => THREE.MathUtils.lerp(s * 0.62, season.rock[i] * 0.50, 0.30));
    assert.deepEqual([gravel.r, gravel.g, gravel.b].map(v => +v.toFixed(6)), expected.map(v => +v.toFixed(6)));
  }
  road.material.dispose(); road.fenceMaterial.dispose();
});

// Winter tarmac used to stay completely bare, which read as a summer road pasted
// into snow. Packed snow now lies between/outside the wheel paths and over the
// markings, while the two polished tracks per lane stay clear and wet.
test('asphalt carries wheel paths, and winter snow lies between them after the markings', () => {
  const road = new RoadMesh({ route: {} }, { register() {} }, {}, { uniforms: {} });
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  road.material.onBeforeCompile(shader);
  const fs = shader.fragmentShader;
  assert.match(fs, /float laneLat = abs\( lat - 1\.75 \)/);
  assert.match(fs, /wheelTrack = exp\( -pow\( \( laneLat - 0\.80 \) \* 3\.6, 2\.0 \) \)/);
  assert.match(fs, /aggFootprint = length\( fwidth\( aggUv \) \)/, 'aggregate fades by pixel footprint');
  assert.match(fs, /laneSnow = uSnowAmount \* \( 1\.0 - smoothstep\( 0\.10, 0\.55, wheelTrack \) \)/);
  assert.match(fs, /col = mix\( col, uPaint, paint \)/);
  assert.ok(fs.indexOf('laneSnow * 0.85') > fs.indexOf('col = mix( col, uPaint, paint )'), 'snow partly buries markings');
  // Road-space noise stretched 14:1 along the lane projected into long fan streaks;
  // the breakup is now world-space, isotropic and footprint-faded.
  assert.doesNotMatch(fs, /snowStreak|sAlong \* 0\.18/);
  assert.match(fs, /float snowPatch = rvnAA\( rot \* ru \* 1\.3/);
  assert.match(fs, /float rvnAA\( vec2 p \)[\s\S]*?smoothstep\( 0\.35, 1\.10, length\( fwidth\( p \) \) \)/);
  // fract(p * 443.897) loses its fractional bits kilometres from the origin.
  assert.match(fs, /float rhash\( vec2 p \) \{ return surfaceHash\( p \); \}/);
  assert.doesNotMatch(fs, /443\.897/);
  // Track centres sit 0.95 m and 2.55 m from the centreline (lane centre 1.75 m ± 0.80 m).
  const track = lat => Math.exp(-(((Math.abs(lat - 1.75) - 0.80) * 3.6) ** 2));
  assert.equal(track(0.95), 1); assert.equal(track(2.55), 1);
  assert.ok(track(1.75) < 0.01 && track(0) < 0.01, 'lane centre and crown are outside the tracks');
  road.material.dispose(); road.fenceMaterial.dispose();
});
