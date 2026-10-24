# LOOP — how a piece gets improved

Every piece runs an alternating loop of two agents with **fresh context each round**:

```
builder(round N)  ->  critic(round N)  ->  builder(round N+1)  ->  critic(round N+1) -> ...
```

The lead agent orchestrates. Nothing is trusted unless it is on disk.
`gauntlet/COMPARISON_PROTOCOL.md` governs blinding and the current acceptance gate.

## Builder round contract
1. Read `gauntlet/RULES.md`, `gauntlet/PLAN.md`, `gauntlet/RIG.md` (if present).
2. Read the previous critic verdict for your piece, if any:
   `gauntlet/verdicts/<piece>_r<N-1>.json` — its `gap` field is your assignment.
3. Study the bar with your own eyes: the relevant images in `refs/slowroads/official/`
   (and `refs/bridges/` for the bridge piece). Read `refs/slowroads/OBSERVATIONS.md` if it exists.
4. Change ONLY the source files that own your piece (see RIG.md's ownership table).
   Never touch another piece's files. Never edit `gauntlet/shoot.mjs`, `browser.mjs`,
   `log.mjs`, `progress.html`, `state.json`.
5. Implement the concrete gap. Run technical build, asset, geometry and runtime
   checks, but do not score the visuals or call a winner.
6. Report changed files, tests and limitations to the lead. Do not write a visual
   verdict or a builder self-assessment. Preserve earlier historical reports.
7. The lead freezes the source revision before an independent capture run.

## Critic round contract
1. A capture operator renders the frozen build using `gauntlet/shoot.mjs` and the
   reference/parameter fixture selected before implementation.
2. The operator randomizes A/B with `gauntlet/ab.mjs`, withholding keys, source
   labels and implementation details from three fresh independent judges.
3. Judges receive only anonymous images and the shared rubric. They must not read
   source, builder reports, previous scores, reference names or private keys.
4. Each judge locks a quality preference and concrete visual gaps before any
   optional identity guess. The operator reveals the key only after all decisions
   are saved. Identity accuracy is never a quality score.
5. Score the piece 0-100 against the bar, name **the single biggest remaining gap** in
   one concrete actionable sentence, and list secondary gaps.
6. Evaluate material visible gaps across the required families. A nice screenshot
   or an improved score is not sufficient for acceptance.
7. Write `gauntlet/verdicts/<piece>_r<N>.json`:
   `{piece, round, winner:"ours"|"bar"|"tie", score, blind_pick_correct, gap, secondary_gaps:[],
     evidence:[{our_shot, bar_shot, ab_image, note}], verdict_text}`
8. The operator records judge decisions and logs with an explicit `--status judging`
   until the full acceptance gate is met. Never let one win auto-mark a piece won.

## Stop condition
All required families must have no material visible gap according to all three
fresh judges in two consecutive complete runs, with the performance baseline
preserved. See `COMPARISON_PROTOCOL.md`. Stalled iteration must be reported as
unfinished, not relabeled as success or supported by builder self-assessment.
