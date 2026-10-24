# Plant Optimization Completion

## Scope

The active renderer is generation 2 (`src/vegetation/system.js`), not the legacy
`vegetation.js`. Its worker-generated populations, continuous grass detail,
same-source tree/shrub impostors, coverage mipmaps, and instance culling were
already implemented before this pass. The earlier `PERFORMANCE.md` measurements
apply to the legacy renderer, not this baseline.

This pass finishes integration without changing models, population density,
placement, LOD thresholds, lighting, or resolution:

- Grass and forest instance construction now yields in bounded slices. Grass
  bounding-sphere construction yields too and matches Three.js's result exactly.
- Cells publish atomically only after all representations are complete, with a
  final terrain-coverage check. Their scheduler key stays pending between slices.
- Moving away, resetting, disposing, or dropping a task releases partially built
  meshes. Saved callbacks cannot publish cancelled cells. Shared asset buffers
  remain owned by their fields.
- Direct autumn startup initializes flower coverage to 0.4, matching an
  interactive season change. Late flower loads and failed builds release their
  resources instead of resurrecting disposed fields or leaking partial meshes.
- The profiler supports both vegetation generations, recognizes V2 field
  materials, and restores its temporary hooks and GPU state even on failure.
  Missing GPU samples are reported as unavailable, not as zero cost.

## Reproduce

Use an available port without replacing a server already running:

```sh
npm run dev -- --host 127.0.0.1 --port 5189
node --test gauntlet/*.test.mjs
npm run build
GAUNTLET_URL=http://127.0.0.1:5189 node gauntlet/run-round.mjs \
  --out gauntlet/rounds/plant-check \
  --shots chase_summer_noon,forest_dense,vista_wide,season_winter,chase_golden \
  --perf-ms 6000 --profile
```

`run-round.mjs` serializes captures, driving measurements, desktop/mobile rig
checks, and CPU/GPU profiles using one isolated headless browser, then verifies
that its profile has no remaining processes. `GAUNTLET_URL` selects the app
server; the profiler also accepts `--url` directly.

## Validation

The frozen before/after capture rounds are stored in
`gauntlet/rounds/plant-completion-before` and
`gauntlet/rounds/plant-completion-after`.

The chase, forest, and vista before/after PNGs are byte-identical. This proves
unchanged rendering for those three fixed fixtures, not every possible scene.
This is a runtime-completion pass, not acceptance of the separate whole-game
visual comparison gate in `COMPARISON_PROTOCOL.md`.

Verified on 2026-09-19 (local time), isolated Chromium / ANGLE Metal / Apple M4
Pro, 1920x1080 at DPR 1:

- All 193 Node tests pass; production build succeeds. Vite retains its existing
  large-bundle warning.
- All 58 browser rig checks pass, including plant assets, population identity,
  winter/summer transitions, direct autumn startup, seed reset, teleport,
  driving, and canonical buffer restoration after culling.
- Nonblank canvas and non-overlapping HUD checks pass at 1280x720, 390x844,
  320x568, and 844x390. Five seasonal/scene screenshots were visually checked.
- No browser errors; isolated browser cleanup reports `remaining: 0`.

| Current V2 scene | Static FPS | Driving FPS | Submitted triangles |
| --- | ---: | ---: | ---: |
| Chase, seed 7, km 6 | 60.0 | 59.7 | 1,581,117 |
| Forest, seed 12, km 5.5 | 60.0 | 59.4 | 1,673,327 |
| Vista, seed 7, km 12.1 | 60.0 | 57.2 | 1,559,243 |

These profiler samples use 15 warmup and 90 measured frames per mode. A separate
6-second chase drive measured 59.8 FPS with no frame over 33.4 ms. The V2 baseline
was already about 60 FPS, so this pass does not claim an FPS increase. The goal
is bounded build work and correct lifecycle behavior without visual regression.
The scheduler budget remains cooperative, not a hard frame-time guarantee;
terrain and other callbacks can still exceed it (vista build-queue P95: 8.7 ms).
Raw measurements are in the after round's `profile.json` and
`logs/perf.stdout.log`; browser checks are in `logs/rigcheck.stdout.log`.

