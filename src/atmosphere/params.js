// src/atmosphere/params.js — TUNABLES for sky, light, fog, seasons.
//
// SKY RAMPS ARE NOT ARBITRARY. Every entry was solved backwards from a measured pixel in
// refs/slowroads/official/ through the exact display transform in tonemap.js, so that
// e.g. the clear-day sky at 12 deg elevation lands on #8ab9ef S0.42 V0.94 (sr_01) and the
// horizon on #9acbfc S0.39 V0.99. See src/atmosphere/TARGETS.md for the full table and
// /tmp/gauntlet-atmo/invert.mjs for the solver. Values are LINEAR scene-referred
// radiance; do not eyeball-edit them without re-checking against TARGETS.md.
//
// Ramps are keyed on SUN ELEVATION IN RADIANS, not on clock time, so they behave
// correctly for every season and latitude. Reference elevations:
//   1.21  summer noon (t=12)        0.50  autumn 09:50      0.42  summer 17:12
//   0.21  summer 18:24 golden       0.13  spring 06:06 dawn 0.00  sunrise/sunset
//  -0.10  blue hour                -0.34  summer 22:30 night
//
// Owned jointly by the ATMOSPHERE / DAYCYCLE / SEASON builder agents.

export const ATMO = {
  latitude: 44 * Math.PI / 180,
  exposure: 1.0,               // held constant; time-of-day brightness lives in the ramps

  sunPeak: 2.40,               // keep low-sun foreground contrast below the white haze ceiling
  moonPeak: 0.31,              // keep low-angle/moonlit silhouettes readable without lifting the sky
  hemiPeak: 0.40,              // retain readable foliage silhouettes after sunset
  ambientPeak: 0.105,

  // ---- haze / aerial perspective -----------------------------------------------
  // layer A: the broad exponential air column. e-folds over 1/0.0021 = ~476 m.
  //
  // DENSITY IS SOLVED FROM THE REFERENCE, not guessed. Inverting V = a + f*(1-a) on
  // sr_03's four ridge steps (V0.66 @ ~1.5 km, V0.87 @ ~3 km, V0.93 @ ~5 km over an
  // albedo of ~0.30) gives f = 0.51 / 0.81 / 0.90, hence optical depths 0.71 / 1.66 /
  // 2.30 and a consistent D ~= 5.0e-4 for the HAZY case. The same inversion on sr_01
  // (clear) gives D ~= 2.2e-4. An earlier value of 8.2e-4 put the 2 km mark at 97%
  // extinction — everything past the middle distance turned into one white wall, which
  // is the exact failure the piece exists to fix.
  hazeBaseY: 4,
  hazeFalloff: 0.0024,
  // Keep the far field open enough for several ridge steps to survive; the
  // shader material supplies the additional blue-green separation at range.
  // A slightly denser daytime aerial column keeps the valley's 3-5 ridge
  // layers blue-gray and separated instead of leaving a saturated blue strip.
  hazeDensityDay: 0.000210,
  hazeDensityDawn: 0.00046,
  hazeDistanceDay: 0.0000200,  // leave two to three blue-gray ridge steps readable
  hazeDistanceDawn: 0.0000310,
  // layer B: shallow valley mist. e-folds over 1/0.019 = ~53 m, so it fills hollows and
  // leaves ridges above it crisp. Only switched on near dawn/dusk and in bad weather.
  mistFalloff: 0.019,
  mistBaseY: 2,
  mistDensityDawn: 0.0075,
  mistDensityNight: 0.0026,
  // aerial: x = chroma loss with distance, y = dark-pixel mix exponent (<1 = darks fog
  // out first, which flattens local contrast before it flattens value), z = mist tint
  // blend, w = haze gain
  aerialDesat: 0.80,
  aerialDarkPow: 0.70,
  mistTintBlend: 0.55,
  aerialMixGamma: 3.0,   // preserve value steps between successive distant ridges

  // ---- grade -------------------------------------------------------------------
  gradeSat: 1.07,
  gradeSlope: 1.0,
  gradePower: 1.0,
  vignetteDay: 0.13,
  vignetteNight: 0.40,
  vignetteRadius: 0.78,
  dither: 1.0,

  shadow: {
    enabled: false,
    mapSize: 2048,
    extent: 145,
    near: 1,
    far: 620,
    bias: -0.00035,
    normalBias: 0.18,
  },

  // ================= sky colour ramps (LINEAR radiance) ==========================
  // zenith / mid / horizon-away-from-sun / horizon-toward-sun
  zenithRamp: [
    [-0.45, [0.0050, 0.0046, 0.0076]],
    [-0.30, [0.0056, 0.0054, 0.0098]],
    [-0.22, [0.0072, 0.0078, 0.0162]],
    [-0.10, [0.0300, 0.0480, 0.1150]],
    [-0.03, [0.0750, 0.0750, 0.2600]],
    [0.04, [0.0480, 0.0850, 0.4000]],
    [0.13, [0.0480, 0.1150, 0.5800]],
    [0.21, [0.0450, 0.1300, 0.7200]],
    [0.42, [0.0360, 0.1550, 1.0500]],
    [0.60, [0.0330, 0.1500, 1.1000]],
    [1.25, [0.0300, 0.1400, 1.1000]],
  ],
  midRamp: [
    [-0.45, [0.0062, 0.0060, 0.0102]],
    [-0.30, [0.0070, 0.0072, 0.0128]],
    [-0.22, [0.0088, 0.0098, 0.0192]],
    [-0.10, [0.0420, 0.0620, 0.1300]],
    [-0.03, [0.3400, 0.1800, 0.3100]],
    [0.04, [0.3200, 0.2200, 0.4000]],
    [0.13, [0.2700, 0.2500, 0.5600]],
    [0.21, [0.3000, 0.4200, 1.1500]],
    [0.30, [0.2100, 0.4400, 1.5500]],
    [0.42, [0.1400, 0.4600, 1.9500]],
    [0.60, [0.1350, 0.4700, 1.9000]],
    [1.25, [0.1250, 0.4550, 1.9500]],
  ],
  horizonRamp: [
    [-0.45, [0.0088, 0.0086, 0.0132]],
    [-0.30, [0.0100, 0.0102, 0.0168]],
    [-0.22, [0.0118, 0.0130, 0.0235]],
    [-0.10, [0.0600, 0.0750, 0.1400]],
    [-0.03, [0.4800, 0.2800, 0.3600]],
    [0.04, [0.5800, 0.3600, 0.4400]],
    [0.13, [0.5600, 0.4200, 0.5600]],
    [0.21, [0.5400, 0.5000, 0.9000]],
    [0.30, [0.4200, 0.6300, 2.5000]],
    [0.42, [0.1600, 0.6000, 4.1000]],
    [0.60, [0.1300, 0.5750, 4.3500]],
    [1.25, [0.1000, 0.5500, 4.6000]],
  ],
  // Must never end up magenta: G has to sit between R and B or the whole low sky turns
  // pink once the wedge is applied (this cost one iteration).
  sunHazeRamp: [
    [-0.45, [0.0102, 0.0098, 0.0150]],
    [-0.22, [0.0450, 0.0330, 0.0300]],
    [-0.10, [0.3600, 0.2100, 0.1050]],
    [-0.03, [1.7000, 0.4500, 0.1500]],
    [0.04, [1.6500, 0.5000, 0.1500]],
    [0.13, [1.5000, 0.6000, 0.2400]],
    [0.21, [1.4000, 0.5500, 0.2000]],
    [0.30, [1.4000, 1.1500, 2.6000]],
    [0.42, [0.9000, 1.1000, 5.0000]],
    [0.60, [0.8000, 1.0500, 5.1000]],
    [1.25, [0.7000, 1.0000, 5.2000]],
  ],
  // colour of the sun itself (normalised); magnitude comes from sunAureoleRamp/discRamp
  sunColorRamp: [
    [-0.25, [0.40, 0.16, 0.08]],
    [-0.10, [0.70, 0.26, 0.11]],
    [-0.03, [0.95, 0.38, 0.16]],
    [0.04, [1.00, 0.50, 0.24]],
    [0.13, [1.00, 0.45, 0.18]],
    [0.21, [1.00, 0.55, 0.22]],
    [0.42, [1.00, 0.94, 0.84]],
    [1.25, [1.00, 0.98, 0.95]],
  ],
  // Mie aureole magnitude and sun disc magnitude by elevation
  sunAureoleRamp: [
    [-0.22, [0.00, 0, 0]],
    [-0.10, [0.10, 0, 0]],
    [-0.03, [0.34, 0, 0]],
    [0.04, [0.55, 0, 0]],
    [0.13, [0.45, 0, 0]],
    [0.21, [0.38, 0, 0]],
    [0.42, [0.30, 0, 0]],
    [1.25, [0.20, 0, 0]],
  ],
  sunDiscRamp: [
    [-0.02, [0.0, 0, 0]],
    [0.01, [2.8, 0, 0]],
    [0.06, [3.6, 0, 0]],
    [0.13, [4.5, 0, 0]],
    [0.42, [8.0, 0, 0]],
    [1.25, [8.0, 0, 0]],
  ],
  // sky vertical profile exponent + sunward wedge exponent, by elevation.
  // Low sun -> smaller profile exponent (the dusk gradient reaches much higher up the
  // dome) and a much broader azimuthal wedge (sr_02's peach covers ~120 deg).
  // x = vertical profile exponent, y = position of the mid stop, z = sunward wedge
  // exponent (higher = narrower), w = sunward wedge amount.
  shapeRamp: [
    [-0.22, [1.55, 0.55, 0.95, 0.95]],
    [-0.03, [1.62, 0.55, 1.15, 0.94]],
    [0.13, [1.90, 0.55, 1.80, 0.90]],
    [0.21, [2.05, 0.55, 2.30, 0.82]],
    [0.42, [2.25, 0.55, 3.20, 0.68]],
    [1.25, [2.45, 0.55, 3.60, 0.60]],
  ],
  // the flat, near-achromatic colour an overcast sky converges on
  overcastRamp: [
    [-0.45, [0.0045, 0.0048, 0.0068]],
    [-0.22, [0.0100, 0.0110, 0.0140]],
    [-0.10, [0.0400, 0.0430, 0.0520]],
    [-0.03, [0.1050, 0.1120, 0.1280]],
    [0.04, [0.2000, 0.2150, 0.2450]],
    [0.13, [0.4200, 0.4600, 0.5300]],
    [0.21, [0.6200, 0.6800, 0.7800]],
    [0.42, [1.1500, 1.3000, 1.5000]],
    [0.60, [1.4500, 1.6200, 1.8500]],
    [1.25, [1.7500, 1.9500, 2.2000]],
  ],
  // split tone applied in the display-encoded domain: cool shadows, warm highlights.
  gradeShadowRamp: [
    [-0.22, [0.96, 0.98, 1.07]],
    [-0.03, [0.965, 0.985, 1.06]],
    [0.13, [0.97, 0.99, 1.045]],
    [1.25, [0.985, 0.995, 1.02]],
  ],
  gradeHighRamp: [
    [-0.22, [1.02, 1.00, 1.02]],
    [-0.03, [1.07, 1.01, 0.96]],
    [0.13, [1.07, 1.01, 0.96]],
    [1.25, [1.01, 1.00, 1.00]],
  ],
};

