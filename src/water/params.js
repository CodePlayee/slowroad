// src/water/params.js — TUNABLES for rivers/water rendering. Owned by the WATER builder.
export const WATER = {
  maxLevel: 4,          // build water meshes for clipmap levels 0..maxLevel
  resDiv: 1,            // water grid = terrain res / resDiv
  // Lit albedo, not final colour. Deep water stays green-dominant so the sky term
  // below supplies the blue (sr_03 open water: G/B ~0.8, never black from above).
  shallow: [0.170, 0.275, 0.230],
  deep: [0.036, 0.125, 0.105],
  alphaShallow: 0.50,
  alphaDeep: 0.95,
  depthFade: 2.6,       // metres over which shallow -> deep
  // Sky reflection = mix(reflectFloor, reflectMax, fresnel). The floor keeps a steep
  // look-down mirroring some scene sky; it scales with that sky, so it darkens at night.
  reflectFloor: 0.09,
  reflectMax: 0.72,
  roughness: 0.10,
  rippleScale: 26,      // metres per tile of the ripple normal map
  rippleStrength: 0.42,
  flowSpeed: 0.035,
};
