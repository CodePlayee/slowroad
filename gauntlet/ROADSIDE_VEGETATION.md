# Roadside Vegetation and Continuous Streaming

## Requested Behavior

- Tall woodland along most of the route, not just the starting area.
- Modeled grass only near the road; textured terrain takes over smoothly away
  from the road and camera.
- Preserve road clearance, water exclusions, seasons, stable placements and
  independent terrain/vegetation streaming.

The implementation stays in the existing Three.js WebGL2 instanced-mesh and
GLSL material architecture. It adds no post-processing passes, renderer change
or terrain geometry. World-space sampling combines a newly generated meadow
turf texture with the existing CC0 litter texture. Asset provenance is recorded
in `public/textures/meadow-turf-v1.md`.

## Diagnosis

The former generation rules did not make the entire later route treeless. A
production-equation audit found seed 7's first six kilometres averaged 88.8 trees
per 100 m of road, versus 95.9 later, measured in 300 m windows with roots 10-80 m
from the centreline. Some individual sections were very sparse: km 26 had only
53 trees in its window. Forest cover, not altitude or slope, caused those gaps.

A separate real-queue reproduction found a streaming bug: a retained tree job
approaching the car changed its planned priority from 5715.29 to 0, but the
worker queue retained 5715.29. New near-grass jobs could continue taking
precedence. The previous four-layer grass population also covered a much wider
area than the requested roadside strip.

## Changes

- Refresh priorities for retained population-worker jobs and partially built
  scheduler tasks whenever the streaming focus crosses a cell. Preserve their
  identities, results and build continuations.
- Cull whole off-road grass cells with a conservative circumscribed bound.
  Stream a three-cell grass radius instead of five. Reject candidate roots at
  or beyond 28 m from the road before expensive slope sampling.
- Share the CPU/GLSL transition contract in `grassCoverage.js`: full roadside
  coverage from 6.5-16 m, taper to zero at 28 m; camera-distance fade from 48-76 m.
  Values are measured from the road centreline, not its paved edge. Root and
  blade heights never snap during fading. Original blade geometry, wind and
  conservative 8/13/18-blade draw prefixes remain intact.
- Keep textured ground continuous underneath. Add a rotated, broadly warped
  0.12/m detail sample alongside fine grass/litter samples; use its value
  with seasonal turf color. Contact shading uses the same road/view weights,
  while texture contribution gradually increases as modeled grass thins out.
  Snow, shore, rock and road-edge material masks remain protected.
- Add a world-noise-modulated woodland cover floor within 90 m of the road,
  fading back to the original biome cover at 150 m. This retains small gaps,
  existing remote forests and all road/water/slope/altitude exclusions without
  increasing the number of tree candidates or special-casing route kilometres.
- Increase species-specific tree heights to 13-30 m. The seed-7 audit mean is
  19.65 m, up from 13.50 m; 92% of sampled accepted trees are at least 15 m tall.

## Route Evidence

Frozen added visual fixtures: seed 7, summer noon, clear weather, chase camera,
km 18 and km 26, 1920x1080. Existing canonical fixtures are unchanged.
Before captures are in `rounds/roadside-before-valid`; numerical after results
are in `rounds/roadside-after-valid/route-audit.json`.

Seed 7, sampled each kilometre over its 28.88 km route:

| Metric | Before | After |
| --- | ---: | ---: |
| Mean trees per 100 m | 94.2 | 190.9 |
| Sparsest sampled window, trees per 100 m | 17.7 | 125.7 |
| Trees in the km-26 300 m window | 53 | 467 |
| Mean accepted tree height | 13.50 m | 19.65 m |

Seeds 12 and 31 are independently sampled every four kilometres. Regression
tests require woodland density along the majority of sampled road sections,
tall trees, road-band filtering, deterministic revisits and correct queued
priority after approaching a cell. These are generated population measurements,
not the number of trees visible in a single screenshot.

## Verification

