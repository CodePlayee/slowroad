import { chromium } from 'playwright';
const q = process.argv[2];
const b = await chromium.connectOverCDP('http://127.0.0.1:9251', {timeout:20000});
const ctx = b.contexts()[0]; const p = await ctx.newPage();
await p.setViewportSize({width:1920,height:1080});
await p.goto('http://localhost:5188/?'+q+'&paused=1', {timeout:30000, waitUntil:'domcontentloaded'});
const r = await p.evaluate(async () => {
  const t=Date.now(); while(!window.__rig && Date.now()-t<15000) await new Promise(r=>setTimeout(r,50));
  window.__rig.pause(); await window.__rig.ready({timeoutMs:150000});
  const a=window.__app.atmo, u=a.sky.userData.uniforms, cam=window.__app.cameras.camera;
  const f=(c)=>c.isColor?[+c.r.toFixed(4),+c.g.toFixed(4),+c.b.toFixed(4)]:(c.toArray?c.toArray().map(x=>+x.toFixed(5)):c);
  
  return {
    el:+a.sunElev.toFixed(3), sunDir:f(u.uSunDir.value),
    zen:f(u.uSkyZenith.value), mid:f(u.uSkyMid.value), hor:f(u.uSkyHorizon.value),
    sunHaze:f(u.uSkySunHaze.value), ground:f(u.uSkyGround.value), shape:f(u.uSkyShape.value),
    lobe:f(u.uSunLobe.value), cloud:f(u.uCloud.value), cloudLit:f(u.uCloudLit.value),
    cloudDark:f(u.uCloudDark.value), night:f(u.uNight.value),
    hemi:[f(a.hemi.color), +a.hemi.intensity.toFixed(3)],
    sun:[f(a.sun.color), +a.sun.intensity.toFixed(3)],
    exposure:window.__app.renderer.toneMappingExposure,
    camFov:cam.fov, camPitch:+Math.asin(-cam.getWorldDirection(new cam.position.constructor()).y).toFixed(3),
  };
});
console.log(JSON.stringify(r,null,1));
await p.close(); process.exit(0);
