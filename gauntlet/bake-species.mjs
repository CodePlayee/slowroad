import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

// The generator eagerly loads browser textures; only its geometry is baked here.
THREE.TextureLoader.prototype.load = () => new THREE.Texture();
const { Tree, TreePreset, TreeType, Billboard } = await import('@dgreenheck/ez-tree');
const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = path.join(root, 'public/models/woodland');
fs.mkdirSync(outDir, { recursive: true });

// These are different branch architectures, not scaled copies of the existing
// oak and pine. Maple uses broad ash-like branching with the library's lobed map.
const configs = {
  birch: {
    preset: 'Aspen Medium', seed: 48217, type: TreeType.Deciduous,
    branch: {
      levels: 3, children: { 0: 7, 1: 3, 2: 2 },
      length: { 0: 44, 1: 17, 2: 12, 3: 6 }, radius: { 0: 0.78, 1: 0.55, 2: 0.59, 3: 0.56 },
      angle: { 1: 48, 2: 54, 3: 51 }, start: { 1: 0.45, 2: 0.28, 3: 0.1 },
      sections: { 0: 9, 1: 6, 2: 4, 3: 3 }, segments: { 0: 7, 1: 5, 2: 3, 3: 3 },
      gnarliness: { 0: 0.018, 1: 0.1, 2: 0.17, 3: 0.2 },
      force: { direction: { x: 0, y: 1, z: 0 }, strength: 0.008 },
    },
    leaves: { count: 11, size: 3.8, sizeVariance: 0.48, start: 0.18, angle: 40 },
  },
  aspen: {
    preset: 'Aspen Medium', seed: 93661, type: TreeType.Deciduous,
    branch: {
      levels: 2, children: { 0: 18, 1: 3 },
      length: { 0: 49, 1: 6.8, 2: 9.5 }, radius: { 0: 0.92, 1: 0.37, 2: 0.56 },
      angle: { 1: 29, 2: 25 }, start: { 1: 0.35, 2: 0.08 },
      sections: { 0: 10, 1: 5, 2: 3 }, segments: { 0: 7, 1: 4, 2: 3 },
      gnarliness: { 0: 0.012, 1: 0.06, 2: 0.1 },
      force: { direction: { x: 0, y: 1, z: 0 }, strength: 0.012 },
    },
    leaves: { count: 17, size: 4.0, sizeVariance: 0.4, start: 0.06, angle: 30 },
  },
  maple: {
    preset: 'Ash Medium', seed: 36173, type: TreeType.Deciduous,
    branch: {
      levels: 3, children: { 0: 6, 1: 4, 2: 3 },
      length: { 0: 30, 1: 24, 2: 13, 3: 6 }, radius: { 0: 1.6, 1: 0.67, 2: 0.66, 3: 0.58 },
      angle: { 1: 54, 2: 55, 3: 47 }, start: { 1: 0.38, 2: 0.18, 3: 0 },
      sections: { 0: 8, 1: 5, 2: 3, 3: 2 }, segments: { 0: 7, 1: 4, 2: 3, 3: 3 },
      gnarliness: { 0: 0.06, 1: 0.14, 2: 0.18, 3: 0.13 },
      force: { direction: { x: 0, y: 1, z: 0 }, strength: 0.012 },
    },
    leaves: { count: 12, size: 3.6, sizeVariance: 0.44, start: 0, angle: 47 },
  },
  spruce: {
    preset: 'Pine Medium', seed: 28037, type: TreeType.Evergreen,
    branch: {
      levels: 1, children: { 0: 72 },
      length: { 0: 55, 1: 22 }, radius: { 0: 1.02, 1: 0.35 },
      angle: { 1: 99 }, start: { 1: 0.1 },
      sections: { 0: 10, 1: 5 }, segments: { 0: 7, 1: 4 },
      gnarliness: { 0: 0.018, 1: 0.045 },
      force: { direction: { x: 0, y: 1, z: 0 }, strength: -0.001 },
    },
    leaves: { count: 24, size: 2.7, sizeVariance: 0.27, start: 0.03, angle: 47 },
  },
};

