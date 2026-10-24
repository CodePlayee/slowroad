# BRIDGE_SPEC.md — believable 2-lane road bridge over a river

Derived from the 32 verified photographs in `refs/bridges/` (see `manifest.json`).
Every number below is either measured off those photographs or is standard rural-highway
practice that the photographs confirm. Where a photo is the authority it is named.

**Unit convention.** Everything is expressed against `L = lane width`. Use `L = 3.5 m`.
Expressing the spec in `L` means a critic can verify most of it from a single screenshot
by comparing against the painted lane, without knowing our world scale.

---

## 0. The one thing that matters most

In the driver/chase view a modest real bridge is **almost not there**. `approach04`,
`approach03`, `cross02`, `curve02` are all "road approaching a bridge over a river" and in
every one of them the bridge is nothing but *a short run of parapet on both shoulders and
an unchanged road surface*. No visible deck, no visible piers, no visible structure.

The structure only becomes visible when (a) the camera is off to the side, (b) the crossing
is deep enough that the deck is well above the water (`pier04`, `truss02`), or (c) the road
descends towards the crossing so you look down onto it (`arch04`, `approach03`).

So the bridge must be built as *a continuation of the road that happens to have a parapet
and a structure hanging under it* — not as a bridge object that the road is laid on top of.
Most CG bridges fail because they are modelled the second way.

---

## 1. Widths

| quantity | value | in L | authority |
|---|---|---|---|
| lane | 3.5 m | 1.00 L | — |
| approach carriageway (2 lanes) | 6.5–7.3 m | 1.9–2.1 L | `curve02`, `approach04` |
| bridge clear width between parapets | 6.0–7.3 m | 1.7–2.1 L | `cross01`, `girder02` |
| ratio bridge clear width : approach carriageway | **0.85–1.00, never > 1.00** | — | `truss01`, `valley01`, `pier03` |
| parapet/fascia thickness each side | 0.35–0.55 m | 0.10–0.16 L | `girder04`, `slab06` |
| total structure width (out-to-out) | 7.0–8.4 m | 2.0–2.4 L | `girder06` |

**The pinch.** A rural bridge is the narrowest point on the road. `truss01` (driver view)
and `valley01` (on the deck) both show the shoulders vanishing and the guardrail flaring
outward so the driver is funnelled in. Our bridge should lose the shoulder over the deck and
regain it after. A bridge *wider* than its approach road instantly reads as CG.

**Railing height.** 1.0–1.25 m above the deck = **0.29–0.36 L**. Hard ceiling 0.40 L.
Cross-check in `cross01`: the parapet top sits at about a motorcyclist's shoulder, i.e. above
a car's window sill and below its roof. Old stone parapets are lower: 0.8–1.1 m = 0.23–0.31 L
(`arch01`, `arch03`, `approach07`).

**Railing visual thickness** — the single most common scale tell:

- open steel rail: rail members 0.05–0.12 m thick (0.015–0.035 L), posts at 1.8–2.5 m,
  and **you can see through it** to the water and far bank (`girder06`, `pier04`, `slab03`).
- solid concrete parapet: 0.25–0.40 m (0.07–0.11 L) (`girder03`).
- stone parapet: 0.45–0.60 m (0.13–0.17 L), plus a coping slab overhanging 50–80 mm each
  side with a drip line under it (`arch02`).

Anything thicker than 0.20 L reads as a wall, not a railing.

---

## 2. Spans, and how many

River width `W` is measured at the normal waterline, bank to bank.

| W | spans | pier count | authority |
|---|---|---|---|
| ≤ 18 m | **1** | 0 | `truss03`, `arch01`, `arch03`, `slab06` |
| 18–35 m | 2 | 1 | `pier04` |
| 35–70 m | 3 | 2 | `girder06`, `girder04` |
| > 70 m | 4+, keep the same pier spacing | 3+ | — |

- Typical pier-to-pier span: **12–30 m**, i.e. **3.5–8.5 L**. Below 12 m don't use a pier,
  just span it.
- **Piers must never sit in the deepest thread of the flow.** With 2 spans the single pier
  goes on a gravel bar or the shallow side, not mid-channel (`pier04` — the pier is planted
  on a visible bar, with the fast water passing to its right).
- With 3 spans the **middle span is the longest** (1.15–1.4× the outer spans) and it is the
  one that clears the main channel; the outer spans reach over the shallows and the bank toe
  (`girder06`, `girder04` — spans visibly unequal).
- Total structure length is **1.15–1.5 × W**: the abutments sit back from the water's edge,
  up on the bank, never right at the waterline (`girder06`, `truss03`).
