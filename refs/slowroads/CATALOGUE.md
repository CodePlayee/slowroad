# Slow Roads Reference Catalogue

One entry per reference image. 24 official gameplay screenshots (1920x1080) plus live web-build frames.
Piece tags: terrain, road, bridge, water, vegetation, atmosphere, daycycle, season, journey, streaming.

STATUS: in progress — entries appended in batches of 4.

Measurement method: images opened with the Read tool; colours and marking geometry sampled
numerically with `_probe.py` (mean of a 13x13 patch, so JPEG noise is averaged out).

---

## sr_01.jpg
- **camera**: chase, medium-far (car ~285 px wide = 0.15 frame width, ~2.1% frame area), camera ~4.5 m behind / ~2.6 m above road, pitch ≈ -6°
- **biome**: temperate rolling hills, conifer + broadleaf mix, lake in the mid-left
- **season / time / weather**: summer / late morning–noon (short, soft shadows) / clear
- **impressive**: Five readable depth layers stacked without a single hard silhouette edge — near golden grass verge, mid dark conifer belt, lake shelf, sunlit pasture-and-woodland hill on the right, then a fully de-saturated blue ridge at `#7fa3cd` at y≈0.29. The road is *pinned to the contour*: it banks around the hill shoulder on a fill embankment that catches the light on its outer face, and the post-and-rail fence follows the road's vertical curvature exactly, which sells the terrain-following. The right verge changes species with the slope — tall dry gold *Stipa*-like grass on the sunny cut face, short green pasture on the shaded left.
- **best bar for**: **road** (contour-following + fill embankment), also terrain, journey, streaming

## sr_02.jpg
- **camera**: cinematic wide, high and detached (~120–180 m above the road, pitch ≈ -20°); car is a 50 px speck at (0.80, 0.81)
- **biome**: coastal cliff, dry pine/scrub hillside above a beach and open water
- **season / time / weather**: summer / dusk, sun already below the horizon / clear with heavy low-altitude haze
- **impressive**: The sea horizon sits *high*, at y≈0.43, and the whole left half of the frame is nothing but a value ramp — sky `#e6ba93` → water at horizon `#a9937c` → mid water `#8c795b` → foreground water `#624745`. The hillside recedes in four haze steps and the two furthest headlands are pure flat wash with zero texture. The road is legible only as a thin pale ribbon plus a guardrail highlight zigzagging down the slope, which is exactly how a real coast road reads from that distance. The beach is a continuous S-curve of pale sand, ~6–10 px wide, that never breaks or z-fights with the water plane.
- **best bar for**: **water** (colour ramp + glint field), **atmosphere**, daycycle (dusk), journey

## sr_03.jpg
- **camera**: cinematic wide / high-3/4, ~30–40 m above and outside the road, pitch ≈ -25°; car ~90 px wide at (0.385, 0.64)
- **biome**: Mediterranean / chaparral coast — tan soil, scree, umbrella pines, oak-like broadleaf shrubs, yellow flowering bushes
- **season / time / weather**: summer (dry) / midday–early afternoon / clear with strong distance haze
- **impressive**: The best **cut-vs-fill** reference in the set. On the left the road is carved into the hillside: a 45–55° exposed tan cut face with individual scree fans and plants clinging to ledges; on the right the same road sits on a fill shoulder that drops straight into treetops with a guardrail on that side only. Marking scheme is American — **double solid yellow centreline + solid white edge lines** — with a ~0.5-lane tan gravel shoulder outside the white line. Five depth layers: near cut slope, mid scrub ridge, big green headland, pale blue-grey mountain, faint far ridge. The teal water goes *lighter and cooler* toward the horizon, opposite to the usual lazy "darker at horizon" mistake.
- **best bar for**: **road** (cut/fill, shoulder, guardrail asymmetry), **terrain**, water, vegetation

## sr_04.jpg
- **camera**: chase, close (car ~390 px wide = 0.20 frame width, ~10% frame area), camera ~3.2 m behind / ~1.9 m above road, pitch ≈ -4°
- **biome**: upland farmland / moor — dry stone walls, rough golden tussock grass, hedgerow trees, patchwork pasture
- **season / time / weather**: late summer or early autumn (grass fully cured gold) / dusk ~20:30 / clear with thin cirrus
- **impressive**: The exposure is honest — the terrain has fallen to `#26201a`–`#3d2910` (≈13–20% luminance) while the sky near the horizon is `#fdc7a2` (≈90%). Nothing is lifted by a fake ambient floor, so the land reads as silhouette-with-detail. A single hero tree at x≈0.48 breaks the horizon line and hides the road's vanishing point, which is a deliberate composition trick — the road curves right and disappears rather than shrinking to a dot. Marking scheme here is a **solid double *white*** centreline, different again from sr_01 and sr_03. Dry stone wall (~0.35 lane heights) on the left runs with the road for ~40 m before the grass swallows it.
- **best bar for**: **daycycle** (dusk exposure), **season**, road markings, journey
- **note**: HUD is visible (`6.1 MILES`, `50.9 MILES PER HOUR`, `AUTOSTEER`) at y≈0.83–0.90.

