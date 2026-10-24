export function validateTreeLodBand(band) {
  if (!Number.isFinite(band?.low) || !Number.isFinite(band?.high) || band.low <= 0 || band.high <= band.low) {
    throw new RangeError('Tree LOD requires finite 0 < low < high pixel thresholds');
  }
  return { low: band.low, high: band.high };
}

export function parseTreeLodBands(value = '160:260') {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Tree LOD bands must be low:high pairs');
  const bands = value.split(',').map(pair => {
    const values = pair.trim().split(':');
    if (values.length !== 2 || values.some(part => !part.trim())) throw new RangeError('Tree LOD bands must be low:high pairs');
    return validateTreeLodBand({ low: Number(values[0]), high: Number(values[1]) });
  });
  if (bands.length > 2) throw new RangeError('At most two diagnostic tree LOD candidates are supported');
  if (new Set(bands.map(band => `${band.low}:${band.high}`)).size !== bands.length) throw new RangeError('Tree LOD candidates must be distinct');
  return bands;
}

/** Diagnostic-only override. It never changes population records or material programs. */
export function createTreeLodTrial({ treeRange, forest, renderer, terrain }) {
  const liveMaterials = [...forest.materials.values()].flatMap(group => Object.values(group))
    .filter(material => material.userData?.foliageTemplate?.kind === 'tree');
  const liveRange = liveMaterials[0]?.userData.foliageLodRange;
  if (!liveRange) throw new Error('Live tree materials lack foliageLodRange; reload the diagnostic page');
  if (treeRange !== undefined && treeRange !== liveRange) throw new Error('Supplied treeRange is not the live CPU range object');
  treeRange = liveRange;
  validateTreeLodBand(treeRange);
  if (![treeRange.fadeStart, treeRange.fadeEnd, forest?.pixelScale, terrain?.farRidgeAmp,
    terrain?.farRidgeNear, terrain?.farRidgeFar].every(Number.isFinite) || terrain.farRidgeFar <= terrain.farRidgeNear) {
    throw new TypeError('Incomplete tree LOD diagnostic inputs');
  }
  if (Object.isFrozen(treeRange)) throw new TypeError('The inner tree LOD range must be mutable');
  const original = Object.freeze({ low: treeRange.low, high: treeRange.high, fadeStart: treeRange.fadeStart, fadeEnd: treeRange.fadeEnd });
  const uniforms = new Map(), materials = new Map();
  let initialDiscovery = true;
  const extract = material => {
    if (material.userData.foliageLodRange !== treeRange) throw new Error('Tree materials do not share the live CPU range object');
    const shader = { uniforms: {}, vertexShader: '', fragmentShader: '' };
    material.onBeforeCompile(shader, renderer);
    const uniform = material.userData.foliageLodUniform;
    if (!uniform || shader.uniforms.uFoliageLod !== uniform) throw new Error('Live tree GPU uniform does not match its compile hook');
    if (!uniform?.value || !['x', 'y', 'z', 'w'].every(key => Number.isFinite(uniform.value[key]))) {
      throw new Error('Tree material did not expose its foliage LOD uniform');
    }
    return uniform;
  };
  const discover = () => {
    for (const group of forest.materials.values()) for (const material of Object.values(group)) {
      if (material.userData?.foliageTemplate?.kind !== 'tree' || materials.has(material)) continue;
      const uniform = extract(material);
      if (extract(material) !== uniform) throw new Error('Tree LOD uniform is not a stable compile-hook reference');
      if (!uniforms.has(uniform)) uniforms.set(uniform, initialDiscovery
        ? ['x', 'y', 'z', 'w'].map(key => uniform.value[key])
        : [original.low, original.high, original.fadeStart, original.fadeEnd]);
      materials.set(material, uniform);
    }
    if (!materials.size) throw new Error('No live tree materials available for a LOD trial');
  };
  const invalidate = () => {
    let count = 0;
    for (const mesh of forest.meshes) {
      if (mesh.userData?.foliageKind !== 'tree') continue;
      const distance = mesh.userData.foliageLevel === 'far' ? treeRange.fadeEnd
        : Math.min(treeRange.fadeEnd, mesh.userData.foliageMaximumHeight * forest.pixelScale / treeRange.low);
      const t = Math.max(0, Math.min(1, (distance - terrain.farRidgeNear) / (terrain.farRidgeFar - terrain.farRidgeNear)));
      mesh.userData.worldBoundsPadding = terrain.farRidgeAmp * (t * t * (3 - 2 * t));
      mesh.userData.instanceVisibilityVersion = (mesh.userData.instanceVisibilityVersion || 0) + 1;
      count++;
    }
    return count;
  };
  const describe = () => ({ bindingSource: 'material.userData', range: { low: treeRange.low, high: treeRange.high, fadeStart: treeRange.fadeStart, fadeEnd: treeRange.fadeEnd },
    treeMaterials: materials.size, uniforms: [...uniforms.keys()].map(uniform => ['x', 'y', 'z', 'w'].map(key => uniform.value[key])) });
  const probe = (bands = [original, treeRange]) => {
    const pixels = [...new Set(bands.flatMap(band => {
      validateTreeLodBand(band);
      return [Math.max(band.low / 2, band.low - 1), band.low + 1, band.high - 1, band.high + 1];
    }))].sort((a, b) => a - b);
    const meshes = [...forest.meshes], near = meshes.find(mesh => mesh.userData?.foliageKind === 'tree'
      && mesh.material?.userData?.foliagePart === 'bark' && mesh.userData.population?.length && typeof mesh.userData.instanceVisible === 'function');
    const far = near && meshes.find(mesh => mesh.userData?.foliageKind === 'tree' && mesh.userData.foliageLevel === 'far'
      && mesh.userData.population === near.userData.population && typeof mesh.userData.instanceVisible === 'function');
    if (!near || !far) return { ok: false, error: 'No paired live tree near/far predicates', cases: [] };
    const record = near.userData.population[0], template = near.material.userData.foliageTemplate;
    const height = record.height * (template.heightScale ?? 1), cases = [];
    for (const projectedPixels of pixels) {
      const distance = height * forest.pixelScale / projectedPixels;
      if (!(distance >= 0.5 && distance < treeRange.fadeEnd)) return { ok: false, error: 'Probe record exceeds the supported LOD distance', cases };
      // Same x/z makes the visual ridge lift exactly zero without importing a second runtime module.
      const camera = { position: { x: record.x, y: record.y + height * 0.5 + distance, z: record.z } };
      const expectedNear = projectedPixels >= treeRange.low - 0.01, expectedFar = projectedPixels <= treeRange.high + 0.01;
      const actualNear = near.userData.instanceVisible(0, camera), actualFar = far.userData.instanceVisible(0, camera);
      cases.push({ pixels: projectedPixels, expectedNear, expectedFar, actualNear, actualFar,
        ok: actualNear === expectedNear && actualFar === expectedFar });
    }
    return { ok: cases.every(row => row.ok), recordId: record.id, template: template.name, height,
      nearAccepted: cases.filter(row => row.actualNear).length, farAccepted: cases.filter(row => row.actualFar).length, cases };
  };
  const restore = () => {
    Object.assign(treeRange, original);
    let discoveryError;
    try { discover(); } catch (error) { discoveryError = error; }
    for (const [uniform, values] of uniforms) ['x', 'y', 'z', 'w'].forEach((key, i) => { uniform.value[key] = values[i]; });
    const meshes = invalidate();
    if (discoveryError) throw discoveryError;
    return { ...describe(), meshes };
  };
  discover();
  initialDiscovery = false;
  return {
    original,
    apply(band) {
      const { low, high } = validateTreeLodBand(band);
      discover();
      try {
        treeRange.low = low; treeRange.high = high;
        for (const uniform of uniforms.keys()) { uniform.value.x = low; uniform.value.y = high; }
        return { ...describe(), meshes: invalidate() };
      } catch (error) { restore(); throw error; }
    },
    restore, describe, probe, isLiveRange: candidate => candidate === treeRange,
  };
}

