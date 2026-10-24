# Frame Pacing

## Diagnosis

Average FPS hid two independent causes, measured on 2026-09-29 on this Mac.
Tests use an isolated bundled Chromium/ANGLE Metal browser, 1920x1080 CSS,
device DPR 2, seed 7, the default chase camera and automatic raster quality.
The recorder times application frames and CPU stages, not GPU timer queries.
It takes no screenshots or video during the measurement. The interval ending
at frame N is paired with the work in frame N-1.

1. Terrain publishing still synchronously sampled the river on the main thread,
   including dry tiles. A 90-second drive from km 6 recorded publication bursts
   up to 13.4 ms and consecutive 22-29 ms frames. A second 45-second drive from
   km 7.6 isolated water building as over 90% of these bursts. The geometry
   wrapper generally took only 0.1-0.3 ms. The scheduler's 6 ms budget cannot
   interrupt a long synchronous callback.
2. After moving water work, another 90-second run caught canvas resizing itself
   taking 23.5-41.2 ms, with corresponding frame intervals up to 58.7 ms. The
   old controller could lower quality on ordinary RAF short/long jitter and
   then probe upward again after 12 seconds. Stable vsync is not evidence of
   spare GPU capacity. The first baseline run had no ratio changes, so this
   second cause was not visible in that run.

3. A subsequent V8 trace proved a 42.914 ms main-thread MajorGC overlapping a
   58.5 ms frame interval. It was not terrain publishing or a raster resize.
   Culling also built many temporary layout/signature arrays every frame.

The Chrome overlay screenshot alone cannot identify these causes. Its GPU
memory figure is not treated as total application WebGL memory. Other system
contention has not been proven and is not claimed as a cause.

## Changes

- River sampling and water buffer generation now accompany terrain generation
  in the existing two-worker pool. Wet buffers are transferred, not copied.
  An explicit `water: null` marks dry tiles and prevents resampling on publish.
- The no-worker path uses the same generator and yields every water row. Epoch
  rejection, cancellation, terrain/road readiness and parent coverage remain.
- Raster adaptation requires two consecutive two-second windows of mean frame
  time above 19.5 ms or over 15% missed frames
  with CPU headroom, not the old p75 threshold. CPU time is paired with the
  correct preceding frame. A settled ratio stays fixed during travel; viewport
  resizing resets it. Genuine overload can still lower quality, and such a
  necessary canvas resize can still stall. Explicit DPR/high locks are intact.
- No plant density, visibility range, water resolution, materials, MSAA or
  road geometry was reduced for this fix.
- Culling reuses layout scratch space, double-buffered signatures and restore
  snapshots instead of per-batch `Object.entries`/`flatMap` chains. Instance
  copying and upload-range marking no longer create per-selection closures.
  All source-version, attribute-divisor, transform and layout invalidations
  remain. This reduces allocation pressure; it does not disable browser GC.

## Final Measurements

All rows are 90-second drives from km 6, excluding the first 15 seconds here.
Raster DPR remained 1.0063 and plant LOD stayed unchanged in these three rows.

| Run | FPS | P95 ms | P99 ms | Frames >20 ms | Frames >33.4 ms | Maximum ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Original pacing baseline | 59.74 | 17.7 | 20.5 | 54 | 0 | 29.1 |
| Water/controller fixed, with V8 trace | 59.76 | 17.5 | 18.8 | 23 | 5 | 58.5 |
| Plus culling storage reuse, with V8 trace | 59.83 | 17.6 | 18.2 | 18 | 1 | 59.7 |

These separate runs share a route/configuration, not an identical system load.
The baseline was untraced; the two traced runs use identical trace categories.
Do not claim a universal percentage speedup or that all tail latency is gone.
In the matched traced runs, minor collections fell from 562 to 495 over the
full 90 seconds, and their total main-thread duration fell from 524.8 to 395.3 ms.
Major collections fell from eight to seven but still included a 46.5 ms pause,
responsible for the final run's isolated 59.7 ms interval. This residual is
explicitly unresolved, not hidden by the better P99/average.

Water building is absent from main-thread publication in the final run.
Publication's measured per-frame maximum was 4.0 ms versus the original 13.4 ms;
the full queue's mean was 0.109 ms. No adaptive canvas resize occurred in either
of the last two traced runs.

## Checks

- Independent comparison against the pre-change water implementation: all
  positions, normals, colors, UVs, indices and bounding spheres were exactly
  equal across 64 tiles (16 wet, 48 dry). Script:
  `/tmp/slowroad-water-parity.mjs`.
- Regression coverage includes wet-buffer worker transfer, dry markers,
  cancellation, fallback row yields, publication without river resampling,
  jitter immunity, sustained-load raster adaptation and signature-storage reuse.
- 416 unit tests and all 63 browser rig checks passed. Desktop/mobile canvas
  pixel checks passed. Six old/new culler views have identical pixels and
  submitted triangle counts. The frozen summer PNG is byte-identical to the
  original baseline. A two-minute natural drive covered 3.168 km with no
  significant missing grass cells, before the final culler-only storage change.

Raw measurements:

- `/tmp/slowroad-pacing-before-20260929/frame-pacing.json`
- `/tmp/slowroad-pacing-detail-20260929/frame-pacing.json`
- `/tmp/slowroad-pacing-worker-clean-20260929/frame-pacing.json`
- `/tmp/slowroad-pacing-final-20260929/`
- `/tmp/slowroad-pacing-stable-20260929/`
- `/tmp/slowroad-pacing-gc-20260929/`
- `/tmp/slowroad-pacing-reuse-20260929/`

The initial validation still caught resize stalls in isolated two-second
slowdowns. The final controller therefore requires consecutive bad windows;
single-window intervention was not accepted as a frame-pacing fix.

One interrupted intermediate run was discarded after a source reload during
measurement; its isolated browser was cleaned up before a fresh run.

## Reproduce

```sh
node --test gauntlet/*.test.mjs
GAUNTLET_URL=http://127.0.0.1:5190 PACING_MS=90000 \
  node gauntlet/run-round.mjs --out /tmp/pacing-new --shots summer --frame-pacing
GAUNTLET_URL=http://127.0.0.1:5190 GAUNTLET_DRIVE_QUALITY=auto \
  node gauntlet/run-round.mjs --out /tmp/pacing-coverage-new --drive-ms 120000
```

`PACING_QUERY` can select a starting pose or explicit DPR lock. Report frame
percentiles and counts as well as FPS; machine load varies between runs. These
are application/RAF intervals, not direct compositor-present timestamps.
`PACING_TRACE=1` additionally records V8 GC and a clock-alignment marker in
`frame-pacing-trace.json`; use matching trace settings when comparing GC work.
