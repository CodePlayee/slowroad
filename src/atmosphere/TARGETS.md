# Atmosphere acceptance targets — measured off `refs/slowroads/official/`

All values are **post-tonemap sRGB**, sampled as 11x11 box averages. `S`/`V` are HSV.
Sampling script: `/tmp/gauntlet-atmo/pts.py` (regenerate as needed).

## The one thing that matters

The bar's distant terrain does **not** fade to grey. It fades to a *saturated pale blue*
— the sky colour in that view direction. Measured on sr_01 (clear afternoon), the same
grass/tree material at four depths:

| depth | hex | hue | S | V |
|---|---|---|---|---|
| near grass | `#37361a` | 58° | 0.53 | 0.22 |
| mid tree band | `#405725` | 88° | 0.57 | 0.34 |
| far hill | `#63869f` | **205°** | 0.38 | 0.62 |
| farthest ridge | `#91c2f6` | **211°** | 0.41 | 0.96 |
| sky just above it | `#9acbfc` | 210° | 0.39 | 0.99 |

Hue rotates 58° → 211°. Saturation **stays at 0.38–0.41** because it inherits the sky's
saturation. Value climbs 0.22 → 0.96, i.e. the far ridge sits at 96% of the sky value.
Any implementation that lerps toward a desaturated grey fails this immediately.

sr_03 (hazy) shows five distinct value steps — this is what makes ridges "layer":
near tree V0.55 → mid ridge V0.66 → ridge V0.87 → ridge V0.93 → sky V1.00.

## Sky gradients (top of frame ≈ 25–30° elevation, not true zenith)

| mood | ref | top of frame | mid | horizon |
|---|---|---|---|---|
| clear day | sr_01 | `#8ab9ef` S0.42 V0.94 | `#8ec0f5` | `#9acbfc` S0.39 V0.99 |
| clear day | sr_17 | `#91c4fd` S0.43 V0.99 | — | — |
| hazy | sr_03 | `#b1d3ff` S0.31 V1.00 | `#bedaff` | `#d8ebff` S0.15 |
| dusk | sr_04 | `#c38182` S0.34 (rose) | `#d5a99c` S0.27 | `#fac5a3` S0.35 V0.98 (peach) |
| dusk/sea | sr_02 | `#c39db4` H324 S0.19 V0.76 (mauve) | `#cfa6ac` | `#e6ba95` H27 S0.35 V0.90 |
| blue hour | sr_09 | `#3b5476` H215 **S0.50** V0.46 | — | `#6d7f9b` V0.61 |
| late dusk | sr_20 | `#2f3c45` H205 S0.32 V0.27 | `#383d3d` V0.24 | warm residual `#413d32` H44 |
| night | sr_14 | `#08070c` H252 S0.42 V0.05 | — | `#13131d` V0.11 |
| overcast | sr_11 | `#abb4bd` H210 **S0.10** V0.74 | flat | `#afb8c0` V0.75 |
| overcast bright | sr_23 | `#e3e7ea` S0.03 V0.92 | flat | flat |
| snow overcast | sr_13 | `#71797c` S0.09 V0.49 | flat | flat |

### Non-obvious rules extracted
1. **Clear day sky saturation is 0.40–0.43, not 0.15.** Our baseline was S0.20 at noon and
   S0.03 on the hazy vista. That is the single loudest failure.
2. **Dusk is desaturated dusty rose, not saturated orange.** S peaks at 0.35 and the whole
   frame's upper sky sits at V0.76–0.94. There is *no deep blue* anywhere in a dusk frame.
   The hue sweeps 324° (mauve, high) → 27° (peach, horizon) — a long rotation through pink.
3. **The warm band follows the sun's azimuth**, it is not a full horizon ring. sr_02 has
   peach at x=0.12 (sunward) and mauve at x=0.40 at the same height.
4. **Night is genuinely dark** (V0.05 zenith, V0.11 near horizon) with an indigo hue near
   H240–250 and visible stars. Our baseline night was V0.24–0.27 — 2.5× too bright — and
   too saturated (S0.60 vs 0.42).
5. **Overcast = very bright, near-achromatic sky (S0.03–0.10) over a still-saturated, dark
   foreground** (sr_23 near shrub S0.76 V0.20). It is not grey mush. Vertical gradient is
   almost flat (0.74 → 0.75). Shadows are absent, ambient is high, but the ground is
   *underexposed relative to the sky*.
6. **Far terrain at overcast reaches sky value exactly** — sr_11's hill at y=0.20 reads
   `#acb5bd` against sky `#abb4bd`. Total extinction.
7. Highlights roll off but the horizon *does* reach V0.99–1.00 on clear days. Exposure is
   set for the sky; the ground is allowed to sit at V0.20–0.35.
8. Vignette is subtle by day, obvious at night/dusk (sr_13, sr_14, sr_04 corners).
9. Clouds: thin high wisps by day (sr_01), directionally lit stratus at dusk (sr_04),
   full featureless deck at overcast (sr_11/23).

## Baseline failures (shots/baseline/, measured)

| shot | ours | should be | delta |
|---|---|---|---|
| chase_summer_noon | `#adc0d8` S0.20 V0.85, flat 0.85→0.86 | S0.42 V0.94→0.99 | half the saturation, no gradient |
| vista_ridges (hazy) | `#e3e5e9` **S0.03** V0.91, flat at every height | S0.31 V1.00 | achromatic white paste, ridges in one flat band |
| chase_dawn t=6.1 | `#bfc5d2` S0.09 V0.82 | S0.19–0.50, warm sunward band | zero dawn colour, ~2× too bright |
| chase_golden t=18.4 | `#dfe0e3` S0.02 → `#e5e4e5` **S0.00** | rose → peach S0.34 | literally achromatic; catastrophic |
| chase_night | `#17213e` S0.63 V0.24, flat | V0.05 → 0.11, S0.42 | 2.5× too bright, too saturated |
| cockpit_overcast | `#aabad1` S0.19 V0.82 | S0.03–0.10 | too blue, gradient runs the wrong way |

Root causes found by reading the shader: (a) `mix(horizon, zenith, pow(t,0.42))` never
reaches the zenith colour inside a 50° fov so the frame is dominated by a *pale*
horizon colour; (b) a `pow(cos,7)*0.55` near-white forward-scatter halo added over the
whole hemisphere pushes everything into the tonemapper's desaturating shoulder;
(c) fog colour was a hand-authored two-colour ramp, decoupled from the sky, so it could
never make ridges layer.
