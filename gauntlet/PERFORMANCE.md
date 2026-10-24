# Vegetation Performance

The measurements below describe the **legacy vegetation renderer**. The app now
uses the generation-2 `VegetationSystem` from `src/vegetation/system.js`.
See [PLANT_OPTIMIZATION.md](PLANT_OPTIMIZATION.md) for its completion work,
current validation, and the supported profiling command. Do not compare the
legacy triangle counts below with V2 as though they measure the same scene.

Measured on 2026-09-18 with isolated Chromium, ANGLE Metal on Apple M4 Pro,
1920x1080, pixel ratio 1. These are same-machine comparisons, not a universal
FPS guarantee. No model, plant density, resolution, material, or shadow setting
was reduced by the optimization.

## Diagnosis

In the default seed-7/km-6 scene, the baseline submitted 49.54 million triangles
per frame. Steady-state JavaScript frame work averaged 2.16 ms while wall-frame
time averaged 35.79 ms. The scene was primarily GPU-bound, with additional CPU
build spikes during driving.

| Component | Submitted triangles/frame | FPS with that component hidden |
| --- | ---: | ---: |
| Full scene | 49.54 M | 27.9 |
| Understory leaves and branches | 23.19 M | 49.9 |
| Near/far meadow grass | 14.77 M | 38.6 |
| Detailed woodland trees | 10.59 M | 35.7 |
| Terrain | 0.35 M | 29.0 |

The hide-one-component probes are diagnostic only; production does not hide
these components. Their timing differences are not additive. Halving render
resolution only reached 38.6 FPS, indicating significant geometry work as well
as rasterization cost. A repeated full-scene sample returned 27.8 FPS.

## Changes

- `InstanceCuller` removes out-of-frustum instances from GPU draws, not merely
  from whole-tile visibility. Padded transformed bounds include root-to-crown
  shrink, rotation, scale, inherited shear, and shader sway.
- Meadow instances whose existing shader produces exactly zero geometry are
  excluded too. The current fade's partially visible tail is deliberately kept.
- Only temporary render buffers are packed. Matrices, colors, instance attributes,
  ordering and canonical woodland indices restore after each render. Unchanged
  cameras reuse cached selections, changed buffers upload only their packed prefix,
  and disposal releases owned buffers without deleting shared templates.
- Plant sampling, matrix population and bounding-sphere construction are now
  cooperative tasks. A tile publishes atomically after completion; cancelled or
  stale tasks release partial resources and cannot reappear after a world reset.

## Results

Each static sample uses 15 warmup frames and 90 measured frames after complete
residency. Driving samples use 90 live simulation frames from each initial view;
their exact traveled distances differ with the frame rate. GPU timer intervals
are recorded separately in raw output and are not interpreted as reciprocal FPS.

| Scene | Static FPS before | Static FPS after | Driving FPS before | Driving FPS after | Triangles before/after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chase, seed 7, km 6 | 27.9 | 38.0 | 29.9 | 40.0 | 49.54 M / 24.24 M |
| Forest, seed 12, km 5.5 | 29.0 | 38.5 | 28.7 | 38.2 | 44.97 M / 22.52 M |
| Vista, seed 7, km 12.1 | 31.6 | 42.5 | 29.3 | 38.2 | 38.86 M / 14.79 M |

Driving build-queue P95 improved from 19.2/20.2/20.2 ms to 8.5/6.6/6.4 ms.
Driving frame P95 improved from 38.7/43.7/41.2 ms to 28.9/29.5/30.6 ms.
Instance culling itself costs about 1 ms paused and 5 ms while moving in these
scenes; its net reduction in GPU work outweighs that added CPU work.

The three before/after PNG pairs are byte-identical (matching SHA-256), providing
a strict regression check for these fixed views. Camera-edge, rotation, cache,
attribute alignment and resource cleanup cases are covered by additional tests.
This does not claim pixel identity at every possible camera and world state.

## Reproduce

```sh
node gauntlet/browser.mjs up perf-opt --port 9421
node gauntlet/profile-frame.mjs --port 9421 --ablation --label sample --out /tmp/slowroad-performance
node gauntlet/browser.mjs down perf-opt
node --test gauntlet/*.test.mjs
node gauntlet/streamcheck.mjs
```

The profiler expects the app on port 5188 by default; `--url` selects a different
server. Historical raw measurements and PNGs from this run are under
`/tmp/slowroad-performance-20260918/` as `baseline.*`/`optimized.*` and scene PNGs.
Do not run other GPU benchmarks concurrently when comparing results.

Further gains toward a stable 60 FPS would likely require additional occlusion
work or perceptual vegetation LOD. Those are intentionally separate from this
pass, which preserves the visible scene instead of thinning vegetation.

## Root-Only Tree LOD Trial

The diagnostic compares the original `110:200` tree screen-height band with an
earlier same-source impostor band, then repeats the baseline in the same page.
It does not change production defaults, fade distances, seeds, placements, or
population counts. Only the root agent runs this, serially through the isolated
browser lifecycle in `run-round.mjs`:

```sh
node gauntlet/run-round.mjs --out gauntlet/rounds/tree-lod-trial --shots chase_summer_noon --skip-rig --tree-lod-trial --tree-lod-drive-ms 12000
```

`--tree-lod-bands 140:230,160:260` adds one intermediate candidate. The trial uses
the first requested shot's query, one 1920x1080 page at DPR 1, 90 static samples,
and the same fixed natural-driving duration for every band. Each stage resets
the car/camera and checks identical canonical population and pose signatures
before writing its screenshot. FPS, GPU time, CPU stages, triangle submissions,
and driven start/end kilometres are recorded in `tree-lod-trial.json`.

The override updates both the CPU range and existing GPU uniform references.
Its `finally` restores thresholds/uniforms and invalidates every current tree
mesh, including newly streamed meshes, with baseline bounds padding recomputed
at the current pixel scale. The standalone `tree-lod-trial.mjs` only attaches to
an explicit existing private `--port`; it never starts or owns a browser profile.
Treat differences smaller than baseline versus baseline-repeat variation as
inconclusive, and inspect both visual transitions and geometry/GPU reductions.

Every stage now persists a separate `tree-lod-<stage>.snapshot.json` before its
comparability check can throw. Snapshots include each tile's record count,
canonical/legacy hashes, per-field hashes and numeric-type counts, plus the
vegetation wanted/resident difference and terrain prediction anchor. Real tile,
record, or finite-value differences still fail the trial and remain in its report.

Canonical hashes explicitly distinguish missing fields, `undefined`, `NaN`,
positive/negative infinity, `null`, and finite values. Finite values, including
negative zero, retain their exact Float64 bytes. The former raw-NaN hash and its
observed NaN bit patterns remain as diagnostics, so a representation-only mismatch
can be distinguished from a changed population without guessing its cause.
Use a fresh output directory for each run; existing trial reports are immutable.

Version 3 controls the live range and uniform exposed by each tree material,
not `FOREST_LOD` from a fresh direct import. Vite can load the application's
`forestField.js?t=...` and the diagnostic's plain URL as separate module instances.
Their object identity difference is recorded and allowed, but the direct-import
range is never modified. Equal values in a different object are not evidence of
changing the CPU's captured range.

Each phase now checks real near/far `instanceVisible` callbacks at fixed projected
pixel boundaries, captures current-camera culler selections, and records actual
tree draw submissions by bark/leaf/impostor. A candidate must change the actual
selected and submitted workload; baseline-repeat must restore both. A matching
GPU uniform alone cannot pass. Historical trial-10 measurements are marked
unusable in that round's `UNUSABLE.md`; its original reports remain untouched.
