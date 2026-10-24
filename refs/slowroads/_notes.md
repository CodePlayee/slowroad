# Raw second-pass measurement notes (scratch; OBSERVATIONS.md is composed from this)

All fractions are of a 1920x1080 frame. y=0 top. Lane width assumed 3.5 m.
Colours are 13x13 patch means via `_probe.py patch`.

## Batch 1 — sr_09, sr_10, sr_11, sr_12

### sr_09 (motorcycle cockpit, blue hour / dusk, coastal chaparral, HUD clock 10:08)
- Camera: motorcycle rider view. Handlebar + instrument pod occupies y 0.68–1.00, x 0.10–0.90.
  Two bar-end mirrors: left (0.11–0.21, 0.68–0.75), right (0.79–0.90, 0.72–0.79). Both carry live
  reflections (road + double-yellow visible in the left one).
- Sea horizon y ≈ 0.445. Road vanishing point at (0.50, 0.455) — VP sits ON the sea horizon.
- Sky column x=0.25 top→horizon: 0.00 `#415b7c`, 0.12 `#485f7e`, 0.24 `#5c708b`, 0.36 `#6a7e99`,
  0.44 `#7789a1`. Monotonic, +54 in R over the sky. NO banding, NO visible dither.
- Markings: double solid yellow centreline (two ~7 px stripes with ~9 px gap at y=0.60,
  i.e. 2x0.12 m stripes + 0.15 m gap at that range) + solid white edge line each side.
  Yellow reflector chevrons painted on the asphalt at (0.40,0.53).
- Headlight: elliptical pool centred (0.50,0.62), ~430x300 px, peak `#8d8b84` vs surrounding
  asphalt `#4a4e55` — only ~2:1 brightening, NOT a blown white blob.
- Guardrail on the SEA (left) side only; W-beam, single rail, top edge catches a 1–2 px specular.
- Right side is a cut slope covered in silver-grey sage scrub; NO guardrail on the cut side.
- Far headland (0.45,0.435) is a flat pale wash; the mid headland (0.55,0.42) still shows a
  faint rock band. Two haze steps between them.
- Distant road visible as a pale cut on the far hillside at (0.55,0.43) — see-your-future-road.

### sr_10 (high cinematic 3/4, sunset, coastal, bus)
- Camera ~25–35 m above road, outside the curve, pitch ≈ -22°. Bus occupies x 0.30–0.47,
  y 0.48–0.73 — ~0.17 frame width, ~4% frame area.
- Sea horizon y ≈ 0.435, sits above the mid-frame. Road enters bottom-right, exits mid-left.
- Sky: 0.02 `#cca190`, 0.15 `#dfab90`, near-horizon (0.75,0.44) `#d7a98a`. Warm, low-chroma
  ramp; sky peaks in *lightness* about 0.15–0.25 down, not at the horizon.
- Water just below horizon `#c1a088` — only ~8% darker than sky above it. Horizon line is a
  soft ~4 px transition, not a hard 1 px seam.
- Landform: 4 depth layers — near cut slope (bare tan `#b08a72`-ish), dark green forested
  ridge, second ridge with bare tan crown + tree stipple, then flat far headland.
- Treeline is ALTITUDE-DEPENDENT: conifers stop ~2/3 up the mid ridge and the crown above is
  bare grass/rock. This is the single clearest "vegetation respects altitude" reference.
- Cut face on the far left (x 0.00–0.10) is a smooth tan sedimentary slope at ~50°, with
  scrub only on ledges and at the toe.
- Guardrail on BOTH sides here (fill side and drop side), W-beam, posts ~2 m.
- A yellow diamond warning sign at (0.155,0.505). Roadside furniture exists but is sparse:
  ~1 sign per 150 m.

### sr_11 (car cockpit, OVERCAST, coastal chaparral, clock 09:53)
- Camera: driver eye ~1.15 m. Steering wheel + dash occupy y 0.68–1.00, x 0.14–0.66.
  Left A-pillar is a solid grey band x 0.155–0.29 running full height of the glass.
  Interior mirror at (0.25–0.34, 0.07–0.38) shows the road behind AND two other vehicles.
- **Overcast sky is FLAT**: column x=0.10 reads 0.00 `#abb4bb`, 0.12 `#a1aab3`, 0.24 `#acb5bc`,
  0.36 `#b0b9c0`, 0.48 `#abb4bb`. Total variation ≈ 17/255 (7%) across the whole sky, and it is
  NON-monotonic — brightest around y 0.32–0.36, slightly darker at the zenith. Cloud structure
  is visible as soft ~150–400 px blotches, ±8 units. So overcast ≠ constant colour, but the
  gradient is nearly nil.
- Overcast shadows: essentially absent. Trees have only a small dark contact patch. Terrain
  relief is read from albedo + occlusion, not from cast shadow.
- Sea at (0.02,0.53) `#828e9a` — under overcast the sea is *within 6%* of the sky, the horizon
  almost disappears; only a faint value step marks it at y ≈ 0.52.
