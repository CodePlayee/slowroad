# Earlier EZ-Tree Prototype

`src/vegetation/ezTree.js` is the earlier sparse-template experiment and is not
imported by the running app. The active pipeline bakes complete crowns using
`gauntlet/bake-trees.mjs`, then loads the binary assets under `../woodland/`.
This keeps EZ-Tree and its eager texture catalog out of the application bundle.

EZ-Tree is distributed under the MIT License. Keep the upstream attribution
and license when redistributing the dependency or generated templates:
<https://github.com/dgreenheck/ez-tree/blob/main/LICENSE>.
