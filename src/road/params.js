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
  gradeWeight: 6500,       // punish steep grades hard: this is a scenic road; the
                           // 0.3-3 km rolling hills (TERRAIN.roll*) need it to keep
                           // the walk on the 7.5 % contours instead of cut/fill
  turnWeight: 62,
  turnChangeWeight: 210,
  riverAlongWeight: 3.4,   // punish running *along* a river; crossing square is fine
  riverAheadScale: 13,     // x that again at the look-ahead probe (route.js _sideTerm):
                           // the landform terms would otherwise win and cross obliquely
  headingWeight: 26,
  wanderFreq: 0.000085,    // how fast the intended bearing drifts
  wanderAmp: 1.15,
  headingSlack: 1.2,       // radians off the drifting bearing before the barrier bites
  headingBarrier: 300,     // per rad^2 beyond the slack: the walk never loops back
  // ---- landform: hillside shelves over valley-floor corridors ----
  // Each step probes the cross profile and the land ahead `sideAhead` m along
  // the candidate arc (route.js _sideTerm).  Heights are natural ground relative
  // to the probe point; the eye is the chase/driver camera height.
  sideAhead: 132,          // ~6 steps on: the 9-candidate fan has spread to ~±55 m
  sideNear: 45,            // lateral probes either side
  sideFar: 150,
  sideEye: 2.6,
  troughWeight: 3,         // per metre both sides stand above the road (valley floor)
  openWeight: 3.5,         // per metre one side falls away in plain view (hillside)
  openMax: 30,             // metres; caps the trough and hillside terms
  viewNear: 400,           // forward probes along the candidate heading
  viewFar: 1000,
  viewWeight: 1.5,         // per metre the land ahead falls away in plain view
  viewMax: 60,
  maxGrade: 0.075,         // 7.5 % hard cap after profile smoothing
  profileCut: 2.5,         // smoothed road may sit this far below the ground (cuttings
                           // wall the view in; fills open it) ...
  profileFill: 10.5,       // ...or this far above it, before the final grade limit
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