export const SEASONS = {
  spring: {
    dayOfYear: 105,
    grassLush: [0.160, 0.315, 0.090], grassDry: [0.285, 0.300, 0.135],
    foliage: [[0.165, 0.300, 0.095], [0.230, 0.360, 0.120], [0.120, 0.230, 0.090]],
    conifer: [0.070, 0.150, 0.085],
    rock: [0.345, 0.320, 0.290], sand: [0.470, 0.425, 0.330],
    snowAmount: 0.0, snowLine: 900,
    fogTint: [1.0, 1.0, 1.0], density: 1.05, leafiness: 0.92,
    mist: 1.25,           // spring mornings are the mistiest
  },
  summer: {
    dayOfYear: 190,
    grassLush: [0.170, 0.340, 0.090], grassDry: [0.325, 0.325, 0.140],
    foliage: [[0.140, 0.270, 0.082], [0.190, 0.330, 0.102], [0.105, 0.205, 0.070]],
    conifer: [0.062, 0.150, 0.082],
    rock: [0.365, 0.340, 0.305], sand: [0.500, 0.450, 0.340],
    snowAmount: 0.0, snowLine: 1100,
    fogTint: [1.0, 1.0, 1.0], density: 1.0, leafiness: 1.0,
    mist: 0.75,
  },
  autumn: {
    dayOfYear: 288,
    grassLush: [0.240, 0.265, 0.112], grassDry: [0.375, 0.295, 0.125],
    foliage: [[0.440, 0.215, 0.045], [0.530, 0.340, 0.070], [0.300, 0.115, 0.040]],
    conifer: [0.065, 0.135, 0.080],
    rock: [0.360, 0.325, 0.290], sand: [0.485, 0.420, 0.315],
    snowAmount: 0.0, snowLine: 620,
    fogTint: [1.04, 0.99, 0.93], density: 1.25, leafiness: 0.82,
    mist: 1.4,
  },
  winter: {
    dayOfYear: 15,
    grassLush: [0.205, 0.225, 0.185], grassDry: [0.340, 0.350, 0.325],
    foliage: [[0.190, 0.205, 0.220], [0.235, 0.255, 0.280], [0.150, 0.170, 0.195]],
    conifer: [0.055, 0.105, 0.105],
    rock: [0.395, 0.385, 0.375], sand: [0.455, 0.440, 0.410],
    snowAmount: 1.0, snowLine: -20,
    fogTint: [0.93, 0.98, 1.05], density: 1.45, leafiness: 0.18,
    mist: 1.25,
  },
};

