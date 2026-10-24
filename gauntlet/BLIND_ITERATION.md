# Vegetation and Ground Blind Iteration

## Scope and Acceptance

The user explicitly narrowed the task to vegetation and ground surfaces during
the first iteration. Vehicle, road shape/markings, sky and global lighting are
not optimization targets. Only the grassy road-edge transition is included.
The trial asphalt aggregate and winter wheel-track changes were removed.

The benchmark is the saved, source-verified Slow Roads official set. All 24 local
reference hashes were verified against `refs/slowroads/manifest.json`. This is
not represented as a live capture of the current web game.

Source identities are hidden from fresh independent judges. PNG packaging is
lossless; declared UI rectangles, when required, are identical in both images.
Judges must choose quality before guessing identity, score only scoped
dimensions and name the largest remaining visible gap. Different framing and
weather are recorded separately rather than used to excuse weak plant materials.

Acceptance requires three fresh judges to find no material scoped gap across
the required vegetation/ground families in two successive re-randomized rounds.
Neither better scores, successful builds nor source-identification failures are
acceptance. The wider whole-game gate remains outside the user-confirmed scope.

Frozen inputs: `rounds/blind-loop-01/frozen-contract.json` and `core-cases.json`.
The core diagnostic set covers later-route woodland, winter ground, summer
verge, dense forest and open meadow. Spring/autumn frames remain required before
scoped final acceptance. No reference or capture parameter is retuned to make
the implementation look better.

## Iteration Log

### 01: Independent Diagnosis

Three fresh judges (`blind_01_a/b/c`) independently reviewed two anonymous pairs.
All chose the reference in both. Their recurring largest in-scope gap was the
foreground plant/ground system: thin isolated grass over flat exposed ground,
large flat flower discs, weak root embedding and an overly broad smooth verge.
Winter ground and uniformly pale upright grass lacked convincing accumulation.
Reports: `rounds/blind-loop-01/verdict-{a,b,c}.md`.

Nine canonical baseline families were captured separately in
`rounds/blind-loop-01/capture`; the browser exited with `remaining: 0`.

### 02: Layered Plants and Ground

- Replace the 18-leaf tuft with 30 real curved leaves: 12 short/wide basal,
  eight middle and ten near details, with only four tall accents. Each template
  has 170 triangles; conservative prefixes are 180/300/510 indices.
- Keep grass inside the previously requested roadside/camera limits. Bring the
  inner verge close to the paved shoulder: roots begin at 4.2 m from centreline,
  full coverage at 4.85 m. Roots remain stable; distance fading still changes
  width rather than snapping height.
- Flatten basal leaves in winter, retain sparse subdued taller shoots and
  reduce the uniform white coating. Seasonal shape changes are separate from LOD.
- Replace large flower discs with three small, tilted flower heads, closed
  folded petals and raised gold centers. Preserve GLB loading/disposal, stable
  instances, two draw batches and seasonal visibility.
- Narrow the terrain's worn strip to 4.15-7.5 m, use sub-metre edge breakup and
  interleave turf texture with worn ground. The road ribbon only narrows/fades
  its grassy outer apron; the travelled surface remains unchanged after scope
  clarification.
- Add layered snow accumulation and compacted texture to the terrain material,
  without changing ground height, route geometry or global illumination.

The initial technical round (`blind-loop-02/capture`) passed 253 Node tests and
61 browser checks, including GPU prefix parity. Static median was 60 FPS and
the six-second drive 58.8 FPS at 1080p. These are runtime checks, not a visual pass.

### 03: Scoped Correction and Re-Review

Technical inspection found a real precision problem: the old float hash used
`fract(p * 443.897)` for fine material coordinates. Float32 multiplication loses
all fractional bits kilometres along the road, flattening detail or creating
quantized patterns. Terrain now uses the existing CPU hash2i-style uint mixing
in GLSL, with tests across positive/negative coordinates up to 26 km at fine
material scales. World generation and plant placement are not changed by this
material-only correction.

Terrain microrelief was also reduced to avoid amplifying fine grass texture
into harsh snow-surface noise. Out-of-scope road-snow/track experiments were
removed before this scoped capture. New comparisons are under `blind-loop-03`.

## Current Status

Still iterating. No vegetation/ground family has yet met the two-round,
three-judge no-material-gap acceptance threshold. Historical reports and all
intermediate images are preserved, including rejected experiments.

### 03 Scoped Verdict

