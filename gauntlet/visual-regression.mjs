import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const manager = fileURLToPath(new URL('./browser.mjs', import.meta.url));
const name = `visual-regression-${process.pid}`;
const port = Number(process.env.REGRESSION_PORT || 19741);
const failures = [];
let browser;
let page;
const watchdog = setTimeout(() => {
  try { execFileSync(process.execPath, [manager, 'down', name]); } catch {}
  process.exit(1);
}, 240000);

try {
  execFileSync(process.execPath, [manager, 'up', name, '--port', String(port)]);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
  page = await browser.contexts()[0].newPage();
  page.on('pageerror', (error) => failures.push(error.message));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('http://127.0.0.1:5188/?seed=7&km=6&paused=1', {
    timeout: 20000, waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.__rig, { timeout: 20000 });

  const result = await page.evaluate(async () => {
    await __rig.ready();
    const app = __app;
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok, detail });
    const uvReport = () => {
      let meshes = 0, bad = 0;
      app.veg.group.traverse((mesh) => {
        if (!mesh.isMesh || !('VEG_UVSEL' in (mesh.material.defines || {}))) return;
        meshes++;
        const uv = mesh.geometry.getAttribute('iUv');
        if (!uv || uv.count !== mesh.count || !Array.from(uv.array).every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) bad++;
      });
      return { meshes, bad };
    };
    const uv = uvReport();
    check('far foliage has per-instance atlas UVs', uv.meshes > 0 && uv.bad === 0, uv);
    const instances = () => app.veg.group.children.reduce((n, mesh) => n + (mesh.count || 0), 0);
    const summer = instances();
    await __rig.set({ season: 'winter' });
    const winter = instances();
    check('winter changes vegetation density', winter < summer && app.veg.seasonName === 'winter', { summer, winter });
    check('winter impostors retain UVs', uvReport().bad === 0, uvReport());
    await __rig.set({ season: 'summer', km: NaN, dist: -100, cam: 'cockpit' });
    check('invalid inputs remain finite and bounded',
      [...app.vehicle.pos.toArray(), ...app.cameras.camera.position.toArray()].every(Number.isFinite) &&
      app.cameras.distScale >= 0.1 && app.cameras.distScale <= 4 && app.vehicle.km >= 0,
      { km: app.vehicle.km, dist: app.cameras.distScale });
    check('authored car asset loaded', app.vehicle.assetReady && !app.vehicle.assetError, { assetReady: app.vehicle.assetReady });
    let externalVisible = 0, interiorVisible = 0;
    app.vehicle.group.traverse((mesh) => {
      if (mesh.isMesh && mesh.visible && !mesh.userData.interior) externalVisible++;
      if (mesh.isMesh && mesh.visible && mesh.userData.interior) interiorVisible++;
    });
    check('cockpit hides exterior shell', externalVisible === 0 && interiorVisible > 0, { externalVisible, interiorVisible });
    return checks;
  });

  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const pixels = await page.evaluate(async () => {
      await __rig.ready({ frames: 3 });
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
    });
    result.push({ name: `canvas nonblank ${viewport.width}x${viewport.height}`, ok: pixels.visible > 20 && pixels.max - pixels.min > 30 && !pixels.error, detail: pixels });
  }
  result.push({ name: 'no uncaught runtime errors', ok: failures.length === 0, detail: failures });
  for (const row of result) console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.name}: ${JSON.stringify(row.detail)}`);
  assert(result.every((row) => row.ok), 'visual regression failed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (page) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  try { console.log(execFileSync(process.execPath, [manager, 'down', name], { encoding: 'utf8' }).trim()); } catch {}
  clearTimeout(watchdog);
}
