// src/vegetation/params.js — TUNABLES for plant cover. Owned by the VEGETATION builder.
//
// Layer plan (draw calls matter — every tile of every layer is >=1 call):
//   grassNear  fine blade cards, wind lean, tight to camera
//   grassFar   wider "mass" cards, cheap, carries the field to the mid-ground
//   shrub      bush / fern / tussock / flower — the layer that was MISSING and that
//              makes the transition from grass to trees read as a real edge
//   tree       3D card trees (spruce / pine / broadleaf), one draw call per species
//              per tile because ALL tree parts share one texture atlas
//   far        impostors drawn from the SAME layout schedule as the 3D trees, so the
//              silhouette matches across the swap
// Worker-safe variant metadata shared by foliage rendering and root contact.
export const SHRUB_VARIANTS = Object.freeze([
  Object.freeze({ key: 'shrub-0', winterBuried: false }), // woodland woody bush
  Object.freeze({ key: 'shrub-1', winterBuried: true }),  // fern
  Object.freeze({ key: 'shrub-2', winterBuried: true }),  // flowering verge shrub
  Object.freeze({ key: 'shrub-3', winterBuried: true }),  // dry tussock
  Object.freeze({ key: 'shrub-4', winterBuried: true }),  // verge woody bush
]);

export function shrubVariant(record) {
  const variant = Math.abs(record.variant || 0);
  return SHRUB_VARIANTS[variant < SHRUB_VARIANTS.length ? variant : variant % 2];
}

