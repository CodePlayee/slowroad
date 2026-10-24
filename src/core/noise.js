// src/core/noise.js — seeded value/gradient noise + fbm variants.
// Analytic, stateless, deterministic: noise(x,z,seed) is a pure function.

import { hash2i, u2f } from './rng.js';

const F = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** 2D gradient (Perlin-style) noise in [-1,1]. */
export function gnoise(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = F(xf), v = F(yf);

  const g = (ix, iy, dx, dy) => {
    const h = hash2i(ix, iy, seed);
    // 8 evenly spread gradient directions
    const a = (h & 7) * 0.7853981633974483;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };

  const n00 = g(xi, yi, xf, yf);
  const n10 = g(xi + 1, yi, xf - 1, yf);
  const n01 = g(xi, yi + 1, xf, yf - 1);
  const n11 = g(xi + 1, yi + 1, xf - 1, yf - 1);

  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 1.4142;
}

/** 2D value noise in [0,1] — smoother, cheaper, good for masks. */
export function vnoise(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = F(xf), v = F(yf);
  const a = u2f(hash2i(xi, yi, seed));
  const b = u2f(hash2i(xi + 1, yi, seed));
  const c = u2f(hash2i(xi, yi + 1, seed));
  const d = u2f(hash2i(xi + 1, yi + 1, seed));
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

/** Classic fbm, output roughly [-1,1]. */
export function fbm(x, y, seed, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * gnoise(x * freq, y * freq, seed + i * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal, output [0,1] with sharp crests. */
export function ridged(x, y, seed, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0, prev = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(gnoise(x * freq, y * freq, seed + i * 7717));
    n *= n;
    sum += n * amp * prev;
    prev = n;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Billowy fbm (abs), [0,1]. */
export function billow(x, y, seed, octaves = 4) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * Math.abs(gnoise(x * freq, y * freq, seed + i * 3301));
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Domain-warped fbm — gives terrain organic, non-grid-aligned shapes. */
export function warpedFbm(x, y, seed, octaves = 5, warp = 0.6) {
  const wx = fbm(x + 5.2, y + 1.3, seed ^ 0x51fd, 3);
  const wy = fbm(x - 3.7, y + 9.1, seed ^ 0x9a2b, 3);
  return fbm(x + warp * wx, y + warp * wy, seed, octaves);
}
