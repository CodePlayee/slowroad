import * as THREE from 'three';

const ROOT = '/models/woodland/';
const SPECIES = ['pine', 'oak'];
const NEAR_LOD_START = 130;
const NEAR_LOD_END = 210;
const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function resolveLodLevel(distance, current, inView) {
  if (!current) return distance < NEAR_LOD_START ? 'near' : 'mid';
  if (inView) return current;
  if (current === 'near' && distance > NEAR_LOD_END + 10) return 'mid';
  if (current === 'mid' && distance < NEAR_LOD_START - 10) return 'near';
  return current;
}

export function decodeWoodland(manifest, buffer) {
  if (manifest.format !== 'slowroad-woodland-v1') throw new Error('Unknown woodland asset format');
  const result = {};
  for (const species of SPECIES) {
    result[species] = {};
    for (const [level, tree] of Object.entries(manifest.trees[species])) {
      const parts = {};
      for (const [part, spec] of Object.entries(tree.parts)) {
        const geometry = new THREE.BufferGeometry();
        for (const [name, info] of Object.entries(spec.attributes)) {
          const Type = name === 'index' ? Uint16Array : Float32Array;
          const size = name === 'index' ? 1 : name === 'uv' ? 2 : 3;
          if (info.count * Type.BYTES_PER_ELEMENT !== info.byteLength || info.count % size ||
              info.byteOffset < 0 || info.byteOffset + info.byteLength > buffer.byteLength) {
            throw new Error(`Invalid woodland buffer: ${species}/${level}/${part}/${name}`);
          }
          const values = new Type(buffer, info.byteOffset, info.count);
          if (!values.every(Number.isFinite)) throw new Error('Non-finite woodland vertex');
          const attribute = new THREE.BufferAttribute(values, size);
          if (name === 'index') geometry.setIndex(attribute); else geometry.setAttribute(name, attribute);
        }
        if (geometry.index.array.some(i => i >= geometry.attributes.position.count)) throw new Error('Woodland index out of bounds');
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        parts[part] = geometry;
      }
      result[species][level] = parts;
    }
  }
  return result;
}

export function selectWoodland(sources, x, z, nearCount = 32, nearRadius = 170, midCount = 96, midRadius = 500) {
  const candidates = [];
  for (const mesh of sources) {
    const data = mesh.userData.woodlandSource;
    if (!data) continue;
    for (let index = 0; index < data.records.length; index++) {
      const record = data.records[index];
      const distance2 = (record.x - x) ** 2 + (record.z - z) ** 2;
      if (distance2 <= midRadius * midRadius) candidates.push({ mesh, index, record, distance2, id: `${data.id}:${index}` });
    }
  }
  candidates.sort((a, b) => a.distance2 - b.distance2 || a.id.localeCompare(b.id));
  const near = candidates.filter(c => c.distance2 <= NEAR_LOD_END ** 2).slice(0, nearCount)
    .map(c => ({ ...c, level: 'near', fade: 1 - smoothstep(NEAR_LOD_START, NEAR_LOD_END, Math.sqrt(c.distance2)) }));
  const mid = candidates.filter(c => c.distance2 >= NEAR_LOD_START ** 2).slice(0, midCount)
    .map(c => ({ ...c, level: 'mid', fade: smoothstep(NEAR_LOD_START, NEAR_LOD_END, Math.sqrt(c.distance2)) }));
  return near.concat(mid);
}

export class Woodland {
  constructor(parent, atmo) {
    this.group = new THREE.Group();
    this.group.name = 'woodland-assets';
    parent.add(this.group);
    this.maxCount = 64;
    this.maxMidCount = 512;
    this.selected = [];
    this.lodLevels = new Map();
    this._viewDir = new THREE.Vector3();
    this.meshes = {};
    this.ready = false;
    this.error = null;
    this.signature = '';
    this.resources = new Set();
    this.assetPromise = this.load(atmo).catch(error => {
      this.dispose();
      this.error = String(error.message || error);
    });
  }