- Vegetation: pale sage/silver shrubs `#a8a68c`-ish on the near verge, pines up the right slope,
  bare pink-tan soil `#b08a78` showing between shrubs at ~35–45% ground exposure on the dry slope.
- Markings again double solid yellow + solid white edge. White edge line on the right is a
  crisp ~6 px at y=0.72, widening to ~14 px at the frame bottom.
- Shoulder: ~0.35 lane widths (≈1.2 m) of compacted tan gravel outside the white line, then grass.

### sr_12 (chase, blue hour, coastal, chevron sign array)
- Camera ~3.5 m behind / ~2.2 m above road, pitch ≈ -7°. Car spans x 0.17–0.42, y 0.66–0.90
  → ~0.25 frame width, ~6% frame area. Car sits LEFT of centre, road curves right.
- Sky: zenith `#687f9e`, 0.15 `#7085a3`, horizon-ish (0.35,0.40) `#8194b1`. +26 R over the sky —
  a *shallower* gradient than daylight frames.
- Sea: (0.30,0.46) `#8296b1` just under the far shore; (0.30,0.52) `#536782`; (0.25,0.58)
  `#41556f`. So the water darkens by ~50% luminance from horizon to near-shore — the gradient
  runs the same direction as the sky reflection, not toward the camera.
- Three chevron (right-turn) signs at x 0.36, 0.54, 0.67, all y≈0.58, spaced evenly along the
  guardrail — a real highway-engineering cue for a tight bend.
- Erosion: the right-hand mountain shows a ~200 m long horizontal pale sedimentary band at
  y 0.40–0.46 with the road cut visible on top of it at (0.72,0.43). Scree fans below.
- Headlight spill visible on the asphalt ahead of the car and on the gravel shoulder at
  (0.62,0.79) — the beam lights the shoulder, not just the lane.
- Foreground shrubs at the very bottom-right (x>0.55, y>0.85) are dark and slightly out of
  focus-free but heavily shadowed; they frame the shot without being lit.

## Batch 2 — sr_13, sr_16, sr_17, sr_18

### sr_13 (WINTER, active snowfall, high 3/4 cinematic, downland)
- Camera ~12–18 m above road, outside the bend, pitch ≈ -14°. Car is small: x 0.345–0.415,
  y 0.53–0.61 → 0.07 frame width, ~0.6% frame area. Headlights ON and throwing two visible
  pools on the snow at (0.38,0.63).
- Sky is FLAT overcast-grey: 0.02 `#70787b`, 0.20 `#737a7f`, 0.30 `#6d7276`. <10/255 variation.
- **Snowstorm desaturation, measured**: mean row saturation is 17.5/255 at y=0.30, 10.8 at 0.40,
  13.3 at 0.60, 28.6 at 0.90. i.e. the whole frame lives at 4–11% saturation. Winter-storm
  acceptance: no row mean saturation above ~35/255.
- Mean row VALUE falls toward the camera: 111 at y=0.30, 96 at 0.40, 90 at 0.60, 66 at 0.90.
  The DISTANCE is brighter than the foreground — inverted from the usual haze assumption,
  because the snow-fog is luminous. Foreground is where the dark asphalt shows.
- **Snow accumulation rules visible**: (a) road is snow-covered EXCEPT two cleared wheel ruts
  per lane showing brown-black slush `#302c2a`; ruts are ~0.5 m wide, 4 of them, and they
  *bend with the road* rather than being straight decals. (b) The rock outcrop at x 0.00–0.18
  keeps snow only on ledges and low-slope shelves — the steep faces (>~50°) are bare
  `#2c2927`. (c) Bare deciduous branches carry a thin white rime on the upper side only.
  (d) Conifers hold snow in the crown but their flanks stay dark green-black.
- Post-and-rail TIMBER fence (3 rails) follows the right verge for the full frame and its
  vertical profile matches the road's crest and dip exactly — the strongest terrain-following
  cue in the set.
- **Six depth layers** in a rolling-downland frame: (1) near snow verge + rock, (2) mid pasture
  hill with hedgerow, (3) conifer belt y≈0.45–0.55, (4) further conifer belt y≈0.40, (5) pale
  patchwork downland y≈0.32–0.36, (6) faint hill silhouettes at y≈0.285 that are only ~6/255
  darker than the sky.
- Snowflakes: ~40–60 individual white specks, 2–5 px, spread over the whole frame, NOT
  concentrated near the camera, with no streaking.

### sr_16 (SPRING, bright overcast, tree avenue, 3 vehicles, dry stone wall)
- Camera ~5–7 m above road, pitch ≈ -11°, chase. Player car x 0.155–0.29, y 0.62–0.75
  → 0.135 frame width, ~1.7% frame area. Two more vehicles ahead at (0.53,0.58) and (0.75,0.54).
