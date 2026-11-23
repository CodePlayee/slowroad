import { serializeWorld } from '../terrain/mesh-data.js';

// Each generation worker holds its own hydrated copy of the world.
export const POPULATION_WORKERS_MAX = 3;

/** Generation workers for a hardware thread count; the main thread and the two terrain workers keep the rest. */
export function populationWorkerCount(threads) {
  const count = Math.floor((Number.isFinite(threads) ? threads : 2) / 2);
  return Math.max(1, Math.min(POPULATION_WORKERS_MAX, count));
}

export class PopulationPool {
  /**
   * `size` workers share one priority queue (lowest value first). A job whose
   * priority is at or above `backgroundPriority` never takes the last idle
   * worker, so urgent work cannot queue behind long background tiles.
   */
  constructor({ WorkerClass, size = 1, backgroundPriority = Infinity } = {}) {
    this.epoch = 0;
    this._nextId = 1;
    this._jobs = new Map();
    this._slots = [];
    this._disposed = false;
    this.backgroundPriority = backgroundPriority;
    if (!WorkerClass && typeof Worker === 'undefined') return;
    const count = Math.max(1, Math.min(POPULATION_WORKERS_MAX, Math.floor(Number(size) || 1)));
    for (let i = 0; i < count; i++) {
      try {
        const worker = WorkerClass
          ? new WorkerClass(new URL('./population.worker.js', import.meta.url), { type: 'module' })
          : new Worker(new URL('./population.worker.js', import.meta.url), { type: 'module' });
        const slot = { worker, ready: false, failed: false, current: null };
        worker.onmessage = ({ data }) => this._receive(slot, data);
        worker.onerror = event => this._fail(slot, event.message || 'Population worker failed');
        worker.onmessageerror = () => this._fail(slot, 'Population worker message could not be decoded');
        this._slots.push(slot);
      } catch {
        break;
      }
    }
  }

  get available() { return !this._disposed && this._slots.some(slot => !slot.failed); }
  get pending() { return this._jobs.size; }

  reset(world) {
    this.epoch++;
    this._jobs.clear();
    if (!this.available) return;
    const snapshot = serializeWorld(world);
    for (const slot of this._slots) {
      if (slot.failed) continue;
      slot.current = null;
      slot.ready = false;
      try {
        slot.worker.postMessage({ type: 'init', epoch: this.epoch, world: snapshot });
      } catch (error) {
        this._fail(slot, String(error.message || error));
      }
    }
  }

  request(key, tile, priority = 0) {
    if (!this.available) return false;
    const existing = this._jobs.get(key);
    if (existing) {
      existing.priority = priority;
      return true;
    }
    this._jobs.set(key, { id: this._nextId++, epoch: this.epoch, key, tile, priority,
      state: 'queued', result: null });
    this._dispatch();
    return true;
  }

  has(key) { return this._jobs.has(key); }

  poll(key) {
    const job = this._jobs.get(key);
    if (!job || job.state !== 'complete') return null;
    this._jobs.delete(key);
    return job.result;
  }

  cancelExcept(keys) {
    for (const [key, job] of this._jobs) {
      if (keys.has(key)) continue;
      this._jobs.delete(key);
      if (job.state !== 'running') continue;
      const slot = this._slots.find(candidate => candidate.current === job);
      if (!slot) continue;
      try { slot.worker.postMessage({ type: 'cancel', id: job.id, epoch: job.epoch }); }
      catch (error) { this._fail(slot, String(error.message || error)); }
    }
    this._dispatch();
  }

  _dispatch() {
    if (this._disposed) return;
    for (;;) {
      const idle = this._slots.filter(slot => slot.ready && !slot.failed && !slot.current);
      if (!idle.length) return;
      const reserve = idle.length === 1 && this._slots.filter(slot => !slot.failed).length > 1;
      let next = null;
      for (const job of this._jobs.values()) {
        if (job.state !== 'queued' || (reserve && job.priority >= this.backgroundPriority)) continue;
        if (!next || job.priority < next.priority) next = job;
      }
      if (!next) return;
      const slot = idle[0];
      slot.current = next;
      next.state = 'running';
      try {
        slot.worker.postMessage({ type: 'build', id: next.id, epoch: next.epoch, tile: next.tile });
      } catch (error) {
        this._fail(slot, String(error.message || error));
      }
    }
  }

  _receive(slot, message) {
    if (this._disposed || slot.failed || message.epoch !== this.epoch) return;
    if (message.type === 'ready') {
      slot.ready = true;
      this._dispatch();
      return;
    }
    if (message.type === 'error' && message.id === undefined) {
      this._fail(slot, message.error);
      return;
    }
    const job = slot.current;
    if (!job || message.id !== job.id || message.epoch !== job.epoch) return;
    slot.current = null;
    if (this._jobs.get(job.key) === job) {
      job.state = 'complete';
      job.result = message.type === 'built'
        ? { records: message.records }
        : { error: message.error || 'Population build cancelled' };
    }
    this._dispatch();
  }

  _fail(slot, error) {
    if (slot.failed) return;
    slot.failed = true;
    slot.ready = false;
    slot.worker.terminate();
    const job = slot.current;
    slot.current = null;
    if (job && this._jobs.get(job.key) === job) {
      job.state = 'complete';
      job.result = { error };
    }
    if (!this.available) {
      for (const pending of this._jobs.values()) if (pending.state !== 'complete') {
        pending.state = 'complete';
        pending.result = { error };
      }
    }
    this._dispatch();
  }

  dispose() {
    this._disposed = true;
    this._jobs.clear();
    for (const slot of this._slots) slot.worker.terminate();
    this._slots.length = 0;
  }
}
