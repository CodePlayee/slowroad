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
const { ROAD } = await import('../src/road/params.js');

test('road verge feathers after alpha testing without changing asphalt or geometry dimensions', () => {
  const road = new RoadMesh({ route: {} }, { register() {} }, {}, { uniforms: {} });
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  road.material.onBeforeCompile(shader);
  assert.equal(road.material.transparent, false);
  assert.equal(road.material.depthWrite, true);
  assert.equal(road.material.alphaToCoverage, true);
  assert.equal(ROAD.vergeWidth, 3.8, 'ground grading must not change with the material blend');
  assert.match(shader.fragmentShader, /diffuseColor\.a \*= vergeCoverage/);
  assert.ok(shader.fragmentShader.indexOf('diffuseColor.a *= vergeCoverage') > shader.fragmentShader.indexOf('#include <alphatest_fragment>'));
  assert.match(shader.fragmentShader, /if \(vergeCoverage <= 0\.001\) discard/);
  const shoulder = road.uniforms.uShoulderEdge.value;
  for (const noise of [0, 0.5, 1]) {
    const coverage = lat => 1 - THREE.MathUtils.smoothstep(lat + (noise - 0.5) * 0.45, shoulder + 0.02, shoulder + 0.82);
    assert.equal(coverage(ROAD.laneWidth * ROAD.lanes / 2), 1, 'asphalt remains fully opaque');
    assert.equal(coverage(ROAD.laneWidth * ROAD.lanes / 2 + 0.07), 1, 'narrow bridge deck remains intact');
    assert.equal(coverage(shoulder + ROAD.vergeWidth), 0, 'outer ribbon cannot stamp its edge over the meadow');
    assert.ok(coverage(shoulder + 0.4) > 0 && coverage(shoulder + 0.4) < 1);
  }
  road.material.dispose(); road.fenceMaterial.dispose();
});

test('verge iteration leaves asphalt, paint and winter road clearance unchanged', () => {
  const road = new RoadMesh({ route: {} }, { register() {} }, {}, { uniforms: {} });
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  road.material.onBeforeCompile(shader);
  assert.doesNotMatch(shader.fragmentShader, /roadSnowCover|roadSurfaceNormal|clearedTrack/);
  assert.match(shader.fragmentShader, /col = mix\( col, uPaint, paint \)/);
  road.material.dispose(); road.fenceMaterial.dispose();
});
