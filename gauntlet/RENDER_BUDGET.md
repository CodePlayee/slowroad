# Render Budget and Forest Visibility

Implemented 2026-09-29, following the CPU/render audit. This pass does not change
plant placement, authored models, road geometry, grass coverage distance, shadows,
or the existing alpha-to-coverage/MSAA path.

## Quality Modes

- Default: adaptive raster budget, initially about 2.1 million pixels, capped by
  device DPR and 1.5. The normal viewport budget has a 0.75 floor; adaptation has
  a 0.8 floor. Extremely large CSS viewports can exceed the nominal pixel budget
  to retain this minimum image quality.
- `?quality=high`: lock the former native-DPR limit and matching plant detail.
- `?dpr=1.5&lod=1.5`: explicit independent raster/detail locks.
- `?paused=1`: deterministic DPR 1 capture; `quality=auto` opts a paused boot into
  adaptive mode when resumed.

Plant LOD uses CSS viewport height times its independent detail scale. It does
not change when the raster controller changes pixel ratio. The controller uses
two-second mean/missed-frame windows and ignores paused, background, loading,
force-drained and CPU-limited states. It no longer probes higher ratios during
travel: canvas reallocations themselves caused long stalls on this Mac. A
viewport resize starts a fresh budget. See `FRAME_PACING.md`. Resizing is applied
before a new draw, never after presenting a completed frame. HUD remains CSS UI.

Automatic mode trades some raster sharpness for responsiveness. It is not an
identical-image substitute for the high-quality lock.

## Forest Changes

- Forest populations now have a tile parent and near/far child groups, with
  conservative bounds and LOD rejection before descending into species meshes.
- Immutable forest batches carry conservative cached bounds. Entirely in-view,
  LOD-valid batches use canonical instance buffers instead of per-instance
  testing/compaction. Boundary batches retain the existing exact path.
- Mutable buffer/geometry versions invalidate the shortcuts. Group visibility
  restores after rendering; cached and unsupported cells remain hidden, and
  disposal removes the complete hierarchy.
- World matrices update during visible traversal, rather than eagerly updating
  every hidden descendant before culling. Forest object transforms are static;
  wind continues to run in shaders.

## Material Changes

Terrain has snow/non-snow shader variants. Summer and autumn omit snow-only
noise and color work. Variants change only at a snow-season boundary, not every
frame or time-of-day update. Foliage skips uniform-disabled snow shading too.
This is a conservative first material optimization, not a new terrain look or
a replacement with the unlit diagnostic material.

## Evidence

These are the original budget-pass measurements, before the subsequent frame
pacing fix. They describe throughput, not a guarantee of even presentation.

On this Mac, 1920x1080 CSS viewport, Retina-emulated device DPR 2:

| Mode | Driving window | Mean FPS | Later half FPS | Raster DPR | Plant detail |
| --- | ---: | ---: | ---: | --- | --- |
| High lock | 10 s | 34.7 | 32.3 | 1.5 | 1.5 |
| Automatic | 30 s | 57.8 | 59.4 | about 1.006 to 0.806 | fixed 1.0 |

Both start at seed 7 / km 6. Different durations/travel distances and machine
load mean this is a mode comparison, not a universal speedup guarantee.
The high lock deliberately remains GPU-limited rather than silently lowering
its resolution.

The same explicit high-quality audit measured total main-thread time about
12.3 ms versus the earlier 16.6 ms, and aggregate culling about 6.1 ms versus
11.3 ms. The culling reduction is about 46%; different runs are not a hardware
cycle-accurate comparison.

- Two-minute automatic drive: 3.062 km, 107 samples, no significant missing
  grass cells. Sampled HUD FPS averaged 58.6; this is not a per-frame percentile.
- Six old/new culler comparisons: identical pixels AND triangle submissions,
  including camera offsets, a reverse view and returning to the original view.
- Summer shader before/after captures: bottom 40% of the image pixel-identical.
- Summer, winter, desktop/mobile checks and all 63 rig checks pass.

Artifacts: `/tmp/slowroad-budget-quality-20260929/quality-check.json` and
`/tmp/slowroad-budget-final-20260929/` (drive, performance audit, rig and parity).
The earlier quality round's single failed rig assertion expected a flat parent;
the test now verifies unchanged parent identity and ancestry through the new
hierarchy, without weakening population stability.

## Reproduce

```sh
node --test gauntlet/*.test.mjs
GAUNTLET_URL=http://127.0.0.1:5190 node gauntlet/run-round.mjs \
  --out /tmp/quality-check-new --shots chase_summer_noon,season_winter --quality-check
GAUNTLET_URL=http://127.0.0.1:5190 GAUNTLET_DRIVE_QUALITY=auto \
node gauntlet/run-round.mjs --out /tmp/quality-drive-new --drive-ms 120000
```

Larger changes such as new middle-distance tree assets or baked terrain material
fields remain separate visual work. This pass intentionally does not claim that
native high-DPR rendering now sustains 60 FPS without quality tradeoffs.
