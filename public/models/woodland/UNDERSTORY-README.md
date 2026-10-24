# Understory Assets

`manifest.json` and `understory.bin` retain the existing two-slot asset interface.
Rebuild both files with `node gauntlet/bake-understory.mjs` from the project root.

| Population Slot | Template | Source | Triangles |
| --- | --- | --- | --- |
| `shrub-0` | `bush-1` | Existing seeded EZ-Tree shrub, unchanged | 2,714 |
| `shrub-1` | `bracken-1` | Repository-authored procedural fern geometry | 672 |

The first shrub uses the existing bark and leaf textures and the EZ-Tree license
in this directory. Its vertex positions have not been changed for this addition.
The fern introduces no downloaded model, texture, or external image asset. Its
seven arching rachises and 91 folded, pointed leaflets are generated directly by
the bake script. Leaf silhouettes are actual geometry, not alpha-masked cards.

Both templates use the woody root as height zero. Source templates are normalized
before the existing near/far impostor bake. The fern has a 0.68 height multiplier
applied once by the field to matrices, GPU LOD height, CPU LOD, and bounds. Canonical
population records and widths remain unchanged. No additional instances or draw
batches are added: both slots still have stem, leaf, and same-source impostor parts.

The fern uses green leaves and muted brown rachises without bark/leaf image maps.
Its autumn palette is dry gold. The existing winter leaf-removal and bare-impostor
path leaves only the thin brown rachises, rather than a green or white foliage ball.
