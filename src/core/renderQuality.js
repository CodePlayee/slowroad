const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class RenderQuality {
  constructor({ deviceRatio = 1, fixedRatio = null, lodScale = 1, adaptive = true, pixelBudget = 2100000 } = {}) {
    this.fixedRatio = fixedRatio;
    this.deviceRatio = clamp(deviceRatio, 0.75, 1.5);
    this.lodScale = clamp(lodScale, 0.5, 2);
    this.adaptive = adaptive && fixedRatio === null;
    this.pixelBudget = pixelBudget;
    this.pixelRatio = fixedRatio ?? this.deviceRatio;
    this.lodHeight = 1;
    this._samples = [];
    this._cpu = [];
    this._elapsed = 0;
    this._overloaded = 0;
    this.changes = 0;
  }

  resize(width, height) {
    this.lodHeight = Math.max(1, height) * this.lodScale;
    this.maximumRatio = this.fixedRatio ?? Math.max(0.75,
      Math.min(this.deviceRatio, Math.sqrt(this.pixelBudget / Math.max(1, width * height))));
    this.pixelRatio = this.maximumRatio;
    this.reset();
    return this.pixelRatio;
  }

  reset() {
    this._samples.length = 0; this._cpu.length = 0;
    this._elapsed = 0;
    this._overloaded = 0;
  }

  sample(frameMs, cpuMs, eligible = true) {
    if (!eligible || !this.adaptive || !Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 250 || !Number.isFinite(cpuMs)) {
      this.reset(); return false;
    }
    this._samples.push(frameMs); this._cpu.push(cpuMs); this._elapsed += frameMs;
    if (this._elapsed < 2000 || this._samples.length < 30) return false;
    // RAF delivery has harmless short/long pairs. A percentile alone mistakes
    // that jitter for sustained GPU pressure and repeatedly rebuilds the canvas.
    const mean = this._elapsed / this._samples.length;
    const missed = this._samples.reduce((count, ms, i) => count + (ms > 25 && this._cpu[i] < 14 ? 1 : 0), 0)
      / this._samples.length;
    this._cpu.sort((a, b) => a - b);
    const cpu = this._cpu[Math.floor(this._cpu.length * 0.5)];
    let next = this.pixelRatio;
    // A canvas rebuild is expensive on Metal. Require two sustained bad
    // windows instead of chasing brief dips around an otherwise stable 60 Hz.
    this._overloaded = (mean > 19.5 || missed > 0.15) && cpu < 17 ? this._overloaded + 1 : 0;
    if (this._overloaded >= 2) {
      next = Math.max(0.8, this.pixelRatio - 0.05);
      this._overloaded = 0;
    }
    // Stable vsync does not prove spare GPU capacity. Keep a successful ratio
    // during travel; a viewport resize starts a fresh budget, not a timed probe.
    this._samples.length = 0; this._cpu.length = 0; this._elapsed = 0;
    next = Math.min(this.maximumRatio, next);
    if (Math.abs(next - this.pixelRatio) < 0.0001) return false;
    this.pixelRatio = next; this.changes++;
    return true;
  }
}
