import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

// ez-tree eagerly constructs a TextureLoader at module evaluation time. The
// bake is geometry-only, so make that one loader a no-op before importing it.
THREE.TextureLoader.prototype.load = function loadStub() {
  return new THREE.Texture();
};

const { Tree, TreePreset, TreeType, Billboard } = await import('@dgreenheck/ez-tree');

const root = path.resolve(new URL('..', import.meta.url).pathname);
const outDir = path.join(root, 'public/models/woodland');
fs.mkdirSync(outDir, { recursive: true });

function tris(geometry) {
  return (geometry.index?.count ?? geometry.attributes.position.count) / 3;
}

function bounds(branches, leaves) {
  let min = new THREE.Vector3(Infinity, Infinity, Infinity);
  let max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const geometry of [branches, leaves]) {
    geometry.computeBoundingBox();
    min.min(geometry.boundingBox.min);
    max.max(geometry.boundingBox.max);
  }
  const height = max.y - min.y;
  const scale = height > 0 ? 1 / height : 1;
  for (const geometry of [branches, leaves]) {
    // Keep the preset trunk at x=z=0, not the bounding box's corner.
    geometry.translate(0, -min.y, 0);
    geometry.scale(scale, scale, scale);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
  return { height, width: (max.x - min.x) * scale, depth: (max.z - min.z) * scale };
}

function makeTree(spec, profile) {
  const tree = new Tree();
  tree.options.copy(TreePreset[spec.preset]);
  tree.options.type = spec.type;
  tree.options.bark.textured = false;
  tree.options.bark.maps = { color: null, ao: null, normal: null, roughness: null };
  for (const [key, value] of Object.entries(profile.branch)) {
    if (value && typeof value === 'object' && tree.options.branch[key]) Object.assign(tree.options.branch[key], value);
    else tree.options.branch[key] = value;
  }
  Object.assign(tree.options.leaves, profile.leaves);
  tree.options.leaves.billboard = profile.leaves.billboard ?? Billboard.Double;
  tree.generate();
  const branches = tree.branchesMesh.geometry.clone();
  const leaves = tree.leavesMesh.geometry.clone();
  const shape = bounds(branches, leaves);
  return {
    branches,
    leaves,
    shape,
    branchTriangles: Math.round(tris(branches)),
    leafTriangles: Math.round(tris(leaves)),
    triangles: Math.round(tris(branches) + tris(leaves)),
  };
}

// Keep the preset topology (including the oak's three recursive levels), only
// reducing ring density/leaf sampling enough for streamed mid-distance trees.
const specs = {
  pine: { preset: 'Pine Medium', type: TreeType.Evergreen },
  oak: { preset: 'Oak Medium', type: TreeType.Deciduous },
};
const profiles = {
  pine: {
    near: [
      { branch: { children: { 0: 82 }, sections: { 0: 12 }, segments: { 0: 8 } }, leaves: { count: 30, billboard: Billboard.Double } },
      { branch: { children: { 0: 60 }, sections: { 0: 8 }, segments: { 0: 6 } }, leaves: { count: 14, billboard: Billboard.Double } },
    ],
    mid: [
      { branch: { children: { 0: 40 }, sections: { 0: 5, 1: 4 }, segments: { 0: 4, 1: 4 } }, leaves: { count: 8, billboard: Billboard.Single } },
      { branch: { children: { 0: 32 }, sections: { 0: 5, 1: 4 }, segments: { 0: 4, 1: 4 } }, leaves: { count: 8, billboard: Billboard.Single } },
    ],
  },
  oak: {
    near: [
      { branch: { sections: { 0: 8, 1: 6, 2: 3, 3: 2 }, segments: { 0: 7, 1: 5, 2: 3, 3: 3 } }, leaves: { count: 30, billboard: Billboard.Double } },
      { branch: { sections: { 0: 8, 1: 6, 2: 3, 3: 2 }, segments: { 0: 7, 1: 5, 2: 3, 3: 3 } }, leaves: { count: 24, billboard: Billboard.Double } },
    ],
    mid: [
      { branch: { sections: { 0: 3, 1: 3, 2: 2, 3: 2 }, segments: { 0: 3, 1: 3, 2: 3, 3: 3 } }, leaves: { count: 4, billboard: Billboard.Single } },
      { branch: { sections: { 0: 3, 1: 3, 2: 2, 3: 2 }, segments: { 0: 3, 1: 3, 2: 3, 3: 3 } }, leaves: { count: 3, billboard: Billboard.Single } },
    ],
  },
};