- Sky is a blown-out white `#ececec` visible only in gaps in the canopy (x>0.72, y<0.10).
  There is no visible horizon line at all on the left; the canopy closes over the road.
- **Species mix**: mature broadleaf avenue with PALE GREY-WHITE trunks (`#b9b9b2`-ish highlights)
  on the left, trunk diameter ~28–45 px at 15 m ⇒ ~0.6–0.9 m DBH; canopy tops leave frame,
  so tree height > 15 m ≈ 4+ lane widths. Dark spruce cluster on the right at x 0.80–0.98.
- **Intra-species colour variation is large**: canopy patches read `#303e09`, `#21270a`,
  `#111a11`, `#181c17` — a 3x spread in green value inside one avenue. No two adjacent crowns
  share a hue.
- Ground: grass verge is a bright yellow-green `#6a6e31`, ~0.5–0.8 m tall with visibly resolved
  blades out to ~25 m, then it becomes a smooth mat by ~40 m. Grass covers the entire right
  bank at 100% (no soil showing) — the opposite of the arid frames.
- Spring flora: daffodil/narcissus clumps of 3–8 heads (yellow `#c9c020`-ish, white) scattered
  irregularly along BOTH verges and along the base of the wall, ~1 clump every 8–15 m.
- Dry stone wall on the left, ~0.55 m high (≈0.16 lane widths), dark mossy `#3a3a2a`, runs
  parallel to the road at ~2.5 m offset and disappears into the grass at the frame edge.
- **Markings**: double solid WHITE centreline (two ~5 px lines, ~7 px gap) + solid white edge
  line each side; a DASHED white centreline segment is visible in the far distance at
  (0.79,0.53), dash ≈ 12 px on / 14 px off at that range. So the game does change marking
  type along the route.
- Road total width at y=0.85 ≈ 470 px for 2 lanes ⇒ scale check 7.0 m over 470 px.

### sr_17 (SUMMER noon, UNPAVED gravel track, blue sky, plantation + pasture)
- Camera ~2.2 m above the track, pitch ≈ -8°, chase-close. Car x 0.34–0.59, y 0.43–0.78
  → 0.25 frame width, ~9% frame area.
- **No lane markings at all** — this is a gravel/dirt secondary road: warm tan `#6f6648`
  surface with resolved 2–4 px gravel, a darker central strip of grass-free wear and a faint
  grassy median hint at (0.60,0.42). Track width ≈ 5.5 m (one-and-a-half lanes), narrower
  than the paved frames.
- Sky: only a thin strip visible at x 0.02–0.30. (0.20,0.20) `#9dcdfe` — a clean cool blue.
  Trees occlude the rest.
- **Aerial-perspective ramp measured across five layers** (this is the best AP reference):
  near sunlit grass (0.85,0.75) `#6d8236`; mid pasture (0.30,0.50) `#8f874e`; dark woodland
  belt (0.30,0.30) `#37481c`; gold+green patchwork hill crown (0.22,0.245) `#999b68`;
  distant blue mountain (0.10,0.235) `#7a9bc8`, (0.03,0.255) `#6993c0`.
  Row-mean saturation: 141/255 at y=0.24 vs 131 at y=0.55 — but that number is dominated by
  the blue mountain; the *terrain* saturation drops from ~0.55 near to ~0.21 on the far ridge.
- The far mountain `#7a9bc8` vs the sky above it `#9dcdfe`: value ratio 0.78, hue within ~5°.
  **Rule: the furthest ridge is the sky colour at ~75–80% value, same hue.**
- Vegetation: dense conifer plantation (regular-ish spacing, 8–14 m tall) on the right; the
  mid hill carries hedgerow oaks in LINES following field boundaries, plus a gold/green field
  patchwork — cultivated-land cue, not noise.
- White flowering shrub band at (0.60–0.72, 0.36–0.40) marks the track edge where it enters
  the wood.
- Grass at the verge is TALL, ~0.7–0.9 m (reaching ~0.25x car height), leaning, with visible
  individual blades to ~20 m and its own soft AO at the base.
- Two chevron signs at (0.235,0.37) and (0.37,0.365) — on an unpaved road, which reads slightly
  odd but is the game's convention.

### sr_18 (ARID / desert badland, warm dusk, unpaved road, rusted guardrail)
- Camera ~2.5 m above road, pitch ≈ -10°, chase. Car x 0.365–0.60, y 0.44–0.79
  → 0.235 frame width, ~8.5% frame area.
- **Near-monochrome biome**: sky 0.02 `#bdaa8f` → 0.10 `#ccb08a` → 0.20 `#e1b985` (brightest
  just above the horizon, ~y 0.22); terrain (0.45,0.25) `#ac8962`, (0.15,0.30) `#b57c40`,
  (0.9,0.25) `#a26e3e`, mid road (0.5,0.42) `#bc8040`, near road (0.5,0.85) `#634428`.
  Every hue in the frame is between 25° and 40°. The scene still reads because VALUE spans
  0.39 (`#634428`) to 0.88 (`#e1b985`) — a 2.3x range.
