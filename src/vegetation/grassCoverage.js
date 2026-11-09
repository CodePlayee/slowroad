import { smoothstep } from '../core/rng.js';

// Distances are metres from the road centreline and the camera respectively.
export const GRASS_COVERAGE = Object.freeze({
  // Grass roots begin past the bare dirt/gravel shoulder (terrain roadScuff*).
  roadStart: 4.55, roadFull: 5.4,
  // The outer edge follows the world-space clump field instead of a fixed
  // offset: dense patches run out to roadEnd, sparse ones recede to roadEndNear,
  // each over roadFadeWidth. The ~12 m clump patches make the edge meander
  // rather than form a straight band parallel to the road; roadEnd stays the
  // hard population limit.
  roadEndNear: 18, roadEnd: 31, roadFadeWidth: 10, roadEdgeClump: [0.22, 0.78],
  // Keep readable roadside blades fully present; only the distant, small-scale
  // coverage fades. The population ring must extend beyond this entire band.
  viewFadeStart: 96, viewEnd: 160,
});
export const GRASS_SNOW = Object.freeze({ exposureStart: 0.68, exposureFull: 0.85 });

export function grassWinterExposure(clump) {
  return Number.isFinite(clump) ? smoothstep(GRASS_SNOW.exposureStart, GRASS_SNOW.exposureFull, clump) : 0;
}

export function grassRoadCoverage(distance, clump = 0.5) {
  if (!Number.isFinite(distance)) return 0;
  const c = GRASS_COVERAGE, edge = smoothstep(c.roadEdgeClump[0], c.roadEdgeClump[1], Number.isFinite(clump) ? clump : 0.5);
  const end = c.roadEndNear + (c.roadEnd - c.roadEndNear) * edge;
  return smoothstep(c.roadStart, c.roadFull, distance) * (1 - smoothstep(end - c.roadFadeWidth, end, distance));
}

export function grassViewCoverage(distance) {
  return Number.isFinite(distance)
    ? 1 - smoothstep(GRASS_COVERAGE.viewFadeStart, GRASS_COVERAGE.viewEnd, distance) : 0;
}

const f = key => GRASS_COVERAGE[key].toFixed(2);
export const GRASS_COVERAGE_GLSL = /* glsl */`
float grassRoadCoverage(float roadDistance, float clump) {
  float grassEdgeEnd = mix(${f('roadEndNear')}, ${f('roadEnd')},
    smoothstep(${GRASS_COVERAGE.roadEdgeClump[0].toFixed(2)}, ${GRASS_COVERAGE.roadEdgeClump[1].toFixed(2)}, clump));
  return smoothstep(${f('roadStart')}, ${f('roadFull')}, roadDistance)
    * (1.0 - smoothstep(grassEdgeEnd - ${f('roadFadeWidth')}, grassEdgeEnd, roadDistance));
}
float grassViewCoverage(float viewDistance) {
  return 1.0 - smoothstep(${f('viewFadeStart')}, ${f('viewEnd')}, viewDistance);
}
float grassWinterExposure(float clump) {
  return smoothstep(${GRASS_SNOW.exposureStart.toFixed(2)}, ${GRASS_SNOW.exposureFull.toFixed(2)}, clump);
}
`;