- Soffit clearance above normal water: **1.5–4.0 m** for a modern bridge (`pier04`,
  `truss02`, `girder06`); **0.8–2.0 m at the crown** for an old low stone arch (`arch01`).
  Never less than 0.5 m, and the soffit must be above the seasonal high-water stain line.

---

## 3. Deck thickness

The visible fascia depth `d` (top of deck to soffit at the deck edge) is driven by span `S`:

| deck type | d | note |
|---|---|---|
| concrete girder | **S / 14 to S / 20** | use S/16; `girder06`, `girder04` |
| solid slab (short single span) | S / 20 to S / 25 | `slab06` |
| haunched over a pier | deepens to S / 10 at the pier, thins to S / 25 at midspan | `pier04` |
| steel truss | deck itself thin (0.3–0.5 m); the truss above it carries the load | `truss03`, `pier01` |

Sanity cross-check tying §1 and §3 together, useful because it needs no world scale:
**d / railing height must land in 0.55–1.6** for spans in our 10–30 m range. A 12 m span
gives d ≈ 0.7 m against a 1.1 m railing (0.6); a 30 m span gives d ≈ 1.8 m (1.6). A deck
that looks like a sheet of paper under a chunky railing is the classic tell.

**Girder shadow line.** Under the deck edge there is always a hard dark band, because a
projecting fascia beam overhangs the girders and the soffit behind it is in ambient-only
light. In `girder03` and `girder04` the soffit is essentially black against a bright fascia.
Target: soffit luminance **20–40% of the sunlit fascia**, with a crisp edge at the fascia
underside, plus a visible thickness step where the fascia projects 50–150 mm below the
soffit. Over water, add a subtle rippling caustic band on the soffit within ~1.5 m of the
water surface from bounce light (`pier04`, `slab06`).

---

## 4. Piers

- Form: **wall pier**, long in the direction of flow. Length along flow 3–6× its thickness;
  thickness 0.7–1.5 m (0.2–0.43 L). `pier04`, `girder04`. Round columns also occur
  (`girder05`), steel cylinders on old truss bridges (`pier01`).
- **Batter: 1:20 to 1:12 per face** — measured off `pier04` at ~1:13. So over a 4 m height
  the base is 0.3–0.65 m wider than the top. A perfectly prismatic extruded box is wrong.
- The pier cap may flare outward towards the deck (`girder04` — clearly wider at the top
  where it meets the soffit). Either batter down or flare up, but not neither.
- Upstream nose: rounded or a 60–90° wedge; downstream can be square.
- **How it enters the water.** The pier goes *into* the bed and the bed comes *up* to it.
  There is no plinth, no base slab, no visible footing edge, and no ring of geometry sitting
  on the water plane. The intersection is hidden by (a) the water surface itself, (b) a local
  scour hollow immediately upstream, (c) a small deposition tail of gravel/silt/snagged
  branches downstream. `pier04` shows exactly this: a gravel bar wraps the pier base.
- **Waterline staining — three bands, not one:**
  1. from the water surface up **0.15–0.5 m**: darkest, wet/algal, green-black, sharp top edge;
  2. above that up to the seasonal high-water mark (**+0.5–1.5 m**): mid-tone tan/grey
     mineral band, blotchy, soft-edged (`pier01` is literally titled "High Water Marks");
  3. above that: base concrete tone, with vertical rust/dirt streaks running *down* from the
     deck joints and drainage points into band 2.
- Piers cast a shadow on the water and a reflection in it. A pier with neither is floating.

---

## 5. Abutments, wingwalls, embankment

This is where CG bridges most often die, and it's cheap to get right.

- The deck lands on an abutment **set back on the bank**, above the waterline, not at it.
- Wingwalls splay **20–45°** from the deck axis (or run parallel as a U on small bridges).
- **The wingwall must be shorter than the earth it retains, so that soil and grass wrap
  around and bury its outer end.** In `slab03`, `girder05`, `arch03` you cannot find where
  the wall stops — vegetation and fill swallow it. A wingwall whose outer end is a visible
  free-standing slab edge in mid-air is an instant fail.
- Embankment side slope **1:2 to 1:1.5 (27–34°)**, running continuously from the shoulder
  edge down into the existing riverbank profile with **C1 continuity** — no cliff, no step,
  no gap, no terrain poking through the wall. `slab03` is the reference: the whole approach
  ramp is one graded earth form that flows into the bank.
- Slope treatment: grass/scrub above, and rip-rap or loose rock in the bottom 1–2 m where
  the slope meets the water (`girder05`, `pier03`).
- Vegetation grows **right up to and onto** the abutment: ivy on the concrete (`abut01`),
  brambles over the parapet end (`valley01`), willow scrub against the bank (`girder06`).
  A clean mown collar around the bridge is a giveaway.

