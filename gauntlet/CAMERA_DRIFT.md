# Eased Chase Camera

The default chase view changes distance, height and side offset slowly,
without rolling the horizon, changing FOV or orbiting to face backward. Since
2026-10-25 it is a raised, slightly downward-looking view matched to the
official Slow Roads chase stills (see "Reference framing" below).

- Back distance: 13 m with a 3.2 m sinusoidal variation, period 660 m travelled
  (9.8–16.2 m).
- Height rides with the dolly: `up = 5.2 m × back / 13 m`, plus a 0.5 m swell with
  period 920 m (3.4–7.0 m above the vehicle origin, 1.9 m minimum). Because height
  scales with distance the car keeps its depression angle, so it grows and shrinks
  in frame instead of sliding up and down. Terrain clearance can raise the eye further.
- Pitch: the aim point is the route 19 m ahead of the car; its height is set from the
  unclamped eye so the view looks 12° below horizontal on a level road (horizon at
  0.291 of frame height with the 54° vertical FOV). The road climbing or falling
  ahead tilts the view by its height difference, as before; a terrain lift of the
  eye tilts it further down onto the car.
- Open-side lean: on a hillside the aim moves up to 4 m (≈7.5° yaw) toward the
  lower side. The side is the mean ground height 40–250 m either side of route nodes
  every 20 m (full lean at a 30 m difference), raised-cosine smoothed over ±160 m
  of route, so it is continuous and a pure function of the world and arc length.
- Target side: smoothly traverses both sides within 3.8 m, period 1,000 m. Narrow
  portrait views and close zooms reduce this amplitude, and the minimum framing
  distance includes the current side offset, to keep the car in frame.
- Existing exponential damping eases toward the moving targets. These are target
  offsets; actual tracking distance/height also includes follow lag and terrain.
- Ground clearance is enforced after damping as well as at the target, so the
  interpolated camera cannot pass below the sampled ground.
- Ordinary pause/loading frames hold the existing pose rather than jumping to
  the ideal target. Explicit snap/teleport/mode changes remain deterministic.
  Viewport resize reframes once for the new aspect.
- The cockpit remains seat-attached. The cinematic camera's old sign-based
  side switch has been replaced with continuous sine motion. Vista retains its
  overview framing, with a terrain-clearance guard.

Motion uses distance travelled from the route's origin, not wall-clock time
or per-frame randomness. It therefore stops with the car and produces the same
view on revisiting a position or taking a deterministic capture. Default cruise
speed gives different roughly 27-41 second cycles for the three axes.

## Reference framing (2026-10-25)

Measured on the official 1920×1080 stills with PIL crops (car bounding box incl.
wheels; rows are fractions of frame height from the top). "Horizon" is the far
skyline, or the road vanishing row where trees hide it (marked ~). The eye
height is FOV-free: `h ≈ 1.98 m × (car-bottom row − horizon row) / car-box width`
(px), which overestimates width and so underestimates height for a 3/4 view; it is
computed the same way for our frames so the two are comparable. Pitch is the
equivalent pitch at our 54° vertical FOV that puts the horizon on that row.
"Far" is the share of the whole frame, below the horizon, showing landscape more
than ~100 m away (visual estimate for the stills).

| still | car width | car bottom | horizon | eye height eq. | pitch @54° | far |
|---|---|---|---|---|---|---|
| sr_01 | 0.156 | 0.80 | 0.29 | 3.6 m | 12° | 0.26 |
| sr_04 | 0.207 | 0.75 | 0.28 | 2.5 m | 12.6° | 0.12 |
| sr_13 | 0.066 | 0.62 | 0.28 | 5.8 m | 12.6° | 0.19 |
| sr_16 | 0.136 | 0.75 | ~0.45 | ~2.5 m | ~3° | 0.02 |
| sr_22 | 0.056 | 0.68 | ~0.47 | ~4.2 m | ~2° | 0.02 |
| median | 0.136 | 0.75 | 0.29 | 3.6 m | 12° | 0.12 |

Targets: horizon ≈0.29, car ≈1/8 of frame width (0.07–0.21 over the drift cycle),
car bottom ≈0.75 (0.69–0.84). Predicted with `World` ray casts (terrain incl. the
shader far-ridge lift, tree crowns as cylinders from the placement records, car
box; trees' trunks/cards and the renderer itself not modelled) over 60 stations
(seeds 7/12/21, km 1–20):

| median (p10–p90) | before | after |
|---|---|---|
| car width | 0.146 (0.106–0.212) | 0.134 (0.099–0.195) |
| car bottom | 0.678 | 0.739 |
| horizon | 0.432 (0.367–0.477) | 0.295 (0.249–0.332) |
| eye height eq. | 2.0 m | 4.0 m |
| landscape > 60 m, share of frame (mean) | 0.118 | 0.136 |
| below-horizon share > 60 m (mean) | 0.062 | 0.086 |
| stations with ≥10% of below-horizon > 60 m | 23% | 33% |

Without the open-side lean the last two rows are 0.079 and 0.083 mean. Most
stations still see verge banks or roadside trees within 60 m (ground beyond 150 m
is only ~1% of frame), so the remaining gap is terrain and roadside cover, not
camera placement. The eye sits inside a crown cylinder (1 m pad) at 3/60 stations
(before: 2/60); chase has no canopy avoidance.

Tests cover target ranges, continuity, the fixed pitch on a level road, the
1920×1080 horizon/car-size/car-row bands over the drift cycle, the smooth and
deterministic open-side lean, moving-frame displacement, pause/snap,
mobile/desktop car bounds, terrain clearance, cockpit stability, resize and the
cinematic side crossing. The natural-drive diagnostic can additionally record
per-frame camera ranges, clearance, turn rate, forward direction and whether the
car leaves the viewport, alongside existing roadside vegetation coverage checks.

```sh
node --test gauntlet/*.test.mjs
GAUNTLET_URL=http://127.0.0.1:5190 GAUNTLET_DRIVE_QUALITY=auto \
GAUNTLET_CAMERA_DRIFT=1 node gauntlet/run-round.mjs \
  --out /tmp/camera-drift-new --shots summer,vista --drive-ms 60000
```

This intentionally changes the frozen external-camera compositions. Reference
images from before this change should not be used for exact pixel parity.

Validation on 2026-09-29, for the previous level 12.6 m / 2.65 m framing (not re-run
for the 2026-10-25 framing, which has only numeric checks): 428 unit tests, 66 browser checks and production build
pass. A 60-second natural drive covered 1.492 km over 3,461 frames with no missing
grass coverage and no vehicle-center departure from the viewport. Actual camera
offsets varied by 7.84 m fore/aft, 2.56 m vertically and 9.30 m laterally (including
curve-following lag). Minimum ground clearance was 1.4 m; maximum per-frame turn
was 0.0054 radians. Desktop/mobile pixel and layout checks pass. Artifacts:
`/tmp/slowroad-camera-drift-20260929/`; isolated browser cleanup left zero processes.
