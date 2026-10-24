import * as THREE from 'three';
import { EXTRA_TREE_SPECIES_NAMES } from './treeSpecies.js';

const ROOT = '/models/woodland/';

/** Decode offline-generated crowns without loading the tree generator at runtime. */
export function decodeTreeSpecies(manifest, buffer) {
  if (manifest?.format !== 'slowroad-woodland-v1') throw new Error('Unknown tree species asset format');
  const result = {};
  const allocated = [];
  try {
    for (const name of EXTRA_TREE_SPECIES_NAMES) {
      const tree = manifest.trees?.[name]?.near;
      if (!tree) throw new Error(`Missing tree species: ${name}`);
      const parts = {};
      for (const part of ['bark', 'leaf']) {
        const attributes = tree.parts?.[part]?.attributes;
        const geometry = new THREE.BufferGeometry();
        allocated.push(geometry);
        for (const attributeName of ['position', 'normal', 'uv', 'index']) {
          const info = attributes?.[attributeName];
          const Type = attributeName === 'index' ? Uint16Array : Float32Array;
          const size = attributeName === 'index' ? 1 : attributeName === 'uv' ? 2 : 3;
          if (!info || !Number.isInteger(info.count) || info.count <= 0 || info.count % size ||
              !Number.isInteger(info.byteOffset) || info.byteOffset < 0 || info.byteOffset % Type.BYTES_PER_ELEMENT ||
              info.count * Type.BYTES_PER_ELEMENT !== info.byteLength || info.byteOffset + info.byteLength > buffer.byteLength) {
            throw new Error(`Invalid tree species buffer: ${name}/${part}/${attributeName}`);
          }
          const values = new Type(buffer, info.byteOffset, info.count);
          if (!values.every(Number.isFinite)) throw new Error(`Non-finite tree species vertex: ${name}/${part}/${attributeName}`);
          const attribute = new THREE.BufferAttribute(values, size);
          if (attributeName === 'index') geometry.setIndex(attribute); else geometry.setAttribute(attributeName, attribute);
        }
        const count = geometry.attributes.position.count;
        if (geometry.attributes.normal.count !== count || geometry.attributes.uv.count !== count ||
            geometry.index.count % 3 || geometry.index.array.some(index => index >= count)) {
          throw new Error(`Invalid tree species topology: ${name}/${part}`);
        }
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        parts[part] = geometry;
      }
      result[name] = { near: parts };
    }
    return result;
  } catch (error) {
    for (const geometry of allocated) geometry.dispose();
    throw error;
  }
}

export async function loadTreeSpeciesAssets(fetcher = globalThis.fetch) {
  const read = async (file, type) => {
    const response = await fetcher(ROOT + file);
    if (!response.ok) throw new Error(`Tree species ${file}: HTTP ${response.status}`);
    return response[type]();
  };
  const manifest = await read('species.manifest.json', 'json');
  return decodeTreeSpecies(manifest, await read(manifest.buffer, 'arrayBuffer'));
}
