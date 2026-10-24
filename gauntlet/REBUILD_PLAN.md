# Slow Roads++ rebuild plan

## Acceptance bar

Use the official Slow Roads screenshots in `refs/slowroads/official/` as the visual
bar. Cover at least these families at 1920x1080: chase/cockpit/vista, summer and
winter/autumn, dawn/noon/golden/overcast/night, open meadow/forest/water/bridge.
For each family, render our frame with `gauntlet/shoot.mjs`, randomise the two
frames with `gauntlet/ab.mjs`, and record the blind winner in `gauntlet/verdicts/`.
A piece is accepted only after two different shots are blind wins for ours.

## Technical direction

The implementation follows the constraints documented by Anslo: a single
non-branching road gives us a predictable look-ahead window; generate the route
and environment ahead of the vehicle, reserve high resolution for a narrow road
corridor, use coarse far tiles, instance foliage, and schedule geometry work in
small frame budgets. Keep deterministic seeded generation so every A/B shot is
reproducible. Prefer pooling/reuse over allocating geometry during streaming.

## Workstreams

1. **World and composition**: improve heightfield macro relief, road grade and
   river/bridge placement; preserve the route as the single source of truth.
2. **Look development**: tune sky, fog, tone mapping, ground materials, water,
   foliage silhouettes and seasonal hooks against reference families.
3. **Camera and journey**: match Slow Roads' low, wide chase framing and calm
   motion while retaining cockpit/vista alternatives.
4. **Runtime**: keep generation off the critical frame path, recycle streamed
   tiles, validate rig inputs, and keep ready/residency diagnostics truthful.

## Iteration protocol

Builders change only the files owned by their workstream and leave a build
verdict. A fresh critic then captures the current build, performs a blind A/B,
names one actionable largest gap, and logs it. The next builder addresses that
gap. Build, rigcheck and screenshot smoke tests are required after every round.

## Round 1 starting findings

The independent blind critic scored the baseline 23/100 and selected the
reference in all seven comparisons. The first builders therefore target the
highest-leverage visual failures in this order: vehicle silhouette and cockpit
occlusion, vegetation/atmosphere coherence across seasons and time of day, then
road/terrain material and composition. A fresh critic must rerun the same seven
families after these changes; no builder self-assessment is an acceptance
decision.
