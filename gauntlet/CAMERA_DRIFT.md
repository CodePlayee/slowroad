# Eased Chase Camera

The default chase view now changes distance, height and side offset slowly,
without rolling the horizon, changing FOV or orbiting to face backward.

- Back distance: 12.6 m with a 3.2 m sinusoidal variation, period 660 m travelled.
- Height: 2.65 m with a 1 m variation, period 920 m, with a 1.9 m minimum target
  above the vehicle origin. Terrain clearance can raise it further.
- Target side: smoothly traverses both sides within 3.8 m, period 1,000 m. Narrow
  portrait views and close zooms reduce this amplitude to keep the car in frame.
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

Tests cover target ranges, continuity, moving-frame displacement, pause/snap,
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

Validation on 2026-09-29: 428 unit tests, 66 browser checks and production build
pass. A 60-second natural drive covered 1.492 km over 3,461 frames with no missing
grass coverage and no vehicle-center departure from the viewport. Actual camera
offsets varied by 7.84 m fore/aft, 2.56 m vertically and 9.30 m laterally (including
curve-following lag). Minimum ground clearance was 1.4 m; maximum per-frame turn
was 0.0054 radians. Desktop/mobile pixel and layout checks pass. Artifacts:
`/tmp/slowroad-camera-drift-20260929/`; isolated browser cleanup left zero processes.
