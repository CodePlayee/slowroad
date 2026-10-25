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
  accel: 3.2,
  brake: 5.0,
  headlightsFrom: 0.06,  // dayness below this -> lights on

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
