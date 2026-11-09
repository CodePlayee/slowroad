#!/usr/bin/env node
// gauntlet/rigcheck.mjs — exercise every documented window.__rig method and print a
// pass/fail table. Run this after ANY change to src/rig/rig.js or src/main.js.
//
//   node gauntlet/rigcheck.mjs [--browser ours] [--port 9223] [--query "seed=7&t=12"]
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { plantVariantQuery } from './plant-variant.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const browserName = flag('browser', 'ours');
const port = Number(flag('port', browserName === 'ours' ? 9223 : 9300 + (browserName.length % 50)));
const query = plantVariantQuery(flag('query', 'seed=7&t=12&season=summer&cam=chase&km=6&paused=1'));
const screenshotsDir = flag('screenshots-dir', null);
const baseUrl = process.env.GAUNTLET_URL || 'http://localhost:5188';

execFileSync(process.execPath, [path.join(HERE, 'browser.mjs'), 'up', browserName, '--port', String(port)], { stdio: 'pipe' });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
const ctx = browser.contexts()[0] || (await browser.newContext());
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
await page.setViewportSize({ width: 1920, height: 1080 });
await page.goto(`${baseUrl}/?${query}`, { timeout: 20000, waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async () => {
  const rows = [];
  const t0 = Date.now();
  while (!window.__rig && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 50));
  const r = window.__rig;
  if (!r) return [{ name: 'window.__rig', ok: false, note: 'never appeared' }];
  const check = async (name, fn, verify) => {
    const s = performance.now();
    try {
      const v = await fn();
      const bad = verify ? verify(v) : null;
      rows.push({ name, ok: !bad, ms: Math.round(performance.now() - s), note: bad || '', value: v });
    } catch (e) {
      rows.push({ name, ok: false, ms: Math.round(performance.now() - s), note: 'THREW: ' + (e.message || e) });
    }
  };

  rows.push({ name: 'rig.version', ok: r.version >= 1, value: r.version });
  for (const m of ['ready', 'set', 'teleport', 'hideUI', 'showUI', 'stats', 'findBridge', 'findWater', 'findVista', 'pause', 'resume', 'snap']) {
    rows.push({ name: 'has ' + m, ok: typeof r[m] === 'function', note: typeof r[m] });
  }

  await check('pause()', () => r.pause(), (v) => (v === true && window.__app.paused ? null : 'did not set paused'));
  await check('snap()', () => r.snap(), (v) => (v === true ? null : 'falsy'));
  await check('ready()', () => r.ready({ timeoutMs: 120000 }),
    (v) => (v && v.ok && v.pending === 0 ? null : 'not resident: ' + JSON.stringify(v)));

  await check('Model Y asset and fit', () => {
    const vehicle = __app.vehicle, asset = vehicle.asset;
    if (!asset) return { error: vehicle.assetError || 'missing vehicle asset' };
    asset.updateWorldMatrix(true, true);
    const inverse = vehicle.group.matrixWorld.clone().invert();
    const box = __app.instanceCulling._box.clone().makeEmpty();
    const point = vehicle.pos.clone(), transform = inverse.clone();
    let meshes = 0, cabin = 0;
    asset.traverse(mesh => {
      if (!mesh.isMesh) return;
      meshes++; if (mesh.userData.interior) cabin++;
      if (mesh.userData.contactShadow) return;
      transform.multiplyMatrices(inverse, mesh.matrixWorld);
      const position = mesh.geometry.attributes.position;
      for (let i = 0; i < position.count; i++) box.expandByPoint(point.fromBufferAttribute(position, i).applyMatrix4(transform));
    });
    return { ready: vehicle.assetReady, error: vehicle.assetError, name: asset.name, meshes, cabin,
      size: box.getSize(vehicle.pos.clone()).toArray(), ground: box.min.y + 0.145 };
  }, v => v.ready && !v.error && v.name === 'tesla-model-y-2025-awd' && v.meshes === 32 && v.cabin > 0 &&
    Math.abs(v.size[2] - 4.79) < 0.01 && v.size[0] > 2 && v.size[0] < 2.3 &&
    v.size[1] > 1.5 && v.size[1] < 1.8 && Math.abs(v.ground - 0.04) < 0.015 ? null : JSON.stringify(v));

  await check('sky IBL stays cached during frames', async () => {
    const vehicle = __app.vehicle, env = vehicle.assetEnvironment;
    const before = env.bakes;
    await r.ready({ frames: 4 });
    return { before, after: env.bakes, name: env.texture.name,
      width: env.target.width, height: env.target.height,
      bound: vehicle.assetMaterials.every(material => material.envMap === env.texture),
      shadowPlanes: vehicle.asset.children.filter(mesh => mesh.material?.name === 'M_ExtCarShadow').length };
  }, v => v.before === v.after && v.name === 'vehicle-sky-ground-pmrem' && v.bound &&
    v.width === 384 && v.height === 512 && v.shadowPlanes === 0 ? null : JSON.stringify(v));

  await check('wheel rolling follows autodrive', async () => {
    const v = __app.vehicle;
    const pose = () => JSON.stringify(v.assetWheels.map(wheel => [wheel.quaternion.toArray(), wheel.rollGroup.quaternion.toArray()]));
    const start = v.s, before = pose();
    r.resume();
    for (let i = 0; i < 8; i++) await __app.nextFrame();
    r.pause();
    const moving = pose(), travelled = v.s - start;
    const rolling = v.assetWheels.every(wheel => {
      const expected = ((v.s - v.route.kmToS(0)) / wheel.userData.radius) % (2 * Math.PI);
      return Math.abs(wheel.rollGroup.rotation.x - expected) < 1e-9;
    });
    const steering = v.assetWheels.every(wheel => wheel.userData.front
      ? Math.abs(v.curv) < 1e-8 || Math.sign(wheel.rotation.y) === -Math.sign(v.curv)
      : wheel.rotation.y === 0);
    await __app.nextFrame(); await __app.nextFrame();
    const held = pose() === moving;
    r.snap(); await r.ready();
    return { wheels: v.assetWheels.length, travelled, moving: moving !== before, rolling, steering, held, restored: pose() === before };
  }, v => v.wheels === 4 && v.travelled > 0 && v.moving && v.rolling && v.steering && v.held && v.restored ? null : JSON.stringify(v));

  await check('road contact shadow GPU pixels', () => {
    const app = __app, renderer = app.renderer, gl = renderer.getContext();
    const width = renderer.domElement.width, height = renderer.domElement.height;
    const before = new Uint8Array(width * height * 4), shaded = new Uint8Array(before.length);
    const group = app.vehicle.group, asset = app.vehicle.asset, visible = asset.visible, quaternion = group.quaternion.clone();
    const opacity = app.road.uniforms.uVehicleShadowOpacity, savedOpacity = opacity.value;
    const render = pixels => {
      try {
        app.instanceCulling.prepare(app.veg.group, app.cameras.camera);
        renderer.render(app.scene, app.cameras.camera);
        if (pixels) gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      } finally { app.instanceCulling.restore(); }
    };
    try {
      asset.visible = false;
      opacity.value = 0; render(before);
      opacity.value = 1; render(shaded);
      let darkened = 0, lightened = 0;
      const levels = new Set();
      for (let i = 0; i < before.length; i += 4) {
        const delta = before[i] + before[i + 1] + before[i + 2] - shaded[i] - shaded[i + 1] - shaded[i + 2];
        if (delta > 3) { darkened++; levels.add(delta); }
        if (delta < -3) lightened++;
      }
      group.rotateX(0.2); group.rotateZ(0.2); render(before);
      let rollChanged = 0;
      for (let i = 0; i < before.length; i++) if (Math.abs(before[i] - shaded[i]) > 1) rollChanged++;
      return { darkened, lightened, levels: levels.size, rollChanged, pixels: width * height,
        shadowMaps: renderer.shadowMap.enabled };
    } finally {
      opacity.value = savedOpacity; asset.visible = visible; group.quaternion.copy(quaternion); render();
    }
  }, v => v.darkened > 100 && v.darkened < v.pixels * 0.05 && v.lightened === 0 &&
    v.levels > 8 && v.rollChanged === 0 && !v.shadowMaps ? null : JSON.stringify(v));

  await check('stats()', () => r.stats(), (v) => {
    for (const k of ['fps', 'drawCalls', 'triangles', 'km', 'cam', 'seed', 't', 'season', 'weather', 'residency'])
      if (v[k] === undefined) return 'missing key ' + k;
    return v.triangles > 1000 ? null : 'suspiciously few triangles';
  });

  await check('reject inherited settings', async () => {
    const app = window.__app;
    const before = [app.atmo.seasonName, app.atmo.weatherName, app.veg.version, app.terrain.version];
    await r.set({ season: 'constructor', weather: '__proto__' });
    return JSON.stringify(before) === JSON.stringify([app.atmo.seasonName, app.atmo.weatherName, app.veg.version, app.terrain.version]) && !r.error();
  }, v => v ? null : 'invalid enums changed the scene or rebuilt geometry');

  await check('paused day/night lights', async () => {
    const app = window.__app;
    const before = [app.vehicle.s, app.vehicle.speed];
    const time = app.atmo.time;
    await r.set({ t: 0 });
    const night = app.vehicle.headlight.intensity;
    await r.set({ t: 12 });
    const day = app.vehicle.headlight.intensity;
    await r.set({ t: time });
    return { night, day, stationary: before[0] === app.vehicle.s && before[1] === app.vehicle.speed };
  }, v => v.night === 55 && v.day === 0 && v.stationary ? null : JSON.stringify(v));

  const populationIds = mesh => Array.isArray(mesh.userData.population)
    ? mesh.userData.population.map(record => record.id) : mesh.userData.population?.ids || [];
  const populationSnapshot = () => JSON.stringify([...window.__app.veg.tiles]
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, entry.records.map(record => record.id)]));
  const forestPopulationContract = () => {
    const veg = window.__app.veg;
    let groups = 0, records = 0, instances = 0, valid = true;
    for (const entry of veg.tiles.values()) {
      if (entry.job.kind !== 'tree' && entry.job.kind !== 'shrub') continue;
      records += entry.records.length;
      const templates = new Map();
      for (const mesh of entry.meshes) {
        if (mesh.userData.field !== 'forest') continue;
        const name = mesh.material.userData.foliageTemplate.name;
        if (!templates.has(name)) templates.set(name, {});
        templates.get(name)[mesh.material.userData.foliagePart] = mesh;
      }
      const represented = new Set();
      for (const parts of templates.values()) {
        groups++;
        const { bark, leaf, impostor } = parts;
        if (!bark || !leaf || !impostor) { valid = false; continue; }
        const ids = populationIds(bark), matrices = bark.instanceMatrix.array;
        instances += ids.length;
        valid &&= bark.count === ids.length && bark.userData.foliageLevel === 'near' && impostor.userData.foliageLevel === 'far';
        for (const mesh of [leaf, impostor]) {
          valid &&= mesh.count === bark.count && JSON.stringify(populationIds(mesh)) === JSON.stringify(ids) &&
            mesh.instanceMatrix.array.length === matrices.length && mesh.instanceMatrix.array.every((value, i) => value === matrices[i]);
        }
        valid &&= bark.geometry.getAttribute('position') === bark.material.userData.foliageTemplate.parts.bark.getAttribute('position') &&
          leaf.geometry.getAttribute('position') === leaf.material.userData.foliageTemplate.parts.leaf.getAttribute('position');
        bark.userData.population.forEach((record, i) => {
          if (represented.has(record.id)) valid = false;
          represented.add(record.id);
          valid &&= matrices[i * 16 + 12] === Math.fround(record.x) && matrices[i * 16 + 13] === Math.fround(record.y) &&
            matrices[i * 16 + 14] === Math.fround(record.z);
        });
        valid &&= matrices.every(Number.isFinite);
      }
      valid &&= represented.size === entry.records.length && entry.records.every(record => represented.has(record.id));
    }
    return { groups, records, instances, valid };
  };

  if (window.__app.veg.generation === 2) {
    await check('V2 assets and unique population', () => {
      const veg = window.__app.veg, ids = [], counts = { grass: 0, pasture: 0, shrub: 0, tree: 0 };
      let valid = true;
      for (const [key, entry] of veg.tiles) {
        valid &&= key === entry.job.key && key.startsWith(`veg:${veg.version}:`);
        for (const record of entry.records) {
          ids.push(record.id); counts[entry.job.kind]++;
          valid &&= typeof record.id === 'string' && [record.x, record.y, record.z, record.height, record.width, record.phase].every(Number.isFinite);
        }
      }
      return { ready: veg.assetReady && !veg.assetError && !!veg.forest.assets && !!veg.flowers.geometry,
        unique: new Set(ids).size === ids.length, counts, valid };
    }, value => value.ready && value.unique && value.valid && ['grass', 'shrub', 'tree'].every(kind => value.counts[kind] > 0)
      && Object.values(value.counts).every(count => Number.isSafeInteger(count) && count >= 0) ? null : JSON.stringify(value));

    await check('V2 same-source near/far trees', forestPopulationContract,
      value => value.valid && value.groups > 0 && value.records > 0 && value.records === value.instances ? null : JSON.stringify(value));

    await check('V2 foliage coverage mipmaps', async () => {
      const { foliageCoverageContract } = await import('/gauntlet/foliage-coverage-contract.mjs');
      const templates = [...window.__app.veg.forest.assets.templates.values()];
      return foliageCoverageContract(templates);
    }, value => value.ok ? null : JSON.stringify(value));

    await check('six tree species present', async () => {
      const { TREE_SPECIES_NAMES } = await import('/src/vegetation/treeSpecies.js');
      const counts = Object.fromEntries(TREE_SPECIES_NAMES.map(name => [name, 0]));
      for (const entry of __app.veg.tiles.values()) if (entry.job.kind === 'tree') {
        for (const record of entry.records) counts[record.species]++;
      }
      return counts;
    }, counts => Object.keys(counts).length === 6 && Object.values(counts).every(value => value > 0) ? null : JSON.stringify(counts));

    // The previous full-density fixture had 164,683 trees. Bound both sides so
    // this catches accidental canopy removal AND a return to the old density.
    await check('reduced roadside tree budget', () => {
      const { x, z } = __app.vehicle.pos;
      let trees = 0, closeTrees = 0;
      for (const entry of __app.veg.tiles.values()) if (entry.job.kind === 'tree') {
        trees += entry.records.length;
        closeTrees += entry.records.filter(record => Math.hypot(record.x - x, record.z - z) < 150).length;
      }
      return { trees, closeTrees };
    }, result => result.trees >= 60000 && result.trees <= 100000 && result.closeTrees >= 250 ? null : JSON.stringify(result));

    await check('V2 metre-based continuous grass', async () => {
      const { grassLodWeights } = await import('/src/vegetation/grassField.js');
      const { GRASS_COVERAGE } = await import('/src/vegetation/grassCoverage.js');
      const field = window.__app.veg.grass, geometry = field.geometry;
      const p = geometry.getAttribute('position'), center = geometry.getAttribute('aBladeCenter');
      const normal = geometry.getAttribute('normal'), param = geometry.getAttribute('aBladeParam');
      let radius = 0, roots = 0, finite = true;
      for (let i = 0; i < p.count; i++) {
        radius = Math.max(radius, Math.hypot(p.getX(i), p.getZ(i)));
        finite &&= [p.getX(i), p.getY(i), p.getZ(i), normal.getX(i), normal.getY(i), normal.getZ(i)].every(Number.isFinite) &&
          Math.abs(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)) - 1) < 2e-3 && p.getY(i) === center.getY(i);
        if (param.getX(i) === 0 && p.getY(i) === 0) roots++;
      }
      let continuous = true;
      for (const boundary of [1.1, 3, 4, 6, 12, 15, 16, 34]) {
        const before = grassLodWeights(boundary - 1e-5, 80), after = grassLodWeights(boundary + 1e-5, 80);
        continuous &&= Object.keys(before).every(key => Math.abs(before[key] - after[key]) < 1e-4);
      }
      const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <color_vertex>\n#include <begin_vertex>',
        fragmentShader: '#include <common>\n#include <alphatest_fragment>\n#include <normal_fragment_begin>\n#include <opaque_fragment>' };
      field.material.onBeforeCompile(shader, window.__app.renderer);
      let checks = 0, violations = 0, batches = 0;
      for (const entry of window.__app.veg.tiles.values()) if (entry.job.kind === 'grass') {
        batches += entry.meshes.filter(mesh => mesh.userData.field === 'grass').length;
        for (const record of entry.records) {
          if (checks++ >= 512) break;
          const road = window.__app.world.route.nearest(record.x, record.z, 5.5);
          if (road && road.dist < GRASS_COVERAGE.roadStart - 1e-6) violations++;
        }
        if (checks >= 512) break;
      }
      const layout = geometry.userData.grassLayout;
      return { finite, roots, vertices: p.count, triangles: geometry.index.count / 3, batches, violations,
        panicle: layout.bladeCount === 36 && layout.seedStemCount === 1 && layout.seedHead.spikeletCount === 7,
        unit: Math.abs(geometry.boundingBox.max.y - 1) < 1e-5 && Math.abs(radius * 2 - 1) < 1e-5,
        continuous, widthOnly: shader.vertexShader.includes('aBladeCenter + (transformed - aBladeCenter)') && !/fract\s*\(/.test(shader.vertexShader) };
    }, value => value.finite && value.unit && value.roots === 74 && value.vertices === 290 && value.panicle && value.triangles === 202 && value.batches > 0 &&
      value.violations === 0 && value.continuous && value.widthOnly ? null : JSON.stringify(value));

    await check('V2 flower asset instancing', () => {
      const field = window.__app.veg.flowers, meshes = [...field.meshes];
      return { loaded: !!field.geometry && !field.assetError, batches: meshes.length,
        valid: meshes.every(mesh => mesh.isInstancedMesh && mesh.instanceColor &&
          mesh.material.vertexColors === Boolean(mesh.geometry.getAttribute('color')) &&
          mesh.material.color.getHex() === 0xffffff && mesh.geometry.getAttribute('normal') &&
          Number.isFinite(mesh.boundingSphere.radius) && populationIds(mesh).length === mesh.count) };
    }, value => value.loaded && value.valid && value.batches > 0 ? null : JSON.stringify(value));

    await check('V2 winter preserves population', async () => {
      const { isEvergreenSpecies } = await import('/src/vegetation/treeSpecies.js');
      const veg = window.__app.veg, season = veg.seasonName, version = veg.version;
      const before = populationSnapshot();
      const meshes = [...veg.tiles.values()].flatMap(entry => entry.meshes);
      const parents = meshes.map(mesh => mesh.parent);
      await r.set({ season: 'winter' });
      const flowerMeshes = meshes.filter(mesh => mesh.userData.field === 'flowers');
      const bareTemplates = [...veg.forest.assets.templates.values()].filter(template => !isEvergreenSpecies(template.species));
      const winter = veg.flowers.uniforms.uFlowerSeason.value === 0 && flowerMeshes.every(mesh =>
        !mesh.userData.batchVisible(window.__app.cameras.camera)) && veg.forest.uniforms.uFoliageBare.value === 1 &&
        veg.forest.uniforms.uFoliageSnow.value >= 0.5 && bareTemplates.every(template =>
          veg.forest.materials.get(template.name).impostor.map === template.bareImpostor.texture);
      const stable = veg.version === version && populationSnapshot() === before && meshes.every((mesh, i) => {
        if (mesh.parent !== parents[i]) return false;
        let parent = mesh.parent;
        while (parent && parent !== veg.group) parent = parent.parent;
        return parent === veg.group;
      });
      await r.set({ season });
      return { winter, stable, restored: veg.version === version && populationSnapshot() === before };
    }, value => value.winter && value.stable && value.restored ? null : JSON.stringify(value));

    await check('grass LOD GPU pixel parity', () => {
      const app = __app, renderer = app.renderer, field = app.veg.grass;
      const camera = app.cameras.camera.clone(), origin = camera.position.clone();
      const gl = renderer.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
      const reference = new Uint8Array(width * height * 4), optimized = new Uint8Array(reference.length);
      const saved = [...field.meshes].map(mesh => ({ mesh, hook: mesh.onBeforeRender, range: { ...mesh.geometry.drawRange } }));
      const render = pixels => {
        try {
          app.instanceCulling.prepare(app.veg.group, camera);
          renderer.render(app.scene, camera);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          return renderer.info.render.triangles;
        } finally { app.instanceCulling.restore(); }
      };
      const rows = [];
      try {
        // Keep the scene and uniforms frozen while exercising changing LOD ranges.
        for (const offset of [0, 40, 160, 0]) {
          camera.position.copy(origin); camera.position.x += offset;
          for (const { mesh } of saved) mesh.onBeforeRender = (_r, _s, _c, geometry) => geometry.setDrawRange(0, Infinity);
          const fullTriangles = render(reference);
          for (const { mesh, hook } of saved) mesh.onBeforeRender = hook;
          const prefixTriangles = render(optimized);
          let different = 0;
          for (let i = 0; i < reference.length; i++) if (reference[i] !== optimized[i]) different++;
          rows.push({ offset, different, fullTriangles, prefixTriangles });
        }
      } finally {
        for (const { mesh, hook, range } of saved) {
          mesh.onBeforeRender = hook; mesh.geometry.setDrawRange(range.start, range.count);
        }
      }
      return rows;
    }, rows => rows.every(row => row.different === 0 && row.prefixTriangles <= row.fullTriangles) &&
      rows.some(row => row.prefixTriangles < row.fullTriangles) ? null : JSON.stringify(rows));

    await check('V2 culler restores canonical state', async () => {
      const app = window.__app, ids = populationSnapshot();
      const saved = [...app.veg.tiles.values()].flatMap(entry => entry.meshes).map(mesh => ({ mesh,
        geometry: mesh.geometry, matrix: mesh.instanceMatrix, color: mesh.instanceColor,
        count: mesh.count, visible: mesh.visible, ids: JSON.stringify(populationIds(mesh)),
        values: mesh.instanceMatrix.array.slice(),
        attributes: Object.entries(mesh.geometry.attributes).filter(([, attribute]) => attribute.isInstancedBufferAttribute)
          .map(([name, attribute]) => ({ name, attribute, values: attribute.array.slice() })),
      }));
      await app.nextFrame(); await app.nextFrame();
      return populationSnapshot() === ids && saved.every(({ mesh, geometry, matrix, color, count, visible, ids: meshIds, values, attributes }) =>
        mesh.geometry === geometry && mesh.instanceMatrix === matrix && mesh.instanceColor === color && mesh.count === count &&
        mesh.visible === visible && JSON.stringify(populationIds(mesh)) === meshIds && matrix.array.every((value, i) => value === values[i]) &&
        attributes.every(({ name, attribute, values: array }) => mesh.geometry.getAttribute(name) === attribute &&
          attribute.array.every((value, i) => value === array[i])));
    }, value => value ? null : 'a render frame mutated canonical population or instance buffers');
  } else {
  await check('flower asset instancing', () => {
    const veg = window.__app.veg;
    const flowers = [];
    for (const tile of veg.tiles.values()) {
      for (const mesh of tile.meshes) {
        if (mesh.material.name.startsWith('veg-flower')) flowers.push(mesh);
      }
    }
    return {
      loaded: !!veg.flower && !veg.assetError,
      batches: flowers.length,
      instances: flowers.reduce((sum, m) => sum + m.count, 0),
      valid: flowers.every(m => m.isInstancedMesh && m.instanceColor && !m.material.vertexColors &&
        m.material.color.getHex() === 0xffffff && m.geometry.getAttribute('normal') &&
        Number.isFinite(m.boundingSphere.radius)),
    };
  }, v => v.loaded && v.valid && v.batches > 0 && v.batches <= 50 ? null : JSON.stringify(v));
  await check('needle asset atlas loaded', () => window.__app.veg.needleAssetReady, v => v === true ? null : 'needle atlas fallback still active');
  if (window.__app.veg.study) {
    await check('woodland asset budget', () => {
      const w = window.__app.veg.woodland;
      const selected = w.selected;
      const batches = Object.values(w.meshes).flatMap(Object.values);
      return {
        loaded: w.ready && !w.error,
        selected: selected.length,
        capacity: w.maxCount + w.maxMidCount,
        batches: batches.flatMap(levels => Object.values(levels)).length,
        originalsHidden: selected.every(({ mesh, index }) => mesh.instanceMatrix.array[index * 16 + 12] === 1e8),
        finiteBounds: batches.every(m => !m.count || Number.isFinite(m.boundingSphere?.radius)),
        leavesPresent: Object.values(w.meshes).flatMap(levels => Object.values(levels)).flatMap(parts => Object.values(parts)).filter(mesh => mesh.material.name.endsWith('-leaf')).reduce((n, mesh) => n + mesh.count, 0) === selected.length,
      };
    }, v => v.loaded && v.selected > 0 && v.selected <= v.capacity && v.batches === 8 && v.originalsHidden && v.finiteBounds && v.leavesPresent ? null : JSON.stringify(v));
    await check('grass uses folded rooted geometry', () => {
      const v = window.__app.veg;
      const near = v.geo.grassNear, far = v.geo.grassFar;
      const np = near.getAttribute('position'), fp = far.getAttribute('position');
      const nn = near.getAttribute('normal'), fn = far.getAttribute('normal');
      const finite = (g, expected) => {
        const p = g.getAttribute('position'), n = g.getAttribute('normal');
        if (!p || !n || p.count !== expected * 10 || g.index.count !== expected * 30) return false;
        if (!g.boundingBox || !g.boundingSphere || !Number.isFinite(g.boundingSphere.radius)) return false;
        for (let i = 0; i < p.count; i++) {
          if (![p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i)].every(Number.isFinite)) return false;
          const nl = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
          if (Math.abs(nl - 1) > 2e-3) return false;
        }
        return Math.abs(p.getY(0)) < 1e-5 && Math.abs(p.getY(1)) < 1e-5 && Math.abs(p.getY(2)) < 1e-5;
      };
      let prefix = true;
      const fa = far.getAttribute('position').array, na = near.getAttribute('position').array;
      for (let i = 0; i < fa.length; i++) if (fa[i] !== na[i]) { prefix = false; break; }
      const nearBatches = [], farBatches = [];
      for (const tile of v.tiles.values()) for (const mesh of tile.meshes) {
        if (!mesh.isInstancedMesh || mesh.count <= 0) continue;
        if (mesh.material === v.mat.meadowNear) nearBatches.push(mesh);
        if (mesh.material === v.mat.meadowFar) farBatches.push(mesh);
      }
      const road = window.__app.world.route;
      let roadViolations = 0, roadSamples = 0, roadChecks = 0;
      const maxRoadChecks = 512;
      for (const mesh of [...nearBatches, ...farBatches]) {
        for (let i = 0; i < mesh.count; i++) {
          if (roadChecks >= maxRoadChecks) break;
          const a = mesh.instanceMatrix.array;
          const hit = road.nearest(a[i * 16 + 12], a[i * 16 + 14], 4.3 + 1);
          roadChecks++;
          if (hit) { roadSamples++; if (hit.dist < 4.3) roadViolations++; }
        }
        if (roadChecks >= maxRoadChecks) break;
      }
      const noShadows = [...nearBatches, ...farBatches].every(m => !m.castShadow && !m.receiveShadow);
      return {
        near: finite(near, 22), far: finite(far, 14), prefix,
        nearBatches: nearBatches.length, farBatches: farBatches.length,
        noAlphaTexture: v.mat.meadowNear.alphaMap === null && v.mat.meadowFar.alphaMap === null,
        noShadows, roadSamples, roadViolations,
        normalTemplates: !!nn && !!fn,
      };
    }, v => v.near && v.far && v.prefix && v.nearBatches > 0 && v.farBatches > 0 &&
      v.noAlphaTexture && v.noShadows && v.roadViolations === 0 ? null : JSON.stringify(v));
  }
  await check('winter removes flowers', async () => {
    await r.set({ season: 'winter' });
    const meshes = window.__app.veg.group.children.filter(m => m.visible && m.material?.name.startsWith('veg-flower'));
    const w = window.__app.veg.woodland;
    const woodlandMeshes = w ? Object.values(w.meshes).flatMap(levels => Object.values(levels)).flatMap(parts => Object.values(parts)) : [];
    if (w && (woodlandMeshes.filter(m => m.material.name.startsWith('woodland-oak-leaf')).some(m => m.count !== 0) ||
      woodlandMeshes.filter(m => m.material.name.startsWith('woodland-pine-leaf')).some(m => m.material.userData.snow.value < 0.5))) {
      throw new Error('woodland winter state not applied');
    }
    await r.set({ season: 'summer' });
    return meshes.length;
  }, v => v === 0 ? null : `${v} winter flower batches`);
  }

  await check('background render suspension', async () => {
    const app = window.__app;
    const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    try {
      r.pause();
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pageshow'));
      const before = app.frameNo;
      await new Promise(res => setTimeout(res, 100));
      const stopped = app.frameNo === before && app._rafId === 0;
      const km = r.stats().km;
      await app.nextFrame();
      const manual = app.frameNo === before + 1 && r.stats().km === km && app._rafId === 0;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      const raf = app._rafId;
      window.dispatchEvent(new Event('pageshow'));
      const single = raf !== 0 && app._rafId === raf;
      await new Promise(res => setTimeout(res, 100));
      return { stopped, manual, single, resumed: app.frameNo > before + 1, paused: app.paused };
    } finally {
      if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
      else delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    }
  }, v => Object.values(v).every(Boolean) ? null : JSON.stringify(v));

  await check('hideUI()', () => r.hideUI(), () => {
    const h = document.getElementById('hud');
    return !h || getComputedStyle(h).display === 'none' || h.style.display === 'none' ? null : 'hud still displayed';
  });
  await check('showUI()', () => r.showUI(), () => {
    const h = document.getElementById('hud');
    return !h || getComputedStyle(h).display !== 'none' ? null : 'hud still hidden';
  });
  r.hideUI();

  await check('teleport(11.5)', () => r.teleport(11.5), () => {
    const km = r.stats().km;
    return Math.abs(km - 11.5) < 0.02 ? null : 'km is ' + km;
  });
  await check('teleport determinism', async () => {
    const a = r.stats().pos.join(',');
    await r.teleport(3.25); await r.teleport(11.5);
    return { a, b: r.stats().pos.join(',') };
  }, (v) => (v.a === v.b ? null : `pos drifted ${v.a} -> ${v.b}`));

  await check('set({t,season})', () => r.set({ t: 18.4, season: 'autumn' }), () => {
    const s = r.stats();
    return Math.abs(s.t - 18.4) < 1e-6 && s.season === 'autumn' ? null : 'got t=' + s.t + ' season=' + s.season;
  });
  await check('set({seed}) rebuild', () => r.set({ seed: 31, km: 8 }), () => {
    const s = r.stats();
    return String(s.seed) === '31' && s.residency.pending === 0 ? null : JSON.stringify(s.residency);
  });
  if (window.__app.veg.generation === 2) {
    await check('V2 seed reset residency', () => {
      const veg = window.__app.veg, seed = window.__app.world.seed >>> 0;
      const population = forestPopulationContract();
      return population.valid && population.records > 0 && [...veg.tiles].every(([key, entry]) =>
        key.startsWith(`veg:${veg.version}:`) && entry.records.every(record => record.id.startsWith(`${entry.job.kind}:${seed}:`)));
    }, value => value ? null : 'a cell or representation refers to a previous world generation');
    await check('V2 population stable while paused', async () => {
      const before = populationSnapshot(), version = window.__app.veg.version;
      await window.__app.nextFrame(); await window.__app.nextFrame();
      return before === populationSnapshot() && window.__app.veg.version === version && forestPopulationContract().valid;
    }, value => value ? null : 'paused frames changed population or near/far pairing');
  } else if (window.__app.veg.study) {
    await check('woodland reset residency', () => {
      const v = window.__app.veg;
      return v.woodland.selected.length <= v.woodland.maxCount + v.woodland.maxMidCount && v.woodland.selected.every(t => t.mesh?.userData?.woodlandSource && t.mesh.instanceMatrix.array.every(Number.isFinite));
    }, v => v ? null : 'replacement refers to a retired source tile');
    await check('LOD assignment stable while paused', async () => {
      const w = window.__app.veg.woodland;
      const before = [...w.lodLevels.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      await window.__app.nextFrame(); await window.__app.nextFrame();
      const after = [...w.lodLevels.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      return JSON.stringify(before) === JSON.stringify(after);
    }, v => v ? null : 'LOD assignments changed during a paused frame');
  }
  await check('vegetation shadows disabled', () => {
    let shadowed = 0;
    window.__app.veg.group.traverse(obj => { if (obj.isMesh && (obj.castShadow || obj.receiveShadow)) shadowed++; });
    return shadowed;
  }, v => v === 0 ? null : `${v} vegetation meshes still cast/receive shadows`);
  await check('renderer shadows disabled', () => ({
    map: window.__app.renderer.shadowMap.enabled,
    sun: window.__app.atmo.sun.castShadow,
  }), v => v.map || v.sun ? JSON.stringify(v) : null);
  await check('set({cam:cine})', () => r.set({ cam: 'cine' }), () => (r.stats().cam === 'cine' ? null : r.stats().cam));
  await r.set({ seed: 7, km: 0, cam: 'chase', t: 12, season: 'summer' });

  await check('findBridge(0)', () => r.findBridge(0), (v) => (typeof v === 'number' && v >= 0 ? null : 'got ' + v));
  await check('findWater(0)', () => r.findWater(0), (v) => (typeof v === 'number' && v >= 0 ? null : 'got ' + v));
  await check('findVista(0)', () => r.findVista(0), (v) => (typeof v === 'number' && v >= 0 ? null : 'got ' + v));
  await check('findBridge monotonic', async () => {
    const a = await r.findBridge(0); const b = await r.findBridge(a + 0.1);
    return [a, b];
  }, (v) => (v[1] > v[0] ? null : `not advancing: ${v[0]} -> ${v[1]}`));
  await check('findBridge lands on water', async () => {
    const km = await r.findBridge(0);
    await r.teleport(km);
    const b = r.bridges().find((x) => Math.abs(x.km - km) < 0.2);
    return b || null;
  }, (v) => (v ? null : 'no bridge record at the km findBridge returned'));

  await check('pause stops the car', async () => {
    r.pause(); const a = r.stats().km;
    await new Promise((res) => setTimeout(res, 400));
    return [a, r.stats().km];
  }, (v) => (v[0] === v[1] ? null : `moved ${v[0]} -> ${v[1]} while paused`));
  await check('resume moves the car', async () => {
    r.resume(); const a = r.stats().km;
    await new Promise((res) => setTimeout(res, 600));
    const b = r.stats().km; r.pause();
    return [a, b];
  }, (v) => (v[1] > v[0] ? null : `did not move ${v[0]} -> ${v[1]}`));
  await check('snap() after resume restores', async () => {
    await r.teleport(6);
    await r.set({ cam: 'cockpit' });
    r.snap();
    const pose = () => JSON.stringify({
      speed: __app.vehicle.speed, position: __app.vehicle.pos.toArray(),
      quaternion: __app.vehicle.group.quaternion.toArray(),
      camera: __app.cameras.camera.position.toArray(),
      cameraQuaternion: __app.cameras.camera.quaternion.toArray(),
      wheels: __app.vehicle.assetWheels.map(w => [w.quaternion.toArray(), w.rollGroup.quaternion.toArray()]),
    });
    const a = pose();
    r.resume(); await new Promise((res) => setTimeout(res, 500)); r.pause();
    r.snap();
    const restored = a === pose();
    await r.set({ cam: 'chase' });
    return restored;
  }, (v) => (v ? null : 'speed, vehicle pose, wheels, or cockpit camera changed'));

  await check('O cannot enter unsupported manual mode', async () => {
    const app = window.__app;
    r.pause();
    let noManual = true;
    for (const key of ['o', 'O']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key }));
      noManual &&= app.vehicle.autodrive !== false;
    }
    r.resume();
    const start = app.vehicle.s;
    await new Promise(resolve => setTimeout(resolve, 400));
    app.hud.update(1, app);
    const moving = app.vehicle.s > start;
    const mode = document.getElementById('hud-mode').textContent;
    r.pause();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }));
    const resumed = !app.paused;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P' }));
    return { moving, mode, noManual, pauseKeys: resumed && app.paused };
  }, v => v.moving && v.mode.includes('AUTODRIVE') && v.noManual && v.pauseKeys ? null : JSON.stringify(v));

  await check('route wrap resets camera and waits for destination', async () => {
    const app = window.__app;
    await r.teleport(app.world.route.sToKm(app.world.route.length - 200.01));
    const render = app.renderer.render;
    let draws = 0;
    try {
      app.renderer.render = function (...args) { draws++; return render.apply(this, args); };
      app.paused = false;
      app.lastT = performance.now() - 16;
      app.frame();
    } finally {
      app.paused = true;
      app.renderer.render = render;
    }
    const result = {
      wrapped: app.vehicle.s === app.world.route.kmToS(0),
      anchor: app.requestedS === app.world.route.kmToS(0),
      cameraDistance: app.cameras.camera.position.distanceTo(app.vehicle.pos),
      heldFrame: app.loading && draws === 0,
    };
    const start = app.vehicle.s;
    r.resume();
    await app.nextFrame();
    r.pause();
    result.stationary = app.vehicle.s === start;
    await r.ready();
    result.ready = !app.loading && app.residencyOk();
    r.snap();
    result.snapAtStart = app.vehicle.s === app.world.route.kmToS(0);
    await r.teleport(6);
    return result;
  }, v => v.wrapped && v.anchor && v.cameraDistance < 100 && v.heldFrame &&
    v.stationary && v.ready && v.snapAtStart ? null : JSON.stringify(v));

  await check('error() is null', () => r.error(), (v) => (v === null ? null : 'fatal: ' + v));
  await check('params()', () => r.params(), (v) => (v && v.routeKm > 10 ? null : JSON.stringify(v)));
  return rows;
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
  await page.setViewportSize(viewport);
  const pixels = await page.evaluate(async () => {
    await __rig.ready({ frames: 3 });
    try {
      // Match the actual frame path; raw draws submit every offscreen tree LOD.
      __app.instanceCulling.prepare(__app.veg.group, __app.cameras.camera);
      __app.renderer.render(__app.scene, __app.cameras.camera);
      const gl = __app.renderer.getContext(), px = new Uint8Array(4);
      let min = 255, max = 0, visible = 0;
      for (let y = 1; y < 8; y++) for (let x = 1; x < 8; x++) {
        gl.readPixels(Math.floor(gl.drawingBufferWidth * x / 8), Math.floor(gl.drawingBufferHeight * y / 8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const value = (px[0] + px[1] + px[2]) / 3;
        min = Math.min(min, value); max = Math.max(max, value);
        if (value > 5) visible++;
      }
      return { min, max, visible, error: __rig.error() };
    } finally {
      __app.instanceCulling.restore();
    }
  });
  out.push({ name: `canvas ${viewport.width}x${viewport.height}`, ok: pixels.visible > 20 && pixels.max - pixels.min > 30 && !pixels.error, value: pixels });
  const layout = await page.evaluate(() => {
    __rig.showUI();
    __app.hud.update(1, __app);
    const boxes = ['.readout', '.meta', '.autodrive'].map(selector => {
      const r = document.querySelector(`#hud ${selector}`).getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    const contained = boxes.every(r => r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight);
    const overlap = boxes.some((a, i) => boxes.slice(i + 1).some(b =>
      Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)));
    return { contained, overlap };
  });
  out.push({ name: `HUD ${viewport.width}x${viewport.height}`, ok: layout.contained && !layout.overlap, value: layout });
  if (screenshotsDir) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotsDir, `${viewport.width}x${viewport.height}.png`), timeout: 20000 });
  }
}

