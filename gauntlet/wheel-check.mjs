import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const out = flag('--out', '/tmp/slowroad-wheels');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${flag('--port', '9421')}`, { timeout: 20000 });
const report = { errors: [], cases: [] };
let context;
try {
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.route('**/favicon.ico', route => route.fulfill({ status: 204, body: '' }));
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.goto(`${process.env.GAUNTLET_URL || 'http://127.0.0.1:5190'}/?seed=7&km=6&t=12&paused=1&ui=0`, { timeout: 20000 });
  await page.evaluate(async () => {
    await __rig.ready();
    const app = __app, vehicle = app.vehicle;
    const { animateWheels } = await import('/src/vehicle/wheels.js');
    window.__wheelProbe = { animateWheels, update: vehicle.update, fov: app.cameras.camera.fov };
    vehicle.update = () => false;
    const camera = app.cameras.camera;
    camera.fov = 44; camera.updateProjectionMatrix();
    vehicle.group.updateMatrixWorld(true);
    camera.position.copy(vehicle.group.localToWorld(vehicle.pos.clone().set(5, 1.65, 6)));
    camera.lookAt(vehicle.group.localToWorld(vehicle.pos.clone().set(0, 0.7, 0.5)));
    camera.updateMatrixWorld(true);
    await __rig.ready();
  });
  for (const [name, distance, curve] of [['neutral', 0, 0], ['rolling', 0.22, 0], ['left', 0.22, -0.08], ['right', 0.22, 0.08]]) {
    const result = await page.evaluate(({ name, distance, curve }) => {
      const app = __app, vehicle = app.vehicle, probe = __wheelProbe;
      probe.animateWheels(vehicle.assetWheels, distance, curve, 1.72);
      vehicle.group.updateMatrixWorld(true);
      const camera = app.cameras.camera, renderer = app.renderer;
      const width = renderer.domElement.width, height = renderer.domElement.height;
      const point = vehicle.pos.clone(), box = app.instanceCulling._box.clone();
      const boxes = vehicle.assetWheels.map(wheel => {
        box.setFromObject(wheel, true);
        const rect = [Infinity, Infinity, -Infinity, -Infinity];
        for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
          point.set(x, y, z).project(camera);
          const px = (point.x * 0.5 + 0.5) * width, py = (point.y * 0.5 + 0.5) * height;
          rect[0] = Math.min(rect[0], px - 4); rect[1] = Math.min(rect[1], py - 4);
          rect[2] = Math.max(rect[2], px + 4); rect[3] = Math.max(rect[3], py + 4);
        }
        return rect;
      });
      const pixels = new Uint8Array(width * height * 4);
      try {
        app.instanceCulling.prepare(app.veg.group, camera);
        renderer.render(app.scene, camera);
        renderer.getContext().readPixels(0, 0, width, height, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, pixels);
      } finally { app.instanceCulling.restore(); }
      let changed = 0, outside = 0, triangles = 0, meshes = 0;
      const resources = [];
      vehicle.asset.traverse(mesh => {
        if (!mesh.isMesh) return;
        meshes++; triangles += mesh.geometry.index.count / 3;
        resources.push([mesh.geometry.uuid, ...Object.values(mesh.geometry.attributes).map(attribute => attribute.version)]);
      });
      if (name === 'neutral') { probe.pixels = pixels; probe.boxes = boxes; probe.resources = JSON.stringify(resources); }
      else for (let i = 0; i < pixels.length; i += 4) {
        if (Math.max(Math.abs(pixels[i] - probe.pixels[i]), Math.abs(pixels[i + 1] - probe.pixels[i + 1]), Math.abs(pixels[i + 2] - probe.pixels[i + 2])) <= 3) continue;
        changed++;
        const x = i / 4 % width, y = Math.floor(i / 4 / width);
        if (![...boxes, ...probe.boxes].some(rect => x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3])) outside++;
      }
      return { name, changed, outside, meshes, triangles, resourcesUnchanged: JSON.stringify(resources) === probe.resources,
        wheels: vehicle.assetWheels.map(wheel => ({ name: wheel.name, front: wheel.userData.front,
          steering: wheel.rotation.y * 180 / Math.PI, rolling: wheel.rollGroup.rotation.x * 180 / Math.PI })) };
    }, { name, distance, curve });
    report.cases.push(result);
    await page.screenshot({ path: path.join(out, `wheels-${name}.png`), timeout: 20000 });
    if (result.wheels.length !== 4 || result.meshes !== 32 || result.triangles !== 134819 ||
        !result.resourcesUnchanged || name !== 'neutral' && (result.changed < 25 || result.outside > 10)) {
      throw new Error(`Invalid wheel render: ${JSON.stringify(result)}`);
    }
  }
  const left = report.cases.find(item => item.name === 'left').wheels;
  const right = report.cases.find(item => item.name === 'right').wheels;
  const angle = (wheels, name) => wheels.find(wheel => wheel.name === name).steering;
  if (!(angle(left, 'Wheel_LF') > angle(left, 'Wheel_RF') && angle(left, 'Wheel_RF') > 0 &&
        angle(right, 'Wheel_RF') < angle(right, 'Wheel_LF') && angle(right, 'Wheel_LF') < 0) ||
      [...left, ...right].some(wheel => !wheel.front && wheel.steering !== 0)) throw new Error('Steering direction/axle mismatch');
  await page.evaluate(() => {
    __app.vehicle.update = __wheelProbe.update;
    __app.cameras.camera.fov = __wheelProbe.fov; __app.cameras.camera.updateProjectionMatrix();
    __app.vehicle.update(0); __app.cameras.snap(); delete window.__wheelProbe;
  });
  if (report.errors.length) throw new Error('wheel browser errors');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push(String(error.stack || error)); process.exitCode = 1;
} finally {
  try { await context?.close(); } finally { await browser.close(); }
  fs.writeFileSync(path.join(out, 'wheel-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
