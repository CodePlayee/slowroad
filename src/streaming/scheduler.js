// src/streaming/scheduler.js
// Frame-budgeted work queue. Everything that builds geometry goes through here so
// the frame rate stays stable and `__rig.ready()` has a single thing to wait on.

export class Scheduler {
  constructor(budgetMs = 9) {
    this.budgetMs = budgetMs;
    this.tasks = [];
    // Keep a cursor instead of shift(), which otherwise moves every queued task
    // on each build and becomes visible when a clipmap ring is replaced.
    this.head = 0;
    this.keys = new Set();
    this.dirty = false;
    this.active = null;
    this.completed = 0;
    this.lastDrainMs = 0;
    this.error = null;
  }

  has(key) { return this.keys.has(key); }

  push(key, priority, fn) {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.tasks.push({ key, priority, fn });
    this.dirty = true;
    return true;
  }

  /** Re-prioritise an already-queued task (cheap: mark dirty, priority read on sort). */
  reprioritise(fn) {
    if (this.active && !this.active.cancelled) {
      this.active.priority = fn(this.active.key, this.active.priority);
    }
    for (let i = this.head; i < this.tasks.length; i++) {
      const t = this.tasks[i];
      t.priority = fn(t.key, t.priority);
    }
    this.dirty = true;
  }

  drop(pred) {
    if (this.active && !this.active.cancelled && pred(this.active.key)) {
      this.active.cancelled = true;
      this.keys.delete(this.active.key);
    }
    let write = this.head;
    for (let i = this.head; i < this.tasks.length; i++) {
      const t = this.tasks[i];
      if (pred(t.key)) this.keys.delete(t.key);
      else this.tasks[write++] = t;
    }
    this.tasks.length = write;
    // Compact only after filtering. This keeps the common no-drop path cheap.
    if (this.head > 0) {
      const n = this.tasks.length - this.head;
      for (let i = 0; i < n; i++) this.tasks[i] = this.tasks[this.head + i];
      this.tasks.length = n;
      this.head = 0;
    }
    // A running callback may compact the queue. Its continuation must then be
    // reinserted instead of reusing the consumed slot before the old cursor.
    if (this.active) this.dirty = true;
  }

  clear() {
    if (this.active) this.active.cancelled = true;
    this.tasks.length = 0;
    this.head = 0;
    this.keys.clear();
    this.dirty = false;
    this.error = null;
  }

  get pending() { return this.keys.size; }

  run(budgetMs = this.budgetMs) {
    if (this.active) return 0;
    if (this.head >= this.tasks.length) {
      this.tasks.length = 0; this.head = 0; this.lastDrainMs = 0; return 0;
    }
    const t0 = performance.now();
    let done = 0;
    while (this.head < this.tasks.length) {
      if (this.dirty) {
        if (this.head > 0) {
          const n = this.tasks.length - this.head;
          for (let i = 0; i < n; i++) this.tasks[i] = this.tasks[this.head + i];
          this.tasks.length = n;
          this.head = 0;
        }
        this.tasks.sort((a, b) => a.priority - b.priority);
        this.dirty = false;
      }
      const t = this.tasks[this.head++];
      this.active = t;
      let next = null;
      try { next = t.fn(); } catch (e) {
        this.error ||= `${t.key}: ${e?.message || e}`;
        console.error('[scheduler]', t.key, e);
      }
      this.active = null;
      // Geometry builders may return a continuation when a frame-sized slice
      // is complete. Keep the key resident in the queue until the final slice
      // so pending/ready semantics remain unchanged during incremental builds.
      if (!t.cancelled && typeof next === 'function') {
        t.fn = next;
        // Finish urgent surface coverage before starting lower-priority detail.
        // New work or changed priorities are considered before the next slice.
        if (this.dirty) this.tasks.push(t);
        else this.tasks[--this.head] = t;
      } else if (!t.cancelled) {
        this.keys.delete(t.key);
      }
      done++; this.completed++;
      if (performance.now() - t0 >= budgetMs) break;
    }
    if (this.head >= this.tasks.length) { this.tasks.length = 0; this.head = 0; }
    this.lastDrainMs = performance.now() - t0;
    return done;
  }

  /** Synchronously finish everything (used by the capture rig). */
  drain(maxMs = 20000) {
    if (this.active) return false;
    const t0 = performance.now();
    while (this.pending) {
      const remaining = maxMs - (performance.now() - t0);
      if (remaining <= 0) break;
      this.run(Math.min(40, remaining));
    }
    return this.pending === 0;
  }
}
