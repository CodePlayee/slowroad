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
  // distant crest shaping is applied in the terrain vertex shader only; keeping it
  // out of the analytic field preserves route/bridge/river contracts.
  // shader-only distant contour lift: enough to keep successive ridges visible
  // in the wide vista, while fading before the road/cockpit near field.
  farRidgeAmp: 104,
  farRidgeNear: 680,
  farRidgeFar: 5200,
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
  // The road mesh owns the paved shoulder; these bands keep the adjacent
  // ground from reading as a single flat tan apron once it fades into fields.
  // Keep wear close to the pavement; world-space grain breaks up the turf edge.
  roadScuffInner: 4.15,
  roadScuffOuter: 7.5,
  roadContactDarken: 0.19,
  terrainLayerStrength: 0.58,
};
