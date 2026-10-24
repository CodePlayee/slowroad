import * as THREE from 'three';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// EZ-Tree constructs Three.js loaders while its module is evaluated. The bake
// script is Node-only, so provide the tiny DOM surface it needs without ever
// launching a browser.
if (!globalThis.document) {
  globalThis.document = {
    createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {} }),
  };
}
const { Billboard, Tree, TreePreset, TreeType } = await import('@dgreenheck/ez-tree');

const OUT_DIR = resolve('public/models/woodland');
const BIN_PATH = resolve(OUT_DIR, 'understory.bin');
const MANIFEST_PATH = resolve(OUT_DIR, 'manifest.json');
const BUSHES = [
  { name: 'bush-1', preset: 'Bush 1', type: TreeType.Deciduous, seed: 45590, stems: 7, angle: 58, length: 9.5, leaves: 9 },
  { name: 'bracken-1', growthForm: 'fern' },
];

function triangles(geometry) {
  return Math.round((geometry.index?.count || geometry.getAttribute('position')?.count || 0) / 3);
}

function boundsOf(bark, leaf) {
  bark.computeBoundingBox();
  leaf.computeBoundingBox();
  return new THREE.Box3().union(bark.boundingBox).union(leaf.boundingBox);
}

function fitToUnderstory(bark, leaf) {
  const before = boundsOf(bark, leaf);
  const size = before.getSize(new THREE.Vector3());
  const rootY = bark.boundingBox.min.y;
  const height = before.max.y - rootY;
  const yScale = height > 1e-6 ? 1.5 / height : 1;
  const horizontal = Math.max(size.x, size.z);
  const xzScale = horizontal > 1e-6 ? 2 / horizontal : 1;
  // Transparent leaf-card corners may enter soil; only wood defines the root.
  for (const geometry of [bark, leaf]) {
    geometry.translate(0, -rootY, 0);
    geometry.scale(xzScale, yScale, xzScale);
  }
  for (const geometry of [bark, leaf]) {
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
  return boundsOf(bark, leaf);
}

function buildBush(spec) {
  const tree = new Tree();
  tree.options.copy(TreePreset[spec.preset]);
  tree.options.seed = spec.seed;
  tree.options.type = spec.type;
  tree.options.bark.textured = false;
  tree.options.bark.maps = { color: null, ao: null, normal: null, roughness: null };
  Object.assign(tree.options.branch, {
    levels: 2,
    children: { ...tree.options.branch.children, 0: spec.stems, 1: 4 },
    angle: { ...tree.options.branch.angle, 1: spec.angle, 2: 65 },
    length: { ...tree.options.branch.length, 0: 0.45, 1: spec.length, 2: 4.4 },
    radius: { ...tree.options.branch.radius, 0: 0.44, 1: 0.66, 2: 0.52 },
    start: { ...tree.options.branch.start, 1: 0.04, 2: 0.05 },
    sections: { ...tree.options.branch.sections, 0: 3, 1: 4, 2: 3 },
    segments: { ...tree.options.branch.segments, 0: 5, 1: 4, 2: 3 },
    gnarliness: { ...tree.options.branch.gnarliness, 0: 0.03, 1: 0.14, 2: 0.28 },
    force: { direction: { x: 0, y: 1, z: 0 }, strength: 0.035 },
  });
  Object.assign(tree.options.leaves, {
    billboard: Billboard.Double,
    count: spec.leaves,
    size: 2.6,
    start: 0,
    angle: 55,
    sizeVariance: 0.60,
  });
  tree.generate();
  const bark = tree.branchesMesh.geometry.clone();
  const leaf = tree.leavesMesh.geometry.clone();
  tree.branchesMesh.geometry.dispose?.();
  tree.leavesMesh.geometry.dispose?.();
  tree.branchesMesh.material?.dispose?.();
  tree.leavesMesh.material?.dispose?.();
  const bounds = fitToUnderstory(bark, leaf);
  return {
    name: spec.name, growthForm: 'woody', bark, leaf,
    barkTriangles: triangles(bark), leafTriangles: triangles(leaf), bounds,
  };
}

function buildFern(spec) {
  const stemPositions = [], stemUvs = [], stemIndices = [];
  const leafPositions = [], leafUvs = [], leafIndices = [];
  const appendLeaf = (origin, direction, normal, length) => {
    const width = normal.clone().cross(direction).normalize().multiplyScalar(length * 0.19);
    const middle = origin.clone().addScaledVector(direction, length * 0.46);
    const points = [origin, middle.clone().add(width), origin.clone().addScaledVector(direction, length),
      middle.clone().sub(width), middle.clone().addScaledVector(normal, length * 0.065)];
    const first = leafPositions.length / 3;
    for (const point of points) leafPositions.push(...point.toArray());
    leafUvs.push(0, 0.5, 0.46, 1, 1, 0.5, 0.46, 0, 0.46, 0.5);
    leafIndices.push(first, first + 4, first + 1, first + 1, first + 4, first + 2,
      first + 2, first + 4, first + 3, first + 3, first + 4, first);
  };
  for (let frond = 0; frond < 7; frond++) {
    const angle = frond * 2.399963 + Math.sin(frond * 1.7) * 0.18;
    const reach = 0.72 + (0.5 + 0.5 * Math.sin(frond * 2.1)) * 0.22;
    const height = 0.64 + (0.5 + 0.5 * Math.cos(frond * 1.9)) * 0.36;
    const forward = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const side = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
    const point = t => forward.clone().multiplyScalar(reach * (0.1 * t + 0.9 * t ** 1.25))
      .add(new THREE.Vector3(0, height * (Math.sin(Math.PI * 0.9 * t) * 0.86 + 0.14 * t), 0));
    const tangent = t => point(Math.min(1, t + 0.001)).sub(point(Math.max(0, t - 0.001))).normalize();
    const first = stemPositions.length / 3;
    for (let section = 0; section <= 7; section++) {
      const t = section / 7, center = point(t), along = tangent(t), normal = along.clone().cross(side).normalize();
      const radius = 0.0075 * (1 - t * 0.8);
      for (let radial = 0; radial < 3; radial++) {
        const a = radial * Math.PI * 2 / 3;
        stemPositions.push(...center.clone().addScaledVector(side, Math.cos(a) * radius)
          .addScaledVector(normal, Math.sin(a) * radius).toArray());
        stemUvs.push(radial / 3, t);
        if (section < 7) {
          const a0 = first + section * 3 + radial, b0 = first + section * 3 + (radial + 1) % 3;
          stemIndices.push(a0, b0, a0 + 3, b0, b0 + 3, a0 + 3);
        }
      }
    }
    stemIndices.push(first, first + 2, first + 1, first + 21, first + 22, first + 23);
    for (let pair = 0; pair < 6; pair++) for (const sign of [-1, 1]) {
      const t = 0.16 + pair * 0.14 + sign * 0.009;
      const along = tangent(t), normal = side.clone().cross(along).normalize();
      const direction = side.clone().multiplyScalar(sign).addScaledVector(along, 0.24).normalize();
      const length = 0.235 * Math.sin(Math.PI * t) ** 0.8 * (0.93 + 0.09 * Math.sin(frond * 1.7 + pair));
      appendLeaf(point(t), direction, normal, length);
    }
    const t = 0.93, along = tangent(t);
    appendLeaf(point(t), along, side.clone().cross(along).normalize(), 0.115);
  }
  const geometry = (positions, uvs, indices) => {
    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    result.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    result.setIndex(indices); result.computeVertexNormals();
    return result;
  };
  const bark = geometry(stemPositions, stemUvs, stemIndices), leaf = geometry(leafPositions, leafUvs, leafIndices);
  const bounds = fitToUnderstory(bark, leaf);
  return { name: spec.name, growthForm: 'fern', bark, leaf, bounds,
    barkTriangles: triangles(bark), leafTriangles: triangles(leaf) };
}

const chunks = [];
let byteLength = 0;
function appendTyped(array) {
  // Every descriptor is 4-byte aligned, allowing direct typed-array views in
  // the browser without an intermediate copy of the whole binary.
  const padding = (4 - (byteLength % 4)) % 4;
  if (padding) {
    chunks.push(Buffer.alloc(padding));
    byteLength += padding;
  }
  const offset = byteLength;
  const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  chunks.push(bytes);
  byteLength += bytes.byteLength;
  let type = 'float32';
  if (array instanceof Uint16Array) type = 'uint16';
  if (array instanceof Uint32Array) type = 'uint32';
  return { offset, count: array.length, itemSize: 1, type };
}

function encodeGeometry(geometry) {
  const attributes = {};
  for (const name of ['position', 'normal', 'uv']) {
    const attribute = geometry.getAttribute(name);
    if (!attribute) continue;
    const descriptor = appendTyped(attribute.array);
    descriptor.itemSize = attribute.itemSize;
    descriptor.count = attribute.count;
    descriptor.normalized = attribute.normalized === true;
    attributes[name] = descriptor;
  }
  let index = null;
  if (geometry.index) {
    index = appendTyped(geometry.index.array);
    index.itemSize = 1;
    index.count = geometry.index.count;
  }
  return { attributes, index };
}

await mkdir(dirname(BIN_PATH), { recursive: true });
const templates = BUSHES.map(spec => spec.growthForm === 'fern' ? buildFern(spec) : buildBush(spec));
const manifest = {
  version: 1,
  format: 'slowroad-understory-v1',
  generatedBy: 'gauntlet/bake-understory.mjs',
  byteLength,
  templates: templates.map((template) => ({
    name: template.name,
    growthForm: template.growthForm,
    bark: encodeGeometry(template.bark),
    leaf: encodeGeometry(template.leaf),
    barkTriangles: template.barkTriangles,
    leafTriangles: template.leafTriangles,
    bounds: {
      min: template.bounds.min.toArray(),
      max: template.bounds.max.toArray(),
    },
  })),
};
manifest.byteLength = byteLength;
await writeFile(BIN_PATH, Buffer.concat(chunks, byteLength));
await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
for (const template of templates) {
  template.bark.dispose();
  template.leaf.dispose();
}
console.log(JSON.stringify({
  bin: BIN_PATH,
  manifest: MANIFEST_PATH,
  bytes: byteLength,
  templates: manifest.templates.map(({ name, barkTriangles, leafTriangles }) => ({ name, barkTriangles, leafTriangles })),
}, null, 2));
