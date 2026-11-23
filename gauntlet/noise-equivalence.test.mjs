import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true }
    : next(url, context);
} });
const noise = await import('../src/core/noise.js');
const { hash2i, u2f } = await import('../src/core/rng.js');

// Straightforward reference: every corner gradient from Math.cos/Math.sin of its angle.
const F = (t) => t * t * t * (t * (t * 6 - 15) + 10);
function gnoise(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = F(xf), v = F(yf);
  const g = (ix, iy, dx, dy) => {
    const a = (hash2i(ix, iy, seed) & 7) * 0.7853981633974483;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const n00 = g(xi, yi, xf, yf), n10 = g(xi + 1, yi, xf - 1, yf);
  const n01 = g(xi, yi + 1, xf, yf - 1), n11 = g(xi + 1, yi + 1, xf - 1, yf - 1);
  const nx0 = n00 + (n10 - n00) * u, nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 1.4142;
}
function vnoise(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = F(xf), v = F(yf);
  const a = u2f(hash2i(xi, yi, seed)), b = u2f(hash2i(xi + 1, yi, seed));
  const c = u2f(hash2i(xi, yi + 1, seed)), d = u2f(hash2i(xi + 1, yi + 1, seed));
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}
function fbm(x, y, seed, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * gnoise(x * freq, y * freq, seed + i * 1013);
    norm += amp; amp *= gain; freq *= lacunarity;
  }
  return sum / norm;
}
function ridged(x, y, seed, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0, prev = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(gnoise(x * freq, y * freq, seed + i * 7717));
    n *= n; sum += n * amp * prev; prev = n; norm += amp; amp *= gain; freq *= lacunarity;
  }
  return sum / norm;
}
function billow(x, y, seed, octaves = 4) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * Math.abs(gnoise(x * freq, y * freq, seed + i * 3301));
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return sum / norm;
}
function warpedFbm(x, y, seed, octaves = 5, warp = 0.6) {
  const wx = fbm(x + 5.2, y + 1.3, seed ^ 0x51fd, 3), wy = fbm(x - 3.7, y + 9.1, seed ^ 0x9a2b, 3);
  return fbm(x + warp * wx, y + warp * wy, seed, octaves);
}

function sampler(state) {
  return () => { state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0; return (state >>> 0) / 4294967296; };
}
const SPECIAL = [0, -0, 0.5, -0.5, 1, -1, 1e-9, -1e-9, 2 ** 31, -(2 ** 31), 2 ** 31 - 0.25, 2 ** 53, -(2 ** 53), 1e15 + 0.3,
  -1e15 - 0.7, 1e300, Number.MIN_VALUE, Infinity, -Infinity, NaN];
// Seed forms used in src/: small integers, XOR-salted world seeds (negative int32 too),
// offsets added per octave, and the default.
const SEEDS = [undefined, 0, 7, 12, 31, -5, 0x2b7c1f03, 7 ^ 0x2b7c1f03 ^ 0x57c2a9, 0x9a2b ^ 0xdeadbeef, -(2 ** 31), 2 ** 32 + 9, 3.75, -1e9];

function* inputs(count) {
  const r = sampler(0x5eed);
  for (const x of SPECIAL) for (const y of SPECIAL) yield [x, y, 7];
  for (let n = 0; n < count; n++) {
    const scale = [1, 30, 4000, 2e6, 1e12][n % 5];
    const seed = n % 3 === 0 ? SEEDS[n % SEEDS.length] : (Math.floor(r() * 2 ** 32) | 0);
    yield [(r() - 0.5) * scale, (r() - 0.5) * scale, seed];
  }
}

const same = (name, actual, expected, args) => {
  if (!Object.is(actual, expected)) assert.fail(`${name}(${args.join(', ')}) = ${actual}, reference ${expected}`);
};

test('gradient and value noise match the reference bit for bit, including extreme and non-finite inputs', () => {
  for (const [x, y, seed] of inputs(400000)) {
    const args = seed === undefined ? [x, y] : [x, y, seed];
    same('gnoise', noise.gnoise(...args), gnoise(...args), args);
    same('vnoise', noise.vnoise(...args), vnoise(...args), args);
  }
});

test('fractal compositions match the reference bit for bit for every octave setting', () => {
  let n = 0;
  for (const [x, y, rawSeed] of inputs(20000)) {
    const seed = rawSeed ?? 0, octaves = 1 + (n++ % 6);
    same('fbm', noise.fbm(x, y, seed, octaves), fbm(x, y, seed, octaves), [x, y, seed, octaves]);
    same('fbm', noise.fbm(x, y, seed, octaves, 2.3, 0.45), fbm(x, y, seed, octaves, 2.3, 0.45), [x, y, seed, octaves]);
    same('ridged', noise.ridged(x, y, seed, octaves), ridged(x, y, seed, octaves), [x, y, seed, octaves]);
    same('billow', noise.billow(x, y, seed, octaves), billow(x, y, seed, octaves), [x, y, seed, octaves]);
    same('warpedFbm', noise.warpedFbm(x, y, seed, octaves, 0.8), warpedFbm(x, y, seed, octaves, 0.8), [x, y, seed, octaves]);
  }
});
