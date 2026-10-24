import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { decodeWoodland } from './woodland.js';
import { loadUnderstory } from './understory.js';
import { coverageTextureFromImage, createCoverageTexture, createNormalTexture, unpremultiplyResolvedPixels } from './coverageMips.js';
import { TREE_SPECIES, TREE_SPECIES_NAMES, isEvergreenSpecies, loadTreeSpecies } from './treeSpecies.js';

const ROOT = '/models/woodland/';
export const IMPOSTOR = Object.freeze({ views: 8, columns: 4, rows: 2, resolution: 256, padding: 0.035 });

export function prepareShrubParts(source) {
  source.bark.computeBoundingBox(); source.leaf.computeBoundingBox();
  const rootY = source.bark.boundingBox.min.y;
  const height = Math.max(1e-5, Math.max(source.bark.boundingBox.max.y, source.leaf.boundingBox.max.y) - rootY);
  const parts = {};
  try {
    for (const part of ['bark', 'leaf']) {
      const geometry = parts[part] = source[part].clone();
      geometry.translate(0, -rootY, 0).scale(1 / height, 1 / height, 1 / height);
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    }
    return parts;
  } catch (error) {
    for (const geometry of Object.values(parts)) geometry.dispose();
    throw error;
  }
}

export function createRootedBark(source, variant = 0) {
  source.computeBoundingBox();
  const position = source.getAttribute('position'), rootY = source.boundingBox.min.y;
  let radius = 0;
  for (let i = 0; i < position.count; i++) if (position.getY(i) <= rootY + 1e-5) {
    radius = Math.max(radius, Math.hypot(position.getX(i), position.getZ(i)));
  }
  if (!Number.isFinite(radius) || radius <= 0) return source.clone();
  const positions = [], uvs = [], indices = [];
  const vertex = (x, y, z, u, v) => { positions.push(x, rootY + y, z); uvs.push(u, v); };
  for (let i = 0; i <= 8; i++) {
    const angle = i * Math.PI / 4;
    vertex(Math.cos(angle) * radius * 1.22, 0, Math.sin(angle) * radius * 1.22, i / 8, 0);
    vertex(Math.cos(angle) * radius * 0.93, radius * 1.5, Math.sin(angle) * radius * 0.93, i / 8, 0.24);
    if (i < 8) {
      const at = i * 2;
      indices.push(at, at + 1, at + 2, at + 1, at + 3, at + 2);
    }
  }
  for (let root = 0; root < 5; root++) {
    const angle = root * Math.PI * 2 / 5 + variant * 0.37;
    const reach = 1.8 + 0.18 * Math.sin(root * 2.3 + variant);
    const width = 0.24, first = positions.length / 3;
    const points = [[0.70, 0, -width], [0.70, 0, width], [0.78, 1, 0],
      [1.22, 0, -width * 0.65], [1.22, 0, width * 0.65], [1.22, 0.4, 0], [reach, 0, 0]];
    for (const [x, y, z] of points) {
      vertex(radius * (x * Math.cos(angle) - z * Math.sin(angle)), radius * y,
        radius * (x * Math.sin(angle) + z * Math.cos(angle)), 0.5 + z, x * 0.16);
    }
    for (const face of [[0, 2, 3], [2, 5, 3], [2, 1, 4], [2, 4, 5], [3, 5, 6], [5, 4, 6],
      [0, 3, 1], [1, 3, 4], [3, 6, 4], [0, 1, 2]]) indices.push(...face.map(index => first + index));
  }
  const roots = new THREE.BufferGeometry();
  let result = null, completed = false;
  try {
    roots.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    roots.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    roots.setIndex(indices); roots.computeVertexNormals();
    result = mergeGeometries([source, roots]);
    if (!result) throw new Error('Tree root geometry could not be combined');
    result.computeBoundingBox(); result.computeBoundingSphere();
    result.userData.rootFlare = { radius, sourceVertices: position.count, addedTriangles: indices.length / 3 };
    completed = true;
    return result;
  } finally { roots.dispose(); if (!completed) result?.dispose(); }
}