// haze  — multiplier on layer A density and the flat distance term
// sun   — multiplier on direct sunlight
// cloud — [lowCover, lowOpacity, cirrusCover, cirrusOpacity]
// grey  — how far the sky stops are pulled toward `overcastRamp` (0 = clear sky)
// gain  — multiplier on the clear-sky stops before greying
// soft  — cloud edge softness (1 = crisp cumulus, 0 = diffuse stratus)
// mist  — multiplier on the valley mist layer
// sat   — extra chroma multiplier applied to the sky stops
export const WEATHER = {
  clear: {
    haze: 1.0, fog: 1.0, sun: 1.0, grey: 0.0, gain: 1.0, mist: 1.0, sat: 1.0, soft: 0.85,
    // Clear reference frames are mostly open sky. Keep a few wisps without
    // turning the dome into a repeated streak field.
    cloud: [0.08, 0.17, 0.09, 0.06],
  },
  hazy: {
    haze: 1.80, fog: 1.80, sun: 0.90, grey: 0.05, gain: 1.06, mist: 1.6, sat: 0.94, soft: 0.55,
    cloud: [0.26, 0.30, 0.40, 0.20],
  },
  overcast: {
    haze: 2.7, fog: 2.7, sun: 0.10, grey: 0.94, gain: 1.0, mist: 1.5, sat: 0.55, soft: 0.10,
    cloud: [0.92, 0.90, 0.15, 0.0],
  },
  storm: {
    haze: 3.6, fog: 3.6, sun: 0.05, grey: 0.985, gain: 0.55, mist: 2.4, sat: 0.42, soft: 0.05,
    cloud: [1.0, 0.96, 0.0, 0.0],
  },
};
