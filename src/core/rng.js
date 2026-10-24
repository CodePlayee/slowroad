// src/core/rng.js — deterministic hashing + PRNG. NO Math.random anywhere in the world build.

/** 32-bit integer hash (Thomas Wang / murmur-ish). */
export function hashInt(x) {
  x |= 0;
  x = (x ^ 61) ^ (x >>> 16);
  x = (x + (x << 3)) | 0;
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return x >>> 0;
}

/** Hash 2 ints + seed -> uint32. */
export function hash2i(x, y, seed = 0) {
  let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(seed | 0, 0xcb1ab31f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

export function hash3i(x, y, z, seed = 0) {
  return hash2i(hash2i(x, y, seed) | 0, z, seed ^ 0x9e3779b9);
}

/** uint32 -> [0,1) */
export const u2f = (u) => (u >>> 0) / 4294967296;

export function rand2(x, y, seed = 0) { return u2f(hash2i(x, y, seed)); }
export function rand3(x, y, z, seed = 0) { return u2f(hash3i(x, y, z, seed)); }

/** mulberry32 stream PRNG. */
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn any string/number into a stable uint32 seed. */
export function seedFrom(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return hashInt(Math.floor(v) || 0);
  const s = String(v ?? 0);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}
export function smootherstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}
export const mix = lerp;
