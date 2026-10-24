# Forward-View Grass Optimization

The camera follows the road and looks forward. Grass keeps the existing world
population, roots, terrain contact, seasons, 202/160/120-triangle templates,
96-160 m distance fade, and at least 224 m forward prefetch reach.

## Runtime Changes

- Keep the 32 m generation lattice, but publish immutable 16 m render cells.
  A conservative padded cell sphere replaces per-frame per-tuft frustum tests,
  compaction and matrix uploads. Tree/flower instance culling is unchanged.
- Sort each grass cell once by its independent, deterministic population rank.
  A binary search selects the submitted instance prefix. CPU selection is
  conservative: it can retain extra zero-width instances, never omit a positive
  shader contribution. Canonical counts restore after rendering, including errors.
- Within 28 m, retain full original density. Between 28 and 56 m, smoothly enable
  projected-size density LOD (4-26 pixels), retaining a stable nested subset.
  Far cells approach one-quarter of their population; exiting tufts narrow and
  retained leaves widen with a capped 4x compensation. Heights never grow from
  zero. Road/view/winter coverage and the existing blade-detail LOD still apply.
- Only submit the index prefix needed by the tallest retained instance, not an
  omitted tall tuft. Small cells reduce the old 32 m batch's conservative bias.
- Do not request grass tiles wholly more than 64 m behind the camera's horizontal
  forward plane. Keep a full-cell guard, the existing cache, and replan on heading
  bins as well as movement. Camera mode changes wait for destination readiness.
- Prioritize the entire grass prefetch guard before distant woodland population
  jobs. A two-minute drive exposed the old priority cliff outside the visible
  radius; requesting a tile early was not enough if it waited behind woodland.

Steady resident grass no longer uses packed matrix copies. First GPU upload of a
newly visible cell still costs work; this is not a claim of zero total uploads.
The culler's visible-instance count is conservative for cell grass. Use actual
render submissions, not that count, to measure density LOD savings.

## Validation And Measurement

Use the existing isolated headless lifecycle; never reuse the user's browser:

```sh
node --test gauntlet/*.test.mjs
GAUNTLET_URL=http://127.0.0.1:5190 node gauntlet/run-round.mjs \
  --out /tmp/grass-validation-new --shots chase_summer_noon,season_winter \
  --drive-ms 120000 --grass-trial --profile
```

`GAUNTLET_DRIVE_VIDEO=1` also records the natural drive. `GAUNTLET_DRIVE_KM=20.5`
reproduces the later-route prefetch stress area. No forced draining occurs during
the natural drive. The missing-grass check treats coverage above 5% as significant;
it is not a substitute for temporal visual review.

`--grass-trial` compares the legacy 32 m render path, cells alone, production
density LOD, an experimental opaque-order variant, and baseline-repeat in the
same page. It verifies identical canonical population and camera, resets animation
clocks, saves immediate screenshots, and separately measures static and driving
frames. Both render paths share the new forward-only streaming policy.

On 2026-09-28, seed 7 / km 6, 1920x1080 / DPR 1, the actual grass submission
snapshot fell from 6,823,592 to 5,113,030 triangles (25.1%). Grass draw calls rose
from 17 to 48. An 8 m subdivision and a coarse re-tessellation experiment were
not retained: reducing counters alone did not demonstrate a reliable speedup.
Forcing grass after other opaque objects also had no consistent advantage and
is only retained as a diagnostic variant, not a production setting.

Same-page timings varied significantly across baseline and baseline-repeat, so
do not turn the triangle reduction into a guaranteed FPS improvement. Earlier
matched samples reduced total vegetation culling from about 17 to 12 ms, but
later timing samples did not consistently reproduce that result. The deterministic
work reduction and elimination of grass matrix compaction are the robust claims.

Artifacts:
- `/tmp/slowroad-grass-release-20260928/`: final same-page A/B and rig checks.
- `/tmp/slowroad-grass-forward-verified-20260928/`: 120-second natural drive,
  2.519 km, no significant missing grass in 90 samples; summer/winter and
  desktop/mobile checks; recorded `route-drive.webm`.
- `/tmp/slowroad-grass-guard-20260928/`: later-route focused drive and priority fix.

Final A/B screenshots changed 2.5085% of full-image pixels at tolerance 3/255,
with mean absolute channel difference 0.2636/255. The bottom fifth had no pixel
above that tolerance and mean difference 0.0000032/255. Baseline-repeat was
pixel-identical. This validates the fixed view, not every possible camera state.

Regression tests cover stable IDs/matrices, cell partitioning, cancellation of
completed and partially built cells, no steady matrix-version changes, nested
density prefixes, near-density preservation, conservative omission under shear,
render-error restoration, forward/rear planning, prefetch priority and legacy
field-call compatibility.