---

## 6. Approach: guardrail, camber, markings

- **Guardrail run.** W-beam guardrail on both shoulders for **15–30 m** either side of the
  bridge, and it **physically connects to the parapet end** — the last 4–8 m stiffens, posts
  get closer, and the rail bolts into the parapet so the barrier height is continuous.
  `curve01` shows the transition at the joint; `valley01` shows the bridge railing ending in
  a short return with the guardrail peeling away into the bank; `truss01` shows the flare.
  **A parapet that simply stops at the abutment with a gap before the guardrail is a fail.**
- At the far (upstream road) end the guardrail flares out from the carriageway by 1:15 to
  1:25 and its end is turned down or buried in the embankment (`truss01`, `curve02`).
- **Camber/crown 2.0–2.5% each way from the centreline, unchanged across the bridge.**
  `cross01`, `girder02`, `valley01` all show the crown continuing. If the road is
  superelevated on a curve, the superelevation continues across the deck too (`curve01`).
- **Markings continue straight across with no break** — centre dashes on the same phase,
  edge lines unbroken (`cross01`, `girder02`, `approach04`, `curve01`). Either the road has
  markings and so does the bridge, or neither does (`approach07`, `approach08`). A bridge
  where the markings stop at the abutment and restart after is wrong.
- Deck surface: same asphalt as the road, or bare concrete with **transverse joints every
  4–8 m** (`girder02`). Expect a slightly different tone/wear on the deck than the approach,
  plus a visible transverse seam at each abutment, and often a patched strip there.
- Furniture, cheap and highly effective: a river-name sign at the abutment (`approach04`,
  `pier03`, `curve01`), hazard/marker posts at the parapet ends, a chevron board if the
  approach curves (`approach08`).

---

## 7. Vertical and horizontal alignment over a crossing

- The bridge is placed **exactly where the road centreline crosses the water**, and the deck
  axis is the road axis. If the road curves, the bridge curves with it — `curve01` and
  `curve02` are both curved bridges; the fascia sweeps and the railing sweeps with it.
  Straightening the deck under a curved road, or offsetting the bridge from the centreline
  to make the geometry easy, is the single most damning error available.
- Skew: a real bridge crosses the river at **60–90°** to the flow. Below 60° skew the deck
  gets long and the abutments get awkward; if our road meets the river at a shallow angle,
  bend the *road* to meet it nearer square rather than building a heavily skewed deck.
- **Vertical profile.** Two legal shapes only:
  - **sag**: road descends into the valley, crosses at or near the low point, climbs out
    (`approach03`, `grade01`, `arch04`). Most common.
  - **gentle crest / hump**: crest at midspan (`arch01`, `arch03`, `grade01`, `valley01`).
- Numbers: algebraic grade change across the crossing **≤ 6%**, vertical curve length
  **≥ 30 m**, crest/sag radius **≥ 400 m**. Deck grade itself 0–4%.
- **Never a kink.** The tangent must be continuous where the deck meets both approaches.
  The only permitted angle break is a very small one **at a pier** on a multi-span bridge —
  `pier04` shows about 1°, because two straight decks meet over the pier. Anywhere else,
  and especially at the abutment, a slope discontinuity destroys the shot.
- A bridge may sit on a grade — it does not have to be level (`grade01`, `arch04`,
  `curve01`). A bridge forced flat while the road either side has slope creates two kinks.

---

## 8. Materials

**Concrete.** Base tone is warm-grey, sRGB roughly `#b9b5ac` (fresh, sunlit) to `#8e8a82`
(weathered). Never neutral `#808080`, never white. Then:

- **horizontal form-lift lines every 0.6–0.9 m** on abutments, piers and solid parapets,
  with a 2–5 mm offset step at each (`abut01`, `girder03`);
- **per-panel tonal variation of ±6–8%** — adjacent pours never match (`girder03`, `abut01`);
- **vertical drip streaks** from the deck edge, drainage outlets and parapet joints, running
  downward and darkening as they go (`girder03`);
- rust-brown bleed spots, white efflorescence bloom under deck joints, honeycomb/exposed
  aggregate patches (`abut01`), spalled arrises on old work, orange lichen (`cement01`);
- moss/algae in the permanently damp zone at the base and on the north/shaded faces.
- Roughness: 0.6–0.8, mostly diffuse; wet band near the water is glossier.

