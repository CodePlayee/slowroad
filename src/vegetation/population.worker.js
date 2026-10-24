import { hydrateWorld } from '../terrain/mesh-data.js';
import { generatePopulation } from './population.js';

let world = null, epoch = 0;
const active = new Set(), cancelled = new Set();
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

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
  const { id, epoch: buildEpoch, tile } = message;
  let iterator;
  active.add(id);
  try {
    if (!world || buildEpoch !== epoch) {
      self.postMessage({ type: 'cancelled', id, epoch: buildEpoch });
      return;
    }
    iterator = generatePopulation(world, tile.kind, tile.i, tile.j);
    let sliceStart = performance.now();
    while (true) {
      if (buildEpoch !== epoch || cancelled.has(id)) {
        self.postMessage({ type: 'cancelled', id, epoch: buildEpoch });
        return;
      }
      const step = iterator.next();
      if (step.done) {
        self.postMessage({ type: 'built', id, epoch: buildEpoch, records: step.value });
        return;
      }
      if (performance.now() - sliceStart >= 8) {
        await pause();
        sliceStart = performance.now();
      }
    }
  } catch (error) {
    self.postMessage({ type: 'error', id, epoch: buildEpoch, error: String(error.message || error) });
  } finally {
    iterator?.return();
    active.delete(id);
    cancelled.delete(id);
  }
};