const baked = {};
for (const name of Object.keys(specs)) {
  baked[name] = {};
  for (const level of ['near', 'mid']) {
    const candidates = profiles[name][level].map((profile) => makeTree(specs[name], profile));
    const range = level === 'near' ? [8000, 20000] : [1500, 4000];
    const picked = candidates.find((item) => item.triangles >= range[0] && item.triangles <= range[1]);
    if (!picked) throw new Error(`${name}/${level} triangles outside target: ${candidates.map((x) => x.triangles).join(', ')}`);
    baked[name][level] = picked;
  }
}

// Pack all attributes into one compact binary buffer and keep the manifest
// intentionally boring: consumers can create BufferAttributes directly from
// offset/count/type without a GLTF dependency.
const chunks = [];
let offset = 0;
function append(typed) {
  const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const aligned = (offset + 3) & ~3;
  if (aligned > offset) chunks.push(Buffer.alloc(aligned - offset));
  offset = aligned;
  chunks.push(bytes);
  const result = { byteOffset: offset, byteLength: bytes.length, count: typed.length };
  offset += bytes.length;
  return result;
}

const manifest = {
  format: 'slowroad-woodland-v1',
  coordinateSystem: 'Three.js Y-up; each root is translated to y=0 and scaled so total height=1',
  buffer: 'trees.bin',
  materials: { bark: { slot: 0, texture: 'pine_color_1k.jpg / oak_color_1k.jpg' }, leaf: { slot: 1, texture: 'pine_color.png / oak_color.png' } },
  trees: {},
};
for (const [name, levels] of Object.entries(baked)) {
  manifest.trees[name] = {};
  for (const [level, item] of Object.entries(levels)) {
    const attrs = (geometry, includeNormal = true) => {
      const out = {
        position: append(geometry.attributes.position.array),
        uv: append(geometry.attributes.uv.array),
        index: append(geometry.index.array),
      };
      if (includeNormal && geometry.attributes.normal) out.normal = append(geometry.attributes.normal.array);
      return out;
    };
    manifest.trees[name][level] = {
      root: { position: [0, 0, 0], scale: [1, 1, 1] },
      normalizedHeight: 1,
      original: { height: item.shape.height, width: item.shape.width, depth: item.shape.depth },
      triangles: item.triangles,
      parts: { bark: { material: 'bark', triangles: item.branchTriangles, attributes: attrs(item.branches) }, leaf: { material: 'leaf', triangles: item.leafTriangles, attributes: attrs(item.leaves) } },
    };
  }
}
fs.writeFileSync(path.join(outDir, 'trees.bin'), Buffer.concat(chunks));
fs.writeFileSync(path.join(outDir, 'trees.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const pkg = path.dirname(new URL(import.meta.resolve('@dgreenheck/ez-tree')).pathname);
const assetRoot = path.join(pkg, '../src/lib/assets');
for (const file of ['bark/pine_color_1k.jpg', 'bark/oak_color_1k.jpg', 'leaves/pine_color.png', 'leaves/oak_color.png']) {
  fs.copyFileSync(path.join(assetRoot, file), path.join(outDir, path.basename(file)));
}
fs.copyFileSync(path.join(pkg, '../LICENSE'), path.join(outDir, 'EZ-TREE-LICENSE'));
fs.copyFileSync(path.join(assetRoot, 'bark/README.md'), path.join(outDir, 'BARK-README.md'));
fs.writeFileSync(path.join(outDir, 'BARK-SOURCES.md'), '# Woodland sources\n\nGenerator and leaf maps: @dgreenheck/ez-tree 1.1.0, MIT (see EZ-TREE-LICENSE).\n\nPine bark: https://www.texturecan.com/details/588/ (CC0; https://www.texturecan.com/terms/).\nOak bark: https://polyhaven.com/a/bark_brown_02 (CC0; https://polyhaven.com/license).\n\nImages are runtime assets only. Visual references remain official Slow Roads screenshots. Near variants retain full crowns; mid variants are not used for near-distance transitions.\n');

for (const [name, levels] of Object.entries(manifest.trees)) {
  for (const [level, item] of Object.entries(levels)) {
    console.log(`${name}/${level}: ${item.triangles} tris (bark ${item.parts.bark.triangles}, leaf ${item.parts.leaf.triangles}), original h=${item.original.height.toFixed(3)} w=${item.original.width.toFixed(3)}`);
  }
}
console.log(`wrote ${path.relative(root, outDir)} (${fs.statSync(path.join(outDir, 'trees.bin')).size} bytes)`);