export function captureTreeSelection(app) {
  const byPart = Object.fromEntries(['bark', 'leaf', 'impostor'].map(part => [part, { batches: 0, instances: 0, triangles: 0 }]));
  if (!app.instanceCulling?.prepare) return { ok: false, error: 'No live instance culler', byPart };
  try {
    app.instanceCulling.prepare(app.veg.group, app.cameras.camera);
    app.veg.group.traverseVisible(mesh => {
      if (!mesh.isInstancedMesh || mesh.userData?.foliageKind !== 'tree' || !mesh.layers.test(app.cameras.camera.layers)) return;
      const part = mesh.material?.userData?.foliagePart, totals = byPart[part];
      if (!totals || mesh.material.visible === false || mesh.count <= 0) return;
      const geometry = mesh.geometry, available = geometry.index?.count ?? geometry.getAttribute('position').count;
      const start = Math.max(0, geometry.drawRange.start), end = Math.min(available, start + geometry.drawRange.count);
      totals.batches++; totals.instances += mesh.count; totals.triangles += Math.max(0, end - start) / 3 * mesh.count;
    });
    return { ok: true, byPart, treeTriangles: Object.values(byPart).reduce((sum, part) => sum + part.triangles, 0),
      sceneRender: { ...app.renderer.info.render }, culling: { ...app.instanceCulling.stats } };
  } finally { app.instanceCulling.restore(); }
}

