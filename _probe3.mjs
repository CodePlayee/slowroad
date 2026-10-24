import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9251', {timeout:20000});
const p = await b.contexts()[0].newPage();
await p.setViewportSize({width:960,height:540});
await p.goto('http://localhost:5188/?seed=31&t=17.2&season=summer&weather=hazy&cam=vista&km=8.0&paused=1', {timeout:30000, waitUntil:'domcontentloaded'});
await p.evaluate(async () => {
  const t=Date.now(); while(!window.__rig && Date.now()-t<15000) await new Promise(r=>setTimeout(r,50));
  window.__rig.pause(); window.__rig.snap(); await window.__rig.ready({timeoutMs:150000}); window.__rig.hideUI();
});
const cases = {
  nohaze:   'F.uHazeA.value.set(0,0.0021,4,0); F.uHazeB.value.x=0',
  nodesat:  'A.x=0',
  nodark:   'A.y=1',
  gain0:    'A.w=0',
  hazeonlyA:'F.uHazeA.value.w=0',
};
const F_ref = await p.evaluate(() => { window.__F = null; return true; });
for (const [name, code] of Object.entries(cases)) {
  await p.evaluate(async (code) => {
    const app=window.__app;
    if (!window.__saved) {
      // grab the shared uniform objects off any registered material
      const m = app.terrain.material;
      window.__U = m.userData.__u || null;
    }
    // reach them through the module graph: they are on the sky? no. Use the terrain
    // material's compiled program uniforms is hard; instead re-import the module.
    const mod = await import('/src/atmosphere/fog.js');
    const F = mod.fogUniforms, A = F.uAerial.value;
    if (!window.__snap0) window.__snap0 = JSON.stringify({a:F.uHazeA.value.toArray(),b:F.uHazeB.value.toArray(),ae:A.toArray()});
    const s=JSON.parse(window.__snap0);
    F.uHazeA.value.fromArray(s.a); F.uHazeB.value.fromArray(s.b); A.fromArray(s.ae);
    eval(code);
    for(let i=0;i<3;i++) await app.nextFrame();
  }, code);
  await p.screenshot({path:`/tmp/gauntlet-atmo/fz_${name}.png`, timeout:20000});
  console.log('shot', name);
}
await p.close(); process.exit(0);
