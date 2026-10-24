import { buildTerrainTileData, hydrateWorld } from './mesh-data.js';

let world = null, epoch = 0;
const cancelled = new Set();
const active = new Set();
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

self.onmessage = async ({ data: message }) => {
  if (message.type === 'init') {
    epoch = message.epoch;
    cancelled.clear();
    try {
      world = hydrateWorld(message.world);
      self.postMessage({ type: 'ready', epoch });
    } catch (error) {
      world = null;
      self.postMessage({ type: 'error', epoch, error: String(error.message || error) });
    }
    return;
  }
  if (message.type === 'cancel') {
    if (message.epoch === epoch && active.has(message.id)) cancelled.add(message.id);
    return;
  }
  if (message.type !== 'build') return;
  const { id, epoch: buildEpoch, tile, options } = message;
  active.add(id);
  try {
    if (!world || buildEpoch !== epoch) {
      self.postMessage({ type: 'cancelled', id, epoch: buildEpoch });
      return;
    }
    const iterator = buildTerrainTileData(world, tile, options);
    let sliceStart = performance.now();
    while (true) {
      if (buildEpoch !== epoch || cancelled.has(id)) {
        cancelled.delete(id);
        self.postMessage({ type: 'cancelled', id, epoch: buildEpoch });
        return;
      }
      const step = iterator.next();
      if (step.done) {
        const data = step.value;
        const transfer = [data.positions, data.normals, data.surface,
          data.roadDistances, data.ecology, data.indices, data.heights].map((array) => array.buffer);
        if (data.water) for (const array of Object.values(data.water)) transfer.push(array.buffer);
        self.postMessage({ type: 'built', id, epoch: buildEpoch, data }, transfer);
        return;
      }
      // Leave a message turn for cancellations without paying a timer per row.
      if (performance.now() - sliceStart >= 8) {
        await pause();
        sliceStart = performance.now();
      }
    }
  } catch (error) {
    self.postMessage({ type: 'error', id, epoch: buildEpoch, error: String(error.message || error) });
  } finally {
    cancelled.delete(id);
    active.delete(id);
  }
};