## Follow-up: Less Sampling and Buffer Work

The next pass changes only `population.js` and `instanceCulling.js` in the
runtime. Population size, placement, rendering settings and the two-cell
publication limit stay unchanged.

- Population candidates first pass a slope-free upper bound on growth density.
  Impossible candidates skip the two extra ground samples used for slope.
  Survivors retain the original final density arithmetic and random sequence.
- The culler caches an aggregate box enclosing the existing padded instance
  spheres, rejects wholly offscreen batches, then checks individual spheres
  before expensive plant LOD predicates.
- Moving the camera no longer forces identical instance data to be recopied and
  uploaded. Changed selections or source buffers still update correctly;
  pending GPU upload ranges survive intervening canonical-buffer renders.

Exact deep comparisons against the pre-change generator covered 135 real-world
tiles across three seeds, five route locations and all three plant categories:
all 55,360 accepted records were identical. Slope queries fell from 90,720 to
55,370 (39.0% fewer). Permanent regression tests also cover frozen population
fixtures, moving-camera selection parity, source edits, empty/shrinking/growing
selections, padded bounds and pending uploads.

Normal-budget measurements are now available without the capture rig's forced
queue draining:

```sh
GAUNTLET_URL=http://127.0.0.1:5189 node gauntlet/run-round.mjs \
  --out gauntlet/rounds/plant-followup-check --startup --profile \
  --shots chase_summer_noon,forest_dense,vista_wide,season_winter
```

The `startup.json` file records first playable visibility separately from full
scene residency, along with worker backlogs, CPU-ready cells and CPU timings.
The recorded comparison uses `plant-followup-before` and `plant-followup-after`.

| Normal-budget milestone | Before | After |
| --- | ---: | ---: |
| First playable scene | 4.87 s | 4.83 s |
| Full initial scene residency | 20.29 s | 16.43 s |
| Visible destination after teleport | 2.56 s | 2.44 s |
| Full destination residency | 31.36 s | 15.13 s |

These are same-machine samples, not guaranteed loading times. In particular,
full residency includes offscreen plants and must not be confused with the
shorter visible loading period. Final resident population counts match exactly.

The follow-up driving profiles also show substantially less culling CPU work:

| Scene | Culling before | Culling after | Reduction |
| --- | ---: | ---: | ---: |
| Chase | 13.33 ms | 5.65 ms | 57.6% |
| Forest | 16.40 ms | 6.44 ms | 60.7% |
| Vista | 19.55 ms | 6.66 ms | 65.9% |

Use the paired follow-up profiles for this comparison, not the earlier pass:
machine load changed between runs. The corresponding driving FPS samples were
57.8/44.1/39.1 before and 59.8/55.6/52.7 after; these are not universal guarantees.

Validation: 202 Node tests and 58 browser rig checks pass; production build
succeeds. Desktop/mobile canvases and HUD checks pass, with no browser errors
and no remaining owned browser processes after either validation round.

Chase, forest, and winter reference PNGs are byte-identical. The separate vista
loads differ in 8,635 pixels (0.4164%) near the horizon, with different settled
terrain footprints (245 versus 249 tiles). Terrain lookahead uses measured
latency even while paused, so URL parameters alone do not freeze this detail.
That is consistent with the observed difference but does not prove its cause.

To isolate culling correctness, `plant-followup-parity/culling-parity.json`
compares the saved pre-change culler and the optimized culler against the exact
same loaded vista scene. All six 1920x1080 views, including small camera shifts,
a 180-degree turn and return, have **zero differing pixels** and identical
triangle counts. This verifies the optimization independently of cross-load
terrain variability. Reproduce with a saved pre-change culler module:

```sh
GAUNTLET_URL=http://127.0.0.1:5189 node gauntlet/run-round.mjs \
  --out gauntlet/rounds/culling-parity-check --shots vista_wide --skip-rig \
  --culling-reference /path/to/pre-change/instanceCulling.js
```