- Terrain: eroded badland with exposed strata on the right (0.75–1.00, 0.10–0.55) showing
  3–4 horizontal bands and vertical gully rills; smooth sand-drift slopes on the left.
  **Rock appears where slope > ~40°; smooth drift where slope < 25°.**
- ZERO vegetation. The frame proves the terrain shader alone must carry the scene.
- Guardrail is RUSTED BROWN `#8a5a33`-ish, W-beam on posts at ~2.2 m, on the drop side only,
  and it follows the road's vertical curvature over a crest at (0.55,0.40) — visible for
  ~350 m into the distance, which is a strong route-preview cue.
- The road ahead is visible as three separate switchback segments at y 0.40, 0.36, 0.33 before
  vanishing — see-your-future-road again.
- Distant peaks at (0.42,0.265) are a flat `#a89478` wash, only ~12% darker than the sky.

## Batch 3 — sr_19, sr_20, sr_21, sr_22

### sr_19 — **NOT WINTER. This is the MOON / lunar biome.**
- shots.json currently uses sr_19 as the bar for `season_winter`. That is WRONG: sr_19 is an
  airless lunar surface with Earth in the sky. The winter bar must be **sr_13** (and sr_23 has
  a snow-capped range). Flag this in SHOTLIST.md.
- Camera ~2.4 m above the track, pitch ≈ -11°, chase. Car x 0.39–0.64, y 0.44–0.79.
- Sky is a true black `#020202` at y 0.05 and 0.20 with ~500 point stars, 1–2 px, no bloom.
  Earth as a small crescent disc at (0.355,0.125), ~46 px across, blue `#7a9ac8`-ish.
- Ground: `#a9a9a9` sunlit / `#666564` mid / `#171918` in the cast shadow — a >6:1 lit:shadow
  ratio, which is what you get with NO atmospheric scattering fill.
- **Zero aerial perspective**: the furthest ridge at y≈0.31 is `#909090`, essentially the same
  value as the near ground. This is the useful negative control: on Earth frames the far ridge
  MUST wash out; here it deliberately does not.
- Shadow of the car is razor-hard: penumbra < 3 px. Terminator on hills is a hard line.
- Guardrail present (grey W-beam, posts every ~2.2 m) and readable for ~400 m following a
  ridge — the world/route builder is biome-independent.

### sr_20 (TRUE NIGHT, chase, coastal, headlights) — main night bar
- Camera ~2.6 m above road, pitch ≈ -8°, chase but the car is pushed far RIGHT:
  x 0.79–1.00, y 0.60–0.73 (partially cropped). Road curves left away from it.
- **Residual dusk glow on the horizon at screen left**: (0.02,0.44) `#423c31` warm, while the
  zenith at (0.5,0.05) is `#303d44` cool blue-grey. So night is a two-hue sky: warm remnant
  band below y≈0.45 on the sun side, cool everywhere else. Top-right corner (0.9,0.03) is
  nearly black `#020303`. That is a >20:1 azimuthal variation across the sky at night.
- Row-mean VALUE: 51 at y=0.10, 19 at 0.30, 3.6 at 0.50, 18.5 at 0.75, 17 at 0.95. The
  hillside band at y≈0.50 is the darkest thing in the frame (val 3.6/255) — night is allowed
  to go essentially to zero in the unlit mid-ground.
- Row-mean SATURATION rises toward the bottom: 45 → 38 → 69 → 126 → 93. The headlit
  foreground is the MOST saturated part of a night frame (warm asphalt + dry grass under
  tungsten), not the least.
- Headlight: bright pool from (0.55,0.68) to (0.82,0.62), long axis ~520 px along the road,
  peak `#8f8878`. It is a *narrow forward cone with a soft outer edge*, and it re-lights the
  yellow centreline (which reads yellow `#b08e3a`-ish only inside the beam and vanishes
  outside it). Critical: markings are only visible where lit.
- A yellow diamond curve-warning sign at (0.745,0.575) is the brightest small element after the
  headlights — retroreflective signs pick up the beam.
- Lake/sea surface at (0.05,0.55)–(0.20,0.62) holds a faint horizontal glint band from the
  residual sky, ~`#4a4a42`, with 4–6 discrete ripple streaks. Water is NOT black at night.
- Stars are visible but sparse and faint at the top-left; no Milky Way, no bloom.
- Foreground grass (bottom-left quadrant) is lit only by ambient and reads `#312f27` — it is
  present and textured but almost value-less. NOT crushed to flat black.

### sr_21 (AUTUMN, dusk/violet hour, lakeside, concrete retaining wall)
- Camera ~7–9 m above road, pitch ≈ -12°, high chase. Car x 0.335–0.425, y 0.52–0.61
  → 0.09 frame width, ~0.9% frame area. Headlights on, casting a pool at (0.39,0.63).
