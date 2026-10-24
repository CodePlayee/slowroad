// src/rig/rig.js — window.__rig: the deterministic capture contract every critic and
// builder agent depends on. DO NOT change the shape of this API without updating
// gauntlet/RIG.md and gauntlet/shoot.mjs.

export function installRig(app) {
  const rig = {
    version: 1,

    /**
     * Resolves only when the world around the camera is fully resident at final LOD
     * and >= `frames` frames have been rendered since. Throws (rejects) on timeout —
     * never resolves on a half-loaded frame.
     */
    async ready({ timeoutMs = 120000, frames = 22, stableFrames = 3 } = {}) {
      const t0 = performance.now();
      let assetTimer;
      try {
        await Promise.race([
          Promise.all([app.vehicle.assetPromise, app.terrain.assetPromise, app.veg.assetPromise]),
          new Promise((_, reject) => { assetTimer = setTimeout(() => reject(new Error('scene asset load timeout')), timeoutMs); }),
        ]);
      } finally { clearTimeout(assetTimer); }
      if (app.vehicle.assetError) throw new Error(app.vehicle.assetError);
      if (app.terrain.assetError) throw new Error(app.terrain.assetError);
      if (app.veg.assetError) throw new Error(app.veg.assetError);
      app.forceDrain = true;
      let stable = 0;
      for (;;) {
        await app.nextFrame();
        if (app.fatal || app.scheduler.error) {
          app.forceDrain = false;
          throw new Error(app.fatal || app.scheduler.error);
        }
        if (app.residencyOk()) stable++; else stable = 0;
        if (stable >= stableFrames) break;
        if (performance.now() - t0 > timeoutMs) {
          app.forceDrain = false;
          throw new Error('rig.ready timeout after ' + Math.round(performance.now() - t0) +
            'ms: ' + JSON.stringify(app.residencyReport()));
        }
      }
      app.forceDrain = false;
      const target = app.frameNo + frames;
      while (app.frameNo < target) {
        await app.nextFrame();
        if (performance.now() - t0 > timeoutMs) throw new Error('rig.ready frame-settle timeout');
      }
      return { ok: true, ms: Math.round(performance.now() - t0), ...app.residencyReport() };
    },

    async set(opts = {}) {
      await app.applySettings(opts);
      return rig.ready();
    },

    async teleport(km) {
      app.teleport(Number(km) || 0);
      return rig.ready();
    },

    hideUI() { app.hud.hide(); return true; },
    showUI() { app.hud.show(); return true; },

    stats() {
      const info = app.renderer.info;
      const v = app.vehicle;
      return {
        fps: Math.round(app.stats.fps * 10) / 10,
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        programs: info.programs ? info.programs.length : 0,
        km: Math.round(v.km * 1000) / 1000,
        pos: [Math.round(v.pos.x * 100) / 100, Math.round(v.pos.y * 100) / 100, Math.round(v.pos.z * 100) / 100],
        heading: Math.round(v.heading * 1000) / 1000,
        cam: app.cameras.mode,
        seed: app.world.seedInput,
        t: app.atmo.time,
        season: app.atmo.seasonName,
        weather: app.atmo.weatherName,
        residency: app.residencyReport(),
      };
    },

    async findBridge(fromKm = 0) {
      const km = app.world.findBridgeKm(Number(fromKm) || 0);
      return km === null ? null : Math.round(km * 1000) / 1000;
    },
    async findWater(fromKm = 0) {
      const km = app.world.findWaterKm(Number(fromKm) || 0);
      return km === null ? null : Math.round(km * 1000) / 1000;
    },
    async findVista(fromKm = 0) {
      const km = app.world.findVistaKm(Number(fromKm) || 0);
      return km === null ? null : Math.round(km * 1000) / 1000;
    },

    pause() { app.paused = true; return true; },
    resume() { app.paused = false; return true; },

    /**
     * Force the exact deterministic frame for the current parameters: re-place the
     * car at its requested km, snap the camera, zero the wall-clock animation
     * clocks (water flow, cloud drift). Call this after pause() before capturing —
     * shoot.mjs does it for you. Idempotent.
     */
    snap() { app.resnap(); return true; },

    // -------- extras that make critic scripts easier (not part of the contract) --------
    bridges() {
      return app.world.route.bridges.map((b) => ({
        km: Math.round(b.km * 1000) / 1000, width: Math.round(b.W * 10) / 10,
        length: Math.round(b.L * 10) / 10, spans: b.nSpans,
        deckDepth: Math.round(b.deckDepth * 100) / 100, waterY: Math.round(b.waterY * 100) / 100,
      }));
    },
    params() { return app.paramSnapshot(); },
    error() { return app.fatal || app.scheduler.error || app.vehicle.assetError || app.terrain.assetError || app.veg.assetError || null; },
  };

  window.__rig = rig;
  return rig;
}
