// src/terrain/params.js — TUNABLES for landform. Safe to edit values here without
// touching structure. Owned by the TERRAIN builder agent.

export const TERRAIN = {
  // ---- streaming / mesh resolution ----
  chunkSize: 128,          // metres, level 0
  levels: 7,               // clipmap levels: 128,256,...,8192 m
  ringRadius: 2,           // chunks each side of camera per level (=> 5x5)
  // Keep the two near-road rings dense; distant rings cover much larger areas
  // and use progressively fewer samples. This follows clipmap LOD practice:
  // screen-space detail is preserved nearby while far geometry costs fall
  // quadratically with resolution.
  // The road mesh supplies the high-frequency corridor. Terrain rings can use a
  // coarser adaptive sample without visible road degradation, and this keeps one
  // streamed tile build below a frame on the main thread.
  resByLevel: [24, 24, 20, 16, 12, 10, 8],
  // Road-adjacent level 0/1 tiles use a fine grid so broad triangles cannot
  // chord through the paved corridor.  Water deliberately keeps resByLevel.
  nearRoadLevels: 2,
  nearRoadCell: 2,
  nearRoadMargin: 28,
  skirtDepth: 60,          // metres the edge skirt drops, hides LOD cracks
  coverageRadius: 3,       // full coarse tiles, including the centre, past the far plane
  uploadTilesPerFrame: 2,
  cacheTiles: 384,
  cacheBytes: 128 * 1024 * 1024,
  cacheSeconds: 8,
  morphSeconds: 0.25,

  // ---- macro landform ----
  continentFreq: 0.000075, // ~13 km wavelength: which region is high / low
  continentAmp: 250,
  reliefFreq: 0.00012,     // where the land is dramatic vs gentle
  reliefSpread: 0.92,      // widen this and ridges appear in more places
  hillsFreq: 0.00046,      // ~2.2 km: the main rolling hills
  hillsAmp: 108,
  hillsWarp: 0.8,
  ridgeFreq: 0.00054,      // ridgelines, only inside high-relief regions
  ridgeAmp: 205,
  ridgeReliefLo: 0.44,
  ridgeReliefHi: 0.76,
  // Rolling hills (heightfield.js _roll): rounded swells on the 0.3-3 km scale that
  // stand above the river table and fade out towards the channels, so rivers keep
  // the valley floors.  Height = rollAmp * (floor + (1 - floor) * relief)
  // * smoothstep(n) * fade, n = warped fbm in [0, 1]: 0..~130 m hills ~1.7 km apart.
  // Raising rollAmp past ~130 steepens the flanks beyond what the 7.5 % route can
  // follow (cut/fill and oblique multi-span crossings grow; see landform-audit).
  rollFreq: 0.0006,
  rollOctaves: 3,
  rollWarp: 0.55,
  rollAmp: 130,
  rollReliefFloor: 0.5,
  rollValleyNear: 140,     // channel distance (m) where the swells start ...
  rollValleyFar: 800,      // ... and where they reach full height
  // distant crest shaping is applied in the terrain vertex shader only; keeping it
  // out of the analytic field preserves route/bridge/river contracts.
  // Shader-only distant ridge lift (terrain.js FAR_RIDGE_GLSL, mirrored bit-for-bit
  // by vegetation/forestField.js). Nonnegative and bounded by
  // farRidgeAmp * smoothstep(farRidgeNear, farRidgeFar, d), so culling pads stay valid.
  // Zero inside farRidgeNear: road, grass and near trees keep the analytic surface.
  farRidgeAmp: 600,
  farRidgeNear: 1200,
  farRidgeFar: 8500,
  // Crest trains are weighted by farRidgeBase + (1 - base) * shape: the base term is
  // a broad rise that lets each farther row clear the nearer one (layered skylines).
  farRidgeBase: 0.3,
  // Inside the streamed road/water range only ground above the eye is lifted, and
  // only by farRidgeNearScale of the full height, so the unlifted road ribbon and
  // river meshes in the valley stay on their ground. Both gates open past
  // farRidgeOpen[1] (no ribbon beyond 3.4 km, no water meshes past clipmap L4).
  farRidgeNearScale: 0.06,
  farRidgeRamp: [3000, 5600],
  farRidgeHill: [-30, 140],      // metres relative to the camera height
  farRidgeHillFloor: 0.25,
  farRidgeOpen: [3600, 6000],
  midFreq: 0.0022,         // 450 m undulation
  midAmp: 15.5,
  mid2Freq: 0.0062,        // 160 m undulation
  mid2Amp: 4.6,
  detailFreq: 0.0125,      // 80 m texture
  detailAmp: 2.4,
  baseOffset: 55,          // metres, keeps most ground above 0

  // ---- rivers ----
  riverFreq: 0.00026,      // channel network wavelength (~3.8 km between rivers)
  riverOctaves: 3,
  riverGain: 0.36,
  riverGradMin: 1.9e-4,    // clamp so rivers don't vanish at noise saddles
  riverHalfWidthMin: 9,    // metres of *water* half width
  riverHalfWidthMax: 21,
  riverWidthFreq: 0.00035,
  channelDepth: 3.1,       // bed drop at centreline below the valley floor
  waterDepth: 1.9,         // water surface above deepest bed
  valleyHalfWidth: 168,    // metres of carved valley either side
  valleyDepth: 16,         // metres the valley floor sits below the smooth base

  // ---- surface classification ----
  moistureFreq: 0.00031,
  rockSlope: 0.62,         // above this slope -> rock
  snowLine: 265,           // winter snow starts (season scales this)
  treeLine: 430,

  // ---- material layering (shader-only, no extra terrain geometry) ----
  // The road mesh stops at its crumbled asphalt lip (half-pave + 0.08..0.22 m).
  // From there the terrain draws a bare dirt/gravel rim out to roadScuffInner
  // (centreline distance, ±0.6 m world-space raggedness), then turf roots in
  // tufts and is fully established by roadScuffOuter.
  roadScuffInner: 4.0,
  roadScuffOuter: 5.2,
  roadContactDarken: 0.19,
  terrainLayerStrength: 0.58,

  // ---- open-meadow sward field (shader-only; terrain turf and grass models) ----
  // World-space layer above the 2 m tussock / 9 m patch sward octaves: hay,
  // pale-green and dark-green patches plus wind-lodged swaths. The grass models
  // evaluate the same GLSL (meadowField.js) at their roots, so blades and turf
  // shift together. Strengths are blend weights toward fixed RGB tints.
  meadowWindDir: [0.765, 0.644], // unit lodging direction (x, z), matches grass sway
  meadowHayScale: 112,          // m, broad hay-vs-green octave
  meadowPatchScale: 41,         // m, secondary hay octave, fades with pixel footprint
  meadowGreenScale: 68,         // m, dark-green patch octave
  meadowHayStrength: 0.70,
  meadowGreenStrength: 0.70,
  meadowLodgeAlong: 96,         // m, lodged swath length along the wind
  meadowLodgeAcross: 17,        // m, swath width across the wind
  meadowLodgeMeander: 22,       // m, across-wind warp driven by the hay octave
  meadowSheen: 0.13,            // +/- luminance of lodged swaths (view-dependent grain)
};