- **Violet-hour sky, three stops**: zenith `#695782`, y=0.15 `#756290`, y=0.28 `#806d9a`
  (lightest, just above the far ridge). Hue holds ~272–278° throughout; it is a value+chroma
  ramp within one hue, not a hue rotation.
- **Global violet cast**: the lake at (0.75,0.47) is `#87729d` and the mid-ridge at (0.75,0.42)
  is `#675579` — the water is LIGHTER than the land behind it because it mirrors the bright
  sky band. Every surface in the far half of the frame is within 10° hue of the sky.
- Row-mean value: 104 (y=0.10) → 121 (0.30) → 118 (0.50) → 47 (0.75) → 33 (0.95). Row-mean
  saturation: 127 → 94 → 89 → 139 → 170. So the **near foreground is 2x more saturated and
  4x darker than the mid-distance** — this is the aerial-perspective signature to reproduce.
- Water: ~4 concentric brighter ripple bands running parallel to the far shore, plus a broad
  soft sun/sky glint smear at (0.60–0.80, 0.50–0.60). Wave scale ≈ 25–40 px crest spacing at
  ~120 m ⇒ ~1.5–2.5 m wavelength. No tiling repeat visible.
- Shoreline: a poured-CONCRETE retaining wall `#7e6f8a`-ish runs between the road and the lake
  for the whole right side, ~0.9 m above the waterline (0.26 lane widths), with grass tufts at
  its base on the road side. Where there is no wall (far left, y≈0.46) the bank is a soft
  grass-to-water transition with NO visible hard intersection line.
- **Markings here are a DASHED white centreline** — dash 62 px on / 78 px off at y=0.78
  (⇒ roughly 3 m on / 4 m off at that scale) plus solid white edge lines. Third distinct
  marking scheme in the set.
- Autumn flora: bracken/fern clumps turned rust `#8a4a1c`-ish in the left foreground, larch or
  cedar with russet needles overhanging top-left, and rust/ochre broadleaf belts on the far
  shore at y 0.34–0.40 mixed with still-dark conifers.
- Leaf litter scattered on the asphalt in the left half (small 3–6 px rust flecks).

### sr_22 (AUTUMN peak, overcast, larch/spruce forest, guardrail) — best autumn bar
- Camera ~2.8 m above road, pitch ≈ -5°, chase-far. Player car (red) is tiny:
  x 0.595–0.65, y 0.61–0.67 → 0.055 frame width, ~0.35% frame area. Composition is
  landscape-first: the car is a colour accent, not the subject.
- Sky visible only in a small gap at (0.60–0.72, 0.00–0.08), flat `#9f9f9d` overcast.
- **Larch autumn palette, five distinct hues in one stand**: `#a8892a`-ish bright gold,
  `#523e0a` deep ochre, `#422a0b` russet-brown, `#362705` olive-brown, plus untouched dark
  spruce `#020902`. The gold and the spruce differ by >15x in value inside the same canopy
  mass. Autumn acceptance: at least 4 separable foliage hues, plus ≥1 evergreen that did not turn.
- Tree height: the larches leave the top of frame at ~15 m from camera ⇒ height > 20 m,
  ≈ 6 lane widths. Trunks are bare for the lower 40% of their height with the canopy above —
  a plantation profile, not lollipop trees.
- Ground: two-tone verge — pale cured grass `#626031` on the right bank at ~0.6 m, plus rust
  fern clumps `#9a5a1e`-ish at ~0.5 m, plus white umbelliferous seed-heads at (0.05,0.63) and
  (0.35,0.65). At least 3 shrub/herb species at the verge.
- Road: **double solid white centreline** in the foreground that becomes a **dashed white
  centreline** further along at (0.68,0.50) — the marking scheme changes with the geometry
  (solid on the blind bend, dashed on the straight). This is a real highway convention and a
  strong detail to copy.
- Asphalt `#6d625d` at y=0.90 with visible aggregate and slightly darker wheel tracks; a
  small patch of paler repair/edge crumble at (0.03,0.83).
- W-beam guardrail on the left, top rail catching a 1–2 px light line, posts every ~2 m,
  starting and stopping with the drop-off rather than running the whole length.
- Curve radius: the visible S-bend turns ~90° in roughly 120 m of road ⇒ radius ≈ 75–90 m.

## Batch 4 — sr_23, sr_24, sr_14, sr_15

### sr_23 (OVERCAST, near-eye-level chase, pinyon-juniper + arid hill) — best MARKINGS bar
- Camera very low, ~1.6–1.9 m above the road, pitch ≈ -3°. Horizon/hill crest at y≈0.14.
  Player car is far ahead and TINY: x 0.565–0.605, y 0.505–0.555 → 0.04 frame width, ~0.2%.
- Sky flat bright overcast: 0.03 `#e3e7ea`, 0.12 `#dfe2e9` — variation <8/255, faintly cooler
  and slightly *darker* going down. No sun disc, no cloud shapes, no gradient to speak of.