const payload = '<img src=/__hud_xss_probe onerror="window.__hudXss=1">';
await page.goto(`${baseUrl}/?${new URLSearchParams({ paused: '1', seed: payload, season: 'constructor', weather: '__proto__' })}`, { timeout: 20000, waitUntil: 'domcontentloaded' });
const inputSafety = await page.evaluate(async () => {
  if (__rig.error()) return { error: __rig.error() };
  await __rig.ready({ frames: 3 });
  __app.hud.update(1, __app);
  const meta = document.getElementById('hud-meta');
  return {
    literal: meta.textContent.includes(__app.world.seedInput),
    parsed: !!meta.querySelector('img'), executed: !!window.__hudXss,
    season: __app.atmo.seasonName, weather: __app.atmo.weatherName,
  };
});
out.push({ name: 'URL input safety', ok: inputSafety.literal && !inputSafety.parsed && !inputSafety.executed && inputSafety.season === 'summer' && inputSafety.weather === 'clear', value: inputSafety });
await page.goto(`${baseUrl}/?paused=1&season=autumn`, { timeout: 20000, waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__app, null, { timeout: 20000 });
const autumnFlowers = await page.evaluate(() => ({ season: __app.veg.seasonName, amount: __app.veg.flowers.uniforms.uFlowerSeason.value }));
out.push({ name: 'V2 direct autumn flowers', ok: autumnFlowers.season === 'autumn' && autumnFlowers.amount === 0.4, value: autumnFlowers });
await page.close();
let fails = 0;
for (const row of out) {
  if (!row.ok) fails++;
  const val = row.value !== undefined ? ' ' + JSON.stringify(row.value).slice(0, 150) : '';
  console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name.padEnd(26)} ${(row.ms ?? '') + ''.padEnd(2)}  ${row.note || ''}${val}`);
}
if (errs.length) console.log('\npage errors:\n' + errs.slice(0, 10).join('\n'));
console.log(`\n${out.length - fails}/${out.length} passed`);
process.exit(fails ? 1 : 0);
