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
const { Terrain } = await import('../src/terrain/terrain.js');
const { World } = await import('../src/world/world.js');
const { Scheduler } = await import('../src/streaming/scheduler.js');
const { SEASONS } = await import('../src/atmosphere/params.js');
const { TERRAIN: P } = await import('../src/terrain/params.js');
const { makeTile, parentTile, childTile } = await import('../src/terrain/coverage.js');
const { buildTerrainData } = await import('../src/terrain/mesh-data.js');
const { GRASS_COVERAGE_GLSL } = await import('../src/vegetation/grassCoverage.js');
const { MEADOW_FIELD_GLSL } = await import('../src/terrain/meadowField.js');
const { WaterSystem } = await import('../src/water/water.js');
const world = new World(7).build();

async function fixture(t) {
  const textures = new Map(), uploaded = [];
  t.mock.method(THREE.TextureLoader.prototype, 'loadAsync', async url => {
    const texture = new THREE.Texture();
    textures.set(url, texture);
    return texture;
  });
  const atmo = {
    palette: SEASONS.summer,
    renderer: { capabilities: { getMaxAnisotropy: () => 1 }, initTexture(texture) { uploaded.push(texture); } },
    register() {},
  };
  const scheduler = new Scheduler(3);
  const terrain = new Terrain(world, atmo, scheduler);
  t.after(() => terrain.dispose());
  await terrain.assetPromise;
  assert.equal(terrain.assetError, null);
  assert.equal(terrain.workerPool.available, false, 'this fixture exercises the Node fallback path');
  return { terrain, scheduler, atmo, textures, uploaded };
}

test('terrain binds the meadow turf asset separately from forest litter with repeating sRGB sampling', async t => {
  const { terrain, textures, uploaded } = await fixture(t);
  assert.deepEqual([...textures.keys()], ['/textures/meadow-turf-v1.png', '/textures/woodland-litter-v1.png']);
  assert.equal(terrain.uniforms.uGrassDetail.value, textures.get('/textures/meadow-turf-v1.png'));
  assert.equal(terrain.uniforms.uForestDetail.value, textures.get('/textures/woodland-litter-v1.png'));
  assert.deepEqual(uploaded, [...textures.values()]);
  for (const texture of textures.values()) {
    assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
    assert.equal(texture.wrapS, THREE.RepeatWrapping);
    assert.equal(texture.wrapT, THREE.RepeatWrapping);
    assert.equal(texture.anisotropy, 1);
    assert.equal(texture.generateMipmaps, true);
  }
  const png = readFileSync(new URL('../public/textures/meadow-turf-v1.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.readUInt32BE(16) > 0);
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20));
});