246 Node tests pass. The production build passes with the existing large-bundle
warning. A read-only cross-review found no confirmed issues in shared masks,
conservative cell bounds or queue/continuation ownership.

The sustained driving harness starts with ordinary minimum-ready loading at
km 18, then drives for 120 seconds without calling `rig.ready()` or force-draining
the scheduler. It records nearby supported/tall trees, pending near-tree cells,
grass road bounds and errors every second. Static captures, driving evidence,
browser checks and cleanup records are under `rounds/roadside-final`.

The 120-second drive passes: km 18.001 to 21.170 (3.169 km), 118 samples, no
force-drain and no page errors. After the first 10 seconds, every sample has all
near-tree cells supported/resident, at least 650 trees within 150 m and at least
590 trees 15 m or taller. No grass record lies outside the requested road band.
The initial drive screenshot catches the normal boot-overlay fade; use the
60-second/end frames and settled static captures for visual comparison.

All 61 browser checks pass, including GPU grass-prefix pixel parity, seasons,
seed reset, driving, nonblank desktop/mobile canvases and HUD containment. The
round's isolated browser cleanup reports `remaining: 0`.

The first new 1080p performance sample reports 45 FPS static / 49.4 FPS driving
over six seconds, 7.73 million submitted triangles and 698 draw calls. Its worst
frame is 42.2 ms (three above 33.4 ms). This is slower than the prior shorter-tree
59-FPS sample, even with fewer grass models; scene density and machine load both
matter. It must not be reported as a guaranteed 60-FPS result.

An independent image comparison preferred the new tall woodland in both fixed
later-route views, but found no clear improvement in turf handoff. It identified
the pale, weakly textured off-road slopes exposed by removing grass geometry.
That finding prompted a second material pass: a dedicated green grass texture
replaces the leafy/soil-rich source, and a stronger, predominantly world-fixed
turf base replaces gray soil on the existing eligible meadow mask. Population,
streaming and all surface exclusion masks stay unchanged.

The repeat pre-turf 20-second drive (`roadside-performance`) measures 53.4 FPS;
the short profiler intervals vary by view: chase 57.1 static / 59.0 driving,
forest 58.9 / 57.3, and wide vista 44.9 / 42.3. Driving instance-culling CPU work
is about 10-11.5 ms. Tall, dense tree rendering and culling remain performance
costs; the grass restriction is not presented as eliminating every bottleneck.
Final material captures and a repeated browser check are in
`rounds/roadside-turf-final`.

The final material round passes all 61 browser checks again, including desktop
and mobile canvas/HUD checks, with no page errors and `remaining: 0` browser
processes. Its six-second 1080p driving sample averages 58.3 FPS (worst 26.6 ms,
none above 33.4 ms); static median is 59 FPS. The variation across the repeated
samples above is why this remains a measurement, not a device-wide guarantee.

The final turf-only blind comparison prefers the new surface in both scenes
(P1/B and P2/A, second advantage smaller), with no new obvious repeating pattern
or color band. Transition naturalness is rated tied, not a decisive improvement;
exposed patches and distant-slope detail remain visual limitations. See
`rounds/roadside-turf-final/judge.md`. The full Slow Roads reference gate remains
unclaimed.

At the fixed seed-7/km-6 view, the resident grass population drops from 616,876
to 67,520 roots. Nearby trees within 150 m increase from 432 to 891, while the
whole streamed tree population changes only from 156,903 to 164,683. This
redistributes effort toward the requested road experience instead of multiplying
every distant forest cell again.

```sh
node --test gauntlet/*.test.mjs
npm run build
node gauntlet/route-vegetation-audit.mjs --step-km 1 --out /tmp/route-audit.json
GAUNTLET_URL=http://127.0.0.1:5189 node gauntlet/run-round.mjs \
  --out gauntlet/rounds/roadside-check --drive-ms 120000 \
  --shots route_26km,route_18km,chase_summer_noon,season_winter --perf-ms 6000
```

This is a targeted roadside distribution and streaming fix, not a claim of
pixel-perfect Slow Roads reference parity.
