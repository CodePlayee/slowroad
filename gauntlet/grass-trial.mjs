import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { profileScene } from './profile-frame.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const directory = flag('--out', '/tmp/slowroad-grass-trial');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${flag('--port', '9421')}`, { timeout: 20000 });
const report = { stages: {}, errors: [] };
let context;
fs.mkdirSync(directory, { recursive: true });
const save = () => fs.writeFileSync(path.join(directory, 'grass-trial.json'), JSON.stringify(report, null, 2));
try {
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`${process.env.GAUNTLET_URL || 'http://127.0.0.1:5190'}/?seed=7&km=6&paused=1`, { timeout: 20000 });
  await page.evaluate(async () => { await __rig.ready(); __rig.hideUI(); });
  for (const [label, cells, density, sort] of [['baseline', false, false, false], ['cells', true, false, false],
    ['optimized', true, true, false], ['occlusion-order', true, true, true], ['baseline-repeat', false, false, false]]) {
    const signature = await page.evaluate(async ({ cells, density, sort }) => {
      const app = __app, field = app.veg.grass;
      globalThis.__grassTrialSceneRender ||= app.scene.onBeforeRender;
      app.scene.onBeforeRender = sort ? function (...args) {
        __grassTrialSceneRender.apply(this, args);
        for (const mesh of field.meshes) if (mesh.visible && mesh.boundingSphere) {
          mesh.renderOrder = 1 + mesh.boundingSphere.center.distanceTo(app.cameras.camera.position);
        }
      } : __grassTrialSceneRender;
      field.cellRendering = cells;
      field.uniforms.uGrassDensity.value = density ? 1 : 0;
      await __rig.teleport(6);
      __rig.snap();
      await __rig.ready({ frames: 3 });
      let work = 0;
      for (const entry of app.veg.tiles.values()) {
        if (entry.job.kind !== 'grass') continue;
        for (const mesh of entry.meshes) if (mesh.userData.field === 'grass') field.disposeMesh(mesh);
        entry.meshes = entry.meshes.filter(mesh => mesh.userData.field !== 'grass');
        const iterator = cells ? field.buildCellsSteps(entry.records) : field.buildSteps(entry.records);
        let step;
        do {
          step = iterator.next();
          if (!step.done && ++work % 32 === 0) await app.nextFrame();
        } while (!step.done);
        for (const mesh of step.value) {
          mesh.userData.field = 'grass'; mesh.visible = entry.groundReady;
          entry.meshes.push(mesh); app.veg.group.add(mesh);
        }
      }
      await __rig.ready({ frames: 3 });
      let hash = 2166136261, count = 0;
      const entries = [...app.veg.tiles.values()].filter(entry => entry.job.kind === 'grass')
        .sort((a, b) => a.job.key.localeCompare(b.job.key));
      for (const entry of entries) for (const r of entry.records) {
        const text = `${r.id}:${r.x}:${r.y}:${r.z}`;
        for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
        count++;
      }
      return { count, hash: hash >>> 0, camera: app.cameras.camera.position.toArray(),
        direction: app.cameras.camera.quaternion.toArray() };
    }, { cells, density, sort });
    if (report.signature && JSON.stringify(signature) !== JSON.stringify(report.signature)) throw new Error('grass population or camera changed between variants');
    report.signature = signature;
    await page.screenshot({ path: path.join(directory, `grass-${label}.png`), timeout: 20000 });
    report.stages[label] = await page.evaluate(profileScene, { ablation: false, drivingMs: 3000 });
    save();
  }
  if (report.errors.length) throw new Error('page errors during grass trial');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push(String(error.stack || error)); process.exitCode = 1;
} finally {
  try { await context?.close(); } finally { await browser.close(); }
  save();
  console.log(JSON.stringify({ status: report.status, report: path.join(directory, 'grass-trial.json') }));
}
