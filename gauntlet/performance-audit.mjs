import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const out = flag('--out', '/tmp/slowroad-performance-audit');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${flag('--port', '9421')}`, { timeout: 20000 });
const report = { cases: {}, errors: [] };
let context;
fs.mkdirSync(out, { recursive: true });
const save = () => fs.writeFileSync(path.join(out, 'performance-audit.json'), JSON.stringify(report, null, 2));

async function audit({ detailed, driveMs = 12000 }) {
  const app = __app, renderer = app.renderer, culler = app.instanceCulling;
  const gl = renderer.getContext(), originalDpr = renderer.getPixelRatio();
  const lodHeight = renderer.domElement.height;
  const originalQuality = app.quality && { ratio: app.quality.pixelRatio, lod: app.quality.lodHeight, adaptive: app.quality.adaptive };
  if (app.quality) app.quality.adaptive = false;
  const setRaster = ratio => { if (app.quality) app.quality.pixelRatio = ratio; renderer.setPixelRatio(ratio); };
  let lockedLodHeight = lodHeight;
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const result = { viewport: [innerWidth, innerHeight], dpr: originalDpr,
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], samples: gl.getParameter(gl.SAMPLES),
    gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), stages: {} };
  const undos = [], meshUndos = [], seen = new WeakSet(), kinds = new WeakMap();
  let collecting = false, active = null, rows = [], stack = [], hide = null, freezeLod = false, freezeCull = false;
  const summary = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return { mean: values.reduce((sum, n) => sum + n, 0) / Math.max(1, values.length),
      p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
      p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, p99: sorted[Math.floor(sorted.length * 0.99)] ?? 0 };
  };
  const replace = (object, key, fn) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    object[key] = fn;
    undos.push(() => descriptor ? Object.defineProperty(object, key, descriptor) : delete object[key]);
  };
  const timed = (name, fn, that, values) => {
    if (!active) return fn.apply(that, values);
    const entry = { child: 0 }, start = performance.now(); stack.push(entry);
    try { return fn.apply(that, values); }
    finally {
      const duration = performance.now() - start; stack.pop();
      active.cpu[name] = (active.cpu[name] || 0) + duration - entry.child;
      if (stack.length) stack.at(-1).child += duration;
    }
  };
  const trace = (object, key, name) => {
    const fn = object[key];
    replace(object, key, function (...values) { return timed(name, fn, this, values); });
  };
  const kind = mesh => {
    if (kinds.has(mesh)) return kinds.get(mesh);
    let value = mesh.userData?.field === 'grass' ? 'grass'
      : mesh.userData?.foliageKind === 'tree' ? 'trees'
      : mesh.userData?.foliageKind === 'shrub' ? 'shrubs'
      : mesh.userData?.field === 'flowers' ? 'flowers' : null;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!value && material?.name === 'terrain') value = 'terrain';
    if (!value && mesh === app.atmo.sky) value = 'sky';
    if (!value) for (let object = mesh; object; object = object.parent) {
      if (object === app.vehicle.group) { value = 'vehicle'; break; }
      if (object === app.road.group) { value = 'road'; break; }
      if (object === app.bridges.group) { value = 'bridges'; break; }
      if (object === app.terrain.waterGroup) { value = 'water'; break; }
    }
    value ||= 'other'; kinds.set(mesh, value); return value;
  };
  const installMeshHooks = () => app.scene.traverse(mesh => {
    if (!mesh.isMesh || seen.has(mesh)) return;
    seen.add(mesh); kind(mesh);
    const fn = mesh.onBeforeRender;
    mesh.onBeforeRender = function (...values) {
      fn.apply(this, values);
      if (!active) return;
      const geometry = values[3], group = values[5], name = kind(this);
      const total = geometry.index?.count ?? geometry.attributes.position.count;
      const start = Math.max(geometry.drawRange.start, group?.start || 0);
      const end = Math.min(total, geometry.drawRange.start + geometry.drawRange.count,
        group ? group.start + group.count : Infinity);
      const count = Math.max(0, end - start) / 3 * (this.isInstancedMesh ? this.count : 1);
      const bucket = active.draws[name] ||= { calls: 0, triangles: 0 };
      bucket.calls++; bucket.triangles += count;
    };
    meshUndos.push(() => { mesh.onBeforeRender = fn; });
  });
  const originalPrepare = culler.prepare, originalRestore = culler.restore;
  const frame = app.frame;
  replace(app, 'frame', function (...values) {
    if (!collecting) return frame.apply(this, values);
    active = { cpu: {}, draws: {}, uploadBytes: 0, uploadCalls: 0 };
    const start = performance.now();
    try { return timed('other-frame', frame, this, values); }
    finally { active.totalCpu = performance.now() - start; rows.push(active); active = null; }
  });
  trace(app.scheduler, 'run', 'build-queue');
  trace(app.terrain, 'update', 'terrain'); trace(app.terrain, 'refreshCoverage', 'terrain');
  trace(app.veg, 'update', 'vegetation-update');
  for (const [object, method] of [[app.vehicle, 'update'], [app.cameras, 'update'], [app.water, 'update'],
    [app.atmo, 'update'], [app.road, 'update'], [app.bridges, 'update']]) trace(object, method, 'world-camera-atmosphere');
  replace(culler, 'prepare', function (...values) {
    return freezeCull ? this.stats : timed('culling-overhead', originalPrepare, this, values);
  });
  replace(culler, 'restore', function (...values) {
    if (!freezeCull) return timed('culling-overhead', originalRestore, this, values);
  });
  const traverse = app.veg.group.traverseVisible;
  replace(app.veg.group, 'traverseVisible', function (callback) {
    return traverse.call(this, mesh => {
      let bucket = mesh.isMesh ? kind(mesh) : 'groups';
      if (bucket === 'trees') bucket += `-${mesh.userData.foliageLevel || 'unknown'}`;
      return timed(`culling-${bucket}`, callback, null, [mesh]);
    });
  });
  for (const field of [app.veg.grass, app.veg.forest]) {
    const fn = field.update;
    replace(field, 'update', function (camera, time, season, height) {
      return fn.call(this, camera, time, season, freezeLod ? lockedLodHeight : height);
    });
  }
  for (const method of ['bufferData', 'bufferSubData']) {
    const fn = gl[method];
    replace(gl, method, function (...values) {
      if (active) {
        const data = values[method === 'bufferData' ? 1 : 2];
        const length = values[4];
        active.uploadCalls++;
        active.uploadBytes += typeof data === 'number' ? data
          : length !== undefined && length !== 0 ? length * data.BYTES_PER_ELEMENT : data?.byteLength || 0;
      }
      return timed('buffer-upload-submit', fn, this, values);
    });
  }
  const render = renderer.render;
  replace(renderer, 'render', function (...values) {
    installMeshHooks();
    const hidden = [];
    if (hide) app.scene.traverse(mesh => {
      if (!mesh.visible || !mesh.isMesh) return;
      const matches = kind(mesh) === hide || kind(mesh) === 'trees' &&
        hide === `tree-${mesh.userData.foliageLevel}`;
      if (matches) { hidden.push(mesh); mesh.visible = false; }
    });
    try { return timed('render-submit', render, this, values); }
    finally { for (const mesh of hidden) mesh.visible = true; }
  });
  const capture = async (label, { driving = false, uninstrumented = false, frames = 100 } = {}) => {
    collecting = false;
    for (let i = 0; i < 20; i++) await app.nextFrame();
    rows = [];
    collecting = !uninstrumented;
    if (driving) __rig.resume();
    const times = [], start = performance.now(), startKm = app.vehicle.km;
    do {
      const t = performance.now(); await app.nextFrame(); times.push(performance.now() - t);
    } while (driving ? performance.now() - start < driveMs : times.length < frames);
    __rig.pause(); collecting = false;
    const elapsed = performance.now() - start, keys = new Set(rows.flatMap(row => Object.keys(row.cpu)));
    const cpu = Object.fromEntries([...keys].map(key => [key, summary(rows.map(row => row.cpu[key] || 0))]));
    const total = summary(rows.map(row => row.totalCpu));
    const drawKeys = new Set(rows.flatMap(row => Object.keys(row.draws)));
    result.stages[label] = { frames: times.length, elapsed, fps: times.length * 1000 / elapsed,
      frameMs: summary(times), cpu, totalCpu: total,
      cpuShares: Object.fromEntries(Object.entries(cpu).map(([key, value]) => [key, total.mean ? value.mean / total.mean : 0])),
      uploadBytes: summary(rows.map(row => row.uploadBytes)), uploadCalls: summary(rows.map(row => row.uploadCalls)),
      draws: Object.fromEntries([...drawKeys].map(key => [key, {
        calls: summary(rows.map(row => row.draws[key]?.calls || 0)).mean,
        triangles: summary(rows.map(row => row.draws[key]?.triangles || 0)).mean }])),
      render: { ...renderer.info.render }, dpr: renderer.getPixelRatio(), grassFocal: app.veg.grass.uniforms.uGrassFocalPixels.value,
      treeFocal: app.veg.forest.pixelScale, startKm, endKm: app.vehicle.km, error: __rig.error() };
  };
  try {
    await capture('baseline-no-timing', { uninstrumented: true });
    await capture('static');
    await capture('driving', { driving: true });
    await __rig.teleport(6); __rig.snap(); await __rig.ready();
    if (detailed) {
      await capture('baseline-before-ablation');
      for (const target of ['grass', 'trees', 'tree-near', 'tree-far', 'shrubs', 'terrain', 'sky']) {
        hide = target; await capture(`without-${target}`); hide = null;
      }
      for (const target of ['terrain', 'grass', 'trees']) {
        const replacements = new Map(), entries = [];
        app.scene.traverse(mesh => {
          if (!mesh.isMesh || kind(mesh) !== target) return;
          const source = mesh.material;
          const materials = (Array.isArray(source) ? source : [source]).map(original => {
            if (!replacements.has(original)) {
            const material = original.clone();
            material.onBeforeCompile = (shader, r) => {
              original.onBeforeCompile(shader, r);
              if (target === 'trees') {
                const marker = '#include <dithering_fragment>';
                if (!shader.fragmentShader.includes(marker)) throw new Error('tree shader output marker missing');
                shader.fragmentShader = shader.fragmentShader.replace(marker,
                  `${marker}\ngl_FragColor = vec4(diffuseColor.rgb, diffuseColor.a);`);
              } else {
                shader.fragmentShader = target === 'grass'
                  ? '#include <color_pars_fragment>\nvoid main() { gl_FragColor = vec4(vColor.rgb, 1.0); }'
                  : 'void main() { gl_FragColor = vec4(0.25, 0.35, 0.15, 1.0); }';
              }
            };
            material.customProgramCacheKey = () => `audit-${target}-flat-${original.id}`;
            replacements.set(original, material);
            }
            return replacements.get(original);
          });
          entries.push([mesh, source]); mesh.material = Array.isArray(source) ? materials : materials[0];
        });
        if (!entries.length) throw new Error(`No ${target} materials selected for the shader probe`);
        try {
          await capture(`simple-${target}-fragment`);
          result.stages[`simple-${target}-fragment`].materialProbe = { meshes: entries.length, materials: replacements.size };
        }
        finally {
          for (const [mesh, original] of entries) mesh.material = original;
          for (const material of replacements.values()) material.dispose();
        }
      }
      for (const target of ['trees', 'grass']) {
        const entries = [], materials = new Map();
        app.scene.traverse(mesh => {
          if (!mesh.isMesh || kind(mesh) !== target || Array.isArray(mesh.material)) return;
          const source = mesh.material;
          if (!materials.has(source)) {
            const material = source.clone(); material.fog = false;
            material.onBeforeCompile = source.onBeforeCompile;
            material.customProgramCacheKey = () => `audit-${target}-no-fog-${source.id}`;
            materials.set(source, material);
          }
          entries.push([mesh, source]); mesh.material = materials.get(source);
        });
        try { await capture(`${target}-no-fog`); }
        finally { for (const [mesh, source] of entries) mesh.material = source; for (const material of materials.values()) material.dispose(); }
      }
      freezeLod = true; lockedLodHeight = lodHeight / originalDpr;
      await capture('logical-lod-high-dpr');
      lockedLodHeight = lodHeight; setRaster(1);
      await capture('dpr1-fixed-lod');
      freezeLod = false;
      if (app.quality) app.quality.lodHeight = lodHeight / originalDpr;
      await capture('dpr1-native-lod');
      if (app.quality) app.quality.lodHeight = originalQuality.lod;
      setRaster(originalDpr);
      for (let i = 0; i < 5; i++) await app.nextFrame();
      originalPrepare.call(culler, app.veg.group, app.cameras.camera); freezeCull = true;
      try { await capture('static-frozen-culling'); }
      finally { freezeCull = false; originalRestore.call(culler); }
      await capture('baseline-repeat');
    }
    return result;
  } finally {
    collecting = false; freezeCull = false; originalRestore.call(culler);
    for (const undo of meshUndos.reverse()) undo();
    for (const undo of undos.reverse()) undo();
    if (app.quality) {
      app.quality.pixelRatio = originalQuality.ratio; app.quality.lodHeight = originalQuality.lod;
      app.quality.adaptive = originalQuality.adaptive;
    }
    renderer.setPixelRatio(originalDpr); __rig.pause();
  }
}

try {
  context = await browser.newContext({ viewport: { width: 1512, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  for (const [label, width, height, detailed] of [['builtin', 1512, 900, true], ['external', 1920, 1080, true]]) {
    if (process.env.PERFORMANCE_AUDIT_CASE && process.env.PERFORMANCE_AUDIT_CASE !== label) continue;
    await page.setViewportSize({ width, height });
    await page.goto(`${process.env.GAUNTLET_URL || 'http://127.0.0.1:5190'}/?seed=7&km=6&paused=1&quality=high`, { timeout: 20000 });
    await page.evaluate(async () => { await __rig.ready(); __rig.snap(); await __rig.ready({ frames: 3 }); __rig.hideUI(); });
    await page.screenshot({ path: path.join(out, `audit-${label}.png`), timeout: 20000 });
    report.cases[label] = await page.evaluate(audit, { detailed, driveMs: detailed ? 20000 : 10000 });
    save();
  }
  if (report.errors.length) throw new Error('browser errors during performance audit');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push(String(error.stack || error)); process.exitCode = 1;
} finally {
  try { await context?.close(); } finally { await browser.close(); }
  save(); console.log(JSON.stringify({ status: report.status, report: path.join(out, 'performance-audit.json') }));
}