**Stone.** Courses **0.30–0.45 m** high, blocks **0.5–1.2 m** long, mortar joints 15–30 mm
and recessed, rock-faced reveal 25–50 mm so the wall silhouette is ragged, not a flat plane
(`arch02`). Arch ring is a **separate ring of voussoirs 0.4–0.6 m deep, projecting 30–60 mm**
beyond the spandrel face (`arch02`, `arch03`). Coping slab on top of the parapet, overhanging
50–80 mm. Lowest 3–4 courses at the water are dark green-black; moss in the joints on the
shaded side (`approach08`). Colour follows local geology — one hue family, varied value.

**Steel.** Painted: silver/green/black, chalked and faded on the sun side, with rust bleeding
from **every** bolted connection, along the bottom chord, and at the deck joint. Unpainted or
long-abandoned goes an even dark orange-brown, `pier01` — roughly `#7a4a32` to `#5c3526`,
with darker runs below each splice. Truss members are thin (chords 0.25–0.4 m) and the truss
is **visually transparent**: the far bank must be visible through it (`truss03`, `truss02`).

---

## 9. Failure modes — the things that make a CG bridge look fake

1. **Floating deck.** Deck ends in mid-air, or the abutment is a box resting on the terrain
   surface rather than buried in it. No CG bridge survives this.
2. **Piers not reaching the riverbed.** Pier geometry stops at, or just below, the water
   plane; or worse, a footing slab sits *on* the water surface. Piers must continue into the
   bed with the bed material coming up around them.
3. **Uniform untextured concrete.** One flat grey, no lift lines, no streaks, no per-pour
   tone variation, identical on every face regardless of exposure.
4. **Railing too thick.** A 0.5 m slab used as a "railing", or a solid parapet where a
   see-through steel rail belongs. Instantly kills the sense of scale, because the railing is
   the only element the viewer knows the real size of.
5. **Deck too thin.** A 30 m span on a 0.3 m deck. Reads as cardboard. Obey S/14–S/20.
6. **Bridge not aligned with the road centreline.** Deck straight under a curving road,
   deck axis offset from the road axis, or the bridge placed near but not at the crossing.
7. **Banks not graded.** The approach embankment is not built: the road ribbon flies over a
   V-shaped gully and the terrain is untouched underneath. Or the fill ends in a vertical
   cliff, or terrain pokes through the wingwall.
8. **Water clipping through the deck / piers.** The river plane is drawn over the soffit or
   through the pier, or the water is culled at the bridge leaving a hole.
9. **No shadow under the deck.** Soffit lit the same as the top surfaces, no dark band under
   the fascia, no shadow cast onto the water or the bank.
10. **A kink in the profile at the abutment.** Deck forced level, or grades meeting at an
    angle, producing a visible crease the car audibly/visually jolts over.
11. **No waterline staining, no high-water mark.** Pristine concrete meeting water is
    unheard of outside the week of construction.
12. **No guardrail transition.** Parapet begins and ends abruptly with nothing connecting it
    to the approach barrier, or there is no approach barrier at all.
13. **Markings and camber break at the deck.** Centreline stops, dashes change phase, crown
    flattens over the bridge, shoulder width jumps.
14. **Too clean a collar.** A neat vegetation-free apron around the abutments; nothing
    growing on, against, or over the structure; no leaf litter, no silt, no debris snagged on
    the upstream pier face.
15. **Wrong scale of everything at once** (bridge wider than the road, 3 m parapets, 60 m
    spans over a 15 m creek). Check every dimension against `L`.

---

## 10. Minimum viable bridge for our game

If only one bridge type is built, build this — it is the most common real rural river
crossing and it is the archetype of `girder06`:

- 3-span concrete girder, spans 18/24/18 m, over a 45 m river.
- Deck out-to-out 8.0 m (2.3 L); clear width 7.0 m (2.0 L); 2 × 3.5 m lanes; no shoulder
  over the deck.
- Fascia depth 1.4 m (≈ S/17), fascia projecting 100 mm below the soffit, soffit at 20–35%
  of the sunlit fascia luminance.
- Open steel rail, 1.10 m high (0.31 L), rail members 0.08 m, posts at 2.2 m, see-through.
- Two battered wall piers, 1.1 m thick, 5 m long, batter 1:14, rounded upstream noses,
  standing in the shallows either side of the main channel, with the three-band waterline
  stain and gravel deposition tails.
- Abutments set 4 m back from the water's edge, wingwalls splayed 30°, outer ends buried;
  embankment at 1:2 with rip-rap in the bottom 1.5 m.
- W-beam guardrail 22 m either side, bolted into the parapet ends, flared out at the far ends.
- Soffit 2.8 m above normal water. Profile: a sag, crossing 1.5 m below the surrounding
  ground, vertical curve 60 m, no kink at either abutment.
- Markings, crown and asphalt continuous from approach to deck to approach.
