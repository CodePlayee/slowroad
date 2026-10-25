// src/camera/params.js — TUNABLES for camera framing. Owned by the JOURNEY builder.
// Chase framing is matched to the official Slow Roads chase shots (CAMERA_DRIFT.md):
// raised eye looking slightly down, horizon at ~0.29 of frame height, car about
// 1/8 of frame width in the lower quarter, falling ground and far ridges above it.
export const CAMERAS = {
  near: 0.35,
  far: 24000,

  chase: {
    fov: 54,
    back: 13.0,         // metres behind the car
    up: 5.2,            // metres above the car origin at the nominal back distance; scales with it
    lookAhead: 19.0,    // metres of route ahead of the car for the aim point
    pitch: 12,          // degrees below horizontal on a level road (horizon at ~0.29 of frame height)
    lateral: 3.8,       // maximum lateral drift; both sides stay in the road corridor
    lag: 3.2,           // 1/s smoothing (0 = rigid)
    driftBack: 3.2,
    driftUp: 0.5,
    backPeriod: 660,    // metres travelled per cycle, not wall-clock animation
    upPeriod: 920,
    sidePeriod: 1000,
    minBack: 5.5,
    minUp: 1.9,
    // On a hillside road the aim leans toward the lower (open) side.
    open: {
      spacing: 20,      // metres of arc length between side-height nodes
      lateral: [40, 80, 130, 190, 250], // sample offsets either side of the centreline
      drop: 30,         // mean height difference (m) that gives the full lean
      smooth: 8,        // nodes: raised-cosine half width along the route
      aim: 4.0,         // metres the aim point moves sideways at full lean (~7.5 deg yaw)
    },
  },
  cockpit: {
    fov: 63,
    offset: [-0.345, 1.145, 0.18],
    lookAhead: 42,
    lookUp: 0.6,
  },
  cine: {
    fov: 34,
    back: 24,
    side: 34,
    up: 17,
    lookAhead: 55,
  },
  vista: {
    fov: 38,
    back: 16,
    up: 24,
    lookAhead: 260,
    lag: 2.0,
    clearLift: 12,      // vista has no side offset; it rises out of a crown instead
  },
  // Elevated rigs keep the eye and its sight line to the car out of tree crowns.
  // Each mode has a pose family f∈[0,1]: 1 is nominal; lower f orbits the cine
  // eye (same distance) toward straight behind the car, or raises the vista eye.
  // Per route node the largest f whose whole family below it is clear is kept,
  // then eroded and smoothed along arc length, so the pose stays a pure,
  // continuous function of s.
  canopy: {
    spacing: 5,         // metres of arc length between clearance nodes
    steps: 8,           // f is tested in 1/steps increments
    erode: 12,          // nodes: pull in this far before and after an obstruction
    smooth: 8,          // nodes: raised-cosine half width of the transition (< erode)
    crownBase: 0.2,     // crown cylinder starts at this fraction of tree height
    crownRadius: 0.5,   // fraction of rendered tree width
    eyePad: 1.5,        // metres the eye stays outside a crown (near plane, leaf cards)
    targetUp: 1.0,      // sight-line target above the car origin
    targetSkip: 4,      // ignore the last metres of the sight line at the car
    prefetch: 520,      // metres of route ahead whose tree tiles are generated in the background
    prefetchMs: 1.0,    // per-frame generation budget while driving
    maxTiles: 24,
  },
};