export function compareTreeSelections(before, after) {
  const byPart = Object.fromEntries(['bark', 'leaf', 'impostor'].map(part => [part,
    Object.fromEntries(['batches', 'instances', 'triangles'].map(key => [key, (after?.byPart?.[part]?.[key] ?? 0) - (before?.byPart?.[part]?.[key] ?? 0)]))]));
  return { changed: Object.values(byPart).some(part => part.instances !== 0 || part.triangles !== 0), byPart,
    treeTriangles: (after?.treeTriangles ?? 0) - (before?.treeTriangles ?? 0) };
}

export function treeSubmissionTotals(profile) {
  const byPart = Object.fromEntries(['bark', 'leaf', 'impostor'].map(part => [part, { calls: 0, triangles: 0 }]));
  for (const [name, triangles] of Object.entries(profile.submissions || {})) {
    const match = /^field-tree-.+-(bark|leaf|impostor)$/.exec(name);
    if (!match) continue;
    byPart[match[1]].triangles += triangles;
    byPart[match[1]].calls += profile.submissionCalls?.[name] || 0;
  }
  return { byPart, triangles: Object.values(byPart).reduce((sum, part) => sum + part.triangles, 0),
    calls: Object.values(byPart).reduce((sum, part) => sum + part.calls, 0) };
}

export function populationFingerprint(tiles) {
  const fields = ['x', 'y', 'z', 'height', 'width', 'yaw', 'rank', 'phase', 'variant', 'cover', 'clump',
    'groundDx', 'groundDz', 'surfaceY', 'surfaceDx', 'surfaceDz'];
  const initial = 2166136261, mix = (hash, value) => Math.imul(hash ^ value, 16777619);
  const hex = value => (value >>> 0).toString(16).padStart(8, '0');
  const stats = () => Object.fromEntries(fields.map(field => [field, {}]));
  const countType = (result, field, type, value) => {
    const fieldStats = result[field]; fieldStats[type] = (fieldStats[type] || 0) + 1;
    if (type === 'finite') {
      fieldStats.min = Math.min(fieldStats.min ?? value, value); fieldStats.max = Math.max(fieldStats.max ?? value, value);
      if (Object.is(value, -0)) fieldStats.negativeZero = (fieldStats.negativeZero || 0) + 1;
    }
  };
  let hash = initial, legacyHash = initial, records = 0, tile;
  const counts = {}, numeric = stats(), details = [], nanPatterns = new Map(), bytes = new DataView(new ArrayBuffer(8));
  const canonical = (value, field) => {
    hash = mix(hash, value); tile.hash = mix(tile.hash, value);
    if (field !== undefined) tile.fieldHashes[field] = mix(tile.fieldHashes[field], value);
  };
  const text = (value, tag) => {
    canonical(tag); canonical(value.length);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      canonical(code); legacyHash = mix(legacyHash, code); tile.legacyHash = mix(tile.legacyHash, code);
    }
  };
  const number = (record, field, index) => {
    const value = record[field], own = Object.hasOwn(record, field);
    bytes.setFloat64(0, value, true);
    for (let i = 0; i < 8; i++) {
      const byte = bytes.getUint8(i);
      legacyHash = mix(legacyHash, byte); tile.legacyHash = mix(tile.legacyHash, byte);
    }
    let type, tag;
    if (!own && value === undefined) { type = 'missing'; tag = 1; }
    else if (value === undefined) { type = 'undefined'; tag = 2; }
    else if (Number.isNaN(value)) { type = 'nan'; tag = 3; }
    else if (value === Infinity) { type = 'positiveInfinity'; tag = 4; }
    else if (value === -Infinity) { type = 'negativeInfinity'; tag = 5; }
    else if (value === null) { type = 'null'; tag = 6; }
    else if (Number.isFinite(value)) { type = 'finite'; tag = 7; }
    else { type = typeof value; tag = 8; }
    canonical(index); canonical(own ? 1 : 0, field); canonical(tag, field);
    if (type === 'finite') {
      for (let i = 0; i < 8; i++) canonical(bytes.getUint8(i), field);
    } else if (tag === 8) {
      const encoded = `${typeof value}:${String(value)}`;
      canonical(encoded.length, field);
      for (let i = 0; i < encoded.length; i++) canonical(encoded.charCodeAt(i), field);
    }
    countType(numeric, field, type, value); countType(tile.numeric, field, type, value);
    if (value === undefined || Number.isNaN(value)) {
      const high = bytes.getUint32(4, true), low = bytes.getUint32(0, true);
      if (!nanPatterns.has(high)) nanPatterns.set(high, new Map());
      const variants = nanPatterns.get(high);
      variants.set(low, (variants.get(low) || 0) + 1);
    }
  };
  for (const [key, entry] of [...tiles].sort(([a], [b]) => a.localeCompare(b))) {
    tile = { key, kind: entry.job.kind, records: entry.records.length, hash: initial, legacyHash: initial,
      idsHash: initial, speciesHash: initial, numeric: stats(), fieldHashes: Object.fromEntries(fields.map(field => [field, initial])),
      firstId: entry.records[0]?.id ?? null, lastId: entry.records.at(-1)?.id ?? null };
    text(key, 240); canonical(entry.records.length);
    // Job kind is diagnostic identity, but it was not part of the legacy byte hash.
    canonical(241);
    for (const code of entry.job.kind) canonical(code.charCodeAt(0));
    counts[entry.job.kind] = (counts[entry.job.kind] || 0) + entry.records.length;
    for (const record of entry.records) {
      text(record.id, 242); text(record.species || '', 243);
      tile.idsHash = mix(tile.idsHash, record.id.length);
      for (let i = 0; i < record.id.length; i++) tile.idsHash = mix(tile.idsHash, record.id.charCodeAt(i));
      const species = record.species || '';
      tile.speciesHash = mix(tile.speciesHash, species.length);
      for (let i = 0; i < species.length; i++) tile.speciesHash = mix(tile.speciesHash, species.charCodeAt(i));
      fields.forEach((field, index) => number(record, field, index));
      records++;
    }
    details.push({ ...tile, hash: hex(tile.hash), legacyHash: hex(tile.legacyHash), idsHash: hex(tile.idsHash), speciesHash: hex(tile.speciesHash),
      fieldHashes: Object.fromEntries(fields.map(field => [field, hex(tile.fieldHashes[field])])) });
  }
  const legacyNaNBits = {};
  for (const [high, variants] of [...nanPatterns].sort(([a], [b]) => a - b)) {
    for (const [low, count] of [...variants].sort(([a], [b]) => a - b)) legacyNaNBits[hex(high) + hex(low)] = count;
  }
  return { algorithm: 'typed-fnv1a-v2', hash: hex(hash), legacyHash: hex(legacyHash), records, counts, numeric, legacyNaNBits, tiles: details };
}

