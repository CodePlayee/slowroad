// src/vehicle/params.js — TUNABLES for the car and autodrive. Owned by the JOURNEY builder.
export const VEHICLE = {
  bodyLength: 4.79,
  bodyWidth: 1.982,
  wheelRadius: 0.36,
  wheelWidth: 0.28,
  wheelbase: 2.89,
  trackWidth: 1.63,
  rideHeight: 0.145,

  bodyColor: 0xe9edf0,
  glassColor: 0x101820,
  tyreColor: 0x14161a,
  rimColor: 0x59636d,

  laneOffset: 1.72,      // metres right of the centreline (drive on the right)
  cruiseKph: 88,
  maxKph: 108,
  minKph: 42,
  latAccel: 3.1,         // m/s^2 comfort limit -> slows for corners
  cornerSpan: 22,        // m of road whose mean curvature sets a corner's comfort speed
  cornerDecel: 1.5,      // m/s^2 planned deceleration toward a slower corner
  accel: 3.2,            // m/s^2 traction limit of the autodrive
  brake: 5.0,            // m/s^2 braking limit of the autodrive
  speedLag: 0.5,         // s, speed error -> acceleration demand
  jerk: 2.5,             // m/s^3, rate limit of the acceleration demand
  headlightsFrom: 0.06,  // dayness below this -> lights on

  // Lateral dynamics (handling.js): linear single-track model of a Model Y
  // class crossover with a preview driver.
  handling: {
    mass: 2000,           // kg, kerb mass with driver
    frontShare: 0.47,     // static load on the front axle
    yawInertia: 3900,     // kg m^2 (about 0.95 m a b)
    corneringFront: 85000, // N/rad per axle (both tyres)
    corneringRear: 135000, // N/rad per axle; ~1.9 deg/g understeer
    relaxation: 0.5,      // m, tyre relaxation length
    anticipation: 0.4,    // s, the driver reads the bend ahead by its steering and yaw lags
    curvatureSpan: 22,    // m of lane whose mean curvature the driver steers for
    previewTime: 1.0,     // s, an offset or heading error is steered out over this reach
    previewMin: 15,       // m, shortest such reach
    steerLag: 0.15,       // s, driver steering lag
    minSpeed: 3,          // m/s, the model's speed floor
    substep: 1 / 240,     // s, fixed integration step
  },

  // Sprung body on four spring-dampers (suspension.js). Corner rates, the
  // anti-roll bars and the body inertias are derived from these targets.
  suspension: {
    sprungMass: 1750,     // kg
    heaveHz: 1.3,         // body bounce natural frequency
    heaveDamping: 0.38,   // bounce damping ratio (sets the four damper rates)
    pitchHz: 1.5,         // pitch natural frequency (sets the pitch inertia)
    rollHz: 1.65,         // roll natural frequency (sets the roll inertia: ~850 kg m^2 about the roll axis)
    cgHeight: 0.52,       // m above the road (floor battery)
    rollCentre: 0.10,     // m above the road
    rollGradient: 4.5,    // deg of body roll per g of steady lateral acceleration
    antiDive: 0.15,       // share of the braking pitch load taken by the linkages
    antiSquat: 0.25,      // share of the driving pitch load taken by the linkages
    bump: 0.07,           // m of compression to the bump stops
    rebound: 0.08,        // m of extension to the rebound stops
    bumpStop: 8,          // stop rate as a multiple of the wheel rate
    roughness: 0.0015,    // m, road texture amplitude of the longest octave
    roughnessCorrelation: [0.75, 0.35], // left/right track correlation of the 11 m and 4.3 m octaves
    contactPatch: 0.25,   // m, half length over which a tyre averages the road
    substep: 1 / 240,     // s, fixed integration step
  },

  // Low-beam headlight: one SpotLight shaped by a projected intensity cookie
  // (lamps.js). The cookie holds road illuminance nearly level over a long
  // throw, fades the lateral edges over ~20 deg, cuts off at the horizon and
  // dims rays that land beyond the paved edges, so verges, cut slopes and
  // walls near lamp height stay in the road's irradiance range.
  headlight: {
    mountY: 0.73,        // vehicle-local lamp height; road is at -rideHeight
    intensity: 200,      // candela in the hot zone (cookie value 1)
    angle: 0.62,         // cone half-angle; the cookie defines the beam inside it
    penumbra: 0.2,
    decay: 1,
    distance: 150,
    fullThrow: 30,       // metres of road at which the cookie reaches 1
    throwPower: 0.8,     // cookie ~ distance^p below the hot zone
    nearStart: 1.5, nearEnd: 7, nearFloor: 0.45, // foreground taper (metres of road)
    cutoff: -0.016,      // tan(elevation) where the cut-off starts (road ~55 m out)
    cutoffSoft: 0.018,   // tan span of the cut-off ramp; spill is reached at the horizon
    kerbRise: 0.006,     // kerb-side cut-off raised a little (drive on the right)
    kerbWidth: 0.15,
    spill: 0.04,         // stray light above the cut-off
    coreLeft: 0.14, edgeLeft: 0.60,    // tan(azimuth) of full / zero lateral light
    coreRight: 0.22, edgeRight: 0.68,
    // Road-plane footprint: lateral metres (from the lamp axis) where the beam
    // starts to fade past the paved edges (kerb 2.36 m, far edge 5.8 m), its
    // growth with ray distance (curve tolerance), fade width and floor.
    vergeKerb: 2.5, vergeFar: 6.0, vergeGrow: 0.01,
    vergeSoft: 1.0, vergeSoftGrow: 0.03, vergeFloor: 0.05,
    horizonTan: 1e-4,    // rays at/above the horizon use this road distance
    // Half-float RGBA; 1024 columns keep the verge fade free of texel steps.
    cookieWidth: 1024, cookieHeight: 512,
  },
  // Tail lamps: emissive lens/internals plus a faint red spill on the road and
  // the rear bodywork from a short-range point light behind the bumper.
  tailLight: {
    color: 0xff1e0e,
    emissive: 3.5,       // night emissive intensity of lens and internals
    spill: 0.8,          // point light intensity (cd)
    distance: 6,
    position: [0, 0.95, -3.0],
  },
  headlampEmissive: 3.0, // night emissive intensity of the head lamp strip
};
