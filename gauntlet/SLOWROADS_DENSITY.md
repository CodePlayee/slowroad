# Woodland Mass and Grass Contrast

## Target

The requested look is closer to Slow Roads: legible green/gold grass over a
darker base, substantial woodland groups, and retained meadow clearings.
Primary reference: `refs/slowroads/official/sr_01.jpg`. Secondary reference:
`sr_16.jpg`, for forest-edge density and grass/root contrast. Both were inspected
alongside `plant-naturalism-final/shots` before this pass.

This remains an instanced-mesh scene using the existing WebGL2 renderer, PBR
materials, GLSL hooks and atmosphere. No renderer migration, new post-processing
pass, camera changes or screenshot-fixture retuning was introduced.

## Changes

- Trees use eight independently seeded layers over the original 16x10 lattice:
  1,280 candidates per cell instead of 160. Layer zero retains the original
  coordinates and random streams. Supplemental layers favor the interiors of
  groves instead of uniformly filling every clearing.
- Tree root clearance is 10 metres, with a six-metre density ramp beyond it.
  Road, water, slope and altitude filters remain active. All six tree profiles
  and their seasonal behavior remain intact.
- Grass no longer copies the terrain palette. Its four seasonal palettes use
  deeper green bodies, brighter warm tips and darker rooted bases. The shader
  remains scene-lit rather than emissive.
- Grass uses four independently seeded placement layers, with 9,216 candidates
  per cell instead of 2,304. The original layer is retained exactly. This fills
  gaps with curved, wind-responsive blades rather than opaque-looking tuft cards.
- Nearby low-turf shading gives the space between blades more depth. It fades
  continuously between 65 and 145 metres and is gated off at snow, shoreline,
  exposed rock and the immediate road surface. Distant terrain is unchanged.

For seed 7 at km 6, the same streamed tree neighborhood now contains 156,903
trees versus 15,732 previously. Within a 150-metre circle around the car, the
count changes from 36 to 432. These are population counts, not counts of trees
visible in a single frame. In the same captured neighborhood, accepted grass
clumps increase from 154,108 to 616,876. Shrub placement is unchanged. The exact
increase depends on terrain, moisture and forest cover.

## Keeping the Denser Scene Practical

- Each forest species group shares lazy projected-size and distance calculations
  across its bark, leaves and impostor. Camera-independent ridge coefficients
  are cached; camera position and pixel-scale changes invalidate view results.
- A conservative horizontal bound rejects irrelevant groups before per-instance
  work. Exact ridge and LOD equations, visibility thresholds and shaders remain
  unchanged.
- Instance transforms are composed once, then copied in cooperative chunks into
  independently owned representation buffers.
- Grass submits only the blade prefix that can have nonzero width. Conservative
  projected-height bounds select 8, 13 or 18 blades; this does not thin plant
  populations or omit a partially visible LOD band. The pre-infill chase frame
  submits 3.62 million triangles versus 4.05 million before this prefix change.

There is still a real cost to substantially more trees. The first dense pass
measured a 44 FPS static median and 33.9 FPS driving on this machine. The final
pre-infill pass measured a 60 FPS static median and 59.0 FPS during a six-second drive,
with no frame above 33.4 ms (worst: 26.8 ms). Machine load varies, so the full
timing difference cannot be attributed to the prefix optimization alone. Its
reduction of 426,510 submitted triangles in the fixed chase view is directly
measured. Those timings precede the four-layer grass population. None of these
short samples guarantees the frame rate on other devices.

The final four-layer grass pass (`slowroads-dense-blades`) measures 60 FPS static
median (17.1 ms p95) and 57.9 FPS during the six-second drive at 1920x1080. The
worst driving frame is 29.2 ms, with none above 33.4 ms. The static frame submits
8,394,292 triangles in 702 draw calls. More continuous grass therefore carries
a substantial geometry cost despite retaining the measured near-60-FPS result
on this machine.

Normal-budget startup and teleport also pass (`slowroads-dense-blades-startup`),
without forcing the scheduler to drain. Initial playability arrives at 7.0 s;
teleport playability arrives at 5.6 s. The complete 563-cell neighborhood finishes
streaming in the background at 43.1 s / 43.8 s respectively. These full-residency
times are not loading-screen times. Frame CPU p95 across those phases is 6.4 ms /
6.9 ms; startup still includes a 200 ms peak during initial setup.

A second, 20-second driving sample covers 0.563 km at 59.3 FPS, with a 30.3 ms
worst frame and none above 33.4 ms. Its static median remains 60 FPS. Both final
rounds completed successfully and cleaned up every owned browser process.

## Rejected Prototype

A three-card low-grass layer was tested and rejected. Coverage-preserving mips
merged the dense atlas bases while losing fine tips at gameplay distance, making
flat green wedges. GPU atlas readback ruled out a flipped upload. The final
runtime does not include these cards or their asset-loading path; diagnostic
captures remain in `grass-mask-diagnostic-fixed` for traceability.

## Verification

231 Node tests pass, including original-lattice stability, supplementary tree
and grass layers, shared-cache invalidation, exact LOD predicate parity,
conservative grass prefixes, seasonal palette independence and contact-shading
gates.
The production build passes with the existing large-bundle warning.

Pre-infill captures and raw checks are under `gauntlet/rounds/slowroads-density-final`.
Final four-layer grass captures are under `gauntlet/rounds/slowroads-dense-blades`.
All 61 browser checks pass, with no page errors and zero remaining private
browser processes. The rig includes a full-index versus optimized-prefix GPU pixel comparison,
checks dense roadside populations, and exercises seasons, seeds, teleport,
driving and desktop/mobile layouts. The fixed chase view saves 1,703,065 submitted
triangles with the prefix optimization and has zero changed pixel components;
the offset-camera comparisons also pass.

An independent blind review preferred the final grass in both views with high
confidence (`judge-final.md`; A is final, B is the pre-infill population, C is
the official reference). No new static regression was identified. Remaining
gaps include exposed flat ground between foreground clumps and less continuous,
layered vegetation than the reference. This is improvement, not visual parity.

## Reproduce

```sh
node --test gauntlet/*.test.mjs
npm run build
GAUNTLET_URL=http://127.0.0.1:5189 node gauntlet/run-round.mjs \
  --out gauntlet/rounds/dense-woodland-check \
  --shots chase_summer_noon,forest_dense,meadow_open,season_winter,chase_night \
  --perf-ms 6000
```

This is a targeted vegetation-density and material pass. It is not a claim of
pixel-perfect Slow Roads replication or completion of the broader official
reference acceptance gate.
