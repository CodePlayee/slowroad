import { smoothstep } from '../core/rng.js';

// Distances are metres from the road centreline and the camera respectively.
export const GRASS_COVERAGE = Object.freeze({
  roadStart: 4.2, roadFull: 4.85, roadFadeStart: 16, roadEnd: 28,
  // Keep readable roadside blades fully present; only the distant, small-scale
  // coverage fades. The population ring must extend beyond this entire band.
  viewFadeStart: 96, viewEnd: 160,
});
export const GRASS_SNOW = Object.freeze({ exposureStart: 0.68, exposureFull: 0.85 });

export function grassWinterExposure(clump) {
  return Number.isFinite(clump) ? smoothstep(GRASS_SNOW.exposureStart, GRASS_SNOW.exposureFull, clump) : 0;
}

export function grassRoadCoverage(distance) {
  if (!Number.isFinite(distance)) return 0;
  return smoothstep(GRASS_COVERAGE.roadStart, GRASS_COVERAGE.roadFull, distance)
    * (1 - smoothstep(GRASS_COVERAGE.roadFadeStart, GRASS_COVERAGE.roadEnd, distance));
}

export function grassViewCoverage(distance) {
  return Number.isFinite(distance)
    ? 1 - smoothstep(GRASS_COVERAGE.viewFadeStart, GRASS_COVERAGE.viewEnd, distance) : 0;
}

const f = key => GRASS_COVERAGE[key].toFixed(2);
export const GRASS_COVERAGE_GLSL = /* glsl */`
float grassRoadCoverage(float roadDistance) {
  return smoothstep(${f('roadStart')}, ${f('roadFull')}, roadDistance)
    * (1.0 - smoothstep(${f('roadFadeStart')}, ${f('roadEnd')}, roadDistance));
}
float grassViewCoverage(float viewDistance) {
  return 1.0 - smoothstep(${f('viewFadeStart')}, ${f('viewEnd')}, viewDistance);
}
float grassWinterExposure(float clump) {
  return smoothstep(${GRASS_SNOW.exposureStart.toFixed(2)}, ${GRASS_SNOW.exposureFull.toFixed(2)}, clump);
}
`;
