# Plant Appearance Update

## Request and Scope

Improve the artificial grass and limited tree variety. This is an appearance
pass following the runtime work in `PLANT_OPTIMIZATION.md`, not another claim
of pixel-identical vegetation or completion of the whole-game reference gate.

The starting screenshots are in `plant-followup-after/shots`. The existing
official `refs/slowroads/official/sr_01.jpg` was inspected for grass scale,
coverage and crown variety before implementation. Canonical capture parameters
in `gauntlet/shots.json` were not changed.

## Changes

- Grass has 18 narrow, tapered, curved blades per tuft instead of 10 broad flat
  strips. Blade height, curl, twist, shading and per-instance splay vary. World
  heights are lower and more varied, with a shorter roadside fringe.
- The 8/5/5 blade bands preserve grass coverage as detail fades. Root-to-tip
  shading and directional wrapped normals add definition without alpha cards.
- There are six tree profiles: pine, oak, birch, aspen, maple and spruce. Species
  selection is seeded and spatially coherent, with distinct height/width ranges.
- Four additional tree geometries are baked offline from different EZ-Tree
  branch configurations. Birch/aspen have pale bark; maple has a broad crown;
  spruce has a dense, low conical crown. Summer leaf tint compensates for the
  library's golden aspen source map. Near geometry and far impostors use the
  same tints and source meshes.
- Spruce stays evergreen; deciduous trees use their bare impostors in winter.
  Shared texture caching avoids loading a separate copy of each species' maps.
- The road apron now feathers into the meadow instead of ending at a hard
  polygon boundary. Asphalt, lane markings, road dimensions, grading, route,
  fences and bridge deck geometry are unchanged.

The existing WebGL2/GLSL material hooks are retained rather than migrating the
renderer to WebGPU/TSL. Instancing, cooperative construction, worker sampling,
culling, stable plant identities and disposal contracts remain in place.

## Assets

New meshes: `public/models/woodland/species.bin`, approximately 2.12 MB.
Triangle counts: birch 8,676; aspen 8,358; maple 10,716; spruce 9,932.
Rebuild with `node gauntlet/bake-species.mjs`. Source configurations, deterministic
seeds and licenses are retained; see `public/models/woodland/SPECIES-SOURCES.md`.
These are stylized botanical interpretations, not botanically exact scans.

## Iteration and Evidence

R1's thinner grass exposed too much flat ground and the new crowns were too
sparse. R2 restored fuller grass clumps and increased leaf area without adding
tree triangles. Both independent blind reviewers preferred R2 over the original
for grass naturalism and tree variety in both tested views. Their locked reports
are in `plant-naturalism-r2/judge-a.md` and `judge-b.md`.

Both reviewers identified the angular meadow/roadside boundary as the largest
remaining issue. The final material-only apron fade addresses that boundary.
The final reviewer confirmed the smoother transition, plausible winter tree
states and an unclipped mobile HUD, with no blocking issue. Some stepped winter
terrain shading remains; see `plant-naturalism-final/judge-final.md`.
This is a before/after preference test, not the stricter multi-round official
reference acceptance procedure in `COMPARISON_PROTOCOL.md`.

Final evidence lives in `plant-naturalism-final/`: summer chase, forest, meadow,
autumn, winter and golden-hour captures, browser checks and performance logs.
The test suite has 216 passing Node tests and all 59 browser rig checks pass,
including all six species, winter transitions, stable populations, bridges,
driving, and desktop/mobile canvas and HUD checks. Production build succeeds
with the existing large-bundle warning. No browser errors were recorded;
isolated browser cleanup reports `remaining: 0`.

Quality has a measurable geometry cost: grass grows from 50 to 126 triangles per
tuft, and six tree profiles create more material batches. The final 1920x1080
chase sample submitted 2.73 million triangles in 664 calls, with a 60 FPS static
median and 52.9 FPS during a six-second drive. These are same-machine samples,
not a guarantee for other hardware. Density and accepted placement identities
were not increased; the added detail is in each plant.

## Reproduce

```sh
node --test gauntlet/*.test.mjs
npm run build
GAUNTLET_URL=http://127.0.0.1:5189 node gauntlet/run-round.mjs \
  --out gauntlet/rounds/plant-appearance-check \
  --shots chase_summer_noon,forest_dense,meadow_open,season_autumn,season_winter,chase_golden \
  --perf-ms 6000
```

The renderer uses an antialiased context. The apron has explicit zero-coverage
discard, but its smooth multisample edge has only been visually tested on the
available ANGLE Metal GPU, including mobile viewport sizes, not physical phones.