export const VEG = {
  layers: {
    // Keep the close ring crisp, then widen the cheaper cards/impostors so that
    // the shoulder transitions into a continuous near/mid/far plant mass rather
    // than dropping out at the first tile boundary.  The larger populations are
    // still instanced and deterministic, so streaming/residency contracts stay
    // unchanged while the distant hills gain readable silhouettes.
    // Keep instance density proportional to projected footprint.  The old 4,000
    // samples in every 34 m grass tile made one streamed tile a 100 ms main-thread
    // task; cards are cheap to draw but expensive to place because every sample
    // evaluates terrain slope and road clearance.
    grassNear: { tile: 34, radius: 2, perTile: 500, maxDist: 112 },
    grassFar: { tile: 104, radius: 2, perTile: 350, maxDist: 320 },
    shrub: { tile: 132, radius: 2, perTile: 600, maxDist: 380 },
    tree: { tile: 384, radius: 2, perTile: 1200, maxDist: 820 },
    far: { tile: 880, radius: 2, perTile: 3000, maxDist: 2650 },
  },

  // ---------------------------------------------------------------- placement
  // Forests are MASSES with crisp edges (see refs sr_01/sr_03), not a scatter.
  // The fbm field is narrow (10-90% of land lies in 0.38-0.62), so the edge band
  // must be narrow too: about two thirds of the land is woodland with a closed
  // interior, the rest open pasture, instead of half-density cover everywhere.
  forestFreq: 0.00082,
  forestThreshold: 0.465,
  forestSharpness: 0.025,

  // Groves cut ~200 m pasture clearings into the masses: roughly a fifth of a
  // forest opens, the remainder stays closed canopy. Zero cover remains
  // unplanted; the forest mass still controls the larger pattern.
  groveFreq: 0.0048,
  groveLo: 0.39,
  groveHi: 0.45,
  groveDepth: 1.0,
  standaloneGrove: 0.63,     // raw grove value above which a compact stand appears in pasture

  // Species coherence: conifers stand together, oaks stand together.
  speciesFreq: 0.0038,
  speciesCoherence: 0.80,    // 1 = pure stands, 0 = salt-and-pepper

  // Roadside stands: a ~260 m along-road field puts the road inside woodland
  // for roughly half its length (crisp stand ends, irregular outer edge that
  // fades out over the reach), and in open pasture for the rest.
  roadsideStandLo: 0.40,
  roadsideStandHi: 0.48,
  roadsideStandReach: [70, 135],
  roadsideStandCover: 0.74,

  // Roadside openings: each side of the road gets its own along-road field, so a
  // stretch can be open meadow on one side while woodland frames the other (refs
  // sr_01/03/04/13/22). Values are along-road metres measured on the centreline.
  roadsideOpenScale: 260,    // knot spacing of the per-side opening field
  roadsideOpenDetail: 90,    // shorter knots that break segments into bays
  roadsideOpenSwing: 0.55,   // shared component that opens one side as the other closes
  roadsideOpenLo: 0.50,      // field value where a side starts to open (~37% of each side)
  roadsideOpenHi: 0.61,      // field value where a side is fully open; both sides rarely (~6%)
  roadsideOpenEdgeScale: 72, // broad bays and tongues, rather than small perforations
  roadsideOpenEdgeAmp: 0.18,
  roadsideOpenDepth: [75, 140], // lateral reach of an opening; fades to closed by 150 m
  roadsideOpenDepthJitter: 40,
  // Opening remnants are small stands, wide enough to read as a group of crowns.
  roadsideGroveScale: 52,
  roadsideGroveLo: 0.64,
  roadsideGroveHi: 0.86,
  roadsideGroveCover: 0.70,

  slopeLimitTree: 0.62,
  slopeLimitGrass: 0.82,
  slopeLimitShrub: 0.86,     // scrub holds slopes that trees and grass cannot
  treeLine: 430,
  treeLineFade: 130,

  roadClear: 11.0,           // metres of tree-free verge either side of the centreline
  roadFade: 9.0,
  grassClear: 4.3,
  grassFade: 1.5,
  shrubClear: 5.6,
  vergeShrubBoost: 1.35,     // scrub piles up on the verge just past the mown strip
  vergeShrubRange: 24.0,
  waterClear: 2.0,

  // ---------------------------------------------------------------- dimensions
  // Lane width is 3.5 m. The bar's roadside trees read 3-4x that; conifers more.
  grassHeightNear: [0.30, 0.78],
  grassHeightFar: [0.40, 0.95],
  // One terrain sample fans out into a handful of cards. Keep this modest so
  // streaming/query cost stays unchanged while the verge reads as a continuous
  // tuft field instead of isolated stamps.
  grassCopiesNear: 6,
  grassCopiesFar: 3,
  grassSpreadNear: 2.8,
  grassSpreadFar: 4.6,
  grassCardWidthNear: 1.50,
  grassCardWidthFar: 3.50,
  // A tiny slope-proportional sink seats the copied roots into the sampled
  // ground plane without another terrain query (the cards already receive the
  // local tangent tilt in the instancing pass).
  grassRootSink: 0.028,
  tussockHeight: [0.45, 0.95],
  bushRadius: [0.55, 1.55],
  fernHeight: [0.45, 1.05],
  flowerHeight: [0.30, 0.62],
  spruceHeight: [11.0, 26.0],
  pineHeight: [9.0, 21.0],
  broadleafHeight: [8.0, 17.5],

  coniferShare: 0.46,        // modulated by altitude, moisture and the species field

  // ------------------------------------------------------------------ shading
  // Per-instance jitter is what kills the "one flat green" read.
  hueJitter: 0.055,
  satJitter: 0.18,
  valJitter: 0.26,
  crownTopLift: 1.34,        // vertex ramp: sunlit crown top
  crownBaseSink: 0.44,       // vertex ramp: self-shadowed underside
  forestFloorDarken: 0.52,   // ground cover value multiplier under closed canopy
  forestFloorBrown: 0.44,    // hue shift of ground cover towards litter under canopy
  // Alpha-tested cards are retained for the streamed vegetation budget, but a
  // softer edge and a small contact ramp keep their silhouettes from reading as
  // cut paper while preserving the existing draw/instance counts.
  // Let small leaf/needle alpha survive minification.  The fragment shader adds
  // a procedural organic edge below, so this lower cutoff does not turn the
  // cards into translucent rectangles; it keeps fine silhouettes from popping
  // off at the alpha-test boundary.
  cardAlphaTest: 0.11,
  cardEdgeSoftness: 1.90,
  // Darken only the first 16 cm of a card in the shader. A firmer root value
  // helps grass, shrubs and distant tree impostors share the same soil contact
  // without painting a dark vertical band up the trunk.
  groundContactDarken: 0.61,

  // -------------------------------------------------------------------- wind
  // A static, spatially coherent gust field (visible in stills, free at runtime)
  // plus a small animated sway that only advances when the sim is running, so
  // paused captures stay byte-deterministic.
  windDir: 0.7,              // radians
  windFreq: 0.0042,          // gust cell size
  windLeanGrass: 0.30,       // radians of base lean at full gust
  windLeanShrub: 0.13,
  windLeanTree: 0.045,
  windAnim: 0.055,           // radians of animated sway amplitude
  windAnimHz: 0.34,

  // ------------------------------------------------------- season hooks
  // These values are synchronised from Atmosphere.seasonName by Vegetation.  Keep
  // the hooks in one place so all four seasons change foliage, ground cover and
  // density together instead of leaving vegetation on the summer defaults.
  season: {
    leafTint: [1, 1, 1],     // multiplier on broadleaf foliage colour
    needleTint: [1, 1, 1],   // multiplier on conifer foliage colour
    groundTint: [1, 1, 1],   // multiplier on grass / tussock colour
    bareness: 0.0,           // 0 full canopy .. 1 leafless (drops leaf cards, keeps limbs)
    snow: 0.0,               // 0..1 snow load: whitens + weighs down foliage & ground
    flowerAmount: 1.0,       // scales the flower sub-layer
    lushness: 1.0,           // scales grass height + density
  },
};

export const SEASON_HOOKS = {
  spring: {
    leafTint: [0.90, 1.08, 0.82], needleTint: [0.96, 1.02, 0.92],
    groundTint: [0.88, 1.08, 0.82], bareness: 0.02, snow: 0,
    flowerAmount: 1.35, lushness: 1.16,
  },
  summer: {
    leafTint: [1, 1, 1], needleTint: [1, 1, 1], groundTint: [1, 1, 1],
    bareness: 0, snow: 0, flowerAmount: 1, lushness: 1,
  },
  autumn: {
    leafTint: [1.08, 0.92, 0.74], needleTint: [1.02, 0.98, 0.90],
    groundTint: [1.08, 0.92, 0.72], bareness: 0.18, snow: 0,
    flowerAmount: 0.38, lushness: 0.84,
  },
  winter: {
    leafTint: [0.70, 0.78, 0.92], needleTint: [0.78, 0.88, 1.00],
    groundTint: [0.73, 0.80, 0.93], bareness: 0.72, snow: 0.62,
    flowerAmount: 0, lushness: 0.45,
  },
};
