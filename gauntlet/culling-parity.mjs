#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const reference = flag('--reference');
if (!reference) throw new Error('--reference must point to the pre-change culler module');
const source = fs.readFileSync(reference, 'utf8');
if (!source.includes("from 'three'")) throw new Error('Unsupported reference module import');
const base = process.env.GAUNTLET_URL || 'http://localhost:5188';
const out = path.resolve(flag('--out', 'gauntlet/culling-parity'));
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${flag('--port', '9223')}`, { timeout: 20000 });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
context.setDefaultTimeout(20000);
const errors = [], results = [];
try {
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/?seed=7&t=16.5&season=summer&cam=cine&km=12.1&paused=1&dpr=1`, { timeout: 20000 });
  await page.evaluate(async () => { __rig.pause(); __rig.snap(); await __rig.ready(); __rig.hideUI(); });
  const result = await page.evaluate(async ({ source, threeUrl }) => {
    const moduleUrl = URL.createObjectURL(new Blob([source.replace("from 'three'", `from '${threeUrl}'`)], { type: 'text/javascript' }));
    let reference;
    try { reference = new (await import(moduleUrl)).InstanceCuller(); }
    finally { URL.revokeObjectURL(moduleUrl); }
    const app = __app, renderer = app.renderer, optimized = app.instanceCulling;
    const gl = renderer.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const oldPixels = new Uint8Array(width * height * 4), newPixels = new Uint8Array(oldPixels.length);
    const camera = app.cameras.camera.clone(), position = camera.position.clone(), rotation = camera.quaternion.clone();
    const rows = [];
    const render = (culler, pixels) => {
      try {
        culler.prepare(app.veg.group, camera);
        renderer.render(app.scene, camera);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return { ...renderer.info.render };
      } finally { culler.restore(); }
    };
    try {
      // No awaits: terrain, uniforms, population, and GPU scene state stay fixed.
      for (const [dx, turn] of [[0, 0], [0.001, 0], [4, 0], [4, Math.PI], [-7, 0], [0, 0]]) {
        camera.position.copy(position); camera.position.x += dx;
        camera.quaternion.copy(rotation); camera.rotateY(turn);
        const a = render(reference, oldPixels), b = render(optimized, newPixels);
        let different = 0, max = 0;
        for (let i = 0; i < oldPixels.length; i += 4) {
          const delta = Math.max(Math.abs(oldPixels[i] - newPixels[i]), Math.abs(oldPixels[i + 1] - newPixels[i + 1]),
            Math.abs(oldPixels[i + 2] - newPixels[i + 2]), Math.abs(oldPixels[i + 3] - newPixels[i + 3]));
          if (delta) different++;
          max = Math.max(max, delta);
        }
        rows.push({ dx, turn, differentPixels: different, maxChannelDifference: max,
          referenceTriangles: a.triangles, optimizedTriangles: b.triangles });
      }
      return { width, height, terrain: app.terrain.required, rows };
    } finally { reference.dispose(); optimized.restore(); }
  }, { source, threeUrl: new URL('/node_modules/three/build/three.module.js', base).href });
  results.push(result);
  await page.screenshot({ path: path.join(out, 'culling-parity.png'), timeout: 20000 });
  if (errors.length || result.rows.some(row => row.differentPixels || row.referenceTriangles !== row.optimizedTriangles)) process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(out, 'culling-parity.json'), JSON.stringify({ reference: path.resolve(reference),
    referenceSHA256: createHash('sha256').update(source).digest('hex'), results, errors }, null, 2));
  await context.close(); await browser.close();
}
console.log(JSON.stringify({ results, errors }));