Three new fresh judges independently reviewed five pairs, now scoring only
vegetation and ground. All five pairs still favor the reference, unanimously.
The largest recurring gap is not the number of trees: it is repeated grass fans
and exposed uniform gaps, an undifferentiated pale forest floor, and grass-like
fibres showing over most winter snow. Source duplicates are explicitly noted;
five image pairs are not claimed as five independent reference scenes.

### 04: Continuous Lower Cover and Ecological Materials

This iteration targets that repeated failure instead of adding more tall trees.
Shared biome functions produce a terrain ecology field matched to actual forest
cover and grass clumps. Terrain workers carry it at vertices and skirts without
changing height, normal, position or index buffers. The surface can then
distinguish pasture from forest litter/moss, independent of viewing distance.

Grass basal roots spread across the whole footprint rather than radiating from
one tight center. Stable per-blade shape variation breaks repeated fans. Winter
exposure is shared with the ground via clump thresholds 0.68-0.85: most low turf
is buried, with only local patches exposed. Snow no longer inherits the general
grass/litter fibre texture. Plant root shading is local to the material, and
evergreen snow coats favor upward-facing foliage rather than uniformly bleaching
every leaf. No global light, vehicle or road-surface changes are introduced.

The expanded scoped acceptance set is frozen in `vegetation-cases.json`, adding
the existing spring and autumn fixtures without retuning their parameters or
reference mappings. No round has passed the visual gate yet.

### 04 Scoped Verdict

Three fresh reviewers again choose the reference in all seven pairs. Most
important: root contact and meaningful forest-floor material remain weak. Snow
is no longer a grass-fibre carpet, but now lacks local tree-base integration.
The reviewers also identify short disconnected grass pieces and incomplete
autumn vegetation. These findings are not treated as acceptance.

Technical validation passes: 265 Node tests, 61 browser checks, cleanup zero.
The 1080p sample measures 53 FPS static / 55.4 FPS driving; no frame exceeds
33.4 ms during the six-second drive.

### 05: Structural Grass LOD and Actual Roots

- Correct a structural grass LOD mistake: the former persistent group contained
  only low leaves, while main-height leaves disappeared with the near-detail
  band. Persistent geometry now includes six full-height structural leaves and
  18 curved basal leaves; additional bands add detail, not the main silhouette.
  Tests require core/mid height and width to retain at least 85% of the full
  silhouette through 20/40/60 m and the view-fade boundary.
- Re-bake low multistem shrubs using the existing EZ-Tree generator. Rooting is
  based on the actual woody base, not transparent leaf-card corners. One old
  shrub's woody base was 6.54 cm above the union minimum. New shrub leaf skirts
  approach the soil and cost 2714/2518 triangles instead of 11520 each.
- Add restrained root geometry before both near rendering and same-source
  impostor baking. Each tree gains 66 triangles; original authored vertices,
  population positions and layouts remain unchanged.
- Give actual woodland ground a darker humus/moss albedo with controlled RGB
  variation from the existing litter texture. Local canopy transmission affects
  only that ground material, not global lights or open terrain. Winter reduces
  the canopy occlusion and keeps independent, low-contrast anti-aliased snow grain.
- Add restrained root snow coating and true species-specific autumn pigments.
  Multiplying a green texture by a warm tint was leaving deciduous trees green;
  luminance-preserving pigment replacement now affects leaves, while bark and
  evergreen needles retain their own colors. No vehicle or road-surface change.

### 05 Scoped Verdict and Grounding Diagnosis

Three fresh judges still find material gaps in all seven pairs. Rather than
continue only changing appearance, a runtime audit compares plant roots with
the actual settled terrain triangles (`rounds/ground-contact-audit`). It finds
a separate, measurable geometric problem: roots sampled the continuous analytic
heightfield, while rendering uses a triangulated cut/fill surface.

Within 76 m of the car, grass root absolute P95 errors are 14.5 cm at seed 7/km 6,
21.3 cm at seed 7/km 26 and 7.7 cm at seed 12/km 5.5. Worst burial is about 77 cm,
greater than the entire affected plant height. This can erase whole patches and
leave floating basal fragments. These figures do not imply every plant is wrong;
the median is near zero and errors concentrate at the carved verge.

### 06: Match the Rendered Ground

