// src/bridge/params.js — TUNABLES for river crossings. Owned by the BRIDGE builder.
// Numbers follow refs/bridges/BRIDGE_SPEC.md; L = lane width = 3.5 m.
export const BRIDGE = {
  clearGap: 0.05,        // gap from carriageway edge to kerb inner face
  kerbThk: 0.32,         // 0.09 L concrete upstand carrying the rail posts
  kerbH: 0.34,           // upstand height above the deck
  fasciaProject: 0.07,   // fascia projects this far past the kerb face
  fasciaLip: 0.11,       // fascia hangs below the soffit -> hard shadow line
  deckTopInset: 0.09,    // top of fascia band below the road surface

  // underside (girder04/05, pier04): a slab carried by girders bearing on the pier
  // caps and abutments at the soffit line; the outer girders are the fascia beams
  slabRatio: 0.30,       // slab thickness / structural depth, held in [slabMin, slabMax]
  slabMin: 0.24,
  slabMax: 0.42,
  ribMin: 0.25,          // shallower girders than this collapse into a flat soffit
  edgeBeamW: 0.42,       // fascia beam width inboard of the kerb face
  girderLat: 1.30,       // interior girder centrelines at +-this -> ~2.6 m bays
  girderW: 0.40,
  diaphragmGap: 0.15,    // pier diaphragm stops this far above the girder bottoms
  diaphragmThk: 0.36,

  // open steel rail (§1, §10): see-through, members 0.05-0.12 m, posts 1.8-2.5 m
  railH: 1.10,           // top of rail above the deck = 0.31 L (spec 0.29-0.40 L)
  railPost: 0.09,        // square post section
  railPostGap: 2.2,
  railTopH: 0.11,        // top rail section (height x width)
  railTopW: 0.08,
  railMidH: 0.06,        // mid rail section, centred railMidY above the deck
  railMidY: 0.70,
  endBlockLen: 0.9,      // concrete end post at each corner; the guardrail bolts into it

  pierThk: 1.15,         // across flow
  pierLenRatio: 4.0,     // body length along flow / thickness (wedge noses add to it)
  pierNose: 1.2,         // wedge nose length / half thickness -> ~80 deg nose
  pierBatter: 1 / 14,    // per face
  pierEmbed: 1.8,        // metres below the LOWEST ground under the footprint
  capH: 0.8,             // pier cap, flared up towards the soffit
  capFlare: 0.22,

  abutThk: 1.7,          // along the road
  abutEmbed: 2.6,        // below ground
  wingLen: 5.5,

  guardrailLen: 24,      // metres each side, physically joined to the end blocks
  guardrailH: 0.76,
  guardrailSeg: 2.0,
  guardrailStiffLen: 6,  // posts every segment next to the bridge, every other beyond
  guardrailFlare: 0.9,   // lateral flare at the far end (1:20 over the free run)

  longStep: 2.4,         // metres between deck cross-sections
  // linear albedo; sRGB ~#c3c0b8 fresh, weathered down to ~#8e8a82 by the shader (§8)
  concrete: [0.55, 0.53, 0.49],
  concreteDark: [0.34, 0.33, 0.31],
  steel: [0.60, 0.62, 0.63],
  steelPost: [0.44, 0.45, 0.46],
};
