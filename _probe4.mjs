import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9251', {timeout:20000});
const p = await b.contexts()[0].newPage();
await p.setViewportSize({width:960,height:540});
await p.goto('http://localhost:5188/?seed=31&t=17.2&season=summer&weather=hazy&cam=vista&km=8.0&paused=1', {timeout:30000, waitUntil:'domcontentloaded'});
const r = await p.evaluate(async () => {
  const t=Date.now(); while(!window.__rig && Date.now()-t<15000) await new Promise(r=>setTimeout(r,50));
  window.__rig.pause(); window.__rig.snap(); await window.__rig.ready({timeoutMs:150000}); window.__rig.hideUI();
  const app=window.__app;
  const mats=new Map();
  app.scene.traverse(o=>{ if(o.isMesh||o.isInstancedMesh){ const m=o.material;
    const k=(m.name||m.type)+'|fog='+m.fog+'|rough='+m.roughness+'|metal='+m.metalness;
    mats.set(k,(mats.get(k)||0)+1);} });
  return {mats:[...mats.entries()], sceneFog: app.scene.fog && app.scene.fog.type,
    sunI: app.atmo.sun.intensity, hemiI: app.atmo.hemi.intensity};
});
console.log(JSON.stringify(r,null,1));
await p.close(); process.exit(0);
