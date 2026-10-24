import * as THREE from 'three';

export function alphaCoverage(data, cutoff = 0.32, scale = 1) {
  let covered = 0;
  for (let i = 3; i < data.length; i += 4) if (Math.min(255, Math.round(data[i] * scale)) >= cutoff * 255) covered++;
  return covered / (data.length / 4);
}

const LINEAR = Float32Array.from({ length: 256 }, (_, n) => {
  const value = n / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
});
const encode = (value) => Math.round(255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055));
const NEIGHBORS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/** MSAA resolves opaque samples against transparent black in linear light. */
export function unpremultiplyResolvedPixels(pixels, { linear = false } = {}) {
  const result = new Uint8Array(pixels);
  for (let i = 0; i < result.length; i += 4) {
    const alpha = result[i + 3] / 255;
    if (alpha <= 0 || alpha >= 1) continue;
    for (let channel = 0; channel < 3; channel++) result[i + channel] = linear
      ? Math.min(255, Math.round(result[i + channel] / alpha))
      : encode(Math.min(1, LINEAR[result[i + channel]] / alpha));
  }
  return result;
}

function dilateEdgeColors(data, width, height) {
  const source = new Uint8Array(data);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (source[i + 3] !== 0) continue;
    let weight = 0, r = 0, g = 0, b = 0;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const j = (ny * width + nx) * 4, alpha = source[j + 3];
      if (alpha === 0) continue;
      weight += alpha; r += LINEAR[source[j]] * alpha; g += LINEAR[source[j + 1]] * alpha; b += LINEAR[source[j + 2]] * alpha;
    }
    if (weight > 0) { data[i] = encode(r / weight); data[i + 1] = encode(g / weight); data[i + 2] = encode(b / weight); }
  }
}

/** Average premultiplied, linear-light colors, then preserve cutout coverage. */
export function buildCoverageMips(pixels, width, height, cutoff = 0.32) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || pixels.length !== width * height * 4) {
    throw new Error('Invalid foliage RGBA image dimensions');
  }
  const levels = [{ data: new Uint8Array(pixels), width, height }];
  const coverage = alphaCoverage(pixels, cutoff);
  while (width > 1 || height > 1) {
    const previous = levels[levels.length - 1];
    const nextWidth = Math.max(1, Math.floor(width / 2));
    const nextHeight = Math.max(1, Math.floor(height / 2));
    const data = new Uint8Array(nextWidth * nextHeight * 4);
    for (let y = 0; y < nextHeight; y++) for (let x = 0; x < nextWidth; x++) {
      let r = 0, g = 0, b = 0, a = 0, samples = 0;
      const xEnd = Math.floor((x + 1) * width / nextWidth);
      const yEnd = Math.floor((y + 1) * height / nextHeight);
      for (let sy = Math.floor(y * height / nextHeight); sy < yEnd; sy++) {
        for (let sx = Math.floor(x * width / nextWidth); sx < xEnd; sx++) {
          const i = (sy * width + sx) * 4;
          const alpha = previous.data[i + 3] / 255;
          r += LINEAR[previous.data[i]] * alpha;
          g += LINEAR[previous.data[i + 1]] * alpha;
          b += LINEAR[previous.data[i + 2]] * alpha;
          a += alpha;
          samples++;
        }
      }
      const i = (y * nextWidth + x) * 4;
      if (a > 0) {
        data[i] = encode(r / a); data[i + 1] = encode(g / a); data[i + 2] = encode(b / a);
      }
      data[i + 3] = Math.round(a / samples * 255);
    }
    // An alpha histogram makes the coverage search O(256), not 16 full image
    // scans. Large source leaf maps otherwise stall the main thread at boot.
    const histogram = new Uint32Array(257);
    for (let i = 3; i < data.length; i += 4) histogram[data[i]]++;
    for (let alpha = 254; alpha >= 0; alpha--) histogram[alpha] += histogram[alpha + 1];
    const coverageAt = scale => histogram[Math.min(256, Math.max(0, Math.ceil((Math.ceil(cutoff * 255) - 0.5) / scale)))] / (data.length / 4);
    let low = 0, high = 8, best = 1;
    let error = Math.abs(coverageAt(1) - coverage);
    for (let iteration = 0; iteration < 16; iteration++) {
      const scale = (low + high) / 2;
      const current = coverageAt(scale);
      const difference = Math.abs(current - coverage);
      if (difference < error || (difference === error && Math.abs(scale - 1) < Math.abs(best - 1))) {
        error = difference; best = scale;
      }
      if (current < coverage) low = scale; else high = scale;
    }
    for (let i = 3; i < data.length; i += 4) data[i] = Math.min(255, Math.round(data[i] * best));
    levels.push({ data, width: nextWidth, height: nextHeight });
    width = nextWidth; height = nextHeight;
  }
  for (const level of levels) dilateEdgeColors(level.data, level.width, level.height);
  return levels;
}

