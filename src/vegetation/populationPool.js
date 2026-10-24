import { serializeWorld } from '../terrain/mesh-data.js';

export class PopulationPool {
  constructor({ WorkerClass } = {}) {
    this.epoch = 0;
    this._nextId = 1;
    this._jobs = new Map();
    this._slot = null;
    this._disposed = false;
    if (!WorkerClass && typeof Worker === 'undefined') return;
    try {
      const worker = WorkerClass
        ? new WorkerClass(new URL('./population.worker.js', import.meta.url), { type: 'module' })
        : new Worker(new URL('./population.worker.js', import.meta.url), { type: 'module' });
      const slot = { worker, ready: false, failed: false, current: null };
      worker.onmessage = ({ data }) => this._receive(data);
      worker.onerror = event => this._fail(event.message || 'Population worker failed');
      worker.onmessageerror = () => this._fail('Population worker message could not be decoded');
      this._slot = slot;
    } catch {
      this._slot = null;
    }
  }

  get available() { return !this._disposed && Boolean(this._slot && !this._slot.failed); }
  get pending() { return this._jobs.size; }

  reset(world) {
    this.epoch++;
    this._jobs.clear();
    if (!this.available) return;
    const slot = this._slot;
    slot.current = null;
    slot.ready = false;
    try {
      slot.worker.postMessage({ type: 'init', epoch: this.epoch, world: serializeWorld(world) });
    } catch (error) {
      this._fail(String(error.message || error));
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
      if (job.state !== 'running' || this._slot?.current !== job) continue;
      try { this._slot.worker.postMessage({ type: 'cancel', id: job.id, epoch: job.epoch }); }
      catch (error) { this._fail(String(error.message || error)); }
    }
    this._dispatch();
  }

  _dispatch() {
    const slot = this._slot;
    if (!this.available || !slot.ready || slot.current) return;
    let next = null;
    for (const job of this._jobs.values()) {
      if (job.state === 'queued' && (!next || job.priority < next.priority)) next = job;
    }
    if (!next) return;
    slot.current = next;
    next.state = 'running';
    try {
      slot.worker.postMessage({ type: 'build', id: next.id, epoch: next.epoch, tile: next.tile });
    } catch (error) {
      this._fail(String(error.message || error));
    }
  }

  _receive(message) {
    const slot = this._slot;
    if (!this.available || message.epoch !== this.epoch) return;
    if (message.type === 'ready') {
      slot.ready = true;
      this._dispatch();
      return;
    }
    if (message.type === 'error' && message.id === undefined) {
      this._fail(message.error);
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

  _fail(error) {
    const slot = this._slot;
    if (!slot || slot.failed) return;
    slot.failed = true;
    slot.ready = false;
    slot.current = null;
    slot.worker.terminate();
    for (const job of this._jobs.values()) if (job.state !== 'complete') {
      job.state = 'complete';
      job.result = { error };
    }
  }

  dispose() {
    this._disposed = true;
    this._jobs.clear();
    this._slot?.worker.terminate();
    this._slot = null;
  }
}
