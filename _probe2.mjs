import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9251', {timeout:20000});
const p = await b.contexts()[0].newPage();
await p.setViewportSize({width:960,height:540});
await p.goto('http://localhost:5188/?seed=31&t=17.2&season=summer&weather=hazy&cam=vista&km=8.0&paused=1', {timeout:30000, waitUntil:'domcontentloaded'});
const r = await p.evaluate(async () => {
  const t=Date.now(); while(!window.__rig && Date.now()-t<15000) await new Promise(r=>setTimeout(r,50));
  window.__rig.pause(); window.__rig.snap(); await window.__rig.ready({timeoutMs:150000}); window.__rig.hideUI();
  // what objects are at the white band? raycast
  const app=window.__app, cam=app.cameras.camera;
  const THREE = app.scene.constructor;
  const out=[];
  const rc=new (Object.getPrototypeOf(app.world).constructor.Raycaster || Function)();
  // simpler: read renderer info per-object by toggling groups
  const groups={terrain:app.terrain.group, veg:app.veg.group, road:app.road.group,
                water:app.terrain.waterGroup, bridges:app.bridges.group};
  return {groups:Object.keys(groups).map(k=>[k,groups[k].visible,groups[k].children.length])};
});
console.log(JSON.stringify(r));
// now hide groups one at a time
for (const g of ['veg','terrain','water','road']) {
  await p.evaluate(async (g) => {
    const app=window.__app;
    const m={terrain:app.terrain.group, veg:app.veg.group, road:app.road.group, water:app.terrain.waterGroup};
    for(const k in m) m[k].visible = (k!==g);
    for(let i=0;i<3;i++) await app.nextFrame();
  }, g);
  await p.screenshot({path:`/tmp/gauntlet-atmo/hide_${g}.png`, timeout:20000});
  console.log('hid', g);
}
await p.close(); process.exit(0);
