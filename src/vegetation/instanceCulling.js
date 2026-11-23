import * as THREE from 'three';

const equal = (a, b) => {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const IDENTITY = new THREE.Matrix4();
// Culling pass tokens are unique across cullers: batches and groups memoize
// their per-pass validity/visibility answers against them.
let passes = 0;

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
  // sqrt rather than Math.hypot (several times slower in V8); the one-ulp
  // difference is far inside the 1e-4 coverage margin below.
  const dx = matrix[index * 16 + 12] - band[0], dz = matrix[index * 16 + 14] - band[1];
  const distance = Math.sqrt(dx * dx + dz * dz);
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
    this._planes = new Float64Array(24);
    this._mergeCandidates = [];
    this._mergeUsed = [];
    this._mergedShown = [];
    this._buckets = new Map();
  }

  prepare(root, camera) {
    this.restore();
    Object.assign(this.stats, { totalInstances: 0, visibleInstances: 0, culledInstances: 0, batches: 0 });
    if (!this.enabled) return this.stats;
    const pass = ++passes;
    root.updateWorldMatrix(true, false);
    camera.updateWorldMatrix(true, false);
    this._projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const view = [...this._projection.elements, camera.coordinateSystem, camera.reversedDepth];
    if (!equal(this._viewSignature, view)) {
      this._viewSignature = view;
      this._viewVersion++;
      this._frustum.setFromProjectionMatrix(this._projection, camera.coordinateSystem, camera.reversedDepth);
      this._frustum.planes.forEach(({ normal: n, constant }, i) => this._planes.set([n.x, n.y, n.z, constant], i * 4));
    }
    root.traverseVisible((mesh) => {
      mesh.updateWorldMatrix(false, false);
      if (mesh.userData.cullBounds) {
        this._box.copy(mesh.userData.cullBounds).applyMatrix4(mesh.matrixWorld)
          .expandByScalar(mesh.userData.cullPadding || 0);
        // Validity only guards hiding: a group that stays visible is descended
        // either way, so stale bounds can never hide a mutated member.
        if ((!this._frustum.intersectsBox(this._box) || !mesh.userData.batchVisible(camera, pass)) &&
            (!mesh.userData.cullValid || mesh.userData.cullValid(pass))) {
          this._hidden.push(mesh); mesh.visible = false;
        }
        return;
      }
      if (!mesh.isInstancedMesh || mesh.count <= 0) return;
      const count = mesh.count;
      this.stats.totalInstances += count;
      this.stats.batches++;
      if (mesh.userData.instanceMerge) this._mergeCandidates.push(mesh);
      if (mesh.userData.batchVisible && !mesh.userData.batchVisible(camera, pass)) {
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
      if (fixed.staticCullBox && fixed.staticCullValid?.(pass) && mesh.matrixWorld.equals(IDENTITY)) {
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
    this._merge(root);
    this.stats.culledInstances = this.stats.totalInstances - this.stats.visibleInstances;
    return this.stats;
  }

  // Opted-in batches that share a material (forest impostors: one small batch
  // per tile and species) are drawn as one instanced draw per material. Their
  // already selected rows are concatenated into a culler-owned buffer; only
  // members whose rows changed are recopied and uploaded. Members must have an
  // identity world transform, so every row means the same thing in the merged
  // draw, and nothing may depend on draw order or instance id within a material.
  _merge(root) {
    const candidates = this._mergeCandidates;
    if (!candidates.length) return;
    const used = this._mergeUsed;
    if (root.matrixWorld.equals(IDENTITY)) {
      for (const mesh of candidates) {
        const material = mesh.material;
        if (!mesh.visible || mesh.count <= 0 || Array.isArray(material) || mesh.instanceColor || mesh.morphTexture ||
            mesh.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender || !mesh.matrixWorld.equals(IDENTITY)) continue;
        let bucket = this._buckets.get(material);
        if (!bucket) {
          bucket = { material, layout: null, names: null, members: [], segments: [], capacity: 0, mesh: null, geometry: null, idle: 0 };
          this._buckets.set(material, bucket);
        }
        // The first member of a pass may re-key a bucket whose card geometry
        // was replaced (e.g. reloaded assets); later mismatches stay separate.
        if (!bucket.layout || (!bucket.members.length && !this._compatible(bucket, mesh))) {
          this._releaseBucket(bucket);
          bucket.layout = null;
          this._bucketLayout(bucket, mesh);
        }
        if (!this._compatible(bucket, mesh)) continue;
        if (!bucket.members.length) used.push(bucket);
        bucket.members.push(mesh);
      }
    }
    candidates.length = 0;
    for (const bucket of used) {
      // A lone batch gains nothing from a copy.
      if (bucket.members.length > 1) this._drawBucket(root, bucket);
      bucket.members.length = 0;
    }
    used.length = 0;
    for (const [material, bucket] of this._buckets) {
      if (bucket.idle++ > 600) { this._releaseBucket(bucket); this._buckets.delete(material); }
    }
  }

  _bucketLayout(bucket, mesh) {
    const geometry = mesh.geometry, layout = [geometry.index, geometry.drawRange.start, geometry.drawRange.count,
      geometry.groups.length, mesh.renderOrder, mesh.layers.mask], names = [];
    for (const name in geometry.attributes) {
      if (!Object.hasOwn(geometry.attributes, name) || name.startsWith('_instanceCull')) continue;
      const attribute = geometry.attributes[name];
      if (attribute.isInstancedBufferAttribute) names.push(name);
      else layout.push(name, attribute);
    }
    if (names.some(name => geometry.attributes[name].meshPerAttribute !== 1)) return;
    bucket.layout = layout; bucket.names = names.sort();
  }

  _compatible(bucket, mesh) {
    if (!bucket.layout) return false;
    const geometry = mesh.geometry, layout = bucket.layout;
    if (layout[0] !== geometry.index || layout[1] !== geometry.drawRange.start || layout[2] !== geometry.drawRange.count ||
        layout[3] !== geometry.groups.length || layout[4] !== mesh.renderOrder || layout[5] !== mesh.layers.mask) return false;
    let instanced = 0;
    for (const name in geometry.attributes) {
      if (!Object.hasOwn(geometry.attributes, name) || name.startsWith('_instanceCull')) continue;
      const attribute = geometry.attributes[name];
      if (attribute.isInstancedBufferAttribute) {
        if (!bucket.names.includes(name) || attribute.meshPerAttribute !== 1) return false;
        instanced++;
      }
    }
    if (instanced !== bucket.names.length) return false;
    for (let i = 6; i < layout.length; i += 2) if (geometry.attributes[layout[i]] !== layout[i + 1]) return false;
    const reference = bucket.mesh?.geometry ?? null;
    if (reference) for (const name of bucket.names) {
      const a = geometry.attributes[name], b = reference.attributes[name];
      if (a.itemSize !== b.itemSize || a.normalized !== b.normalized || a.array.constructor !== b.array.constructor) return false;
    }
    return true;
  }

  _drawBucket(root, bucket) {
    const members = bucket.members;
    // Fully visible batches draw their canonical, immutable rows; boundary
    // batches draw compacted rows whose counts change as the camera moves.
    // Stable canonical-first order keeps the long immutable prefix in place, so
    // a moving camera only rewrites the boundary tail of the merged buffer.
    const compacted = (mesh) => (this._states.get(mesh)?.saved ? 1 : 0);
    members.sort((a, b) => compacted(a) - compacted(b) || a.id - b.id);
    let total = 0;
    for (const mesh of members) total += mesh.count;
    if (total > bucket.capacity) this._allocateBucket(bucket, Math.max(total, Math.ceil(bucket.capacity * 1.5), 256), members[0]);
    const merged = bucket.mesh, segments = bucket.segments, names = bucket.names;
    // Segments are reusable up to the first member or count that differs.
    let first = 0;
    while (first < members.length && first < segments.length &&
      segments[first].mesh === members[first] && segments[first].count === members[first].count) first++;
    if (first < members.length || segments.length !== members.length) {
      segments.length = members.length;
      let offset = first > 0 ? segments[first - 1].offset + segments[first - 1].count : 0;
      for (let i = first; i < members.length; i++) {
        const segment = segments[i] ||= { mesh: null, count: 0, offset: 0, sources: [] };
        segment.mesh = members[i]; segment.count = members[i].count; segment.offset = offset; segment.sources.length = 0;
        offset += segment.count;
      }
    }
    let dirtyStart = Infinity, dirtyEnd = 0;
    for (const segment of segments) {
      const mesh = segment.mesh, sources = segment.sources;
      let same = sources.length === 2 + names.length * 2 && sources[0] === mesh.instanceMatrix && sources[1] === mesh.instanceMatrix.version;
      for (let k = 0; same && k < names.length; k++) {
        const attribute = mesh.geometry.attributes[names[k]];
        same = sources[2 + k * 2] === attribute && sources[3 + k * 2] === attribute.version;
      }
      if (same) continue;
      sources.length = 0;
      sources.push(mesh.instanceMatrix, mesh.instanceMatrix.version);
      merged.instanceMatrix.array.set(mesh.instanceMatrix.array.subarray(0, segment.count * 16), segment.offset * 16);
      for (const name of names) {
        const attribute = mesh.geometry.attributes[name], target = merged.geometry.attributes[name];
        sources.push(attribute, attribute.version);
        target.array.set(attribute.array.subarray(0, segment.count * attribute.itemSize), segment.offset * attribute.itemSize);
      }
      dirtyStart = Math.min(dirtyStart, segment.offset);
      dirtyEnd = Math.max(dirtyEnd, segment.offset + segment.count);
    }
    if (dirtyEnd > 0) {
      for (const attribute of [merged.instanceMatrix, ...names.map(name => merged.geometry.attributes[name])]) {
        attribute.addUpdateRange(dirtyStart * attribute.itemSize, (dirtyEnd - dirtyStart) * attribute.itemSize);
        attribute.needsUpdate = true;
      }
    }
    merged.count = total;
    for (const mesh of members) { this._hidden.push(mesh); mesh.visible = false; }
    bucket.idle = 0;
    root.add(merged);
    this._mergedShown.push(merged);
  }

  _allocateBucket(bucket, capacity, sample) {
    this._releaseBucket(bucket);
    const geometry = new THREE.BufferGeometry();
    geometry.name = `${bucket.material.name || 'vegetation'}-merged-instances`;
    for (let i = 6; i < bucket.layout.length; i += 2) geometry.setAttribute(bucket.layout[i], bucket.layout[i + 1]);
    geometry.setIndex(bucket.layout[0]);
    geometry.setDrawRange(bucket.layout[1], bucket.layout[2]);
    for (const name of bucket.names) {
      const source = sample.geometry.attributes[name];
      const attribute = new THREE.InstancedBufferAttribute(new source.array.constructor(capacity * source.itemSize),
        source.itemSize, source.normalized, 1);
      attribute.gpuType = source.gpuType;
      attribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attribute);
    }
    const mesh = new THREE.InstancedMesh(geometry, bucket.material, capacity);
    mesh.name = geometry.name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.castShadow = sample.castShadow; mesh.receiveShadow = sample.receiveShadow;
    mesh.renderOrder = sample.renderOrder; mesh.layers.mask = sample.layers.mask;
    // Members are already culled; keep three from scanning every row for a bound.
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    mesh.userData.mergedInstances = true;
    bucket.mesh = mesh; bucket.geometry = geometry; bucket.capacity = capacity; bucket.segments.length = 0;
  }

  _releaseBucket(bucket) {
    if (!bucket.mesh) return;
    bucket.mesh.removeFromParent();
    for (const name of Object.keys(bucket.geometry.attributes)) {
      if (!bucket.names.includes(name)) bucket.geometry.deleteAttribute(name);
    }
    bucket.geometry.setIndex(null);
    bucket.geometry.dispose();
    bucket.mesh.dispose();
    bucket.mesh = null; bucket.geometry = null; bucket.capacity = 0; bucket.segments.length = 0;
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
    // Inlined Frustum.intersectsSphere with identical arithmetic order; this is
    // the per-instance hot loop whenever the camera moves.
    const p = this._planes, bounds = state.bounds;
    for (let index = 0; index < mesh.count; index++) {
      const offset = index * 4;
      const x = bounds[offset], y = bounds[offset + 1], z = bounds[offset + 2], r = -bounds[offset + 3];
      if (p[0] * x + p[1] * y + p[2] * z + p[3] < r || p[4] * x + p[5] * y + p[6] * z + p[7] < r ||
          p[8] * x + p[9] * y + p[10] * z + p[11] < r || p[12] * x + p[13] * y + p[14] * z + p[15] < r ||
          p[16] * x + p[17] * y + p[18] * z + p[19] < r || p[20] * x + p[21] * y + p[22] * z + p[23] < r) continue;
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
    for (const mesh of this._mergedShown) mesh.removeFromParent();
    this._mergedShown.length = 0;
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
    for (const bucket of this._buckets.values()) this._releaseBucket(bucket);
    this._buckets.clear();
    this._layoutScratch.length = 0;
  }
}
