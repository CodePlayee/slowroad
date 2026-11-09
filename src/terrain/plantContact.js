import * as THREE from 'three';

function recordValues(record, target, offset) {
  const kind = record?.kind === 'tree' ? 1 : record?.kind === 'shrub' ? 2 : 0;
  const valid = kind && Number.isFinite(record.x) && Number.isFinite(record.z)
    && Number.isFinite(record.width) && record.width > 0;
  target[offset] = valid ? kind : 0;
  target[offset + 1] = valid ? record.x : 0;
  target[offset + 2] = valid ? record.z : 0;
  target[offset + 3] = valid ? record.width : 0;
}

/**
 * CPU contact field. Inputs must be nearby resident
 * tree/shrub records, not a flattened world population. A supplied revision
 * must change whenever the same input array is mutated; without it, relevant
 * fields are compared every call.
 *
 * update(): bounded input/snapshot passes and at most maxRecords active checks,
 * 2 * resolution^2 byte clears, and one resolution^2 copy for an empty result.
 * step(): at most texelsPerStep raster checks, plus resolution^2 bytes
 * copied on publication. Movement and additions retain the active world map;
 * only removal/change of an active root invalidates it. Include active-window
 * roots as well as target-window roots so window selection is not a deletion.
 */
export class PlantContactTexture {
  constructor({ radius = 256, resolution = 512, anchorStep = Math.min(16, Math.floor(resolution / 4)),
    maxRecords = 8192, texelsPerStep = 16384 } = {}) {
    if (!Number.isFinite(radius) || radius < 1 || radius > 4096
      || !Number.isInteger(resolution) || resolution < 8 || resolution > 1024 || resolution % 2
      || !Number.isInteger(anchorStep) || anchorStep < 1 || anchorStep > resolution / 4
      || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 65536
      || !Number.isInteger(texelsPerStep) || texelsPerStep < 1 || texelsPerStep > 262144) {
      throw new RangeError('Invalid plant contact field configuration');
    }
    this.radius = radius;
    this.resolution = resolution;
    this.span = radius * 2;
    this.texelSize = this.span / resolution;
    this.anchorStep = anchorStep;
    this.maxRecords = maxRecords;
    this.texelsPerStep = texelsPerStep;
    this.origin = new THREE.Vector2(-radius, -radius);
    this.data = new Uint8Array(resolution * resolution);
    this.texture = new THREE.DataTexture(this.data, resolution, resolution, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.name = 'plant-root-contact';
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.unpackAlignment = 1;
    this.texture.needsUpdate = true;
    this.version = 0;
    this.generation = 0;
    this.dirty = true;
    this.disposed = false;
    this._back = new Uint8Array(this.data.length);
    this._scratch = new Float64Array(4);
    this._snapshot = null;
    this._source = null;
    this._sourceRevision = undefined;
    this._targetOrigin = this.origin.clone();
    this._focusOrigin = this.origin.clone();
    this._activeSignatures = new Set();
    this._hasPublishedData = false;
    this._job = null;
    this.lastUpdate = { recordsVisited: 0, stampCandidates: 0, plantsQueued: 0, clearedTexels: 0, publishedTexels: 0 };
    this.lastStep = { texelsVisited: 0, stampsCompleted: 0, publishedTexels: 0 };
  }

  get pending() { return this._job !== null; }
  get activeCount() { return this._activeSignatures.size; }
  get targetOrigin() { return this._targetOrigin; }

  originForFocus(focus, out = new THREE.Vector2()) {
    if (!Number.isFinite(focus?.x) || !Number.isFinite(focus?.z)) throw new RangeError('Invalid plant contact focus');
    const snap = this.texelSize * this.anchorStep;
    const x = Math.floor(focus.x / snap) * snap - this.radius;
    const z = Math.floor(focus.z / snap) * snap - this.radius;
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new RangeError('Invalid plant contact focus');
    return out.set(x, z);
  }

  markClean() { this.dirty = false; }

  _touch() {
    this.version++;
    this.dirty = true;
    this.texture.needsUpdate = true;
  }

  update(records, focus, { revision } = {}) {
    if (this.disposed) return false;
    if (!Array.isArray(records)) throw new TypeError('Plant contact records must be a bounded array');
    if (records.length > this.maxRecords) throw new RangeError('Select nearby plant tiles before updating contact');
    this.originForFocus(focus, this._focusOrigin);
    const x = this._focusOrigin.x, z = this._focusOrigin.y;
    const moved = x !== this._targetOrigin.x || z !== this._targetOrigin.y;
    const work = this.lastUpdate = { recordsVisited: 0, stampCandidates: 0, plantsQueued: 0, clearedTexels: 0, publishedTexels: 0 };
    let same = this._snapshot?.length === records.length * 4;
    const knownRevision = revision !== undefined && records === this._source
      && Object.is(revision, this._sourceRevision);
    if (same && !knownRevision) for (let i = 0; i < records.length; i++) {
      recordValues(records[i], this._scratch, 0);
      work.recordsVisited++;
      const at = i * 4;
      if (this._scratch.some((value, channel) => value !== this._snapshot[at + channel])) {
        same = false; break;
      }
    }
    this._source = records;
    this._sourceRevision = revision;
    if (same && !moved) return false;

    if (!same) {
      const snapshot = new Float64Array(records.length * 4);
      for (let i = 0; i < records.length; i++) {
        recordValues(records[i], snapshot, i * 4);
        work.recordsVisited++;
      }
      this._snapshot = snapshot;
      const retained = new Set();
      for (let at = 0; at < snapshot.length; at += 4) if (snapshot[at]) {
        retained.add(`${snapshot[at]}:${snapshot[at + 1]}:${snapshot[at + 2]}:${snapshot[at + 3]}`);
      }
      for (const key of this._activeSignatures) if (!retained.has(key)) {
        this.data.fill(0);
        this._activeSignatures.clear();
        this._hasPublishedData = false;
        work.clearedTexels += this.data.length;
        this._touch();
        break;
      }
    }
    this.generation++;
    this._targetOrigin.set(x, z);
    this._back.fill(0);
    work.clearedTexels += this._back.length;
    const stamps = [], cell = this.texelSize, n = this.resolution;
    const centerX = x + this.radius, centerZ = z + this.radius;
    const nearSquared = (this.radius - cell) ** 2;
    for (let at = 0; at < this._snapshot.length; at += 4) {
      work.stampCandidates++;
      const kind = this._snapshot[at], px = this._snapshot[at + 1], pz = this._snapshot[at + 2];
      if (!kind || (px - centerX) ** 2 + (pz - centerZ) ** 2 > nearSquared) continue;
      const width = this._snapshot[at + 3];
      // A compact root core sits inside a broader, low-contrast ground contact.
      // Width follows the resident plant, never a camera or grass LOD boundary.
      const radius = kind === 1 ? Math.max(1.5, Math.min(5, width * 0.28))
        : Math.max(1, Math.min(2.5, width * 0.45));
      const x0 = Math.max(1, Math.ceil((px - radius - x) / cell - 0.5));
      const x1 = Math.min(n - 2, Math.floor((px + radius - x) / cell - 0.5));
      const z0 = Math.max(1, Math.ceil((pz - radius - z) / cell - 0.5));
      const z1 = Math.min(n - 2, Math.floor((pz + radius - z) / cell - 0.5));
      if (x0 <= x1 && z0 <= z1) stamps.push({ key: `${kind}:${px}:${pz}:${width}`,
        x: px, z: pz, inverseRadiusSquared: 1 / (radius * radius), strength: kind === 1 ? 0.55 : 0.30,
        x0, x1, z0, z1 });
    }
    work.plantsQueued = stamps.length;
    this._job = { stamps, index: 0, x: stamps[0]?.x0, z: stamps[0]?.z0, originX: x, originZ: z };
    if (!stamps.length) { this._publish(); work.publishedTexels = this.data.length; }
    return true;
  }

  _publish() {
    const job = this._job;
    this.data.set(this._back);
    this.origin.set(job.originX, job.originZ);
    this._activeSignatures = new Set(job.stamps.map(stamp => stamp.key));
    this._hasPublishedData = job.stamps.length > 0;
    this._job = null;
    this._touch();
  }

  step(maxTexels = this.texelsPerStep) {
    if (!Number.isInteger(maxTexels) || maxTexels < 1 || maxTexels > this.texelsPerStep) {
      throw new RangeError('Plant contact step exceeds its raster budget');
    }
    const work = this.lastStep = { texelsVisited: 0, stampsCompleted: 0, publishedTexels: 0 };
    const job = this._job;
    if (this.disposed || !job) return true;
    while (work.texelsVisited < maxTexels && job.index < job.stamps.length) {
      const stamp = job.stamps[job.index], ix = job.x, iz = job.z;
      const dx = job.originX + (ix + 0.5) * this.texelSize - stamp.x;
      const dz = job.originZ + (iz + 0.5) * this.texelSize - stamp.z;
      const distanceSquared = (dx * dx + dz * dz) * stamp.inverseRadiusSquared;
      if (distanceSquared < 1) {
        // Both lobes reach zero with zero slope: no flat dark disk or hard rim.
        // The inner half-radius lobe anchors the stem while the outer lobe
        // connects it to the surrounding turf without additive overlap stains.
        const skirt = 1 - distanceSquared;
        const core = Math.max(0, 1 - distanceSquared * 4);
        const value = Math.round(255 * stamp.strength * (0.65 * skirt * skirt + 0.35 * core * core));
        const at = iz * this.resolution + ix;
        this._back[at] = Math.max(this._back[at], value);
      }
      work.texelsVisited++;
      if (++job.x > stamp.x1) { job.x = stamp.x0; job.z++; }
      if (job.z > stamp.z1) {
        job.index++; work.stampsCompleted++;
        const next = job.stamps[job.index];
        if (next) { job.x = next.x0; job.z = next.z0; }
      }
    }
    if (job.index === job.stamps.length) { this._publish(); work.publishedTexels = this.data.length; }
    return !this.pending;
  }

  sampleWorld(x, z) {
    if (this.disposed || !Number.isFinite(x) || !Number.isFinite(z)
      || x < this.origin.x || z < this.origin.y
      || x >= this.origin.x + this.span || z >= this.origin.y + this.span) return 0;
    const u = (x - this.origin.x) / this.texelSize - 0.5, v = (z - this.origin.y) / this.texelSize - 0.5;
    const i = Math.floor(u), j = Math.floor(v), tx = u - i, tz = v - j, n = this.resolution;
    const at = (ix, iz) => ix < 0 || iz < 0 || ix >= n || iz >= n ? 0 : this.data[iz * n + ix] / 255;
    return (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - tz)
      + (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * tz;
  }

  /** Retire streamed-out roots only outside the new effective window. Pixels
   * stay world-anchored until publication; true deletions must not use this. */
  retireOutsideWindow(records, focus) {
    if (this.disposed) return false;
    this.originForFocus(focus, this._focusOrigin);
    const x = this._focusOrigin.x + this.radius, z = this._focusOrigin.y + this.radius;
    const nearSquared = (this.radius - this.texelSize) ** 2;
    let stillEffective = false;
    for (const record of records) {
      recordValues(record, this._scratch, 0);
      const [kind, px, pz, width] = this._scratch;
      if (!kind) continue;
      const key = `${kind}:${px}:${pz}:${width}`;
      if (!this._activeSignatures.has(key)) continue;
      if ((px - x) ** 2 + (pz - z) ** 2 > nearSquared) this._activeSignatures.delete(key);
      else stillEffective = true;
    }
    return stillEffective;
  }

  reset() {
    if (this.disposed || (!this._snapshot && !this._job && !this.activeCount && !this._hasPublishedData)) return false;
    this._job = this._snapshot = this._source = null;
    this._sourceRevision = undefined;
    this._activeSignatures.clear();
    this._hasPublishedData = false;
    this._targetOrigin.copy(this.origin);
    this.data.fill(0);
    this._back.fill(0);
    this.generation++;
    this._touch();
    return true;
  }

  cancelPending() {
    if (!this._job) return false;
    this._job = this._snapshot = this._source = null;
    this._sourceRevision = undefined;
    this._targetOrigin.copy(this.origin);
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._job = null;
    this._activeSignatures.clear();
    this._hasPublishedData = false;
    this._source = this._snapshot = this._back = this._scratch = null;
    this._sourceRevision = undefined;
    this.data = null;
    this.texture.image.data = null;
    this.texture.dispose();
    this.dirty = false;
  }
}
