# Visual Comparison Protocol

This protocol governs the canonical visual comparison shots. It is a review
protocol, not a completion claim.

## Reference Set and Threshold

- The reference set is the 24 source-verified official screenshots under
  `refs/slowroads/official/`, all at 1920x1080. The visual quality bar is the
  full set; selecting a more convenient crop or a weaker substitute does not
  lower that bar.
- Reference selection and shot parameters are frozen before implementation or
  modeling begins. Once frozen, a comparison run may not retune a reference
  to make a build look closer.
- The current canonical `season_winter` reference is terrestrial `sr_13.jpg`.
  `sr_19.jpg` is a lunar/night scene and is not a terrestrial winter bar.
- The canonical shot IDs and parameters in `gauntlet/shots.json` are the
  contract. Preserve unrelated parameters when changing a reference.

## Comparability Record

For every shot, record camera/framing, season, time of day, weather/lighting,
biome/scene, vehicle/cockpit context, and UI/HUD treatment separately from
the visual verdict. A mismatch is evidence about comparability, not permission
to waive a visible defect:

- Mark only the mismatched dimension `N/A` (for example, time/weather when a
  daytime cockpit reference is overcast).
- Continue scoring all comparable visual dimensions: composition, road and
  terrain continuity, vegetation integration, depth/atmosphere, lighting and
  exposure, materials, contact grounding, and image cleanliness.
- A build must not receive credit merely because a reference is semantically
  different. Conversely, `N/A` must not erase a clearly visible material,
  geometry, lighting, or composition defect.
- HUD, menus, watermarks, or other overlays are either present in both images
  or covered by the same predeclared mask. Do not crop away a defect after
  seeing the result.

## Roles and Blinding

- The capture operator and judges are independent people/processes. The
  capture operator only produces the frozen screenshots and anonymous pair
  packages; they do not judge or annotate a winner.
- Builder output is limited to a technical report: build revision, capture
  parameters, runtime/asset failures, and reproducibility details. Builder
  commentary must not contain a visual verdict or coaching for judges.
- A judge sees only anonymous images (A/B or equivalent randomized order) and
  the shared rubric. Filenames, reference IDs, build labels, shot parameters,
  and prior verdicts are hidden.
- The judge first selects the quality winner and records dimension-level
  reasons. Only after that may the judge optionally guess which image is the
  official reference. Identity guessing is a separate field and never changes
  the quality decision.

## Required Run

1. Freeze shot IDs, parameters, reference files, output resolution, crop/mask
   regions, and rubric before a build is captured.
2. Capture every required family at the frozen 1920x1080 format. Randomize
   A/B order independently per shot and keep the randomization seed in the
   private run record.
3. Use three fresh judges who have not seen the build process, prior verdicts,
   or builder notes. Each judge evaluates every required family independently.
4. Repeat the complete required-family set in a second blinded round with new
   randomized order. Resolve only procedural issues; do not teach the judges
   the expected answer between rounds.
5. A required family can pass only when **all three judges** find no material
   visible gap in **both consecutive rounds**. Any material gap resets that
   family to not-passed for the next run.
6. The overall visual gate is not passed while any required family is not
   passed. Report per-dimension scores, N/A dimensions, winner selection,
   identity guesses, and disagreement; do not collapse these into an identity
   hit rate.

## Performance and Historical Records

- Performance requirements and baselines remain exactly as previously defined;
  visual comparison cannot relax them. Report regressions separately from
  visual findings.
- Preserve all existing verdict files and their original scores. In
  particular, an old `7/7` result is an identity-guess record, not proof of
  completion, semantic comparability, or absence of a material visual gap.
  Do not rewrite old scores to conform to this protocol.

