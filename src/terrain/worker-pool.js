import { serializeWorld } from './mesh-data.js';

export class TerrainWorkerPool {
  constructor({ size = 2, WorkerClass } = {}) {
    this.epoch = 0;
    this._nextId = 1;
    this._jobs = new Map();
    this._slots = [];
    this._disposed = false;
    if (!WorkerClass && typeof Worker === 'undefined') return;
    for (let i = 0; i < Math.max(1, Math.min(2, size)); i++) {
      try {
        const worker = WorkerClass
          ? new WorkerClass(new URL('./terrain.worker.js', import.meta.url), { type: 'module' })
          : new Worker(new URL('./terrain.worker.js', import.meta.url), { type: 'module' });
        const slot = { worker, ready: false, failed: false, current: null };
        worker.onmessage = ({ data }) => this._receive(slot, data);
        worker.onerror = (event) => this._fail(slot, event.message || 'Terrain worker failed');
        worker.onmessageerror = () => this._fail(slot, 'Terrain worker message could not be decoded');
        this._slots.push(slot);
      } catch {
        break;
      }
    }
  }

  get available() { return !this._disposed && this._slots.some((slot) => !slot.failed); }
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
        // Structured cloning keeps the route buffers owned by the main thread.
        slot.worker.postMessage({ type: 'init', epoch: this.epoch, world: snapshot });
      } catch (error) {
        this._fail(slot, String(error.message || error));
      }
    }
  }

  request(key, tile, options, priority = 0) {
    if (!this.available) return false;
    const existing = this._jobs.get(key);
    if (existing) {
      existing.priority = priority;
      return true;
    }
    this._jobs.set(key, {
      id: this._nextId++, epoch: this.epoch, key, tile, options, priority,
      state: 'queued', result: null,
    });
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
      const slot = this._slots.find((candidate) => candidate.current === job);
      if (slot) {
        try { slot.worker.postMessage({ type: 'cancel', id: job.id, epoch: job.epoch }); }
        catch (error) { this._fail(slot, String(error.message || error)); }
      }
    }
    this._dispatch();
  }

  _dispatch() {
    for (const slot of this._slots) {
      if (!slot.ready || slot.failed || slot.current) continue;
      let next = null;
      for (const job of this._jobs.values()) {
        if (job.state === 'queued' && (!next || job.priority < next.priority)) next = job;
      }
      if (!next) return;
      slot.current = next;
      next.state = 'running';
      try {
        slot.worker.postMessage({ type: 'build', id: next.id, epoch: next.epoch,
          tile: next.tile, options: next.options });
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
      if (message.type === 'built') {
        job.state = 'complete';
        job.result = { data: message.data };
      } else {
        job.state = 'complete';
        job.result = { error: message.error || 'Terrain build cancelled' };
      }
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
      job.state = 'complete'; job.result = { error };
    }
    if (!this.available) {
      for (const pending of this._jobs.values()) {
        if (pending.state !== 'complete') {
          pending.state = 'complete'; pending.result = { error };
        }
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
