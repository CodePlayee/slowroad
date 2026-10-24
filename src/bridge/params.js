// src/bridge/params.js — TUNABLES for river crossings. Owned by the BRIDGE builder.
// Numbers follow refs/bridges/BRIDGE_SPEC.md; L = lane width = 3.5 m.
export const BRIDGE = {
  clearGap: 0.05,        // gap from carriageway edge to parapet inner face
  parapetThk: 0.32,      // 0.09 L  (spec: solid parapet <= 0.20 L)
  parapetH: 1.06,        // 0.30 L  (spec: 0.29-0.40 L)
  copingOverhang: 0.05,
  fasciaProject: 0.07,   // fascia projects this far past the parapet face
  fasciaLip: 0.11,       // fascia hangs below the soffit -> hard shadow line
  deckTopInset: 0.09,    // top of fascia band below the road surface

  pierThk: 1.15,         // across flow
  pierLenRatio: 4.0,     // along flow / thickness
  pierBatter: 1 / 14,    // per face
  pierEmbed: 1.8,        // metres the pier continues below the bed

  abutThk: 1.7,          // along the road
  abutEmbed: 2.6,        // below ground
  wingLen: 5.5,
  wingSplay: 32 * Math.PI / 180,

  guardrailLen: 24,      // metres each side, physically joined to the parapet
  guardrailH: 0.76,
  guardrailPostGap: 3.0,

  longStep: 2.4,         // metres between deck cross-sections
  concrete: [0.66, 0.645, 0.605],
  concreteDark: [0.42, 0.41, 0.385],
  steel: [0.56, 0.575, 0.585],
};
