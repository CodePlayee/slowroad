import * as THREE from 'three';

const ROOT = '/models/woodland/';
const LEAF_URL = `${ROOT}oak_color.png`;
const BARK_URL = `${ROOT}oak_color_1k.jpg`;
const MANIFEST_URL = `${ROOT}manifest.json`;
const BINARY_URL = `${ROOT}understory.bin`;

function triangles(geometry) {
  return Math.round((geometry.index?.count || geometry.getAttribute('position')?.count || 0) / 3);
}

function viewForAttribute(bytes, descriptor) {
  const count = descriptor.count * descriptor.itemSize;
  if (descriptor.type === 'uint16') return new Uint16Array(bytes, descriptor.offset, count).slice();
  if (descriptor.type === 'uint32') return new Uint32Array(bytes, descriptor.offset, count).slice();
  return new Float32Array(bytes, descriptor.offset, count).slice();
}

function decodeGeometry(bytes, descriptor) {
  const geometry = new THREE.BufferGeometry();
  try {
    for (const [name, attribute] of Object.entries(descriptor.attributes)) {
      geometry.setAttribute(name, new THREE.BufferAttribute(
        viewForAttribute(bytes, attribute), attribute.itemSize, attribute.normalized === true,
      ));
    }
    if (descriptor.index) geometry.setIndex(new THREE.BufferAttribute(viewForAttribute(bytes, descriptor.index), 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  } catch (error) {
    geometry.dispose();
    throw error;
  }
}

export function groundUnderstory(bark, leaf) {
  bark.computeBoundingBox();
  const rootY = bark.boundingBox.min.y, bounds = new THREE.Box3();
  for (const geometry of [bark, leaf]) {
    geometry.translate(0, -rootY, 0);
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    bounds.union(geometry.boundingBox);
  }
  return bounds;
}

async function loadTexture(url) {
  const texture = await new THREE.TextureLoader().loadAsync(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

function makeMaterials(barkTexture, leafTexture) {
  const bark = new THREE.MeshStandardMaterial({
    name: 'understory-bark', map: barkTexture, color: 0xffffff, roughness: 0.94,
    vertexColors: false, transparent: false, depthWrite: true,
  });
  const leaf = new THREE.MeshStandardMaterial({
    name: 'understory-leaf', map: leafTexture, color: 0xffffff, roughness: 0.9,
    vertexColors: false, side: THREE.DoubleSide, alphaTest: 0.28, alphaToCoverage: true,
    transparent: false, depthWrite: true,
  });
  return { bark, leaf };
}

async function loadBakedTemplates() {
  const [manifestResponse, binaryResponse] = await Promise.all([fetch(MANIFEST_URL), fetch(BINARY_URL)]);
  if (!manifestResponse.ok) throw new Error(`understory manifest request failed (${manifestResponse.status})`);
  if (!binaryResponse.ok) throw new Error(`understory binary request failed (${binaryResponse.status})`);
  const manifest = await manifestResponse.json();
  if (manifest.version !== 1 || !Array.isArray(manifest.templates)) throw new Error('unsupported understory manifest');
  const bytes = await binaryResponse.arrayBuffer();
  const templates = [], owned = [];
  try {
    for (const entry of manifest.templates) {
      const bark = decodeGeometry(bytes, entry.bark); owned.push(bark);
      const leaf = decodeGeometry(bytes, entry.leaf); owned.push(leaf);
      templates.push({ name: entry.name, growthForm: entry.growthForm ?? 'woody', bark, leaf, bounds: groundUnderstory(bark, leaf),
        barkTriangles: triangles(bark), leafTriangles: triangles(leaf) });
    }
    return templates;
  } catch (error) {
    for (const geometry of owned) geometry.dispose();
    throw error;
  }
}

/** Load low shrubs from the pre-baked branch-and-leaf geometry. */
export async function loadUnderstory() {
  let barkTexture = null;
  let leafTexture = null;
  let materials = null;
  let templates = [];
  try {
    // Keep texture ownership explicit so a failed binary request still cleans
    // up both textures and any templates decoded before the failure.
    barkTexture = await loadTexture(BARK_URL);
    leafTexture = await loadTexture(LEAF_URL);
    materials = makeMaterials(barkTexture, leafTexture);
    templates = await loadBakedTemplates();
  } catch (error) {
    for (const template of templates) {
      template.bark.dispose();
      template.leaf.dispose();
    }
    materials?.bark.dispose();
    materials?.leaf.dispose();
    barkTexture?.dispose();
    leafTexture?.dispose();
    throw error;
  }
  let disposed = false;
  return {
    templates,
    materials,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const template of templates) {
        template.bark.dispose();
        template.leaf.dispose();
      }
      materials.bark.dispose();
      materials.leaf.dispose();
      barkTexture.dispose();
      leafTexture.dispose();
    },
  };
}

export { BARK_URL, LEAF_URL, MANIFEST_URL, BINARY_URL };
