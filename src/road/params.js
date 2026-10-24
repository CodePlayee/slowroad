// src/road/params.js — TUNABLES for the route + the ribbon. Owned by the ROAD builder.

export const ROAD = {
  // ---- geometry (metres) ----
  laneWidth: 3.5,
  lanes: 2,
  shoulderWidth: 0.58,     // gravel/asphalt shoulder outside the edge line
  vergeWidth: 3.8,         // graded grass apron carried by the road mesh
  crown: 0.022,            // 2.2 % camber each way from the centreline
  surfaceLift: 0.045,      // road mesh sits this far above the graded terrain

  edgeLineWidth: 0.14,
  centreLineWidth: 0.11,
  centreDashLen: 4.0,
  centreDashGap: 6.0,

  // ---- routing ----
  step: 22,                // metres between raw route samples
  resample: 5.5,           // metres between final (arc-length) samples
  maxTurnPerStep: 0.105,   // radians per `step` -> min radius ~210 m
  candidates: 9,
  gradeWeight: 1750,       // punish steep grades hard: this is a scenic road
  turnWeight: 62,
  turnChangeWeight: 210,
  altitudeWeight: 0.040,   // seek valleys / low ground
  riverAlongWeight: 3.4,   // punish running *along* a river; crossing square is fine
  headingWeight: 26,
  wanderFreq: 0.000085,    // how fast the intended bearing drifts
  wanderAmp: 1.15,
  probeRadius: 340,        // radius of the "am I high?" test
  maxGrade: 0.075,         // 7.5 % hard cap after profile smoothing
  profileSmoothPasses: 26, // heavy: gives long vertical curves
  planSmoothPasses: 5,

  // ---- extent ----
  aheadMetres: 26000,      // route generated this far ahead of the start
  behindMetres: 3000,

  // ---- terrain blending (cut & fill) ----
  cutSlope: 0.72,          // 1 : 1.4  (rock cut above the road)
  fillSlope: 0.5,          // 1 : 2    (embankment below the road)
  blendSoftness: 3.2,      // metres of smooth-min rounding at the daylight line
  carveOuter: 62,          // beyond this distance terrain is untouched
};
