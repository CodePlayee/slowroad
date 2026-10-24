// src/camera/params.js — TUNABLES for camera framing. Owned by the JOURNEY builder.
// Framing is matched to the official Slow Roads chase shots: car small, low in frame,
// horizon just above centre, road sweeping away.
export const CAMERAS = {
  near: 0.35,
  far: 24000,

  chase: {
    fov: 54,
    back: 12.6,         // metres behind the car
    up: 2.65,           // metres above the car origin
    lookAhead: 19.0,    // metres ahead of the car for the aim point
    lookUp: 0.40,
    lateral: 3.8,       // maximum lateral drift; both sides stay in the road corridor
    lag: 3.2,           // 1/s smoothing (0 = rigid)
    driftBack: 3.2,
    driftUp: 1.0,
    backPeriod: 660,    // metres travelled per cycle, not wall-clock animation
    upPeriod: 920,
    sidePeriod: 1000,
    minBack: 5.5,
    minUp: 1.9,
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
  },
};
