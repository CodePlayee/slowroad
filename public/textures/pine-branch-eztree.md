# Pine Branch Runtime Asset

Source: EZ-Tree by Daniel Greenheck, MIT licensed.
This is a runtime texture, not a replacement visual reference. The visual
reference set remains the official Slow Roads screenshots.

- Commit: `dcf309bd86bd521083d9c70f01f2de45fdc7c457`
- Source: https://media.githubusercontent.com/media/dgreenheck/ez-tree/dcf309bd86bd521083d9c70f01f2de45fdc7c457/src/app/public/textures/leaves/pine.png
- Texture license declaration: https://github.com/dgreenheck/ez-tree/blob/dcf309bd86bd521083d9c70f01f2de45fdc7c457/src/app/public/textures/LICENSE.md
- License: `pine-branch-eztree.LICENSE`
- Texture attribution: `pine-branch-eztree-attribution.md`
- Original file: 1024 x 1024 RGBA PNG, 303684 bytes
- SHA-256: `88be36a2387554ac4b7c7d1549eae454a37ad896e8e33a7d6ae5956bd169ab08`

The original file is unmodified. At runtime it is rotated into the existing
branch atlas and converted to grayscale for the scene's seasonal foliage tint.
Near geometry and far impostors both use that atlas. No extra geometry, draw
calls, texture samplers, or package dependencies are needed for this texture.
