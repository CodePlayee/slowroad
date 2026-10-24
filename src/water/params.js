// src/water/params.js — TUNABLES for rivers/water rendering. Owned by the WATER builder.
export const WATER = {
  maxLevel: 4,          // build water meshes for clipmap levels 0..maxLevel
  resDiv: 1,            // water grid = terrain res / resDiv
  shallow: [0.150, 0.225, 0.215],
  deep: [0.022, 0.062, 0.090],
  alphaShallow: 0.46,
  alphaDeep: 0.94,
  depthFade: 2.6,       // metres over which shallow -> deep
  roughness: 0.10,
  rippleScale: 26,      // metres per tile of the ripple normal map
  rippleStrength: 0.42,
  flowSpeed: 0.035,
};
