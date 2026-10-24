# Woodland Litter V1

Generated on 2026-09-19 with the built-in image generation tool, without an
input image. No Slow Roads pixels were used. The generated PNG is copied
unchanged; the previous `forest-floor.jpg` is retained.

Source: `01a0b6e6-ce21-7272-9087-5443c09d6625/exec-293b5c5c-cb57-47fa-86da-028067069ac0.png`.
Runtime file: `public/textures/woodland-litter-v1.png`.

Prompt:

> Use case: photorealistic-natural. Asset type: seamless tiling albedo texture for a Three.js woodland ground material, square 2048x2048. Primary request: an orthographic directly-overhead texture of actual temperate mixed woodland floor covering a 2 metre by 2 metre patch. A close-packed, naturally overlapping mat of many small dry oak and birch leaves, broken pine needles, thin sticks, some dark moist humus visible in irregular little gaps, small connected patches of deep green moss. The individual leaves must have clearly readable broad simple silhouettes, veins and muted natural pigment variation, not be reduced to grain/noise or tangled thin grass strings. Materials: weathered muted russet and olive leaves over deep neutral brown earth, rich dark green moss. Diffuse daylight, neutral white balance, no cast shadows, no directional sunlight, no baked ambient lighting, consistent brightness to all four edges. All-over continuous texture, seamless left/right and top/bottom; no central focal object, no blank borders, no vignette, no text, no rocks, no grass meadow, no sky, no trees, no perspective. The result is solely a material asset, not a scene or an illustration. Prefer legible medium-scale organic shapes over microdetail. Low chroma, distinct dark soil pockets with leaf surfaces moderately lighter; not pale gray beige sand, not orange carpet.

Actual output is 1254 x 1254, not the requested 2048. It is used as sRGB albedo
with mipmaps, anisotropic filtering and world-fixed UVs. Two samples at the
same physical leaf scale blend between world-fixed offsets with explicit UV
derivatives to suppress repetition without enlarged leaf silhouettes. Seasonal
tint, snow and the existing shore, rock and roadside masks remain material
operations, not image edits.