test('meadow root occlusion follows world-fixed turf composition without shading snow or excluded ground', async t => {
  const { terrain } = await fixture(t);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  terrain.material.onBeforeCompile(shader);
  assert.equal(shader.uniforms.uMeadowContactStrength.value, 0.26);
  assert.ok(shader.fragmentShader.includes(GRASS_COVERAGE_GLSL));
  assert.ok(shader.fragmentShader.includes(MEADOW_FIELD_GLSL), 'turf and grass models share the meadow patch/lodging field');
  const contact = shader.fragmentShader.match(/float meadowContact = [\s\S]*?;/)?.[0];
  assert.ok(contact);
  assert.match(contact, /meadowSurface \* \(1\.0 - litterWeight - mossWeight\)/);
  assert.match(contact, /0\.35 \+ 0\.65 \* understoryGrowth/);
  assert.match(contact, /\* roadTurf/);
  assert.doesNotMatch(contact, /grassRoadCoverage|grassViewCoverage|grassModelCoverage|vViewPosition|cameraPosition|Time/);
  assert.doesNotMatch(shader.fragmentShader, /grassModelCoverage/);
  assert.match(shader.fragmentShader, /1\.0 - clamp\(shore, 0\.0, 1\.0\)/);
  assert.match(shader.fragmentShader, /1\.0 - clamp\(uSnowAmount, 0\.0, 1\.0\)/);
  assert.doesNotMatch(shader.fragmentShader, /smoothstep\(65\.0, 145\.0/);
  assert.match(shader.fragmentShader, /col \*= 1\.0 - meadowContact \* uMeadowContactStrength/);
  assert.equal(terrain.chunks.size, 0, 'material contrast must not allocate or rebuild terrain');
});

test('meadow texture handoff keeps fixed world scales and protects existing surface boundaries', async t => {
  const { terrain, atmo } = await fixture(t);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  terrain.material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /vec2 uv = vWPosT\.xz/);
  assert.match(shader.fragmentShader, /vec2 detailUv = uv \* 0\.42/);
  assert.match(shader.fragmentShader, /mat2\( 0\.6, 0\.8, -0\.8, 0\.6 \) \* uv \* 0\.12/);
  assert.match(shader.fragmentShader, /texture2D\( uGrassDetail, coarseGrassUv \)/);
  assert.doesNotMatch(shader.fragmentShader, /textureHandoff/);
  assert.match(shader.fragmentShader, /float meadowTexture = meadowSurface \* roadTurf;/);
  // Summer keeps the 0.10 tuft edge; under snow it widens into a soft slush ramp.
  assert.match(shader.fragmentShader, /float tuftEdge = mix\(0\.10, 0\.40, clamp\(uSnowAmount, 0\.0, 1\.0\)\)/);
  assert.match(shader.fragmentShader, /float roadTurf = smoothstep\(-tuftEdge, tuftEdge, tuftField - mix\(-0\.25, 1\.0, verge \* verge\)\)/);
  assert.match(shader.fragmentShader, /\(1\.0 - clamp\(shore, 0\.0, 1\.0\)\) \* \(1\.0 - rk\)/);
  assert.match(shader.fragmentShader, /float coarseGrassValue = dot\(coarseGrassDetail/);
  assert.match(shader.fragmentShader, /float fineGrassValue = dot\(grassDetail/);
  assert.match(shader.fragmentShader, /vec3 meadowCol = mix\(uGrassDry, uGrassLush/);
  assert.match(shader.fragmentShader, /float snowGrain = clamp\(0\.88 \+ 0\.06 \* snowMounds/);
  assert.equal((shader.fragmentShader.match(/texture2D\( uGrassDetail,/g) || []).length, 2);
  assert.equal((shader.fragmentShader.match(/textureGrad\(uForestDetail,/g) || []).length, 2);
  for (const [name, season] of Object.entries(SEASONS)) {
    atmo.seasonName = name;
    atmo.palette = season;
    terrain.applyPalette();
    assert.deepEqual(shader.uniforms.uGrassLush.value.toArray(), season.grassLush);
    assert.deepEqual(shader.uniforms.uGrassDry.value.toArray(), season.grassDry);
    assert.equal(shader.uniforms.uSnowAmount.value, season.snowAmount);
    assert.equal(shader.uniforms.uLitterAutumn.value, name === 'autumn' ? 1 : 0);
  }
  assert.equal(terrain.chunks.size, 0, 'texture handoff must not create terrain geometry');
  assert.equal(terrain.scheduler.pending, 0, 'palette changes must not rebuild terrain');
});

test('the narrow dirt rim interlocks with world-space turf tufts instead of an extended apron', async t => {
  const { terrain } = await fixture(t);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  terrain.material.onBeforeCompile(shader);
  // Bare rim ends ~0.5 m past the pavement (half-pave 3.5 m); turf closes up within 1-2 m.
  assert.ok(P.roadScuffInner >= 4 && P.roadScuffInner < 4.5);
  assert.ok(P.roadScuffOuter - P.roadScuffInner >= 1 && P.roadScuffOuter - P.roadScuffInner <= 2);
  assert.equal(shader.uniforms.uRoadScuffInner.value, P.roadScuffInner);
  assert.equal(shader.uniforms.uRoadScuffOuter.value, P.roadScuffOuter);
  assert.match(shader.fragmentShader, /\(scuffNoise - 0\.5\) \* 1\.15 \+ \(micro - 0\.5\) \* 0\.30/);
  assert.match(shader.fragmentShader, /uRoadScuffInner \+ 0\.45, roadEdge/);
  assert.match(shader.fragmentShader, /float turfFray = smoothstep\(0\.055, 0\.20, coarseGrassValue \* 0\.65 \+ fineGrassValue \* 0\.35\)/);
  assert.match(shader.fragmentShader, /float tuftField = turfFray \* 0\.70 \+ scuffNoise \* 0\.30/);
  // The thresholded blade fray settles to its mean once blades shrink toward a
  // pixel, and snow buries it outright, so the rim never breaks into speckle.
  assert.match(shader.fragmentShader, /turfFray = mix\(turfFray, 0\.5, max\(smoothstep\(0\.03, 0\.10, uvFootprint\), clamp\(uSnowAmount, 0\.0, 1\.0\)\)\)/);
  assert.ok(shader.fragmentShader.indexOf('turfFray = mix(turfFray') < shader.fragmentShader.indexOf('float tuftField'));
  // The rim is ordinary lit albedo whose mean matches the ribbon's uEdgeGravel.
  assert.match(shader.fragmentShader, /vec3 rimSoil = mix\(uSoil \* 0\.62, uRock \* 0\.50, 0\.30\)/);
  assert.match(shader.fragmentShader, /col = mix\(col, rimSoil, 1\.0 - roadTurf\)/);
  assert.doesNotMatch(shader.fragmentShader, /uRoadScuffInner \+ 7\.5/);
  assert.equal((shader.fragmentShader.match(/texture2D\( uGrassDetail,/g) || []).length, 2, 'no extra samples');
  assert.equal(terrain.chunks.size, 0);
});

test('winter accumulation has layered coverage and shaded relief in the existing terrain material', async t => {
  const { terrain } = await fixture(t);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  terrain.material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /float snowMounds = tvn\(uv \* 0\.18/);
  assert.match(shader.fragmentShader, /float snowCrust = tvn\(mat2/);
  assert.match(shader.fragmentShader, /snowAccumulation = mix\(0\.5,/);
  assert.match(shader.fragmentShader, /snow = max\(snow, uSnowAmount \* snowShelf \* \(0\.78 \+ 0\.12 \* snowAccumulation - 0\.50 \* winterThin\)\)/);
  assert.match(shader.fragmentShader, /snowCol = mix\(packedSnow, snowCol,/);
  assert.match(shader.fragmentShader, /snow \*= 1\.0 - rk \* 0\.56/);
  assert.match(shader.fragmentShader, /snow \*= 1\.0 - \(1\.0 - roadTurf\)/);
  assert.match(shader.fragmentShader, /float terrainMicroHeight = mix\(turfMicroHeight, snowMounds \* 0\.025 \+ snowCrust \* 0\.003, snow\)/);
  assert.match(shader.fragmentShader, /smoothstep\(40\.0, 150\.0, length\(vViewPosition\)\)/);
  assert.ok(shader.fragmentShader.indexOf('vec3 terrainDx') > shader.fragmentShader.indexOf('#include <normal_fragment_maps>'));
  assert.match(shader.fragmentShader, /dFdx\(terrainMicroHeight\) \* terrainR1 \+ dFdy\(terrainMicroHeight\) \* terrainR2/);
  assert.equal((shader.fragmentShader.match(/texture2D\( uGrassDetail,/g) || []).length, 2);
  assert.equal((shader.fragmentShader.match(/textureGrad\(uForestDetail,/g) || []).length, 2);
  assert.equal(terrain.material.type, 'MeshStandardMaterial');
  assert.equal(terrain.chunks.size, 0, 'micro relief must not add terrain geometry');
});

test('terrain meshes carry the population ecology into camera-independent woodland materials', async t => {
  const { terrain } = await fixture(t);
  const tile = makeTile(terrain.version, 0, 0, 0, P.chunkSize), data = dataFor(tile);
  const mesh = terrain._mesh(data, terrain.material, tile);
  t.after(() => mesh.geometry.dispose());
  const ecology = mesh.geometry.getAttribute('aEcology');
  assert.equal(ecology.itemSize, 2);
  assert.equal(ecology.count, mesh.geometry.getAttribute('position').count);
  assert.strictEqual(ecology.array, data.ecology);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  terrain.material.onBeforeCompile(shader);
  assert.match(shader.vertexShader, /attribute vec2 aEcology/);
  assert.match(shader.vertexShader, /vEcology = aEcology/);
  assert.match(shader.fragmentShader, /varying vec2 vEcology/);
  assert.match(shader.fragmentShader, /float canopy = clamp\(vEcology\.x, 0\.0, 1\.0\)/);
  assert.match(shader.fragmentShader, /float clump = clamp\(vEcology\.y, 0\.0, 1\.0\)/);
  const forestMask = shader.fragmentShader.match(/float forestFloor = [\s\S]*?;/)?.[0];
  assert.ok(forestMask);
  assert.match(forestMask, /canopy \+ \(clump - 0\.5\)/);
  assert.doesNotMatch(forestMask, /cameraPosition|vViewPosition|grassViewCoverage|grassRoadCoverage|vRoadDist/);
  assert.doesNotMatch(shader.fragmentShader, /\* \(1\.0 - forestFloor \* 0\.86\)/);
  assert.match(shader.fragmentShader, /vec3 woodlandCol = litterDetail \* litterSeason/);
  assert.match(shader.fragmentShader, /col = col \* \(1\.0 - litterWeight - mossWeight\) \+ woodlandCol \* litterWeight \+ mossCol \* mossWeight/);
  assert.ok(shader.fragmentShader.indexOf('col *= mix(1.0, detailGrain, detailBlend)')
    < shader.fragmentShader.indexOf('col = col * (1.0 - litterWeight - mossWeight)'));
  assert.equal((shader.fragmentShader.match(/\b(?:texture2D|textureGrad)\(/g) || []).length, 5);
});

test('woodland litter RGB and local canopy transmission distinguish forest soil without globally shading terrain', async t => {
  const { terrain } = await fixture(t);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  terrain.material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /vec3 woodlandCol = litterDetail \* litterSeason \* litterPatch/);
  assert.match(shader.fragmentShader, /float litterPatch = 0\.90 \+ 0\.20 \* litterVariation/);
  assert.match(shader.fragmentShader, /float litterExposure = mix\(1\.0, winterThin, winterAmount\)/);
  assert.match(shader.fragmentShader, /woodlandCol = mix\(uSoil \* vec3\(0\.42, 0\.42, 0\.38\), woodlandCol, litterExposure\)/);
  assert.match(shader.fragmentShader, /litterWeight \* \(1\.0 - snow\) \* litterExposure/);
  assert.doesNotMatch(shader.fragmentShader, /litterChroma/);
  assert.match(shader.fragmentShader, /float canopyOcclusion = woodlandWeight/);
  assert.match(shader.fragmentShader, /reflectedLight\.directDiffuse \*= mix\(1\.0, uCanopyDirectTransmission, canopyOcclusion\)/);
  assert.match(shader.fragmentShader, /reflectedLight\.indirectDiffuse \*= mix\(1\.0, uCanopyIndirectTransmission, canopyOcclusion\)/);
  assert.ok(shader.fragmentShader.indexOf('reflectedLight.directDiffuse *=') > shader.fragmentShader.indexOf('#include <aomap_fragment>'));
  assert.ok(shader.fragmentShader.indexOf('reflectedLight.directDiffuse *=') < shader.fragmentShader.indexOf('vec3 totalDiffuse ='));
  const direct = shader.uniforms.uCanopyDirectTransmission.value;
  const indirect = shader.uniforms.uCanopyIndirectTransmission.value;
  const winter = shader.uniforms.uCanopyWinterOcclusion.value;
  assert.equal(direct, 0.44);
  assert.equal(indirect, 0.72);
  assert.equal(winter, 0.38);
  const transmission = (minimum, weight) => 1 + (minimum - 1) * weight;
  assert.equal(transmission(direct, 0), 1, 'open ground retains all direct light');
  assert.equal(transmission(indirect, 0), 1, 'open ground retains all indirect light');
  assert.ok(Math.abs(transmission(direct, winter) - 0.7872) < 1e-10);
  assert.ok(Math.abs(transmission(indirect, winter) - 0.8936) < 1e-10);
  const occlusion = shader.fragmentShader.match(/float canopyOcclusion = [\s\S]*?;/)?.[0];
  assert.doesNotMatch(occlusion, /cameraPosition|vViewPosition|distance\(/);
  assert.equal((shader.fragmentShader.match(/\b(?:texture2D|textureGrad)\(/g) || []).length, 5);
});

test('fine snow grain is independent of vegetation textures and fades below the pixel footprint', async t => {
  const { terrain } = await fixture(t);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  terrain.material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /snowGrainUv = mat2\(0\.8, -0\.6, 0\.6, 0\.8\) \* uv \* 18\.0/);
  assert.match(shader.fragmentShader, /max\(length\(dFdx\(snowGrainUv\)\), length\(dFdy\(snowGrainUv\)\)\)/);
  assert.match(shader.fragmentShader, /smoothstep\(0\.35, 1\.15, snowGrainFootprint\)/);
  const fineSnow = shader.fragmentShader.match(/float snowFine = [\s\S]*?;/)?.[0];
  assert.ok(fineSnow);
  assert.doesNotMatch(fineSnow, /texture2D|Grass|grass|litter/);
  assert.match(shader.fragmentShader, /snowCol \*= 1\.0 \+ snowFine \* 0\.055/);
  assert.match(shader.fragmentShader, /terrainMicroHeight \+= snowFine \* 0\.0006 \* snow \* surfaceReliefFade/);
  assert.equal((shader.fragmentShader.match(/\b(?:texture2D|textureGrad)\(/g) || []).length, 5);
});

test('winter suppresses turf fibers in color and normals outside shared high-clump or thin-snow patches', async t => {
  const { terrain } = await fixture(t);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  terrain.material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /float winterGrassPatch = grassWinterExposure/);
  assert.match(shader.fragmentShader, /float winterThin =/);
  assert.match(shader.fragmentShader, /turfMicroHeight \*= mix/);
  const snowGrain = shader.fragmentShader.match(/float snowGrain = [\s\S]*?;/)?.[0];
  assert.ok(snowGrain);
  assert.doesNotMatch(snowGrain, /textureValue|GrassValue|grassDetail|litterDetail/);
});

function frame(terrain, scheduler, x, z, budget = 3) {
  terrain._frame++;
  terrain.update(x, z);
  if (budget !== null) scheduler.run(budget);
  terrain.refreshCoverage();
  assert.equal(scheduler.error, null);
}

function assertDisjointRegions(terrain) {
  const regions = [...terrain.regions].sort((a, b) => a.x0 - b.x0);
  for (let i = 0; i < regions.length; i++) {
    const a = regions[i];
    assert.ok(terrain.chunks.get(a.key).mesh.visible);
    for (let j = i + 1; j < regions.length && regions[j].x0 < a.x0 + a.C; j++) {
      const b = regions[j];
      assert.ok(Math.min(a.z0 + a.C, b.z0 + b.C) <= Math.max(a.z0, b.z0),
        `overlapping rendered regions: ${a.key}, ${b.key}`);
    }
  }
  for (const [key, chunk] of terrain.chunks) {
    const mask = terrain.renderSet.get(key) || 0;
    assert.equal(chunk.mesh.visible, Boolean(mask));
    assert.equal(chunk.mask, mask);
    const expected = [];
    for (const [q, range] of chunk.mesh.userData.quadrants.entries()) {
      if (!(mask & (1 << q)) || !range.count) continue;
      const last = expected.at(-1);
      if (last && last.start + last.count === range.start) last.count += range.count;
      else expected.push({ ...range, materialIndex: 0 });
    }
    assert.deepEqual(chunk.mesh.geometry.groups, expected);
    if (mask === 15) assert.equal(chunk.mesh.geometry.groups.length, 1, 'full tiles need only one draw');
  }
}

function assertRootCoverage(terrain, roots = terrain.roots.filter(root => terrain.chunks.has(root.key))) {
  for (const root of roots) {
    assert.equal(terrain.coversBounds(root.x0, root.z0, root.x0 + root.C, root.z0 + root.C), true,
      `resident root lost coverage: ${root.key}`);
  }
  assertDisjointRegions(terrain);
}

function dataFor(tile, resolution = 2) {
  const iterator = buildTerrainData(world, tile, { resolution, skirtDepth: P.skirtDepth });
  let step;
  do { step = iterator.next(); } while (!step.done);
  return step.value;
}

function publish(terrain, tile) {
  terrain.requests.set(tile.key, tile);
  terrain._publish(tile, dataFor(tile));
}

test('publishing prepared wet and dry tiles never reruns river sampling on the main thread', async t => {
  const { terrain } = await fixture(t);
  const material = new THREE.MeshBasicMaterial();
  t.after(() => material.dispose());
  terrain.water = Object.assign(Object.create(WaterSystem.prototype), { material,
    buildGeometry() { assert.fail('prepared tiles must not sample the river again'); } });
  for (const wet of [false, true]) {
    const tile = makeTile(0, 0, wet ? 1 : 0, 0, P.chunkSize);
    const data = dataFor(tile);
    data.water = wet ? {
      positions: new Float32Array([-1, 1, -1, 1, 1, -1, -1, 1, 1]),
      colors: new Float32Array(12).fill(1), uvs: new Float32Array(6),
      indices: new Uint16Array([0, 2, 1]),
    } : null;
    terrain.requests.set(tile.key, tile);
    terrain._publish(tile, data);
    assert.equal(Boolean(terrain.chunks.get(tile.key).waterMesh), wet);
  }
  assert.equal(terrain._buildOptions(makeTile(0, 0, 0, 0)).waterResolution, P.resByLevel[0]);
  assert.equal(terrain._buildOptions(makeTile(0, 5, 0, 0)).waterResolution, undefined);
});

function useRoots(terrain, roots, wanted = roots) {
  terrain.roots = roots;
  terrain.requests = new Map(wanted.map(tile => [tile.key, tile]));
  terrain._requiredWant = new Set(wanted.map(tile => tile.key));
  terrain._selectionDirty = true;
}

test('normal-budget startup exposes complete coarse tiles before details and preserves their coverage', async (t) => {
  const { terrain, scheduler } = await fixture(t);
  terrain.update(64, 64);
  assert.equal(terrain.coverageReady, false);
  assert.equal(terrain.regions.length, 0);
  assert.ok(scheduler.pending > 0);
  let frames = 0, firstVisible = false, firstReadyPending = null;
  while (frames++ < 2500 && (!terrain.coverageReady || scheduler.pending)) {
    frame(terrain, scheduler, 64, 64);
    if (!firstVisible && terrain.renderSet.size) {
      firstVisible = true;
      assert.ok([...terrain.renderSet.keys()].every(key => terrain.chunks.get(key).tile.l === P.levels - 1));
      assert.equal(terrain.coverageReady, false, 'a single coarse tile cannot release the startup gate');
    }
    if (terrain.coverageReady && firstReadyPending === null) firstReadyPending = terrain.pending;
    assertRootCoverage(terrain);
  }
  assert.ok(frames < 2500, 'incremental startup did not finish');
  assert.ok(firstVisible);
  assert.ok(firstReadyPending > 0, 'coverage should be ready before every decorative-distance terrain tile');
  assert.equal(terrain.coverageReady, true);
  assert.equal(terrain.pending, 0);
  assert.equal(terrain.jobs.size, 0);
  assertRootCoverage(terrain, terrain.roots);
});

test('crossing x=127 to x=128 retains a coarse parent while the entering fine tile is pending', async (t) => {
  const { terrain, scheduler } = await fixture(t);
  for (let n = 0; n < 2500; n++) {
    frame(terrain, scheduler, 127, 64);
    if (!scheduler.pending) break;
  }
  assert.equal(terrain.pending, 0);
  const oldRoots = [...terrain.roots];
  const entering = makeTile(terrain.version, 0, 3, 0, P.chunkSize), parent = parentTile(entering);
  assert.equal(terrain.chunks.has(entering.key), false);
  assert.equal(terrain.chunks.has(parent.key), true);
  terrain.presented = true;
  for (let n = 0; n < 8; n++) {
    frame(terrain, scheduler, 128, 64, null);
    assert.equal(terrain.chunks.has(entering.key), false);
    assert.ok(terrain.renderSet.get(parent.key) & 2, 'the entering child must not cut its parent early');
    assert.equal(terrain.coversBounds(384, 0, 512, 128), true);
    assert.equal(terrain.coversBounds(384, 0, 512, 128, 0), false);
    assertRootCoverage(terrain, oldRoots);
  }
  assert.ok(scheduler.pending > 0);
  // A zero budget still advances one continuation; it must not expose a partial mesh.
  for (let n = 0; n < 3; n++) {
    frame(terrain, scheduler, 128, 64, 0);
    assertRootCoverage(terrain, oldRoots);
    assert.equal(terrain.coversBounds(384, 0, 512, 128), true);
  }
});

test('negative-coordinate stationary requests have complete coarse coverage without claiming fine readiness', async (t) => {
  const { terrain, scheduler } = await fixture(t);
  terrain.update(-129, -1);
  const fine = makeTile(terrain.version, 0, -2, -1, P.chunkSize);
  assert.ok(terrain.requests.has(fine.key));
  for (const root of terrain.roots) publish(terrain, root);
  terrain.refreshCoverage();
  const revision = terrain.coverageRevision;
  assert.equal(terrain.coversBounds(-225, -97, -33, 95), true);
  assert.equal(terrain.coversBounds(-225, -97, -33, 95, 0), false);
  assert.equal(terrain.coverageReady, false);
  assertRootCoverage(terrain, terrain.roots);
  for (let n = 0; n < 4; n++) frame(terrain, scheduler, -129, -1, null);
  assert.equal(terrain.coverageRevision, revision);
  assertRootCoverage(terrain, terrain.roots);
});

test('finite-level bounds reject coarse or morphing support until the exact child settles', async (t) => {
  const { terrain } = await fixture(t);
  let now = 10000;
  t.mock.method(performance, 'now', () => now);
  const root = makeTile(terrain.version, 1, -1, -1, P.chunkSize), child = childTile(root, 3);
  useRoots(terrain, [root], [root, child]);
  publish(terrain, root);
  terrain.refreshCoverage();
  assert.equal(terrain.coversBounds(-120, -120, -8, -8), true);
  assert.equal(terrain.coversBounds(-120, -120, -8, -8, 0), false);
  terrain.presented = true;
  publish(terrain, child);
  terrain.refreshCoverage();
  const entry = terrain.chunks.get(child.key);
  assert.equal(entry.settled, false);
  assert.equal(terrain.settled, false);
  assert.equal(terrain.coversBounds(-120, -120, -8, -8), true);
  assert.equal(terrain.coversBounds(-120, -120, -8, -8, 0), false);
  assert.equal(terrain.coversBounds(-120, -120, -8, -8, 1), true,
    'refinement must preserve the readiness already provided by its coarse source');
  assertRootCoverage(terrain);
  const previousRevision = terrain.coverageRevision;
  now += (P.morphSeconds + 0.001) * 1000;
  terrain.refreshCoverage();
  assert.equal(entry.settled, true);
  assert.equal(terrain.settled, true);
  assert.ok(terrain.coverageRevision > previousRevision);
  assert.equal(terrain.coversBounds(-120, -120, -8, -8, 0), true);
  assert.equal(terrain.coversBounds(-256, -256, 0, 0, 0), false);
  assert.equal(terrain.coversBounds(-256, -256, 0, 0, 1), true);
  assert.equal(terrain.coversBounds(0, 0, 0, 1), false);
  assertRootCoverage(terrain);
});

test('real mesh selection keeps orphan detail while a coarser replacement is pending', async (t) => {
  const { terrain } = await fixture(t);
  const root = makeTile(terrain.version, 2, 0, 0, P.chunkSize);
  const children = [0, 1, 2, 3].map(q => childTile(root, q));
  const grandchildren = [0, 1, 2, 3].map(q => childTile(children[2], q));
  useRoots(terrain, [root]);
  for (const tile of [children[0], children[1], children[3], ...grandchildren]) publish(terrain, tile);
  terrain.refreshCoverage();
  assert.equal(terrain.renderSet.size, 7);
  assertRootCoverage(terrain, [root]);
  publish(terrain, root);
  terrain.refreshCoverage();
  assert.deepEqual(terrain.renderSet, new Map([[root.key, 15]]));
  assertRootCoverage(terrain, [root]);
});

test('cache trimming is bounded per frame and never evicts requested or rendered support', async (t) => {
  const { terrain } = await fixture(t);
  const root = makeTile(terrain.version, P.levels - 1, 0, 0, P.chunkSize);
  const prefetch = makeTile(terrain.version, 0, 2000, 2000, P.chunkSize);
  useRoots(terrain, [root]);
  publish(terrain, root);
  publish(terrain, prefetch);
  terrain.refreshCoverage();
  for (let i = 0; i < P.cacheTiles + 6; i++) publish(terrain, makeTile(terrain.version, 0, 1000 + i, 1000, P.chunkSize));
  terrain.requests = new Map([[prefetch.key, prefetch]]);
  let disposed = 0;
  for (const chunk of terrain.chunks.values()) chunk.mesh.geometry.addEventListener('dispose', () => disposed++);
  const before = terrain.chunks.size;
  terrain._trimCache(performance.now() / 1000);
  assert.equal(before - terrain.chunks.size, 2);
  assert.equal(disposed, 2);
  for (let i = 0; i < 12; i++) terrain._trimCache(performance.now() / 1000);
  assert.ok(terrain.chunks.size <= P.cacheTiles);
  assert.ok(terrain.cachedBytes <= P.cacheBytes);
  assert.equal(terrain.chunks.has(root.key), true, 'visible support is protected even outside the new request set');
  assert.equal(terrain.chunks.has(prefetch.key), true, 'pending prefetch dependencies are pinned');
  terrain.refreshCoverage();
  assertRootCoverage(terrain, [root]);
});

test('rapid relocation cancels stale jobs and a saved continuation cannot publish into the new request set', async (t) => {
  const { terrain, scheduler } = await fixture(t);
  terrain.update(64, 64);
  const stale = scheduler.tasks[0], oldVersion = terrain.version;
  terrain.update(1e7, -1e7);
  assert.equal(terrain.requests.has(stale.key), false);
  assert.equal(scheduler.has(stale.key), false);
  assert.equal(terrain.jobs.has(stale.key), false);
  assert.equal(stale.fn(), undefined);
  assert.equal(terrain.chunks.has(stale.key), false);
  assert.equal(terrain.jobs.size, terrain.required);
  assert.equal(scheduler.pending, terrain.required);
  for (const key of terrain.jobs.keys()) assert.ok(terrain.requests.has(key));
  terrain.rebuildAll();
  assert.equal(terrain.version, oldVersion + 1);
  assert.equal(terrain.jobs.size, 0);
  assert.equal(scheduler.pending, 0);
  assert.equal(terrain.renderSet.size, 0);
  assert.equal(terrain.coverageReady, false);
});

test('season palette updates keep resident geometry and coverage intact', async (t) => {
  const { terrain, atmo } = await fixture(t);
  const root = makeTile(terrain.version, P.levels - 1, 0, 0, P.chunkSize);
  useRoots(terrain, [root]);
  publish(terrain, root);
  terrain.refreshCoverage();
  const mesh = terrain.chunks.get(root.key).mesh, version = terrain.version;
  const revision = terrain.coverageRevision;
  atmo.palette = SEASONS.winter;
  terrain.applyPalette();
  assert.equal(terrain.uniforms.uSnowAmount.value, 1);
  assert.equal(terrain.chunks.get(root.key).mesh, mesh);
  assert.equal(terrain.version, version);
  assert.equal(terrain.coverageRevision, revision);
  assertRootCoverage(terrain, [root]);
});
