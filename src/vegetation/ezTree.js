// Runtime-only EZ-Tree templates.  Geometry is deliberately returned without
// materials or textures so callers can choose the vegetation atlas they use.
import { Tree, TreeType, Billboard, TreePreset } from '@dgreenheck/ez-tree';

const NEAR_DETAIL = Object.freeze({
  sectionStride: 1,
  segmentFactor: 1,
  leafStride: 1,
  leafScale: 1,
  billboard: Billboard.Double,
});

const MID_DETAIL = Object.freeze({
  sectionStride: 2,
  segmentFactor: 0.55,
  leafStride: 2,
  leafScale: 1.1,
  billboard: Billboard.Single,
});

// The options keep branch counts intentionally small.  EZ-Tree's presets are
// artist-oriented and some of their child counts are too expensive for a
// streamed forest tile (notably Pine Small's original 91 first-level children).
const TEMPLATE_CONFIGS = [
  {
    name: 'pine',
    preset: 'Pine Small',
    type: TreeType.Evergreen,
    levels: 1,
    children: { 0: 4 },
    sections: { 0: 6, 1: 4 },
    segments: { 0: 4, 1: 3 },
    leaves: { count: 8, size: 1.05 },
  },
  {
    name: 'deciduous',
    preset: 'Oak Small',
    type: TreeType.Deciduous,
    levels: 2,
    children: { 0: 2, 1: 2 },
    sections: { 0: 6, 1: 4, 2: 3 },
    segments: { 0: 4, 1: 3, 2: 3 },
    leaves: { count: 8, size: 1.15 },
  },
  {
    name: 'aspen',
    preset: 'Aspen Small',
    type: TreeType.Deciduous,
    levels: 2,
    children: { 0: 2, 1: 2 },
    sections: { 0: 6, 1: 4, 2: 3 },
    segments: { 0: 4, 1: 3, 2: 3 },
    leaves: { count: 8, size: 1.2 },
  },
];

function triangleCount(geometry) {
  const index = geometry?.index;
  const positions = geometry?.attributes?.position;
  return Math.round((index ? index.count : positions?.count ?? 0) / 3);
}

function geometryFor(tree, detail) {
  if (typeof tree.createGeometry === 'function') {
    return tree.createGeometry(detail);
  }

  // Compatibility path for older EZ-Tree builds.  Clone before disposing the
  // generated meshes because the returned templates own their geometries.
  tree.generate();
  const branchSource = tree.branchesMesh?.geometry;
  const leafSource = tree.leavesMesh?.geometry;
  if (!branchSource?.clone || !leafSource?.clone) {
    throw new Error('EZ-Tree did not expose branch and leaf geometry');
  }
  const branches = branchSource.clone();
  const leaves = leafSource.clone();
  branchSource.dispose?.();
  leafSource.dispose?.();
  const branchMaterial = tree.branchesMesh.material;
  const leafMaterial = tree.leavesMesh.material;
  // The package's animated callback writes modelViewMatrix directly and is not
  // safe when its geometry is wrapped in InstancedMesh. Keep its maps/alpha,
  // but use Three's normal instancing path.
  const safeLeafMaterial = leafMaterial?.clone ? leafMaterial.clone() : leafMaterial;
  if (safeLeafMaterial) {
    safeLeafMaterial.onBeforeCompile = () => {};
    safeLeafMaterial.userData = {};
  }
  leafMaterial?.dispose?.();
  return { branches, leaves, branchMaterial, leafMaterial: safeLeafMaterial };
}

function placeOnGround(branches, leaves) {
  const geometries = [branches, leaves];
  let minY = Infinity;
  let maxY = -Infinity;

  for (const geometry of geometries) {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) continue;
    minY = Math.min(minY, box.min.y);
    maxY = Math.max(maxY, box.max.y);
  }

  if (!Number.isFinite(minY)) {
    minY = 0;
    maxY = 0;
  }
  const lift = -minY;
  for (const geometry of geometries) {
    geometry.translate(0, lift, 0);
    // Consumers can safely use frustum culling immediately after creation.
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }

  return Math.max(0, maxY - minY);
}

function buildTemplate(config, detail) {
  const preset = TreePreset[config.preset];
  if (!preset) throw new Error(`Unknown EZ-Tree preset: ${config.preset}`);

  const tree = new Tree();
  tree.options.copy(preset);
  tree.options.type = config.type;
  tree.options.bark.textured = false;
  tree.options.bark.maps = { color: null, ao: null, normal: null, roughness: null };

  Object.assign(tree.options.branch, {
    levels: config.levels,
    children: { ...tree.options.branch.children, ...config.children },
    sections: { ...tree.options.branch.sections, ...config.sections },
    segments: { ...tree.options.branch.segments, ...config.segments },
  });
  Object.assign(tree.options.leaves, {
    ...config.leaves,
    billboard: detail.billboard,
    map: null,
  });

  const { branches, leaves, branchMaterial, leafMaterial } = geometryFor(tree, detail);
  const height = placeOnGround(branches, leaves);
  return {
    name: config.name,
    branches,
    leaves,
    branchMaterial,
    leafMaterial,
    branchTriangles: triangleCount(branches),
    leafTriangles: triangleCount(leaves),
    height,
  };
}

/**
 * Build low-budget pine, deciduous and aspen geometry templates.
 *
 * `level` is optional: `near` (the default) keeps the full low-budget branch
 * detail, while `mid` applies the cheaper ring/leaf stride for a mid-distance
 * pass.  Each returned geometry has a y=0 base and a computed boundingSphere.
 */
export function createEzTreeTemplates(level = 'near') {
  const detail = level === 'mid' ? MID_DETAIL : NEAR_DETAIL;
  return TEMPLATE_CONFIGS.map((config) => buildTemplate(config, detail));
}
