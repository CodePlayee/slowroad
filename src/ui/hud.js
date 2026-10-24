// src/ui/hud.js — minimal, hideable HUD driven from the DOM in index.html.
export class Hud {
  constructor() {
    this.root = document.getElementById('hud');
    this.kph = document.getElementById('hud-kph');
    this.km = document.getElementById('hud-km');
    this.environment = document.getElementById('hud-environment');
    this.runtime = document.getElementById('hud-runtime');
    this.mode = document.getElementById('hud-mode');
    this.visible = true;
    this._acc = 0;
  }
  hide() { this.visible = false; this.root.classList.add('hidden'); }
  show() { this.visible = true; this.root.classList.remove('hidden'); }
  toggle() { this.visible ? this.hide() : this.show(); }

  update(dt, app) {
    this._acc += dt;
    if (this._acc < 0.1) return;
    this._acc = 0;
    if (!this.visible) return;
    const v = app.vehicle;
    this.kph.textContent = String(Math.round(v.speed * 3.6));
    this.km.textContent = v.km.toFixed(2);
    const t = app.atmo.time;
    const hh = String(Math.floor(t)).padStart(2, '0');
    const mm = String(Math.floor((t % 1) * 60)).padStart(2, '0');
    this.mode.textContent = 'AUTODRIVE · ' + app.cameras.mode.toUpperCase();
    this.environment.textContent = `${hh}:${mm}  ${app.atmo.seasonName}  ${app.atmo.weatherName}`;
    this.runtime.textContent = `seed ${app.world.seedInput}  ${Math.round(app.stats.fps)} fps`;
  }
}
