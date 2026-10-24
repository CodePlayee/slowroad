# Terrain Streaming Contract

The target detail set is not the render set. Ancestors stay resident while
descendants load, and each ready child replaces only its parent's quadrant.
The remaining parent quadrants continue to render. Both outer tile edges and
internal quadrant edges have skirts; XZ coverage alone is not a crack test.

## Pipeline

1. Request a complete coarse grid plus current and predicted detail windows.
2. Generate height, normal, surface and index buffers in up to two module Workers.
3. Transfer buffers back, prepare at most two worker results per frame, and
   publish through the regular time-budgeted scheduler.
4. Select disjoint drawable quadrants, retaining coarse coverage until replacement.
5. Morph newly revealed detail from the previously drawn coarse surface.
6. Admit vegetation only when its padded footprint has suitable ground coverage.

Worker cancellation uses world epochs and task IDs. A missing or failed Worker
falls back to the same row-sliced generator on the main thread. Failed image/car
assets retain a placeholder terrain texture/procedural car and show an error
instead of leaving the startup screen indefinitely. Capture readiness still
reports failed assets rather than claiming full-quality success.

## Budgets and Visibility

- `Scheduler(6)` is the normal main-thread build budget. Continuations keep their
  priority, and urgent work can preempt between slices.
- `TERRAIN.uploadTilesPerFrame` limits worker-result preparation.
- `cacheTiles`, `cacheBytes`, and `cacheSeconds` control inactive terrain retention.
  Requested and currently rendered coverage is protected; cache limits are soft
  while protected content needs more space. Disposal is limited to two tiles/update.
- Predicted loading distance uses route position, vehicle speed, and a bounded
  rolling P95 generation-to-publication latency estimate.
- Startup reveals the scene only after coarse coverage and the nearby ground/road
  are available. Teleports and world resets keep the last complete rendered frame
  until the destination is safe to display. Season changes do not rebuild terrain.

`residencyReport()` exposes terrain pending jobs, worker jobs, cached tile count,
buffer bytes, and minimum surface readiness. Final capture readiness also waits
for target detail and active morphs; it is not a streaming quality test.

## Verification

```sh
node --test gauntlet/*.test.mjs
node gauntlet/streamcheck.mjs --out /tmp/slowroad-streamcheck
node gauntlet/rigcheck.mjs --browser ours --port 9223
npm run build
```

The browser commands expect the local app on port 5188. `streamcheck.mjs` uses
normal frame budgets without `__rig.ready()` or `forceDrain`: it checks startup,
delayed worker publication, moving across tile boundaries, camera changes,
season changes, teleport staging, and mobile canvas pixels. The unit tests also
exercise negative coordinates, stale tasks, cache protection, fallback generation,
and actual ray intersections against internal quadrant skirts.

This preserves the existing procedural world and vegetation densities. Vegetation
GPU cost and the existing distant-ridge artistic displacement are separate from
the streaming coverage contract; this is not a full fixed-grid GPU clipmap rewrite.
