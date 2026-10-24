import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9251', {timeout:20000});
const p = await b.contexts()[0].newPage();
await p.setViewportSize({width:960,height:540});
const boot = async () => p.evaluate(async () => {
  const t=Date.now(); while(!window.__rig && Date.now()-t<15000) await new Promise(r=>setTimeout(r,50));
  window.__rig.pause(); window.__rig.snap(); await window.__rig.ready({timeoutMs:150000}); window.__rig.hideUI();
});
await p.goto('http://localhost:5188/?seed=31&t=17.2&season=summer&weather=hazy&cam=vista&km=8.0&paused=1', {timeout:30000, waitUntil:'domcontentloaded'});
await boot();
const info = await p.evaluate(() => {
  const app=window.__app, cam=app.cameras.camera; const out=[];
  for (const yf of [0.36,0.40,0.44,0.50]) {
    const dir = new cam.position.constructor(0.0, -(yf*2-1), 0.5).unproject(cam).sub(cam.position).normalize();
    out.push({yf, dirY:+dir.y.toFixed(4)});
  }
  const su=app.atmo.sky.userData.uniforms;
  return {out, camY:+cam.position.y.toFixed(1), hor:su.uSkyHorizon.value.toArray().map(x=>+x.toFixed(3)),
    terrainU: Object.fromEntries(Object.entries(app.terrain.uniforms).map(([k,v])=>[k, (v.value&&v.value.toArray)?v.value.toArray().map(x=>+x.toFixed(3)):v.value]))};
});
console.log(JSON.stringify(info).slice(0,1800));
for (const [name, code] of Object.entries({
  allblack:'su.uSkyHorizon.value.setRGB(0,0,0);su.uSkyGround.value.setRGB(0,0,0);su.uSkyMid.value.setRGB(0,0,0);su.uSkyZenith.value.setRGB(0,0,0);su.uSkySunHaze.value.setRGB(0,0,0);su.uSunLobe.value.y=0',
  horonly:'su.uSkyHorizon.value.setRGB(0,0,0);su.uSkyGround.value.setRGB(0,0,0)',
})) {
  await p.reload({timeout:30000, waitUntil:'domcontentloaded'}); await boot();
  await p.evaluate(async (code) => { const su=window.__app.atmo.sky.userData.uniforms; eval(code);
    for(let i=0;i<3;i++) await window.__app.nextFrame(); }, code);
  await p.screenshot({path:`/tmp/gauntlet-atmo/kz_${name}.png`, timeout:20000});
  console.log('shot', name);
}
await p.close(); process.exit(0);