Add a shared, cached L0 terrain-triangle sampler. It matches the renderer's
per-tile road-refinement decision, Float32 corner heights, actual vertex grid,
and a-c-b / b-c-d diagonal. Grass records retain all original analytic fields,
IDs, acceptance and random streams, with three additional render-surface fields.
Grass and flowers use these fields for actual root placement; grass normals
follow the corresponding triangle plane. A default 32 m grass job needs only
289 cached corner samples for 9216 queries.

An independent code audit found and reproduced a non-default coarse/fine
resolution counterexample. The sampler now shares the exact corridor predicate
instead of assuming every tile is fine. Surface-grid settings are snapshotted
into workers. Camera-relative ridge displacement entering the visible grass
region is explicitly rejected rather than silently producing bad roots.

The audit also correctly distinguishes a clump center from every blade root:
one tangent plane cannot match every adjacent noncoplanar triangle. Runtime
verification now reads actual restored instance matrices, includes flower roots,
and samples authored blade-root centers to measure any remaining local error.

The completed `surface-fit-validation` browser audit reports clump/flower root
absolute P95 errors of 1.8-3.7 micrometers across all three fixtures, with zero
roots floating or buried by more than 4 cm. Sampled individual blade-root P95
errors remain 3.78 mm / 8.32 mm / 0.98 mm; rare cross-triangle errors reach
24.9 cm. This proves center placement, not perfect conformance of every blade.
All 291 Node tests and the production build pass, and browser cleanup is zero.
The two diagnostic screenshots are not a replacement for the seven-case blind
review, which has not yet accepted this iteration.

### 06 Scoped Verdict

All three fresh judges choose the reference in every pair. The geometric
root-placement correction is valid but not sufficient: the recurrent visible
gap is the thin lower grass layer and nearly uniform exposed forest floor.
Tree structure itself scores much closer. The near-to-far transition at 26 km
is no longer identified consistently as a discontinuity.

The full round passes 61 browser checks, four desktop/mobile viewports and
cleanup zero. Six-second samples report 25.1 FPS and 23.4 FPS driving on a
fresh repeat, below the earlier 57.2 FPS sample. A read-only host check finds
battery power and battery `powermode=1`; the earlier power state was not logged,
so this is not proof of either a code regression or its absence. The profile
uses the Apple M4 Pro Metal renderer and reports no page errors. These slower
measurements are retained, not replaced by the older favorable number.

### 07: Readable Lower Cover and Forest Albedo

Keep population positions, counts, road exclusion and model-distance limits.
The grass template gains a substantial curved lower layer at the same triangle
budget. The second shrub form becomes low arched bracken rather than another
rounded bush. Both are evaluated as appearance changes, not proof of parity.

A new, unmodified generated woodland albedo has identifiable overlapping
leaves, humus pockets and moss. The shader now retains its fine-scale RGB
instead of reducing it to a small modulation of one palette color. The second
sample affects broad patch value without stamping enlarged leaves. Grass-base
contrast and woodland roughness/normal relief are local material properties;
the shared ecology, terrain geometry, road surface and global lighting stay
unchanged. Asset provenance and full prompt are in
`public/textures/woodland-litter-v1.md`.

Independent code review caught two material regressions before capture: direct
leaf RGB bypassed the winter detail mask, and partial woodland weights still
multiplied it by background grain. Winter now explicitly buries the leaf color
and roughness, and leaf color is blended after the background grain.

The first full 07 capture has all seven screenshots, no page errors and cleanup
zero, but is NOT passed: 60/61 browser checks pass. The old coverage-mip test
dereferences a null leaf map on the new solid-geometry fern. The test must allow
only that explicit growth form, while continuing to require all eight complete
impostor chains and seven cutout-leaf textures. The failed report is retained.
All 298 Node tests and the production build pass after updating intentional
material-contract assertions; those checks do not waive the failed browser gate.

### 07 Verified Capture and Scoped Verdict

The original failure is retained. `blind-loop-07/recheck` reruns every capture
and all 61 browser checks successfully, with cleanup zero. The repaired test
permits only the solid fern's missing leaf map and still verifies the other
seven cutout textures, all eight impostors and all required bare atlases; four
new positive/negative Node contract tests pass.

Three new independent judges review the seven anonymous pairs. Two choose this
build in the ordinary summer chase scene (Q03); the third chooses the reference.
All judges still prefer the reference in the other six pairs. Reviewers now
recognize the exposed substrate, branching and some grass as stronger in our
image, while recurring weaknesses are local tree/ground contact, uniform forest
floor transition, grass-shape repetition and seasonal understory integration.
This is progress, not acceptance; no consecutive no-gap round exists.

