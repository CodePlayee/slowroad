import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true }
    : next(url, context);
} });
const { hash2i } = await import('../src/core/rng.js');

const require = createRequire(import.meta.url);
const { PNG } = require(path.join(path.dirname(require.resolve('playwright-core')), 'lib/utilsBundle.js'));
const shader = readFileSync(new URL('../src/terrain/terrain.js', import.meta.url), 'utf8');
const linear = value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const smooth = (a, b, value) => { const t = Math.max(0, Math.min(1, (value - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const hash = (x, z) => (hash2i(x, z) >>> 8) / 16777216;

function noise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = smooth(0, 1, x - ix), fz = smooth(0, 1, z - iz);
  return mix(mix(hash(ix, iz), hash(ix + 1, iz), fx), mix(hash(ix, iz + 1), hash(ix + 1, iz + 1), fx), fz);
}

function antiTile(sample, u, v, phase) {
  const index = Math.floor(phase), blend = smooth(0.20, 0.80, phase - index);
  const a = sample(u + hash(index, 17), v + hash(index, 43));
  const b = sample(u + hash(index + 1, 17), v + hash(index + 1, 43));
  return a.map((value, channel) => mix(value, b[channel], blend));
}

function ecosystem(canopy, clump, moist, meso) {
  const forest = smooth(0.24, 0.76, canopy + (clump - 0.5) * 0.20 + (meso - 0.5) * 0.25);
  const growth = smooth(0.18, 0.82, clump * 0.62 + moist * 0.28 + (1 - canopy) * 0.10);
  const mossShare = smooth(0.30, 0.82, moist) * (0.10 + 0.18 * (1 - clump));
  const litterShare = (0.32 + 0.42 * (1 - growth)) * (1 - mossShare);
  const litter = forest * litterShare, moss = forest * mossShare;
  return { turf: 1 - litter - moss, litter, moss };
}

test('woodland asset is an opaque color image with distinct leaf and humus values', () => {
  const image = PNG.sync.read(readFileSync(new URL('../public/textures/woodland-litter-v1.png', import.meta.url)));
  assert.equal(image.width, image.height);
  assert.ok(image.width >= 1024);
  const luminance = [];
  let colored = 0;
  for (let i = 0; i < image.data.length; i += 4 * 17) {
    const rgb = [0, 1, 2].map(channel => linear(image.data[i + channel] / 255));
    assert.equal(image.data[i + 3], 255);
    luminance.push(rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722);
    if (Math.max(...rgb) - Math.min(...rgb) > 0.015) colored++;
  }
  luminance.sort((a, b) => a - b);
  const q = value => luminance[Math.floor(luminance.length * value)];
  assert.ok(q(0.9) > q(0.1) * 4, 'humus gaps may not collapse into a single pale material value');
  assert.ok(colored / luminance.length > 0.4, 'retain leaf/moss pigment, not grayscale grain');
});

test('forest fine RGB survives the material path without adding samples or geometry', () => {
  assert.match(shader, /loadAsync\('\/textures\/woodland-litter-v1\.png'\)/);
  assert.match(shader, /vec3 woodlandCol = litterDetail \* litterSeason \* litterPatch/);
  assert.doesNotMatch(shader, /litterChroma/);
  assert.equal((shader.match(/\b(?:texture2D|textureGrad)\(/g) || []).length, 5);
  assert.equal((shader.match(/texture2D\(uPlantContact,/g) || []).length, 1);
  assert.match(shader, /litterWeight \* \(1\.0 - snow\)/);
  assert.match(shader, /float litterExposure = mix\(1\.0, winterThin, winterAmount\)/);
  assert.match(shader, /woodlandCol = mix\(uSoil \* vec3\(0\.42, 0\.42, 0\.38\), woodlandCol, litterExposure\)/);
  const grainAt = shader.indexOf('col *= mix(1.0, detailGrain, detailBlend)');
  const litterAt = shader.indexOf('col = col * (1.0 - litterWeight - mossWeight)');
  assert.ok(grainAt > 0 && litterAt > grainAt, 'apply grain before the leaf layer, including partial woodland weights');
  assert.doesNotMatch(shader.slice(litterAt), /col \*= mix\(\s*1\.0, detailGrain/);
  assert.match(shader, /uLitterAutumn\.value = this\.atmo\.seasonName === 'autumn' \? 1 : 0/);
  assert.match(shader, /texture\.colorSpace = THREE\.SRGBColorSpace/);
  assert.match(shader, /woodlandSurface = \(1\.0 - smoothstep/);
});

test('ecological material weights preserve understory turf and do not inherit grass model ranges', () => {
  for (const name of ['forestFloor', 'understoryGrowth', 'mossShare', 'litterShare']) {
    const expression = shader.match(new RegExp(`float ${name} = [\\s\\S]*?;`))?.[0];
    assert.ok(expression, name);
    assert.doesNotMatch(expression, /grassRoadCoverage|grassViewCoverage|grassModelCoverage|vRoadDist|camera|View|Time/);
  }
  assert.match(shader, /clump \* 0\.62 \+ moist \* 0\.28 \+ \(1\.0 - canopy\) \* 0\.10/);
  assert.match(shader, /float mossShare = smoothstep\(0\.30, 0\.82, moist\) \* \(0\.10 \+ 0\.18 \* \(1\.0 - clump\)\)/);
  assert.match(shader, /float litterShare = \(0\.32 \+ 0\.42 \* \(1\.0 - understoryGrowth\)\) \* \(1\.0 - mossShare\)/);
  assert.doesNotMatch(shader, /textureHandoff/);
  assert.match(shader, /col = col \* \(1\.0 - litterWeight - mossWeight\) \+ woodlandCol \* litterWeight \+ mossCol \* mossWeight/);
  for (const canopy of [0, 0.3, 0.7, 1]) for (const moist of [0, 0.4, 0.8, 1]) {
    for (const clump of [0, 0.25, 0.5, 0.75, 1]) for (const meso of [0, 0.5, 1]) {
      const weights = ecosystem(canopy, clump, moist, meso), values = Object.values(weights);
      assert.ok(values.every(value => value >= 0 && value <= 1));
      assert.ok(Math.abs(values.reduce((a, b) => a + b, 0) - 1) < 1e-12);
      assert.ok(weights.turf >= 0.18, 'dense canopy must not turn the entire surface into litter');
      if (canopy === 0) assert.deepEqual(weights, { turf: 1, litter: 0, moss: 0 });
    }
  }
  assert.ok(ecosystem(1, 0.9, 0.7, 0.5).turf > ecosystem(1, 0.1, 0.7, 0.5).turf);
  assert.ok(ecosystem(1, 0.5, 0.9, 0.5).moss > ecosystem(1, 0.5, 0.2, 0.5).moss);
});

test('two equal-scale litter reads use explicit unshifted gradients and continuous world-fixed offsets', () => {
  const block = shader.slice(shader.indexOf('vec2 litterUv ='), shader.indexOf('vec2 coarseGrassUv ='));
  assert.match(block, /\* uv \* 0\.40/);
  assert.match(block, /litterDx = dFdx\(litterUv\), litterDy = dFdy\(litterUv\)/);
  assert.match(block, /tvn\(uv \* 0\.045 \+ vec2\(-7\.0, 23\.0\)\)/);
  assert.match(block, /litterPhase = litterVariation \* 12\.0/);
  assert.match(block, /textureGrad\(uForestDetail, litterUv \+ litterOffsetA, litterDx, litterDy\)/);
  assert.match(block, /textureGrad\(uForestDetail, litterUv \+ litterOffsetB, litterDx, litterDy\)/);
  assert.match(block, /smoothstep\(0\.20, 0\.80, fract\(litterPhase\)\)/);
  assert.doesNotMatch(block, /camera|View|Time|0\.095|coarseLitter/);
  assert.equal((shader.match(/textureGrad\(uForestDetail,/g) || []).length, 2);
  assert.equal((shader.match(/texture2D\( uGrassDetail,/g) || []).length, 2);
  assert.equal((shader.match(/texture2D\(uPlantContact,/g) || []).length, 1);
  assert.equal((shader.match(/\b(?:texture2D|textureGrad)\(/g) || []).length, 5);
  const sample = (u, v) => [Math.sin(u * 6.283) * 0.3 + 0.5, Math.cos(v * 6.283) * 0.3 + 0.5, 0.2];
  for (const boundary of [-1, 0, 1, 7, 12]) {
    const left = antiTile(sample, 3.12, -5.37, boundary - 1e-8);
    const right = antiTile(sample, 3.12, -5.37, boundary + 1e-8);
    assert.deepEqual(left, right, 'neighboring phase bands must share the exact same endpoint sample');
  }
});

test('world-fixed offsets break the source image repeat without changing its leaf scale', t => {
  const image = PNG.sync.read(readFileSync(new URL('../public/textures/woodland-litter-v1.png', import.meta.url)));
  const wrap = (value, size) => ((value % size) + size) % size;
  const sample = (u, v) => {
    const x = wrap(u, 1) * image.width - 0.5, y = wrap(v, 1) * image.height - 0.5;
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const texel = (dx, dy, channel) => linear(image.data[(wrap(iy + dy, image.height) * image.width
      + wrap(ix + dx, image.width)) * 4 + channel] / 255);
    return [0, 1, 2].map(channel => mix(mix(texel(0, 0, channel), texel(1, 0, channel), fx),
      mix(texel(0, 1, channel), texel(1, 1, channel), fx), fy));
  };
  const at = (x, z, tiled) => {
    const u = (0.8 * x + 0.6 * z) * 0.40 + 3.1, v = (-0.6 * x + 0.8 * z) * 0.40 - 2.7;
    return tiled ? sample(u, v) : antiTile(sample, u, v, noise(x * 0.045 - 7, z * 0.045 + 23) * 12);
  };
  let oldDelta = 0, newDelta = 0, count = 0;
  for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++) {
    const x = i * 0.91 - 8, z = j * 0.73 - 9;
    const oldA = at(x, z, true), oldB = at(x + 2, z + 1.5, true);
    const newA = at(x, z, false), newB = at(x + 2, z + 1.5, false);
    for (let channel = 0; channel < 3; channel++) {
      oldDelta += Math.abs(oldA[channel] - oldB[channel]);
      newDelta += Math.abs(newA[channel] - newB[channel]); count++;
    }
  }
  assert.ok(oldDelta / count < 1e-8, 'the reference displacement must be one exact texture period');
  assert.ok(newDelta / count > 0.015, 'random offsets must break the original periodic identity');
  t.diagnostic(`CPU base-level repeat delta: original=${oldDelta / count}, offset blend=${newDelta / count}`);
});

test('new moss and litter weights retain the existing exclusions and winter detail burial', () => {
  const surface = shader.match(/float woodlandSurface = [\s\S]*?;/)?.[0];
  assert.ok(surface);
  assert.match(surface, /shore/); assert.match(surface, /rk/); assert.match(surface, /vRoadDist/);
  assert.match(shader, /float woodlandWeight = forestFloor \* woodlandSurface/);
  assert.match(shader, /float litterWeight = woodlandWeight \* litterShare/);
  assert.match(shader, /float mossWeight = woodlandWeight \* mossShare/);
  assert.match(shader, /mossCol \*= mix\(1\.0, 0\.85 \+ 0\.15 \* coarseGrassGrain, litterExposure\)/);
  assert.match(shader, /turfMicroHeight \*= mix\(1\.0, winterThin, winterAmount\)/);
  assert.match(shader, /litterWeight \* \(1\.0 - snow\) \* litterExposure/);
  assert.match(shader, /float snowGrain = clamp\(0\.88 \+ 0\.06 \* snowMounds \+ 0\.04 \* snowCrust/);
  assert.match(shader, /snowMounds \* 0\.025 \+ snowCrust \* 0\.003, snow/);
  assert.match(shader, /plantContactBounds \* woodlandSurface/);
});

test('turf root occlusion has no model-distance fade and is zero on physical exclusions', () => {
  const contact = shader.match(/float meadowContact = [\s\S]*?;/)?.[0];
  assert.ok(contact);
  assert.doesNotMatch(contact, /grassRoadCoverage|grassViewCoverage|grassModelCoverage|vViewPosition|cameraPosition|Time/);
  assert.match(contact, /meadowSurface \* \(1\.0 - litterWeight - mossWeight\)/);
  assert.match(contact, /\(0\.35 \+ 0\.65 \* understoryGrowth\)/);
  assert.match(contact, /smoothstep\(uRoadScuffInner - 0\.15, uRoadScuffInner \+ 1\.05, vRoadDist\)/);
  const surface = shader.match(/float meadowSurface = [\s\S]*?;/)?.[0];
  assert.ok(surface);
  assert.match(surface, /shore/); assert.match(surface, /rk/); assert.match(surface, /uSnowAmount/);
  const weights = ecosystem(1, 0.6, 0.65, 0.5);
  const growth = smooth(0.18, 0.82, 0.6 * 0.62 + 0.65 * 0.28);
  const occlusion = (road, shore = 0, rock = 0, snow = 0) => weights.turf * (0.35 + 0.65 * growth)
    * smooth(4, 5.2, road) * (1 - shore) * (1 - rock) * (1 - snow);
  const baseline = occlusion(16);
  assert.ok(baseline > 0);
  for (const road of [16, 20, 28, 48, 76, 150, 255]) assert.equal(occlusion(road), baseline);
  assert.equal(occlusion(3.9), 0);
  assert.equal(occlusion(28, 1), 0);
  assert.equal(occlusion(28, 0, 1), 0);
  assert.equal(occlusion(28, 0, 0, 1), 0);
});
