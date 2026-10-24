# Reduced Roadside Trees

Requested 2026-09-29: approximately halve the tree population and favor the road
corridor, with progressively sparser woodland farther from the road.

## Placement

`POPULATION.tree.density` is now 0.5. An additional world-space road-distance
weight falls smoothly from 1.35 within 32 m to 0.9 at 320 m. Combined with the
base density, this retains roughly 67.5% of otherwise eligible roadside trees
and 45% of distant trees. The existing grove, elevation, moisture, slope, water
and 10 m road-clearance rules still apply. Far woodland remains as a background,
not an abrupt empty boundary at 320 m.

This favors near-road framing while reducing the whole streamed population by
approximately half. Density is not based on the camera or distance to the car.
The original candidate lattice and random streams are unchanged, and every
retained tree keeps its ID, position, dimensions, species and wind phase.
Grass and shrubs are unchanged. Fewer accepted records means fewer actual tree
instances, not merely invisible trees left in the renderer.

Terrain carving reports road distance only close to the road. Tree placement
therefore performs one bounded 320 m road query when needed and shares the
result between density and roadside cover. A conservative tile-center test
skips all per-candidate road queries for distant tiles.

## Verification

`tree-distribution-audit.mjs` samples 49 evenly spaced tree tiles in each of nine
streaming neighborhoods: seeds 7, 12, 31 at route km 0, 6, 18. These are sampled
tile counts, not an exhaustive count of an infinite procedural world.

- Previous profile: 208,610 trees across the samples.
- New profile: 99,710, retaining 47.80%, a 52.20% reduction.
- Per-neighborhood retention: 46.67%-48.82%.
- Retention by road distance: within 32 m 68.03%; 32-160 m 64.71%;
  160-320 m 51.14%; beyond 320 m 44.94%.
- All retained tree records compare exactly with their original records.
- 418 unit tests pass, including continuous/monotone distance weights, bounded
  road lookup, unchanged grass/shrub fixtures and worker/fallback parity.

Population audit: `/tmp/slowroad-tree-distribution-20260929.json`.
Browser captures and checks: `/tmp/slowroad-roadside-trees-20260929/`.
The initial browser round passed 62/63 checks; its one obsolete check required
at least 100,000 trees. The new requested budget instead checks 60,000-100,000,
while retaining the roadside minimum. Its settled default view contains 78,740
trees versus the prior 164,683 (47.81% retained), with 583 trees within 150 m of
the car versus 891 previously. The 30-second natural drive passed without gaps.
Final browser validation: `/tmp/slowroad-roadside-trees-final-20260929/`.
All 63 final browser checks pass, including desktop/mobile canvas pixels and HUD
layout; both isolated browser profiles were cleaned up with zero remaining
processes. Production build also passes.

```sh
node gauntlet/tree-distribution-audit.mjs /tmp/tree-distribution-new.json
node --test gauntlet/*.test.mjs
GAUNTLET_URL=http://127.0.0.1:5190 GAUNTLET_DRIVE_QUALITY=auto \
  node gauntlet/run-round.mjs --out /tmp/roadside-trees-new \
  --shots summer,vista --drive-ms 30000
```