## sr_05.jpg
- **camera**: cockpit / driver interior. Windscreen aperture spans x 0.16–0.70, y 0.17–0.61; eye height ~1.15 m; pitch ≈ -2°. Rear-view mirror at (0.00–0.18, 0.11–0.34) and right door mirror at (0.87–1.00, 0.66–0.79) both carry live reflections.
- **biome**: lakeside conifer forest, spruce + birch, rocky cut bank on the right
- **season / time / weather**: summer / **night, clock reads 02:01** / clear with lake fog
- **impressive**: The only true night frame in the set and it is not black. Sky above the far shore is `#333f4f`, the lake surface `#455669`–`#495a70`, i.e. night keeps ~28% luminance and stays *blue*, while the car interior falls to `#000000`–`#0b0f17` — a >20:1 interior:exterior ratio so the cabin reads as pure silhouette. The headlight cone lights the carriageway to y≈0.50 (≈35–45 m) with a hard lateral falloff and picks white roadside flowers out of the dark. Traffic exists: a lit tail-lamp car ~40 m ahead, another visible in the rear-view mirror. Fog sits as a discrete stratum over the water between y 0.40 and 0.48, below the treeline.
- **best bar for**: **daycycle (night)** — the *only* night bar we have, **journey** (cockpit framing), water at night, atmosphere

## sr_06.jpg
- **camera**: low-angle 3/4 front, close (vehicle customiser). Camera ~1.0 m above road, ~7 m ahead of and left of the car; car spans 0.20–0.53 x.
- **biome**: temperate deciduous valley with a grass cut-slope on the right
- **season / time / weather**: **autumn, peak colour** / mid-morning / clear
- **impressive**: The autumn canopy is *not one hue*: `#604506` (deep russet), `#785c09` (ochre), `#4f4627` (olive-brown, still turning), plus bare grey-trunk trees with only a few leaves and a dark green conifer clump at x≈0.65 that refused to turn. Brown leaf litter is scattered on the asphalt itself and drifts against the verge. Close-up asphalt resolves individual 3–5 px aggregate grains plus two darker tyre-polish tracks — it is a real surface, not a flat grey. Cured tussock grass on the right verge stands ~0.5–0.7 m with resolved individual blades and its own contact shadow.
- **best bar for**: **season (autumn)**, road surface material, vegetation
- **note**: vehicle-customiser panel covers the right 17% of the frame.

## sr_07.jpg
- **camera**: low-angle 3/4 front, car parked off-road on a two-rut grass track; camera ~0.9 m above ground, pitch ≈ -3°
- **biome**: chalk/limestone downland — dry stone walls, hedgerow oaks, a single spruce, open sheep pasture
- **season / time / weather**: **spring** / dusk (~21:00) / clear
- **impressive**: Spring is signalled by *flora*, not by a green tint: clumps of 3–6 yellow daffodils and white narcissus scattered irregularly through knee-high fresh grass, plus deciduous crowns that are thin and open rather than solid. The sky runs violet at the zenith `#a4a0c9` → mauve `#c99ebf` → rose `#d999b4` at the horizon: a *three-hue* twilight gradient, not a two-stop lerp. The two-rut dirt track with an unmown grass strip down the middle is a strong "lived-in world" cue.
- **best bar for**: **season (spring)**, **daycycle (dusk/twilight sky gradient)**, vegetation ground cover
- **note**: handling/shocks panel covers the left 17%.

## sr_08.jpg
- **camera**: chase behind a motorcycle, **low** — camera ~1.1–1.3 m above the road, pitch ≈ -2°; horizon pushed up to y≈0.47
- **biome**: Californian coastal chaparral — pale sedimentary mountain, silver sage, yellow-flowering *Ericameria*-type scrub, dry grass, scattered pines
- **season / time / weather**: summer (dry) / sunset, sun on or just below the horizon at screen left / clear with strong warm haze
- **impressive**: Best **erosion and journey** frame. The mountain shows banded pale sediment, a large scree/landslide fan at (0.50, 0.42), darker scrub concentrated in the gullies, and — critically — **the road you will be driving later is visible as a cut traversing the far hillside at (0.60, 0.44)**. Water and sky nearly merge: sky just above the waterline `#e5af8d`, water just below `#c7a78e`, so contrast across the horizon is ~12%, which is what real backlit water does. The distant headland at (0.28, 0.42) is a flat `#a78268` wash with no texture at all. Guardrail is W-beam steel, two rails, posts at ~2 m.
- **best bar for**: **terrain (erosion/scree)**, **journey** (see-your-future-road), atmosphere, daycycle (sunset), vegetation species mix