  async load(atmo) {
    const read = async (file, type) => {
      const response = await fetch(ROOT + file);
      if (!response.ok) throw new Error(`Woodland ${file}: HTTP ${response.status}`);
      return response[type]();
    };
    const manifest = await read('trees.manifest.json', 'json');
    this.geometry = decodeWoodland(manifest, await read(manifest.buffer, 'arrayBuffer'));
    for (const levels of Object.values(this.geometry)) for (const parts of Object.values(levels)) {
      for (const geometry of Object.values(parts)) this.resources.add(geometry);
    }
    const loader = new THREE.TextureLoader();
    for (const species of SPECIES) {
      // Serial asset decode avoids a burst of image allocations on this Mac.
      const bark = await loader.loadAsync(ROOT + `${species}_color_1k.jpg`);
      this.resources.add(bark);
      const leaf = await loader.loadAsync(ROOT + `${species}_color.png`);
      this.resources.add(leaf);
      for (const map of [bark, leaf]) { map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4; }
      bark.wrapS = bark.wrapT = THREE.RepeatWrapping;
      const materials = {
        bark: new THREE.MeshStandardMaterial({ map: bark, roughness: 0.94 }),
        leaf: new THREE.MeshStandardMaterial({ map: leaf, roughness: 0.92, side: THREE.DoubleSide, alphaTest: 0.36, alphaToCoverage: true }),
      };
      for (const material of Object.values(materials)) this.resources.add(material);
      const snow = { value: 0 };
      materials.leaf.userData.snow = snow;
      materials.leaf.customProgramCacheKey = () => 'woodland-leaf-v1';
      this.meshes[species] = {};
      for (const level of ['near', 'mid']) {
        this.meshes[species][level] = {};
        for (const part of ['bark', 'leaf']) {
        const material = materials[part];
        material.name = `woodland-${species}-${part}`;
        // LOD transition is visibility-gated rather than alpha blended. Opaque
        // depth prevents near/mid foliage from sorting through each other.
        material.transparent = false;
        material.depthWrite = true;
        material.onBeforeCompile = (shader) => {
          shader.uniforms.uWoodlandSnow = snow;
          shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float iWoodlandFade;\nvarying float vWoodlandFade;');
          shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvWoodlandFade = iWoodlandFade;');
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform float uWoodlandSnow;\nvarying float vWoodlandFade;')
            .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.76, 0.82, 0.87), uWoodlandSnow);\ndiffuseColor.a *= vWoodlandFade;');
        };
        material.customProgramCacheKey = () => 'woodland-fade-v2';
        atmo.register(material);
        // A visibility-locked tree can remain in either level after crossing
        // the distance band, so each level must hold the whole selected set.
        const capacity = this.maxCount + this.maxMidCount;
        // Keep the authored crown through the whole visible woodland range.
        // The old mid asset dropped most leaf clusters and changed the tree's
        // silhouette. Level ownership remains separate for visibility locking.
        const geometry = level === 'near' ? this.geometry[species].near[part]
          : this.geometry[species].near[part].clone();
        if (level === 'mid') this.resources.add(geometry);
        const mesh = new THREE.InstancedMesh(geometry, material, capacity);
        this.resources.add(mesh);
        // Allocate the color buffer before shader compilation, even if this
        // species is absent from the first streamed patch.
        mesh.setColorAt(0, new THREE.Color(1, 1, 1));
        const fade = new Float32Array(capacity).fill(0);
        mesh.userData.fade = fade;
        mesh.geometry.setAttribute('iWoodlandFade', new THREE.InstancedBufferAttribute(fade, 1));
        mesh.count = 0;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        this.group.add(mesh);
        this.meshes[species][level][part] = mesh;
        }
      }
    }
    this.ready = true;
  }

  dispose() {
    this.clear();
    this.group.clear();
    this.group.removeFromParent();
    for (const resource of this.resources) resource.dispose();
    this.resources.clear();
    this.geometry = null;
    this.meshes = {};
    this.ready = false;
  }

  clear() {
    for (const { mesh, index } of this.selected) {
      const start = index * 16;
      mesh.instanceMatrix.array.set(mesh.userData.woodlandSource.matrices.subarray(start, start + 16), start);
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.selected = [];
    this.signature = '';
    for (const species of SPECIES) for (const level of ['near', 'mid']) for (const mesh of Object.values(this.meshes[species]?.[level] || {})) mesh.count = 0;
  }

  sync(tiles, x, z, revision, season) {
    if (!this.ready) return;
    let viewBucket = 'none';
    if (this.camera) {
      this.camera.getWorldDirection(this._viewDir);
      viewBucket = Math.floor((Math.atan2(this._viewDir.z, this._viewDir.x) + Math.PI) / 0.18);
    }
    const signature = `${Math.floor(x / 8)},${Math.floor(z / 8)}:${viewBucket}:${revision}:${season.snow}:${season.bareness}`;
    if (this.signature === signature) return;
    this.clear();
    const sources = [];
    for (const tile of tiles.values()) {
      if (tile.groundReady === false) continue;
      for (const mesh of tile.meshes) if (mesh.userData.woodlandSource) sources.push(mesh);
    }
    const candidates = selectWoodland(sources, x, z, this.maxCount, 170, this.maxMidCount, 760);
    const groups = new Map();
    for (const item of candidates) {
      const list = groups.get(item.id) || [];
      list.push(item);
      groups.set(item.id, list);
    }
    const selected = [];
    const activeIds = new Set(groups.keys());
    for (const id of this.lodLevels.keys()) if (!activeIds.has(id)) this.lodLevels.delete(id);
    for (const [id, group] of groups) {
      const record = group[0].record;
      const distance = Math.hypot(record.x - x, record.z - z);
      let inView = false;
      if (this.camera && distance > 1e-3) {
        const dx = record.x - this.camera.position.x, dz = record.z - this.camera.position.z;
        const d = Math.hypot(dx, dz) || 1;
        inView = (dx * this._viewDir.x + dz * this._viewDir.z) / d > 0.18 && d < 340;
      }
      const locked = this.lodLevels.get(id);
      const level = resolveLodLevel(distance, locked, inView);
      this.lodLevels.set(id, level);
      const item = group.find(candidate => candidate.level === level) || { ...group[0], level };
      item.fade = 1;
      selected.push(item);
    }
    const matrix = new THREE.Matrix4(), tint = new THREE.Color();
    const counts = { pine: { near: 0, mid: 0 }, oak: { near: 0, mid: 0 } };
    for (const item of selected) {
      const { mesh, index, record } = item;
      const species = ['spruce', 'fir', 'pine'].includes(record.kind) ? 'pine' : 'oak';
      const slot = counts[species][item.level]++;
      matrix.fromArray(mesh.userData.woodlandSource.matrices, index * 16);
      for (const part of ['bark', 'leaf']) {
        const target = this.meshes[species][item.level][part];
        if (!item.targets) item.targets = {};
        if (!item.slots) item.slots = {};
        item.targets[part] = target;
        item.slots[part] = slot;
        target.setMatrixAt(slot, matrix);
        target.userData.fade[slot] = item.fade;
        const jitter = 0.84 + record.v * 0.20;
        if (part === 'bark') tint.setRGB(0.92, 0.92, 0.92);
        else {
          const color = species === 'pine' ? season.needleTint : season.leafTint;
          tint.setRGB(color[0] * jitter, color[1] * jitter, color[2] * jitter);
        }
        target.setColorAt(slot, tint);
      }
      // Hide only the replaced instance, retaining the original matrix and
      // tile bounds for restoration. A non-singular far-away transform avoids
      // invalid inverse scales in the legacy material's normal calculation.
      mesh.instanceMatrix.array[index * 16 + 12] = 1e8;
      mesh.instanceMatrix.needsUpdate = true;
    }
    for (const species of SPECIES) for (const level of ['near', 'mid']) {
      for (const part of ['bark', 'leaf']) {
        const mesh = this.meshes[species][level][part];
        mesh.count = species === 'oak' && part === 'leaf' && season.bareness > 0.6 ? 0 : counts[species][level];
        if (part === 'leaf') mesh.material.userData.snow.value = season.snow * 0.9;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.geometry.getAttribute('iWoodlandFade').needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
        if (mesh.count) { mesh.boundingSphere = null; mesh.computeBoundingSphere(); }
      }
    }
    this.selected = selected;
    this.signature = signature;
  }

  setCamera(camera) { this.camera = camera || null; }

}