export function impostorBounds(parts) {
  const bounds = new THREE.Box3();
  let radius = 0;
  for (const geometry of Object.values(parts)) {
    geometry.computeBoundingBox();
    bounds.union(geometry.boundingBox);
    const positions = geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) radius = Math.max(radius, Math.hypot(positions.getX(i), positions.getZ(i)));
  }
  const height = bounds.max.y - Math.min(0, bounds.min.y);
  return { radius: radius * (1 + IMPOSTOR.padding), width: Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z),
    bottom: Math.min(0, bounds.min.y) - height * IMPOSTOR.padding, top: bounds.max.y + height * IMPOSTOR.padding };
}

/** Every bake transaction restores the live renderer before yielding a frame. */
export function withRendererState(renderer, callback) {
  const state = {
    target: renderer.getRenderTarget(), face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
    viewport: renderer.getViewport(new THREE.Vector4()), scissor: renderer.getScissor(new THREE.Vector4()),
    scissorTest: renderer.getScissorTest(), clear: renderer.getClearColor(new THREE.Color()), clearAlpha: renderer.getClearAlpha(),
    autoClear: renderer.autoClear, toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure,
    outputColorSpace: renderer.outputColorSpace, xr: renderer.xr.enabled,
  };
  try { return callback(); }
  finally {
    renderer.setViewport(state.viewport); renderer.setScissor(state.scissor); renderer.setScissorTest(state.scissorTest);
    renderer.setRenderTarget(state.target, state.face, state.mip);
    renderer.setClearColor(state.clear, state.clearAlpha);
    renderer.autoClear = state.autoClear; renderer.toneMapping = state.toneMapping;
    renderer.toneMappingExposure = state.exposure; renderer.outputColorSpace = state.outputColorSpace;
    renderer.xr.enabled = state.xr;
  }
}

export async function bakeImpostor(renderer, template, bare = false, normal = false) {
  const { resolution, columns, rows, views } = IMPOSTOR;
  const target = new THREE.WebGLRenderTarget(resolution * columns, resolution * rows, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType, samples: 4, depthBuffer: true,
  });
  target.texture.colorSpace = normal ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  target.texture.generateMipmaps = false;
  const scene = new THREE.Scene();
  const materials = [];
  for (const [part, geometry] of Object.entries(template.parts)) {
    if (bare && part === 'leaf') continue;
    const material = new THREE.MeshBasicMaterial({ map: template.maps[part], side: THREE.DoubleSide,
      color: new THREE.Color().setRGB(...(template.tints?.[part] || [1, 1, 1])),
      alphaTest: part === 'leaf' ? 0.32 : 0, alphaToCoverage: false, toneMapped: false });
    if (normal) material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vBakeNormal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBakeNormal = normal;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vBakeNormal;')
        .replace('#include <opaque_fragment>', 'gl_FragColor = vec4(normalize(vBakeNormal) * (gl_FrontFacing ? 0.5 : -0.5) + 0.5, 1.0);');
    };
    material.customProgramCacheKey = () => `foliage-${normal ? 'object-normal' : 'unlit'}-bake-v2`;
    materials.push(material);
    scene.add(new THREE.Mesh(geometry, material));
  }
  const shape = impostorBounds(template.parts);
  const camera = new THREE.OrthographicCamera(-shape.radius, shape.radius, shape.top, shape.bottom, 0.01, 10);
  try {
    for (let view = 0; view < views; view++) {
      const angle = view * Math.PI * 2 / views;
      camera.position.set(Math.sin(angle) * 3, 0, Math.cos(angle) * 3);
      camera.lookAt(0, 0, 0);
      withRendererState(renderer, () => {
        renderer.xr.enabled = false;
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.autoClear = false;
        // Target rectangles are physical pixels; renderer.setViewport would
        // multiply them by the live canvas DPR and crop high-density displays.
        target.viewport.set((view % columns) * resolution, Math.floor(view / columns) * resolution, resolution, resolution);
        target.scissor.copy(target.viewport);
        target.scissorTest = true;
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(scene, camera);
      });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const pixels = new Uint8Array(target.width * target.height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels);
    if (!pixels.some((value, index) => index % 4 === 3 && value > 0)) {
      throw new Error(`Foliage ${template.name} ${bare ? 'bare ' : ''}impostor bake is empty`);
    }
    const straight = unpremultiplyResolvedPixels(pixels, { linear: normal });
    const texture = normal
      ? createNormalTexture(straight, target.width, target.height, { atlasColumns: columns, atlasRows: rows })
      : createCoverageTexture(straight, target.width, target.height, { cutoff: 0.32, atlasColumns: columns, atlasRows: rows });
    texture.name = `${template.name}-${bare ? 'bare-' : ''}${normal ? 'normal-' : ''}same-source-impostor`;
    return { texture, shape, ...IMPOSTOR };
  } finally {
    target.dispose();
    for (const material of materials) material.dispose();
  }
}