- **Marking geometry measured at y=0.85** (run-length scan): yellow stripe x368–396 (29 px),
  gap 14 px, yellow stripe x411–439 (29 px); white edge line x1167–1187 (21 px). Centreline
  centre x≈404, edge line centre x≈1177 ⇒ 773 px = 3.5 m ⇒ 1 m ≈ 221 px.
  So: **double-yellow stripe width ≈ 0.13 m, gap ≈ 0.065 m, white edge line ≈ 0.095 m.**
- Same measurement on sr_22 at y=0.88: white stripes 27 px / gap 27 px, lane = 665 px
  ⇒ stripe ≈ 0.14 m, gap ≈ 0.14 m, edge line 15 px ≈ 0.08 m.
  **Acceptance range: centreline stripe 0.035–0.042 lane widths; edge line 0.022–0.028.**
- **Shoulder is a distinctly different material and colour from the verge**: a 1.2–1.6 m band
  of red-brown compacted gravel `#705947` outside the white line on the left, and a wider
  ~2.2 m pinker apron `#8b7060`-ish on the right where the guardrail sits. Asphalt itself is
  `#656160`. Three separate tones: asphalt / shoulder / vegetation.
- Overcast luminance inversion: row-mean value 163 (sky y=0.15), 52 (dark foliage band y=0.30),
  83 (y=0.55), 116 (asphalt y=0.90). Under overcast the ASPHALT is brighter than the foliage.
- Zero cast shadows. Trees have only a ~10 px darker contact zone at the trunk base.
- Species: dark blue-green pinyon/juniper with heavy irregular crowns (NOT cones, NOT spheres),
  a paler yellow-green broadleaf at x>0.86, silver-grey sage shrubs at 0.4–0.9 m, and pale
  cream pampas-type grass plumes standing ~1.1 m — the plumes are the tallest ground layer and
  break the horizontal line of the verge.
- Hillside behind: green scrub to ~60% up, then bare pink-tan soil with isolated dark shrub
  dots that get sparser with altitude. Ground exposure goes 0% → ~55% from valley to crest.
- Yellow-flowering shrub at (0.855,0.545) — one saturated accent in an otherwise muted frame.

### sr_24 (ASTRONOMICAL TWILIGHT / early night, palms, coastal) — second night bar
- Camera ~3.0 m above road, pitch ≈ -9°, chase. Car x 0.385–0.545, y 0.68–0.83
  → 0.16 frame width, ~2.5% frame area.
- **Sky is a violet→ochre cross-fade**: zenith (0.5,0.02) `#2d1e43`, (0.5,0.10) `#332441`,
  (0.2,0.25) `#42313e`, (0.1,0.40) `#503c3b`, (0.05,0.50) `#574338`, (0.05,0.56) `#5b4537`.
  Hue rotates from ~265° at the zenith to ~28° at the horizon — a genuine hue rotation of
  ~120°, not a value ramp. This is the hardest sky in the set to fake.
- ~120 faint stars, 1–2 px, only in the upper 35% where the sky is dark enough. They fade out
  as the ochre band brightens. No stars survive below y≈0.35.
- Sea at (0.05,0.60) `#453d2f` with a faint horizontal glint band; the water is warmer than
  the zenith sky because it mirrors the low ochre band.
- **Silhouette discipline**: two fan palms (crowns at (0.42,0.14) and (0.28,0.42)) and a
  broadleaf mass are rendered as ~pure `#0f0a09` silhouettes against the lit sky, with
  individual fronds still separable. Nothing is lifted by ambient. The mountain at x>0.60 is
  `#0f0a09`–`#1f1a16` with only its rim catching a faint sky term.
- Headlight pool at (0.60,0.72) peaks `#948f8a` and the lit gravel shoulder at (0.72,0.68) is
  warm `#453520` — the beam is warm on soil and neutral on asphalt.
- Guardrail on the sea side, its top rail picking up ~`#6a6a62` from the sky — a thin
  continuous bright line is what makes the road readable at night.
- Rock cut on the right at (0.65,0.35) shows strata even at this exposure.

### sr_14 (COCKPIT NIGHT, downland, following another vehicle) — darkest frame in the set
- Interior is literally `#000000` at (0.5,0.05) and (0.35,0.90). Windscreen aperture roughly
  x 0.02–0.68, y 0.23–0.62; right door mirror at (0.85–0.99, 0.66–0.77) carries a live
  reflection showing the road, a red car and its own headlight wash.
- Sky through the glass: (0.5,0.30) `#09080d`, (0.5,0.40) `#141420` — deep blue-violet at
  value ~32/255. Stars visible, ~1 px, ~80 of them.
- Terrain silhouette: rolling hill shoulders at (0.1,0.45) `#0d0801` and (0.15,0.52) `#0a0b02`
  — value 8–13/255, effectively black but not clipped; the hill edge against the sky is
  readable as a smooth curve, so the silhouette carries the terrain read.