Performance is not hidden: the recheck sample is 18.6 FPS driving with a 274.8 ms
worst frame. A separate 12-second run, `plant-program-audit`, records 22 FPS
with a 204 ms worst frame. That same frame is the only program-count change,
43 to 45; generation takes 8.2 ms. This is evidence of a first-use compilation
stall, separate from the lower steady-state battery-power framerate. The next
iteration will prewarm plant programs before asset readiness and remeasure.

### 08 In Progress

Use actual nearby resident roots for a bounded world-space contact field, not
random dark spots. It will refine local woodland contact and snow at tree bases
without changing light sources or terrain geometry. A standalone unintegrated
prototype first passed 13 CPU tests, including bounded raster work and atomic
world-origin publication. Integration must avoid whole-world record scans and
contact flicker while driving.

Keep the stronger lower grass layer. Replace a small portion of near-only leaf
detail with sparse mature seedheads rather than increasing grass population.
Also prewarm the actual instanced foliage programs against the real scene's
lighting before publishing ready assets. Each change remains subject to fresh
browser, performance and blind-image validation.

08 implementation is now frozen. Grass remains 202 triangles: 36 leaves and
one narrow panicle replace the former 38 leaves, with 290 vertices / 74 root
vertices. Core/mid buffers are byte-identical; 30% of clumps carry near-only
seedheads. Winter buries basal/detail leaves and retains six readable dry shoots.

The contact integration selects at most 2048 nearby records and raster-checks
16384 texels per frame, with bounded preparation outside those two work counts.
Two windows have a tested population-lattice upper bound of 13816 candidates
under a 16384 input cap. Real seed/km fixtures publish 3438 / 2177 / 3052 roots
in 6 / 4 / 5 frames. It adds one texture fetch, for exactly five terrain samples.

Independent review reproduced a real 64 m streaming-boundary bug: eviction of
one invisible fringe shrub cleared contact beneath all retained near trees.
Explicit out-of-window streaming retirement now preserves the old valid map
through atomic publication; genuine in-window deletion, support loss and seed
reset still invalidate it. Five regression tests include the exact 917-root
case and the later `field.update` call, not just the removal notification.

All 346 Node tests and the production build pass. The full 08 browser run now
includes seven captures, the 61-check rig, a 12-second program-count audit,
startup/teleport checks, serial rendering ablations and two minutes of ordinary
driving. The drive probe records per-frame zero-contact intervals and selection
and raster work limits. None of these results are presumed before completion.

Completed 08 runtime stages: normal-budget startup becomes playable in 5.15 s
and fully resident in 15.03 s; teleport minimum-ready is 3.80 s. The two-minute
drive covers 18.00 to 21.153 km with woodedShare=1 and nearReadyShare=1, no grass
outside the roadside band, and no forced draining. Across 6555 observed frames,
zero-contact frames=0; maximum selection/raster work is exactly 2048/16384.
The host is now on AC power (read-only `pmset -g batt`), unlike the preceding
battery-mode runs. Do not attribute any mean-FPS increase solely to code changes.

### 08 Scoped Verdict and Performance

The full browser run passes, including all 61 rig checks and cleanup zero.
The 12-second chase sample starts with 45 programs and has no program-count
events; the former first-use two-program compilation no longer occurs during
driving. It measures 45.9 FPS with a 51.8 ms worst frame. Power conditions differ
from the earlier 204 ms sample, so the program trace is the stronger causal
evidence than a direct FPS ratio.

Serial ablations identify woodland rendering as the largest component: full
43.1 FPS, without grass 51.1, without terrain 50.1, without trees 60.0. A full
repeat reaches 50.9, demonstrating timing variance. Half resolution also changes
projected LOD and triangle count, so it does not isolate fragment cost alone.

Fresh blind review still rejects overall acceptance. One judge ties the winter
pair; the others choose its reference. Every judge chooses the reference in the
other six pairs. The previous summer win is not a stable consensus. Recurring
issues are the grass-to-bare-forest-floor boundary, visibly repeated substrate,
and limited intermediate/seasonal understory structure. Improved numerical
contact and temporal behavior do not establish visual equivalence.

### 09 In Progress

The forest-floor weight currently increases as `grassRoadCoverage` falls across
the 16-28 m modeling band, tying an ecological material change to the geometry
budget. Test a world-fixed clump/moisture/canopy mixture instead, preserving the
same grass model limit and existing road/shore/rock exclusions. Replace the two
forest texture samples with derivative-safe offset blending at one physical
leaf scale, rather than increasing texture fetches or ground geometry.