export async function loadFoliageAssets(renderer) {
  const resources = new Set();
  let understory = null;
  const templates = new Map();
  const dispose = () => { for (const resource of resources) resource.dispose(); resources.clear(); understory?.dispose(); };
  const read = async (name, type) => {
    const response = await fetch(ROOT + name);
    if (!response.ok) throw new Error(`Foliage ${name}: HTTP ${response.status}`);
    return response[type]();
  };
  try {
    const manifest = await read('trees.manifest.json', 'json');
    const trees = decodeWoodland(manifest, await read(manifest.buffer, 'arrayBuffer'));
    for (const levels of Object.values(trees)) for (const parts of Object.values(levels)) {
      for (const geometry of Object.values(parts)) resources.add(geometry);
    }
    const extra = await loadTreeSpecies();
    for (const levels of Object.values(extra)) for (const parts of Object.values(levels)) {
      for (const geometry of Object.values(parts)) resources.add(geometry);
    }
    Object.assign(trees, extra);
    const loader = new THREE.TextureLoader();
    const textures = new Map();
    const texture = async (file, leaf) => {
      if (textures.has(file)) return textures.get(file);
      const original = await loader.loadAsync(ROOT + file);
      resources.add(original);
      let result = original;
      if (leaf) {
        result = coverageTextureFromImage(original); resources.add(result);
        original.dispose(); resources.delete(original);
      } else {
        result.colorSpace = THREE.SRGBColorSpace;
        result.wrapS = result.wrapT = THREE.RepeatWrapping; result.anisotropy = 4;
      }
      textures.set(file, result);
      return result;
    };
    for (const species of TREE_SPECIES_NAMES) {
      const settings = TREE_SPECIES[species];
      const bark = await texture(settings.barkMap, false), leaf = await texture(settings.leafMap, true);
      const parts = { ...trees[species].near, bark: createRootedBark(trees[species].near.bark, TREE_SPECIES_NAMES.indexOf(species)) };
      resources.add(parts.bark);
      templates.set(species, { name: species, species, kind: 'tree', parts, maps: { bark, leaf },
        tints: { bark: settings.barkTint, leaf: settings.leafTint } });
    }
    understory = await loadUnderstory();
    const shrubLeaf = coverageTextureFromImage(understory.materials.leaf.map);
    resources.add(shrubLeaf);
    understory.templates.forEach((source, index) => {
      const parts = prepareShrubParts(source);
      for (const geometry of Object.values(parts)) resources.add(geometry);
      const fern = source.growthForm === 'fern';
      templates.set(`shrub-${index}`, { name: `shrub-${index}`, species: 'oak', kind: 'shrub', parts,
        growthForm: source.growthForm,
        maps: { bark: fern ? null : understory.materials.bark.map, leaf: fern ? null : shrubLeaf },
        ...(fern ? { heightScale: 0.68, tints: { bark: [0.26, 0.20, 0.055], leaf: [0.15, 0.30, 0.055] } } : {}) });
    });
    for (const template of templates.values()) {
      template.impostor = await bakeImpostor(renderer, template);
      resources.add(template.impostor.texture);
      template.impostor.normalTexture = (await bakeImpostor(renderer, template, false, true)).texture;
      resources.add(template.impostor.normalTexture);
      if (!isEvergreenSpecies(template.species)) {
        template.bareImpostor = await bakeImpostor(renderer, template, true);
        resources.add(template.bareImpostor.texture);
        template.bareImpostor.normalTexture = (await bakeImpostor(renderer, template, true, true)).texture;
        resources.add(template.bareImpostor.normalTexture);
      }
    }
    return { templates, dispose };
  } catch (error) { dispose(); throw error; }
}