- Headlit band: asphalt (0.5,0.55) `#393430` → (0.5,0.58) `#58514a`. The grass verges inside
  the beam go warm yellow-green (~`#6e6a2a`) and are the most saturated thing in frame.
- Lead vehicle's tail lamps at (0.53,0.51) — two ~14x5 px red `#7b1e23` bars plus a soft
  ~30 px bloom, and the white reversing/plate lights. Traffic at night is what gives depth.
- Dashed white centreline visible for ~4 dashes inside the beam then gone. The road beyond the
  beam is inferred purely from the verge grass and the silhouette gap.
- **Acceptance: a night cockpit frame must have >30:1 interior:exterior contrast, a non-clipped
  sky at value 25–40/255, and readable terrain silhouette against it.**

### sr_15 (COCKPIT, nautical dusk, coastal, both mirrors live)
- Windscreen aperture x 0.26–0.70, y 0.22–0.60; A-pillars are solid black wedges either side.
  LEFT door mirror (0.02–0.19, 0.66–0.77) and RIGHT door mirror (0.66–0.96, 0.26–0.35) both
  show a WARM ochre sky and the double-yellow road behind — the mirrors face the sunset and are
  therefore brighter and warmer than the forward view. That asymmetry is a real, copyable cue.
- Forward sky: (0.5,0.24) `#131c23`, (0.5,0.30) `#1e262c` (cool teal-grey), warming to
  `#443b2d` at (0.10,0.48) near the sea horizon on the left.
- Headlit road (0.45,0.58) `#8b6c40` — warm, ~2.6x the value of the unlit asphalt at
  (0.75,0.50) `#0c0a09`.
- Yellow curve-warning sign at (0.585,0.485) glowing from retroreflection.
- Guardrail on the sea side reads as a continuous pale line at y≈0.54–0.56.
- Dry grass on the right cut bank at (0.80,0.55) is warm-lit by the headlight spill out to
  ~15 m laterally, then falls to black.

## Batch 5 — re-verified with my own eyes: sr_01, sr_03, sr_04, sr_08

### sr_01 — corrections to the first pass
- The first pass said "camera ~2.6 m above road, pitch -6°, car 0.15 frame width". Measuring the
  frame myself: the car spans x 0.215–0.375, y 0.655–0.795 → **0.16 frame width, ~2.2% area**,
  and the camera is clearly HIGHER than 2.6 m — you see well over the car roof and down onto
  the far lane, consistent with **~6–7 m above road, pitch ≈ -11°**. Use those numbers.
- **Markings are a DASHED white centreline + solid white edge lines** (run-length at y=0.95:
  white edge run 28 px at x385–412; dashes clearly visible along the centre). NOT double solid.
  So the set contains at least five schemes: dashed white (sr_01, sr_14), double solid white
  (sr_04, sr_22 fg), double solid yellow (sr_03, sr_09, sr_10, sr_11, sr_23, sr_24), dashed
  white + solid edge (sr_21), and no markings at all (sr_17, sr_18, sr_19).
- Sky zenith `#8cbbf1`, y=0.15 `#8fc1f6` (very slightly BRIGHTER than the zenith), far blue
  ridge (0.10,0.28) `#7aa3d4` and (0.30,0.30) `#779cc0`.
  **Far ridge / sky-above value ratio = 192/246 = 0.78, hue within 4°.** Same ratio as sr_17.
- Terrain green ramp by distance: near shaded woodland (0.15,0.44) `#374634`, mid sunlit
  pasture (0.40,0.42) `#4e682e`, right-hand hill (0.75,0.30) `#4d6638`, (0.90,0.36) `#3d562e`.
  These stay saturated; only the layer BEYOND the woodland (y<0.31) goes blue.
  **The aerial-perspective onset is abrupt, at a specific depth, not a smooth global lerp.**
- Gold grass verge (0.85,0.75) `#a5a553`; asphalt (0.30,0.95) `#999181` — a light warm grey,
  much brighter than the autumn/overcast asphalts (`#656160`, `#6d625d`). Asphalt albedo is
  lit-dependent, so a fixed grey road value will read wrong at some times of day.
- Timber post-and-rail fence, 3 rails + posts every ~2.5 m, follows the left verge over a crest
  and dip; the rails' vertical profile visibly matches the road's. Fence height ≈ 1.2 m
  (0.34 lane widths).
- Lake at x 0.00–0.30, y 0.48–0.55, occluded by a conifer belt; only ~4% of frame area. The
  water is a pale desaturated blue `#8fa9c0`-ish because it is far, NOT the near-shore teal of
  sr_03. Water colour is distance-dependent.
- Horizon (top of the furthest ridge) at **y ≈ 0.285**; the highest hill crest at y ≈ 0.225.
  The road's vanishing point is HIDDEN — the ribbon disappears behind the right-hand hill
  shoulder at (0.79,0.48) rather than converging to a point.

