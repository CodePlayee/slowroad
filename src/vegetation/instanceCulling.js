import * as THREE from 'three';

const equal = (a, b) => {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const IDENTITY = new THREE.Matrix4();

function copyInstance(source, target, sourceIndex, targetIndex) {
  const start = Math.floor(sourceIndex / source.meshPerAttribute) * source.itemSize;
  const destination = targetIndex * source.itemSize;
  for (let k = 0; k < source.itemSize; k++) target.array[destination + k] = source.array[start + k];
}

function markChanged(attribute, changedStart, changedEnd) {
  let start = changedStart * attribute.itemSize, end = changedEnd * attribute.itemSize;
  // An all-visible frame may have rendered canonical buffers instead.
  for (const range of attribute.updateRanges) {
    start = Math.min(start, range.start);
    end = Math.max(end, range.start + range.count);
  }
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(start, end - start);
  attribute.needsUpdate = true;
}

function containsBox(frustum, box) {
  return frustum.planes.every(({ normal: n, constant }) =>
    n.x * (n.x >= 0 ? box.min.x : box.max.x) + n.y * (n.y >= 0 ? box.min.y : box.max.y)
    + n.z * (n.z >= 0 ? box.min.z : box.max.z) + constant > 0.001);
}

function grassBand(mesh) {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const uniforms = material?.userData.uniforms;
  if (!mesh.geometry.getAttribute('iShape') || !uniforms?.uBand || !uniforms.uFocus ||
      !material.customProgramCacheKey().startsWith('meadow-')) return null;
  return [uniforms.uFocus.value.x, uniforms.uFocus.value.y, uniforms.uBand.value.x >= 0.5];
}

function grassHidden(matrix, index, shapes, band) {
  const distance = Math.hypot(matrix[index * 16 + 12] - band[0], matrix[index * 16 + 14] - band[1]);
  const near = 1 - smoothstep(62, 85, distance);
  const coverage = band[2] ? (1 - near) * (1 - smoothstep(240, 285, distance)) : near;
  const shape = shapes.array[Math.floor(index / shapes.meshPerAttribute) * shapes.itemSize];
  const random = shape * 31.73;
  // fract is discontinuous at integers; float32 GLSL can round to the other side.
  if (Math.abs(random - Math.round(random)) < 1e-4) return false;
  // Match the shader's actual zero, including its nonzero tail at coverage=0.
  // Leave a margin for float32 GLSL arithmetic at the stochastic threshold.
  return coverage - (random - Math.floor(random)) + 0.18 < -1e-4;
}

function matrixRadiusScale(elements) {
  const a = elements;
  const xx = a[0] ** 2 + a[1] ** 2 + a[2] ** 2;
  const yy = a[4] ** 2 + a[5] ** 2 + a[6] ** 2;
  const zz = a[8] ** 2 + a[9] ** 2 + a[10] ** 2;
  const xy = Math.abs(a[0] * a[4] + a[1] * a[5] + a[2] * a[6]);
  const xz = Math.abs(a[0] * a[8] + a[1] * a[9] + a[2] * a[10]);
  const yz = Math.abs(a[4] * a[8] + a[5] * a[9] + a[6] * a[10]);
  // A Gram-matrix row-sum bound remains conservative under inherited shear.
  return Math.sqrt(Math.max(xx + xy + xz, yy + xy + yz, zz + xz + yz));
}

export class InstanceCuller {
  constructor() {
    this.enabled = true;
    this.stats = { totalInstances: 0, visibleInstances: 0, culledInstances: 0, batches: 0 };
    this._states = new Map();
    this._applied = [];
    this._hidden = [];
    this._batchCounts = [];
    this._layoutScratch = [];
    this._projection = new THREE.Matrix4();
    this._instance = new THREE.Matrix4();
    this._world = new THREE.Matrix4();
    this._frustum = new THREE.Frustum();
    this._sphere = new THREE.Sphere();
    this._box = new THREE.Box3();
    this._origin = new THREE.Vector3();
    this._viewVersion = 0;
    this._viewSignature = null;
  }

  prepare(root, camera) {
    this.restore();
    Object.assign(this.stats, { totalInstances: 0, visibleInstances: 0, culledInstances: 0, batches: 0 });
    if (!this.enabled) return this.stats;
    root.updateWorldMatrix(true, false);
    camera.updateWorldMatrix(true, false);
    this._projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const view = [...this._projection.elements, camera.coordinateSystem, camera.reversedDepth];
    if (!equal(this._viewSignature, view)) {
      this._viewSignature = view;
      this._viewVersion++;
      this._frustum.setFromProjectionMatrix(this._projection, camera.coordinateSystem, camera.reversedDepth);
    }
    root.traverseVisible((mesh) => {
      mesh.updateWorldMatrix(false, false);
      if (mesh.userData.cullBounds) {
        if (mesh.userData.cullValid && !mesh.userData.cullValid()) return;
        this._box.copy(mesh.userData.cullBounds).applyMatrix4(mesh.matrixWorld)
          .expandByScalar(mesh.userData.cullPadding || 0);
        if (!this._frustum.intersectsBox(this._box) || !mesh.userData.batchVisible(camera)) {
          this._hidden.push(mesh); mesh.visible = false;
        }
        return;
      }
      if (!mesh.isInstancedMesh || mesh.count <= 0) return;
      const count = mesh.count;
      this.stats.totalInstances += count;
      this.stats.batches++;
      if (mesh.userData.batchVisible && !mesh.userData.batchVisible(camera)) {
        this._hidden.push(mesh); mesh.visible = false;
        return;
      }
      if (mesh.userData.batchCullOnly && mesh.boundingSphere) {
        this._batchCounts.push(mesh, count, mesh.frustumCulled);
        mesh.frustumCulled = false;
        this._sphere.center.copy(mesh.boundingSphere.center).applyMatrix4(mesh.matrixWorld);
        this._sphere.radius = (mesh.boundingSphere.radius + (mesh.userData.batchCullPadding || 0))
          * matrixRadiusScale(mesh.matrixWorld.elements) + (mesh.userData.worldBoundsPadding || 0);
        if (this._frustum.intersectsSphere(this._sphere)) this.stats.visibleInstances += count;
        else { this._hidden.push(mesh); mesh.visible = false; }
        return;
      }
      const fixed = mesh.userData;
      if (fixed.staticCullBox && fixed.staticCullValid?.() && mesh.matrixWorld.equals(IDENTITY)) {
        this._box.copy(fixed.staticCullBox).expandByScalar(fixed.worldBoundsPadding || 0);
        if (!this._frustum.intersectsBox(this._box)) {
          this._hidden.push(mesh); mesh.visible = false;
          return;
        }
        if (fixed.batchAllVisible(camera) && containsBox(this._frustum, this._box)) {
          this.stats.visibleInstances += count;
          return;
        }
      }
      // Morph texture rows and interleaved instance divisors require their own
      // remapping; leave those uncommon formats untouched rather than mis-pack.
      let interleaved = false;
      for (const name in mesh.geometry.attributes) {
        if (Object.hasOwn(mesh.geometry.attributes, name) && mesh.geometry.attributes[name].data?.isInstancedInterleavedBuffer) {
          interleaved = true; break;
        }
      }
      if (mesh.morphTexture || interleaved) {
        this.stats.visibleInstances += count;
        return;
      }
      const state = this._state(mesh);
      const geometry = mesh.geometry;
      let bounds = geometry.boundingSphere;
      if (!bounds) {
        geometry.computeBoundingSphere();
        bounds = geometry.boundingSphere;
        geometry.boundingSphere = null;
      }
      if (!bounds || !Number.isFinite(bounds.radius)) {
        this.stats.visibleInstances += count;
        return;
      }
      // Double-buffer signatures: comparing mutable inputs stays exact without
      // allocating several arrays per visible batch on every animation frame.
      const boundSignature = state.nextBoundSignature;
      boundSignature.length = 0;
      boundSignature.push(mesh.instanceMatrix, mesh.instanceMatrix.array, mesh.instanceMatrix.version, count,
        geometry, geometry.getAttribute('position'), geometry.getAttribute('position')?.version,
        bounds.center.x, bounds.center.y, bounds.center.z,
        bounds.radius, mesh.userData.worldBoundsPadding || 0, mesh.userData.cullerPadding || 0);
      for (const value of mesh.matrixWorld.elements) boundSignature.push(value);
      if (!equal(state.boundSignature, boundSignature)) {
        this._bounds(state, mesh, bounds);
        state.nextBoundSignature = state.boundSignature || [];
        state.boundSignature = boundSignature;
        state.boundsVersion++;
      }
      const band = grassBand(mesh);
      const sources = state.nextSourceSignature;
      sources.length = 0;
      sources.push(mesh.instanceMatrix, mesh.instanceMatrix.array, mesh.instanceMatrix.version,
        mesh.instanceColor, mesh.instanceColor?.array, mesh.instanceColor?.version, mesh.instanceColor?.meshPerAttribute);
      const signature = state.nextSelectionSignature;
      signature.length = 0;
      signature.push(this._viewVersion, state.boundsVersion);
      for (const source of sources) signature.push(source);
      signature.push(mesh.userData.instanceVisible, mesh.userData.instanceVisibilityVersion || 0, count);
      if (band) for (const value of band) signature.push(value);
      for (const name in geometry.attributes) {
        if (!Object.hasOwn(geometry.attributes, name)) continue;
        const attribute = geometry.attributes[name];
        signature.push(name, attribute, attribute.version, attribute.array, attribute.meshPerAttribute);
        if (attribute.isInstancedBufferAttribute) sources.push(attribute, attribute.version, attribute.array, attribute.meshPerAttribute);
      }
      if (!equal(state.selectionSignature, signature)) {
        this._select(state, mesh, band, camera, !equal(state.sourceSignature, sources));
        state.nextSourceSignature = state.sourceSignature || [];
        state.nextSelectionSignature = state.selectionSignature || [];
        state.sourceSignature = sources;
        state.selectionSignature = signature;
      }
      this.stats.visibleInstances += state.count;
      if (state.count === count) return;
      const saved = state.snapshot;
      saved.geometry = mesh.geometry; saved.matrix = mesh.instanceMatrix; saved.color = mesh.instanceColor;
      saved.count = mesh.count; saved.visible = mesh.visible; saved.frustumCulled = mesh.frustumCulled;
      state.saved = saved;
      this._applied.push(state);
      mesh.geometry = state.geometry;
      mesh.instanceMatrix = state.matrix;
      mesh.instanceColor = state.color;
      mesh.count = state.count;
      mesh.visible = state.count > 0;
      // The original batch bound omits shader sway and may contain moved-away
      // woodland replacements. The padded per-instance test is authoritative.
      mesh.frustumCulled = false;
    });
    this.stats.culledInstances = this.stats.totalInstances - this.stats.visibleInstances;
    return this.stats;
  }

  _state(mesh) {
    let state = this._states.get(mesh);
    const layout = this._layoutScratch;
    layout.length = 0;
    layout.push(mesh.geometry, mesh.instanceMatrix, mesh.instanceMatrix.array, mesh.instanceColor,
      mesh.geometry.index, mesh.geometry.drawRange.start, mesh.geometry.drawRange.count);
    for (const group of mesh.geometry.groups) layout.push(group.start, group.count, group.materialIndex);
    for (const name in mesh.geometry.attributes) {
      if (!Object.hasOwn(mesh.geometry.attributes, name)) continue;
      const a = mesh.geometry.attributes[name];
      layout.push(name, a, a.array?.length, a.meshPerAttribute);
    }
    if (state && !equal(state.layout, layout)) { this._release(state); state = null; }
    if (state) return state;
    const geometry = new THREE.BufferGeometry();
    geometry.name = `${mesh.geometry.name || 'vegetation'}-visible-instances`;
    const attributes = [];
    const capacity = mesh.instanceMatrix.count;
    const packed = (source) => {
      const attribute = new THREE.InstancedBufferAttribute(new source.array.constructor(capacity * source.itemSize),
        source.itemSize, source.normalized, 1);
      attribute.gpuType = source.gpuType;
      attribute.setUsage(THREE.DynamicDrawUsage);
      return attribute;
    };
    for (const [name, source] of Object.entries(mesh.geometry.attributes)) {
      if (source.isInstancedBufferAttribute) {
        const target = packed(source);
        geometry.setAttribute(name, target);
        attributes.push({ source, target });
      } else geometry.setAttribute(name, source);
    }
    geometry.setIndex(mesh.geometry.index);
    geometry.groups = mesh.geometry.groups.map((group) => ({ ...group }));
    geometry.drawRange = { ...mesh.geometry.drawRange };
    geometry.boundingSphere = mesh.geometry.boundingSphere;
    geometry.boundingBox = mesh.geometry.boundingBox;
    geometry.morphAttributes = mesh.geometry.morphAttributes;
    geometry.morphTargetsRelative = mesh.geometry.morphTargetsRelative;
    const matrix = packed(mesh.instanceMatrix);
    const color = mesh.instanceColor ? packed(mesh.instanceColor) : null;
    // Geometry disposal owns these otherwise object-only WebGL buffers too.
    geometry.setAttribute('_instanceCullMatrix', matrix);
    if (color) geometry.setAttribute('_instanceCullColor', color);
    state = { mesh, geometry, matrix, color, attributes, layout: layout.slice(), count: 0,
      bounds: new Float64Array(capacity * 4), batchBounds: new THREE.Box3(),
      indices: new Uint32Array(capacity), boundsVersion: 0, saved: null, snapshot: {},
      nextBoundSignature: [], nextSourceSignature: [], nextSelectionSignature: [] };
    state.onDispose = () => this._release(state);
    mesh.addEventListener('dispose', state.onDispose);
    this._states.set(mesh, state);
    return state;
  }

  _bounds(state, mesh, bounds) {
    const local = bounds.clone();
    // Grass shrinks toward its root in the vertex shader, so bound the whole
    // root-to-template convex hull in addition to the maximum local sway.
    local.expandByPoint(this._origin.set(0, 0, 0));
    local.radius += Math.max(0.25, mesh.userData.cullerPadding || 0);
    const center = new THREE.Vector3();
    const aggregate = state.batchBounds.makeEmpty();
    for (let index = 0; index < mesh.count; index++) {
      this._instance.fromArray(mesh.instanceMatrix.array, index * 16);
      this._world.multiplyMatrices(mesh.matrixWorld, this._instance);
      center.copy(local.center).applyMatrix4(this._world);
      const offset = index * 4;
      state.bounds[offset] = center.x; state.bounds[offset + 1] = center.y; state.bounds[offset + 2] = center.z;
      const radius = local.radius * matrixRadiusScale(this._world.elements) + (mesh.userData.worldBoundsPadding || 0);
      state.bounds[offset + 3] = radius;
      aggregate.min.x = Math.min(aggregate.min.x, center.x - radius);
      aggregate.min.y = Math.min(aggregate.min.y, center.y - radius);
      aggregate.min.z = Math.min(aggregate.min.z, center.z - radius);
      aggregate.max.x = Math.max(aggregate.max.x, center.x + radius);
      aggregate.max.y = Math.max(aggregate.max.y, center.y + radius);
      aggregate.max.z = Math.max(aggregate.max.z, center.z + radius);
    }
  }

  _select(state, mesh, band, camera, sourceChanged) {
    const previousCount = state.count;
    state.count = 0;
    if (!this._frustum.intersectsBox(state.batchBounds)) return;
    let count = 0;
    let changedStart = Infinity, changedEnd = 0;
    const shapes = mesh.geometry.getAttribute('iShape');
    for (let index = 0; index < mesh.count; index++) {
      const offset = index * 4;
      this._sphere.center.fromArray(state.bounds, offset);
      this._sphere.radius = state.bounds[offset + 3];
      if (!this._frustum.intersectsSphere(this._sphere)) continue;
      if (mesh.userData.instanceVisible && !mesh.userData.instanceVisible(index, camera)) continue;
      if (band && grassHidden(mesh.instanceMatrix.array, index, shapes, band)) continue;
      // Re-entering slots may contain stale data from before a source update.
      if (sourceChanged || count >= previousCount || state.indices[count] !== index) {
        copyInstance(mesh.instanceMatrix, state.matrix, index, count);
        if (state.color) copyInstance(mesh.instanceColor, state.color, index, count);
        for (const attribute of state.attributes) copyInstance(attribute.source, attribute.target, index, count);
        state.indices[count] = index;
        changedStart = Math.min(changedStart, count);
        changedEnd = count + 1;
      }
      count++;
    }
    state.count = count;
    if (changedEnd === 0) return;
    markChanged(state.matrix, changedStart, changedEnd);
    if (state.color) markChanged(state.color, changedStart, changedEnd);
    for (const attribute of state.attributes) markChanged(attribute.target, changedStart, changedEnd);
  }

  _restore(state) {
    if (!state.saved) return;
    const { mesh, saved } = state;
    mesh.geometry = saved.geometry;
    mesh.instanceMatrix = saved.matrix;
    mesh.instanceColor = saved.color;
    mesh.count = saved.count;
    mesh.visible = saved.visible;
    mesh.frustumCulled = saved.frustumCulled;
    state.saved = null;
  }

  restore() {
    for (let i = 0; i < this._batchCounts.length; i += 3) {
      this._batchCounts[i].count = this._batchCounts[i + 1];
      this._batchCounts[i].frustumCulled = this._batchCounts[i + 2];
    }
    this._batchCounts.length = 0;
    for (const mesh of this._hidden) mesh.visible = true;
    this._hidden.length = 0;
    for (const state of this._applied) this._restore(state);
    this._applied.length = 0;
  }

  _release(state) {
    this._restore(state);
    state.mesh.removeEventListener('dispose', state.onDispose);
    this._states.delete(state.mesh);
    const owned = new Set([state.matrix, state.color, ...state.attributes.map(({ target }) => target)]);
    for (const [name, attribute] of Object.entries(state.geometry.attributes)) {
      if (!owned.has(attribute)) state.geometry.deleteAttribute(name);
    }
    state.geometry.setIndex(null);
    state.geometry.morphAttributes = {};
    state.geometry.dispose();
  }

  dispose() {
    this.restore();
    for (const state of this._states.values()) this._release(state);
    this._layoutScratch.length = 0;
  }
}
