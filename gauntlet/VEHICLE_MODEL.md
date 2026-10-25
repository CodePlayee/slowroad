# Model Y Vehicle

The active car is the user-provided compact 2025 Tesla Model Y AWD:

- Source: `/Users/minimax/Documents/Play/cars-high-model/dist/optimized/tesla-model-y-2025-awd-compact.glb`
- Served copy: `public/models/tesla-model-y-2025-awd-compact.glb`
- SHA-256: `b3301a2b4b4935c9323d1a430461cfca85096b674b7d8535c5dd6e3693492c90`

The GLB is copied byte-for-byte, with its original paint, glass, interior,
textures and geometry. It has 22 primitives, 16 embedded images, Draco geometry
compression, WebP textures and no animation clips. Draco WASM and its wrapper
are served locally from `public/draco/`, copied from the installed Three.js
glTF decoder distribution. No CDN or neighboring project's server is needed.

## Scene Adaptation

- The model already faces local +Z and uses +X for the driver's side.
- Scale the body to 4.79 m long and keep wheel contact 4 cm above the road datum,
  matching the existing road clearance. Exclude the large baked contact-shadow
  plane from the normalization bounds.
- Preserve the imported PBR materials and disable depth writes for transparent
  glass. The initial fixed-gradient environment is superseded below.
- Identify cabin parts by their `M_Int_` materials rather than the old coupe's
  hierarchy. The cockpit eye sits above/behind the authored steering wheel.
- The compact model ships with merged wheel primitives. `src/vehicle/model-y-wheel-rig.json`
  records a byte- and triangle-level partition of those primitives into four
  wheel groups, so the original GLB stays unchanged while the runtime can
  independently roll every wheel and steer only the front axle. Fixed caliper
  pieces stay outside each rolling subgroup and do not spin with the tyre.
- Retain the procedural vehicle as the existing load-failure fallback.

## Checks

`gauntlet/vehicle-asset.test.mjs` checks the supplied bytes, local decoder,
normalization without shadow-plane contamination, material preservation,
mirrored glass transforms, cabin visibility and fallback hiding. The browser
rig additionally requires the actual Model Y mesh count, dimensions, ground
clearance and cabin, so the fallback cannot silently pass model validation.

Validation on 2026-09-29: 432 unit tests, the wheel-check browser round, and the
production build pass. Runtime body bounds are 2.1023 x 1.6419 x 4.79 m; ground
clearance is 0.04 m.
Chase, cockpit, elevated and night captures plus desktop/mobile canvas checks
are in `/tmp/slowroad-model-y-20260929/`. The model request returns HTTP 200 and
the isolated browser cleanup reports zero remaining processes.

## Environment and Contact Shading

The initial model adaptation did bind an environment map, but it was a fixed
128x64 sky/ground gradient, unrelated to weather, sun direction or clouds.
`VehicleEnvironment` now bakes the shared scene-sky shader plus an approximate
ground hemisphere into a 128-pixel-face HDR PMREM (384x512 CubeUV texture).
It rebakes only when time, season or weather changes, not while the car moves.
The streamed trees/terrain/car are never rendered into this probe. It is an
inexpensive lighting approximation, not real-time local scene reflections.

The sky's art-directed linear RGB ramps can have blue more than 40 times red.
Directly reusing those as illumination repainted silver metal blue. The probe
therefore restrains chroma like the existing hemisphere light and caps peak sky
radiance, while retaining cloud variation and cold/warm lighting cues. This is
IBL calibration, not a change to the car's authored base color or metallicity.
The direct sun disc is omitted from the probe because the directional light
already supplies that highlight. The environment remains linear before PMREM
filtering; the display tone mapper is not baked into it.

The imported `CarShadow` plane has been removed from the rendered vehicle
(the supplied GLB stays byte-identical). Its broad footprint tilted with the
body and intersected the crowned/graded road. A soft body/tyre contact mask is
now evaluated in the road material using world position and vehicle heading.
It follows the actual ribbon and bridges, shades road paint too, and is
independent of body pitch/roll. It adds no mesh, texture, draw call or shadow
render pass. Real-time shadow maps remain disabled. This simulates contact
occlusion only, not a long directional cast shadow.

The first lighting-validation round passed 422 unit tests and 66 browser
checks. Its GPU on/off comparison darkened 10,291 road pixels with 134 falloff
levels, brightened zero pixels, and changed zero pixels after body pitch/roll.
The baked environment stayed unchanged across repeated frames. See
`/tmp/slowroad-car-lighting-20260929/` and the subsequent chroma-balanced
captures in `/tmp/slowroad-car-lighting-balanced-20260929/`.

## Rear-View Mirror

The authored mirror glass (32 triangles of `Roof_Internal_ChromePlastic`) samples
white, fully metallic, roughness ~0.1 texels. Its only reflection source is the
sky/ground-only PMREM above, so it rendered as a blank white plate.
`src/vehicle/mirror.js` splits those triangles into a second material group with
an unlit material and no extra render pass. Its normal is re-aimed so the eye's
ray to the glass centre reflects straight back through the rear window. Along the
true reflected ray it draws the shared sky function, plus an analytic scene behind
the car: the road with its markings (dashes scroll with distance driven), verges,
roadside tree lines and distant hills. These are lit by the scene's sun, hemisphere
and ambient light, faded toward the horizon sky, then multiplied by rear-glass
transmission and mirror reflectance (0.59 overall). This approximates the view
behind the car, not a real reflection of the streamed world.

## Low-Beam Footprint

A surface facing the lamp receives about z/h times the irradiance of the road at
the same distance. The cookie therefore ends its cut-off at the horizon and fades
rays whose road-plane landing point is past the paved edges. Verge grass, cut
slopes and walls near lamp height then stay in the road's irradiance range.
`vehicle-lighting.test.mjs` checks these ratios.

```sh
node --test gauntlet/*.test.mjs
GAUNTLET_URL=http://127.0.0.1:5190 node gauntlet/run-round.mjs \
  --out /tmp/model-y-new --shots summer,cockpit_noon,vista,night
```