### sr_03 — corrections/additions
- Camera ~35–45 m above the road, pitch ≈ -28°. Car x 0.365–0.405, y 0.615–0.665 → 0.04 frame
  width, ~0.25% area. The road, not the car, is the subject.
- Sky: zenith `#b1d3ff`, y=0.10 `#b9dafd`, and near the right horizon (0.95,0.30) `#d1e7fe` —
  brightening toward the horizon by ~+32 in R.
- **Water gets PALER and COOLER toward the horizon, richer toward the camera**:
  (0.90,0.45) `#a6bad3` at the far shore → (0.85,0.55) `#659dbe` → (0.95,0.75) `#3d7ca7`
  near-field. Value 211 → 190 → 167, saturation 0.21 → 0.47 → 0.63.
  **Rule: near water saturation ≥ 2.5x far water saturation; both hues stay 195–205°.**
- Far ridges: (0.60,0.25) `#7c8799`, (0.80,0.33) `#6e8a9a` — three distinct ridge layers behind
  the green headland, each ~8–12% closer to the sky value than the last.
- Cut vs fill in one frame: LEFT side is a 45–55° tan cut face with visible scree fans, sparse
  ledge plants and no guardrail; RIGHT side is a fill shoulder dropping into treetops WITH a
  guardrail. **Guardrail rule: present on the fall side only, absent on the cut side.**
- Tan gravel shoulder ~1.5 m (0.43 lane widths) outside the white edge line, both sides.
- Yellow flowering shrubs at (0.50,0.74) and (0.48,0.96) — 2 accents in the whole frame.
- Umbrella pines: crown width ~1.4x height, asymmetric, wind-leaning; NOT vertical cones.

### sr_04 — corrections/additions
- Car x 0.395–0.605, y 0.47–0.76 → **0.21 frame width, ~6% frame area**; camera ~2.0 m above
  road, pitch ≈ -4°. This is the closest chase framing in the set.
- Sky, dusk: zenith (0.5,0.03) `#b38187` mauve-pink → (0.5,0.12) `#c8a39c` →
  horizon glow (0.20,0.28) `#fac5a3` (value 250/255). Thin cirrus streaks visible in the
  upper 20%, ~4 bands, low contrast (±10 units).
- Terrain values at the same moment: (0.15,0.36) `#3d2910`, (0.20,0.42) `#111002`,
  (0.05,0.50) `#0c0501`, right bank (0.90,0.42) `#4f340b`, asphalt (0.50,0.92) `#49413b`.
  **Sky horizon at 98% luminance while the land sits at 4–20% — a ~10:1 sky:land ratio with
  no ambient lift.** This is the single most-copied-wrongly thing in dusk renders.
- The hero tree at x 0.44–0.52 breaks the horizon and OCCLUDES the vanishing point. The road
  curves right and vanishes at (0.585,0.395) behind the tree/hedge mass.
- Horizon (furthest hill crest) y ≈ 0.275; the pale sky band 0.26–0.30 is what reads as "far".
- Dry stone walls on BOTH sides, ~0.5 m high, dark `#3a2f24`-ish, running with the road; the
  right-hand one is buried in cured tussock grass for half its length.
- Ground cover is cured gold `#7a5c22`-ish tussock on both verges at ~0.6 m with individual
  blades to ~15 m; green patchwork fields beyond, so the SEASON differs between the mown
  fields (still green) and the unmown verge (cured gold). That contrast is the season cue.

### sr_08 — corrections/additions
- Camera ~1.2 m above road, pitch ≈ -2°; horizon (sea) at **y ≈ 0.50**, the highest horizon
  in the set. Motorcycle x 0.355–0.475, y 0.575–0.79 → 0.12 frame width, ~2% area.
- Sky: zenith `#bf978c`, y=0.12 `#d1a48f`, brightest just above the waterline (0.20,0.42)
  `#febb91` (value 254). A single-hue (25–30°) warm ramp with a 95-unit value rise.
- The scree/landslide fan at (0.50,0.42)–(0.62,0.48) is a pale `#b09880`-ish talus cone with a
  DARKER wet-looking toe and scrub creeping up its edges — a specific geomorphic feature, not
  noise. Distinct sedimentary banding runs across the mountain face at y 0.40–0.46.
- Scrub distribution follows the GULLIES: dark green conifer/scrub lines run down the drainage
  lines and the interfluves stay pale bare rock. That correlation is what makes the landform
  read as eroded rather than as a bumpy heightmap.
- Roadside species mix, near verge: silver-grey sage, pale cured grass, and yellow-flowering
  *Ericameria*-type bushes in clusters of 3–8, ~1 cluster every 12–20 m — the only saturated
  colour below the sky.
- W-beam guardrail, TWO rails, posts every ~2.0 m, on the seaward side only, with a
  1–2 px specular highlight along the top edge running unbroken for ~250 m.