function buildAtlasMips(pixels, width, height, columns, rows, build) {
  const cellWidth = width / columns, cellHeight = height / rows;
  const powerOfTwo = value => Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
  if (!powerOfTwo(cellWidth) || !powerOfTwo(cellHeight)) throw new Error('Foliage atlas cells must have power-of-two dimensions');
  const cells = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const data = new Uint8Array(cellWidth * cellHeight * 4);
    for (let row = 0; row < cellHeight; row++) {
      const start = ((y * cellHeight + row) * width + x * cellWidth) * 4;
      data.set(pixels.subarray(start, start + cellWidth * 4), row * cellWidth * 4);
    }
    cells.push(build(data, cellWidth, cellHeight));
  }
  const levels = [];
  for (let level = 0; level < cells[0].length; level++) {
    const cell = cells[0][level];
    const levelWidth = cell.width * columns, levelHeight = cell.height * rows;
    const data = new Uint8Array(levelWidth * levelHeight * 4);
    cells.forEach((chain, index) => {
      const mip = chain[level], x = index % columns, y = Math.floor(index / columns);
      for (let row = 0; row < mip.height; row++) {
        data.set(mip.data.subarray(row * mip.width * 4, (row + 1) * mip.width * 4),
          ((y * mip.height + row) * levelWidth + x * mip.width) * 4);
      }
    });
    levels.push({ data, width: levelWidth, height: levelHeight });
  }
  const last = levels[levels.length - 1];
  // Complete the texture mip chain. The atlas sampler clamps its footprint
  // before these cross-cell levels, including under anisotropic filtering.
  levels.push(...build(last.data, last.width, last.height).slice(1));
  return levels;
}

export function buildAtlasCoverageMips(pixels, width, height, columns, rows, cutoff = 0.32) {
  return buildAtlasMips(pixels, width, height, columns, rows, (data, w, h) => buildCoverageMips(data, w, h, cutoff));
}

function storeNormal(data, i, x, y, z) {
  const length = Math.hypot(x, y, z);
  if (length < 1e-5) { x = 0; y = 1; z = 0; }
  else { x /= length; y /= length; z /= length; }
  data[i] = Math.round((x * 0.5 + 0.5) * 255);
  data[i + 1] = Math.round((y * 0.5 + 0.5) * 255);
  data[i + 2] = Math.round((z * 0.5 + 0.5) * 255);
}

/** Object-space vectors stay linear and are normalized after alpha-weighted filtering. */
export function buildNormalMips(pixels, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || pixels.length !== width * height * 4) {
    throw new Error('Invalid foliage normal image dimensions');
  }
  const base = new Uint8Array(pixels);
  for (let i = 0; i < base.length; i += 4) {
    if (base[i + 3] > 0) storeNormal(base, i, base[i] / 127.5 - 1, base[i + 1] / 127.5 - 1, base[i + 2] / 127.5 - 1);
  }
  const levels = [{ data: base, width, height }];
  while (width > 1 || height > 1) {
    const previous = levels[levels.length - 1];
    const nextWidth = Math.max(1, Math.floor(width / 2)), nextHeight = Math.max(1, Math.floor(height / 2));
    const data = new Uint8Array(nextWidth * nextHeight * 4);
    for (let y = 0; y < nextHeight; y++) for (let x = 0; x < nextWidth; x++) {
      let nx = 0, ny = 0, nz = 0, alpha = 0, samples = 0;
      for (let sy = Math.floor(y * height / nextHeight); sy < Math.floor((y + 1) * height / nextHeight); sy++) {
        for (let sx = Math.floor(x * width / nextWidth); sx < Math.floor((x + 1) * width / nextWidth); sx++) {
          const i = (sy * width + sx) * 4, weight = previous.data[i + 3];
          nx += (previous.data[i] / 127.5 - 1) * weight;
          ny += (previous.data[i + 1] / 127.5 - 1) * weight;
          nz += (previous.data[i + 2] / 127.5 - 1) * weight;
          alpha += weight; samples++;
        }
      }
      const i = (y * nextWidth + x) * 4;
      storeNormal(data, i, nx, ny, nz);
      data[i + 3] = Math.round(alpha / samples);
    }
    levels.push({ data, width: nextWidth, height: nextHeight });
    width = nextWidth; height = nextHeight;
  }
  for (const level of levels) {
    const source = new Uint8Array(level.data);
    for (let y = 0; y < level.height; y++) for (let x = 0; x < level.width; x++) {
      const i = (y * level.width + x) * 4;
      if (source[i + 3] > 0) continue;
      let nx = 0, ny = 0, nz = 0;
      for (const [dx, dy] of NEIGHBORS) {
        const sx = x + dx, sy = y + dy;
        if (sx < 0 || sx >= level.width || sy < 0 || sy >= level.height) continue;
        const j = (sy * level.width + sx) * 4, weight = source[j + 3];
        nx += (source[j] / 127.5 - 1) * weight;
        ny += (source[j + 1] / 127.5 - 1) * weight;
        nz += (source[j + 2] / 127.5 - 1) * weight;
      }
      storeNormal(level.data, i, nx, ny, nz);
    }
  }
  return levels;
}

export function createNormalTexture(pixels, width, height, { atlasColumns = 1, atlasRows = 1 } = {}) {
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
  texture.mipmaps = atlasColumns > 1 || atlasRows > 1
    ? buildAtlasMips(pixels, width, height, atlasColumns, atlasRows, buildNormalMips)
    : buildNormalMips(pixels, width, height);
  texture.image = texture.mipmaps[0];
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

export function createCoverageTexture(pixels, width, height, { cutoff = 0.32, flipY = false, anisotropy = 4,
  atlasColumns = 1, atlasRows = 1 } = {}) {
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
  texture.mipmaps = atlasColumns > 1 || atlasRows > 1
    ? buildAtlasCoverageMips(pixels, width, height, atlasColumns, atlasRows, cutoff)
    : buildCoverageMips(pixels, width, height, cutoff);
  texture.image = texture.mipmaps[0];
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = flipY;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

export function coverageTextureFromImage(texture, cutoff = 0.32) {
  const source = texture.image;
  const canvas = document.createElement('canvas');
  canvas.width = source.width; canvas.height = source.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, source.width, source.height);
  const result = createCoverageTexture(image.data, source.width, source.height, { cutoff, flipY: texture.flipY });
  result.wrapS = texture.wrapS; result.wrapT = texture.wrapT;
  result.name = `${texture.name || 'foliage'}-coverage-mips`;
  return result;
}
