import { chromium } from 'playwright';
import fs from 'node:fs';
const q = process.argv[2];
const b = await chromium.connectOverCDP('http://127.0.0.1:9251', {timeout:20000});
const p = await b.contexts()[0].newPage();
await p.setViewportSize({width:960,height:540});
await p.goto('http://localhost:5188/?'+q+'&paused=1', {timeout:30000, waitUntil:'domcontentloaded'});
await p.evaluate(async () => {
  const t=Date.now(); while(!window.__rig && Date.now()-t<15000) await new Promise(r=>setTimeout(r,50));
  window.__rig.pause(); window.__rig.snap(); await window.__rig.ready({timeoutMs:150000}); window.__rig.hideUI();
});
const variants = {
  base: '',
  noclouds: 'u.uCloud.value.set(0,0,0,0)',
  noaureole: 'u.uSunLobe.value.y=0; u.uSunLobe.value.z=0',
  groundishor: 'u.uSkyGround.value.copy(u.uSkyHorizon.value)',
  skyonly: 'window.__app.scene.traverse(o=>{if(o.name!=="sky"&&o.isMesh)o.visible=false})',
};
for (const [name, code] of Object.entries(variants)) {
  await p.evaluate(async (code) => {
    const u = window.__app.atmo.sky.userData.uniforms;
    if (code) eval(code);
    for (let i=0;i<3;i++) await window.__app.nextFrame();
  }, code);
  await p.screenshot({path:`/tmp/gauntlet-atmo/probe_${name}.png`, timeout:20000});
  console.log('shot', name);
  if (name!=='skyonly') await p.reload({timeout:30000, waitUntil:'domcontentloaded'}), await p.evaluate(async()=>{
    const t=Date.now(); while(!window.__rig && Date.now()-t<15000) await new Promise(r=>setTimeout(r,50));
    window.__rig.pause(); window.__rig.snap(); await window.__rig.ready({timeoutMs:150000}); window.__rig.hideUI();});
}
await p.close(); process.exit(0);