function generate(config) {
  const tree = new Tree();
  tree.options.copy(TreePreset[config.preset]);
  tree.options.seed = config.seed;
  tree.options.type = config.type;
  tree.options.bark.textured = false;
  tree.options.bark.maps = { color: null, ao: null, normal: null, roughness: null };
  for (const [key, value] of Object.entries(config.branch)) {
    if (value && typeof value === 'object') Object.assign(tree.options.branch[key], value);
    else tree.options.branch[key] = value;
  }
  Object.assign(tree.options.leaves, config.leaves, { billboard: Billboard.Double });
  tree.generate();
  const parts = { bark: tree.branchesMesh.geometry.clone(), leaf: tree.leavesMesh.geometry.clone() };
  const bounds = new THREE.Box3();
  for (const geometry of Object.values(parts)) {
    geometry.computeBoundingBox();
    bounds.union(geometry.boundingBox);
  }
  const height = bounds.max.y - bounds.min.y;
  for (const geometry of Object.values(parts)) {
    geometry.translate(0, -bounds.min.y, 0).scale(1 / height, 1 / height, 1 / height);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
  tree.branchesMesh.geometry.dispose(); tree.leavesMesh.geometry.dispose();
  tree.branchesMesh.material.dispose(); tree.leavesMesh.material.dispose();
  return { parts, original: { height, width: (bounds.max.x - bounds.min.x) / height, depth: (bounds.max.z - bounds.min.z) / height } };
}

const chunks = [];
let offset = 0;
function append(array) {
  const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  const aligned = (offset + 3) & ~3;
  if (aligned > offset) chunks.push(Buffer.alloc(aligned - offset));
  offset = aligned;
  const description = { byteOffset: offset, byteLength: bytes.length, count: array.length };
  chunks.push(bytes); offset += bytes.length;
  return description;
}

const manifest = {
  format: 'slowroad-woodland-v1', buffer: 'species.bin',
  coordinateSystem: 'Three.js Y-up; root centered at x=z=0, translated to y=0, total height=1',
  generator: '@dgreenheck/ez-tree 1.1.0', trees: {},
};
for (const [name, config] of Object.entries(configs)) {
  const generated = generate(config);
  const tree = { root: { position: [0, 0, 0], scale: [1, 1, 1] }, normalizedHeight: 1, original: generated.original,
    triangles: 0, parts: {} };
  for (const [part, geometry] of Object.entries(generated.parts)) {
    const attributes = {};
    for (const name of ['position', 'normal', 'uv']) attributes[name] = append(geometry.getAttribute(name).array);
    attributes.index = append(geometry.index.array);
    const triangles = geometry.index.count / 3;
    tree.parts[part] = { material: part, triangles, attributes };
    tree.triangles += triangles;
    geometry.dispose();
  }
  if (tree.triangles < 4000 || tree.triangles > 12000) throw new Error(`${name}: ${tree.triangles} triangles outside 4k-12k budget`);
  manifest.trees[name] = { near: tree };
  console.log(`${name}: ${tree.triangles} tris, normalized width=${tree.original.width.toFixed(3)} depth=${tree.original.depth.toFixed(3)}`);
}

fs.writeFileSync(path.join(outDir, manifest.buffer), Buffer.concat(chunks));
fs.writeFileSync(path.join(outDir, 'species.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const pkg = path.dirname(fileURLToPath(import.meta.resolve('@dgreenheck/ez-tree')));
const assetRoot = path.resolve(pkg, '../src/lib/assets');
for (const file of ['bark/birch_color_1k.jpg', 'leaves/aspen_color.png']) {
  fs.copyFileSync(path.join(assetRoot, file), path.join(outDir, path.basename(file)));
}
fs.writeFileSync(path.join(outDir, 'SPECIES-SOURCES.md'), '# Additional woodland species\n\nGeometry generated offline using @dgreenheck/ez-tree 1.1.0 (MIT; see EZ-TREE-LICENSE). Rebuild with `node gauntlet/bake-species.mjs`; that file retains the seeded branch and leaf parameters.\n\nBirch and aspen use the library birch bark and aspen leaf cutout. Maple is a broad-crowned deciduous interpretation using the ash branch preset and existing oak leaf cutout, not a botanically exact maple leaf model. Spruce uses a low-branching dense evergreen architecture and the existing pine needle cutout. Existing bark/needle maps and their sources remain documented in BARK-SOURCES.md and BARK-README.md. Birch bark is sourced by EZ-Tree from TextureCan (CC0; https://www.texturecan.com/details/221/ and https://www.texturecan.com/terms/). The leaf cutout is distributed with EZ-Tree under MIT.\n\nAll parts retain positions, normals and UVs. Every full crown is rooted at y=0 and normalized to height=1. No tree generator or texture synthesis runs in the game.\n');
console.log(`wrote ${path.relative(root, outDir)}/species.bin (${offset} bytes)`);