export function comparePopulationFingerprints(before, after) {
  const previous = new Map(before.tiles.map(tile => [tile.key, tile])), current = new Map(after.tiles.map(tile => [tile.key, tile]));
  const addedTiles = [...current.keys()].filter(key => !previous.has(key));
  const removedTiles = [...previous.keys()].filter(key => !current.has(key));
  const changedTiles = [], legacyChangedTiles = [];
  for (const [key, tile] of current) {
    const old = previous.get(key);
    if (!old) continue;
    if (old.legacyHash !== tile.legacyHash) legacyChangedTiles.push(key);
    if (old.hash === tile.hash && old.records === tile.records && old.kind === tile.kind) continue;
    const changedFields = Object.keys(tile.fieldHashes).filter(field => old.fieldHashes[field] !== tile.fieldHashes[field]);
    changedTiles.push({ key, beforeCount: old.records, afterCount: tile.records, beforeHash: old.hash, afterHash: tile.hash,
      idsChanged: old.idsHash !== tile.idsHash, speciesChanged: old.speciesHash !== tile.speciesHash, changedFields,
      numeric: Object.fromEntries(changedFields.map(field => [field, { before: old.numeric[field], after: tile.numeric[field] }])),
      beforeFirstId: old.firstId, afterFirstId: tile.firstId, beforeLastId: old.lastId, afterLastId: tile.lastId });
  }
  const countsEqual = before.records === after.records && JSON.stringify(before.counts) === JSON.stringify(after.counts);
  const equal = before.algorithm === after.algorithm && before.hash === after.hash && countsEqual
    && !addedTiles.length && !removedTiles.length && !changedTiles.length;
  const legacyEqual = before.legacyHash === after.legacyHash;
  const nanBitsEqual = JSON.stringify(before.legacyNaNBits) === JSON.stringify(after.legacyNaNBits);
  const classification = addedTiles.length || removedTiles.length ? 'tile-set-difference'
    : !countsEqual ? 'record-count-difference' : !equal ? 'canonical-record-difference'
      : !legacyEqual ? (nanBitsEqual ? 'legacy-byte-representation-only' : 'legacy-nan-representation-only') : 'equal';
  return { equal, legacyEqual, classification, beforeHash: before.hash, afterHash: after.hash,
    beforeLegacyHash: before.legacyHash, afterLegacyHash: after.legacyHash,
    beforeRecords: before.records, afterRecords: after.records, beforeCounts: before.counts, afterCounts: after.counts,
    addedTiles, removedTiles, changedTiles, legacyChangedTiles,
    legacyNaNBits: { before: before.legacyNaNBits, after: after.legacyNaNBits } };
}
