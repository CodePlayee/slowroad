# Car Concept

Source: https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept

Model and textures: Eric Chadwick, Darmstadt Graphics Group GmbH, 2024.
License: Creative Commons Attribution 4.0 International.
https://creativecommons.org/licenses/by/4.0/

Original public-domain concept by Unity Fan. Included Khronos / 3D Commerce logos
remain the marks of the Khronos Group; no affiliation or endorsement is implied.

This project adapts the model's scale, paint, glass, wheel motion, lighting and
cockpit visibility. The source model is stored locally for reproducible capture.

## Tesla Model Y

The compact 2025 Tesla Model Y asset is stored locally as
`tesla-model-y-2025-awd-compact.glb`. It is loaded with the local Draco decoder
under `../draco/`; the wheel partition metadata lives in
`../../src/vehicle/model-y-wheel-rig.json` so no neighboring project or network
request is needed at runtime. See `../../gauntlet/VEHICLE_MODEL.md` for the
normalization, contact, and articulation details.

## Flower Nature Pack

Source: https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Flower/Flower.glb
README: https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Flower/README.md
Model by Kenney, from the Nature Pack. CC0 1.0.
Three.js example modifications by Don McCurdy (stem/blossom split and colour adjustments).
The local asset is `flower-nature.glb`.