A separate root-owned diagnostic will compare earlier same-source tree
impostor transitions, including baseline-repeat and screenshots. It must change
both CPU and GPU LOD parameters together and restore them in `finally`; default
runtime LOD remains unchanged until quality and performance evidence justify it.

The remaining meadow AO also used `grassModelCoverage`, losing up to 26% local
darkening as modeled grass left the roadside or view band. That shading is now
being made world-fixed, based on ecological growth and retained turf, while
actual road/shore/rock/snow exclusions remain.

A separate read-only model/population audit identifies a structural gap too:
within 160 m of the forest/autumn fixtures, there are zero plants at 2-6 m or
6-12 m. Woody shrubs have median heights 1.14/1.10 m, ferns 0.81/0.77 m, and
mature trees 19.20/18.87 m. The median per-tree area-weighted leaf-height P10 is
5.30/5.52 m. This geometry proxy does not measure visible pixel occlusion or
alpha-cutout coverage. Keep every mature tree and all canonical IDs/positions;
test promoting about one third of existing woody shrubs into 2.5-4.5 m multistem
understory, with proportional width and a strict 2.75 m radial bound. No extra
population, fern changes, new assets or distant grass models are planned.

The frozen 09 implementation promotes 73/217 woody shrubs in the forest fixture
and 87/282 in autumn; all 872/986 mature trees and 214/250 ferns remain unchanged.
Rendered dimensions share one helper across geometry, impostors and CPU/GPU LOD.

A further geometry check finds that only 5/36 grass leaves truly descend after
their peak, and even those drop at most 1.8 cm for a 70 cm plant. Four of six
structural leaves now peak at the existing t=0.75 row and descend to 80-90% of
that height at the tip. Their peak and the 202-triangle budget stay unchanged;
hashes protect basal leaves, the two upright structural leaves, detail and
seedheads. This is genuine arching rather than only bending in XZ.

The first LOD diagnostic (`tree-lod-trial-09`) stops on a population-fingerprint
inequality after returning from a drive; pose and CPU/GPU LOD agree, restoration
and cleanup succeed. It has no saved failed-candidate population, so its cause
is unconfirmed. The tool now saves failure snapshots and per-tile/field evidence,
uses explicit type tags for absent/nonfinite data and retains its legacy raw-NaN
hash for comparison. It does not waive finite-value or population differences.
All 372 Node tests and the build pass before the new `tree-lod-trial-10` run.

The new run confirms the fingerprint false alarm: typed population hashes are
identical in all stages, while absent fields acquire different raw NaN payloads
in the legacy byte encoding. It also reveals a separate diagnostic defect:
GPU pixels change but all stages submit exactly the baseline triangle count.
The dev server imports ForestField with a `?t=` URL while the tool imported the
unversioned URL, creating different module instances and different range objects.
Thus the supplied-object equality check did not prove actual CPU selection.

Trial 10 is explicitly marked unusable for an LOD decision; original reports
and images are untouched. Version 3 reads two observation references from live
materials, verifies real instance predicates at the thresholds, counts actual
culler selections and checks actual render submissions and baseline restoration.
All 375 Node tests and the build pass before `tree-lod-trial-11`. Runtime default
LOD is still 110/200; no performance setting is accepted from an invalid trial.

Trial 11 verifies actual predicates, selected workloads and submissions. With
identical population and pose, 160/260 reduces submitted triangles from
9,179,597 to 6,637,867 (27.7%). Static/driving FPS are 57.47/54.56 versus
53.44/51.88 initially and 53.86/52.13 in the baseline repeat. Two fresh blind
reviewers of counterbalanced, lossless before/after pairs both report ties with
no material visible disadvantage. This narrow diagnostic is not the seven-scene
Slow Roads acceptance gate. Adopt 160/260, preserving counts, heights and the
1800/2000 m distance fade; perform the complete visual regression next.

09 full capture passes all seven scenes, 61 browser checks and cleanup zero.
The 1080p sample is 60 FPS static / 56.6 FPS during a 12-second drive, worst
frame 31.9 ms, zero frames above 33.4 ms and no new shader programs. The ordinary
two-minute route test travels 3.179 km, woodedShare/nearReadyShare both 1. Across
6724 frames there are zero empty-contact frames and the work limits hold.
Fresh seven-pair blind review remains pending; these runtime results are not
visual acceptance.
