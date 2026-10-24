# Gauntlet Loop — Slow Roads++ (open-world scenic driving)

## Goal
开放世界的驾驶体验 web 游戏，重点是旅途的风景，而不是驾驶操纵感。
地形平缓且有变化，道路在合理的位置，与地形衔接自然，跨越河流可以架桥。
有丰富的植被、层次感的大气、季节与时间变化。

## The bars
1. **Primary bar — the 24 official Slow Roads screenshots.** `refs/slowroads/official/`
   holds all 24 official 1920x1080 gameplay screenshots from the Steam store page
   (app 3431300) — the exact analogue of the "real Call of Duty screenshots" Matt Shumer
   used. They are the developer's own best-looking frames, which makes them a *hard* bar.
   `refs/slowroads/live/` additionally holds a few frames captured from the live web build.
   Our game must produce a screenshot that, framed like a given reference, wins a blind
   A/B against it. Critics pick the closest-composition reference for the piece they judge.
   (Live re-capture is NOT available: slowroads.io is behind Cloudflare and we are not
   allowed to open visible browser windows. Work from the official set.)
2. **Secondary bar — real road bridges (slowroads has NO bridges).** Bridges are a net-new
   requirement, so they are judged against real photographs of rural road bridges crossing
   rivers (`refs/bridges/`), plus these non-negotiable structural checks:
   - the bridge exists exactly where the road centerline croses water, not elsewhere;
   - deck grade is continuous with the road either side (no kink, no step);
   - abutments are buried in the banks, piers reach the riverbed under the water surface;
   - span/pier spacing and railing scale read as plausible for a 2-lane road.

## Protocol (per piece)
- One **builder** subagent (fresh context) improves exactly one piece.
- One **critic** subagent (fresh context, never sees builder's reasoning) runs the real
  build, captures our shot with the matched rig, puts it next to the bar shot, calls the
  blind A/B winner, names the single biggest remaining gap, writes a verdict JSON.
- Loop the pair until the critic picks ours (or ties in ours' favour) on that piece.
- Every round appends to `gauntlet/state.json`; the live page renders from it.

## Pieces
| id | piece | bar shots |
|----|-------|-----------|
| terrain | rolling landform, gentle but varied, believable silhouettes | slowroads wide shots |
| road | route placement + how the ribbon meets the ground | slowroads chase shots |
| bridge | river crossings | real bridge photos + structural checks |
| water | rivers, lakes, shoreline | slowroads water shots |
| vegetation | grass/shrub/tree density, near-far falloff | slowroads forest + open shots |
| atmosphere | fog layering, sky, distant ridgelines, aerial perspective | slowroads hazy depth shots |
| daycycle | dawn / noon / golden / dusk / night lighting | slowroads time variants |
| season | spring/summer/autumn/winter palette + foliage | slowroads season variants |
| journey | camera + motion feel: it's a journey, not a driving sim | slowroads in motion |
| streaming | endless world, no pops, stable framerate | slowroads perf |

## Shared rig contract (all agents rely on this)
- Dev server: `npm run dev` on port **5188**.
- Deterministic scene via URL params, e.g.
  `http://localhost:5188/?seed=12&t=17.5&season=autumn&weather=clear&cam=chase&x=...&z=...`
- `window.__rig` on the page exposes:
  - `await __rig.ready()` resolves when terrain/veg around the camera are fully resident
  - `__rig.set({seed,t,season,weather,cam,dist})`
  - `__rig.teleport(km)` — move car along the road to km marker
  - `__rig.hideUI()` / `__rig.showUI()`
  - `__rig.stats()` -> `{fps, drawCalls, triangles, km}`
  - `__rig.findBridge()` -> nearest bridge km, for bridge shots
- Screenshots: `node gauntlet/shoot.mjs <outfile> <query-string>` at 1600x900.

## Chrome instances (avoid collisions)
Read `gauntlet/RULES.md` FIRST. Headless only, via `gauntlet/browser.mjs`. Never pkill.
- 9223 — "ours", shooting our game
- 9231+ — per-critic instances

## Comparison resolution
Our shots are rendered at **1920x1080** to match the official reference set exactly.
