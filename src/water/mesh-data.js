import { WATER as W } from './params.js';
import { clamp, lerp } from '../core/rng.js';

// Pure buffers let the terrain worker do river sampling before main-thread
// publication. Row yields keep the no-worker fallback cooperative as well.
export function* buildWaterData(world, ox, oz, size, res, groundAt) {
  if (!Number.isFinite(res) || res < 1 || res > 512) throw new RangeError('Invalid water resolution');
  const n = Math.max(4, Math.floor(res / W.resDiv));
  const cell = size / n, nv = (n + 1) * (n + 1);
  const wy = new Float32Array(nv), gy = new Float32Array(nv);
  const half = new Float32Array(nv), dist = new Float32Array(nv);
  let any = false;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = ox + i * cell, z = oz + j * cell;
      const r = world.hf.river(x, z), k = j * (n + 1) + i;
      wy[k] = r.waterY; half[k] = r.channelHalf; dist[k] = r.dist;
      gy[k] = groundAt(x, z);
      if (gy[k] < wy[k] - 0.02 && dist[k] < half[k] * 2.4) any = true;
    }
    yield;
  }
  if (!any) return null;
  const pos = [], col = [], idx = [], uv = [];
  const map = new Int32Array(nv).fill(-1);
  let vc = 0;
  const addVert = (k, i, j) => {
    if (map[k] >= 0) return map[k];
    const x = ox + i * cell, z = oz + j * cell;
    pos.push(x - ox - size / 2, wy[k], z - oz - size / 2);
    const depth = clamp(wy[k] - gy[k], 0, 100);
    const t = clamp(depth / W.depthFade, 0, 1);
    col.push(lerp(W.shallow[0], W.deep[0], t), lerp(W.shallow[1], W.deep[1], t),
      lerp(W.shallow[2], W.deep[2], t), lerp(W.alphaShallow, W.alphaDeep, t));
    uv.push(x / W.rippleScale, z / W.rippleScale);
    map[k] = vc;
    return vc++;
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k00 = j * (n + 1) + i, k10 = k00 + 1;
      const k01 = k00 + n + 1, k11 = k01 + 1;
      if (!(gy[k00] < wy[k00] || gy[k10] < wy[k10] || gy[k01] < wy[k01] || gy[k11] < wy[k11])) continue;
      if (dist[k00] > half[k00] * 3 && dist[k11] > half[k11] * 3) continue;
      const a = addVert(k00, i, j), b = addVert(k10, i + 1, j);
      const c = addVert(k01, i, j + 1), d = addVert(k11, i + 1, j + 1);
      idx.push(a, c, b, b, c, d);
    }
    yield;
  }
  if (!idx.length) return null;
  return { positions: new Float32Array(pos), colors: new Float32Array(col), uvs: new Float32Array(uv),
    indices: vc > 65535 ? new Uint32Array(idx) : new Uint16Array(idx) };
}
