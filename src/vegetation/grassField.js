import * as THREE from 'three';
import { makeRng } from '../core/rng.js';
import { GRASS_COVERAGE, GRASS_COVERAGE_GLSL, grassRoadCoverage, grassViewCoverage, grassWinterExposure } from './grassCoverage.js';
import { SURFACE_HASH_GLSL } from '../core/shaderNoise.js';
import { MEADOW_FIELD_GLSL } from '../terrain/meadowField.js';
import { PASTURE, pastureCoverage } from './pasture.js';

const GRASS_LAYERS = [
  { blades: 24, basalBlades: 18, rows: [0, 0.4, 0.75], height: [0.60, 0.88], halfWidth: [0.038, 0.056], radius: [0.06, 0.62], lean: [0.28, 0.46], shade: 0.88 },
  { blades: 8, rows: [0, 0.4, 0.75], height: [0.60, 0.87], halfWidth: [0.014, 0.025], radius: [0.03, 0.17], lean: [0.25, 0.42], shade: 0.95 },
  { blades: 4, rows: [0, 0.3, 0.58, 0.82], height: [0.65, 0.90], halfWidth: [0.009, 0.018], radius: [0.025, 0.12], lean: [0.23, 0.40], shade: 1 },
];
const STRUCTURE_LEAF = { halfWidth: [0.022, 0.037], radius: [0.025, 0.12], lean: [0.35, 0.58], shade: 0.97 };
const LOCAL_PADDING = 0.16;
export const GRASS_RENDER_CELL = 16;
export const GRASS_DENSITY = Object.freeze({ low: 4, high: 26, minimum: 0.25, transition: 0.04,
  nearStart: 28, nearEnd: 56 });
// Pasture tufts widen their leaves at most this much; the rest of the density
// and detail compensation spreads the tuft footprint instead (GRASS_PASTURE).
export const PASTURE_LEAF_COMPENSATION = 1.8;
// The sparser pasture population keeps a larger far-field share of its tufts.
export const PASTURE_DENSITY_MINIMUM = 0.4;
// Shading/shape response to the shared meadow field. Placement is untouched:
// clusters (~3 m) and lodged swaths only change tint, length and lean.
export const GRASS_SWARD = Object.freeze({ clusterScale: 3.2, clusterHeight: [0.84, 1.04],
  clusterTint: Object.freeze([[0.88, 0.93, 0.90], [1.10, 1.05, 0.86]]), tuftHue: 0.06,
  lodgeLean: 0.16, lodgeShorten: 0.18 });
// Sward light transport at night. The moon reaches lower blade sections
// through the neighbouring blades (Beer-Lambert); its path lengthens as
// 1/sin(elevation), so a low moon lights only the tips, while daylight keeps
// the unattenuated sunlit sward. Moonlit blades lose chroma like the forest
// foliage but keep a dark, warm brown-green rather than a cool grey; the sky
// fill under neighbouring blades falls off toward the roots. The headlight
// shades the photopic albedo.
export const GRASS_LIGHT = Object.freeze({ density: 0.65, freePath: 1.15, minElevation: 0.12,
  scotopic: 0.58, scotopicTint: Object.freeze([1.06, 0.98, 0.84]), nightSkyFill: Object.freeze([0.38, 0.72]) });
// Blade palettes stay separate from the flatter ground palette; the shared
// meadow field (meadowField.js) applies the same patch tint and sheen to both.
// `cured` is sun-dried straw; `curedAmount` scales how many blades per tuft cure.
const GRASS_PALETTES = {
  spring: { lush: [0.075, 0.285, 0.030], dry: [0.220, 0.330, 0.055], tip: [0.550, 0.660, 0.140], seed: [0.24, 0.36, 0.07], seedGrowth: 0.35,
    cured: [0.300, 0.320, 0.090], curedAmount: 0.35 },
  summer: { lush: [0.075, 0.245, 0.024], dry: [0.240, 0.310, 0.055], tip: [0.620, 0.680, 0.140], seed: [0.48, 0.43, 0.16], seedGrowth: 1,
    cured: [0.470, 0.390, 0.125], curedAmount: 0.8 },
  autumn: { lush: [0.160, 0.235, 0.035], dry: [0.340, 0.245, 0.065], tip: [0.620, 0.440, 0.130], seed: [0.49, 0.32, 0.09], seedGrowth: 1,
    cured: [0.500, 0.350, 0.110], curedAmount: 1 },
  winter: { lush: [0.225, 0.235, 0.180], dry: [0.340, 0.310, 0.220], tip: [0.490, 0.480, 0.350], seed: [0.30, 0.26, 0.16], seedGrowth: 0,
    cured: [0.420, 0.370, 0.240], curedAmount: 0.6 },
};
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function grassDensityLimit(pixels, distance = Infinity, minimum = GRASS_DENSITY.minimum) {
  const d = GRASS_DENSITY;
  const density = minimum + (1 + d.transition - minimum) * smoothstep(d.low, d.high, pixels);
  return 1 + d.transition + (density - 1 - d.transition) * smoothstep(d.nearStart, d.nearEnd, distance);
}

export function grassSeedPresence(phase) {
  if (!Number.isFinite(phase)) return 0;
  const cycle = phase / (Math.PI * 2);
  return cycle - Math.floor(cycle) >= 0.70 ? 1 : 0;
}

function worldScaleBound(matrix) {
  const a = matrix.elements;
  const xx = a[0] ** 2 + a[1] ** 2 + a[2] ** 2;
  const yy = a[4] ** 2 + a[5] ** 2 + a[6] ** 2;
  const zz = a[8] ** 2 + a[9] ** 2 + a[10] ** 2;
  const xy = Math.abs(a[0] * a[4] + a[1] * a[5] + a[2] * a[6]);
  const xz = Math.abs(a[0] * a[8] + a[1] * a[9] + a[2] * a[10]);
  const yz = Math.abs(a[4] * a[8] + a[5] * a[9] + a[6] * a[10]);
  return Math.sqrt(Math.max(xx + xy + xz, yy + xy + yz, zz + xz + yz));
}

export function grassLodWeights(projectedPixels, distance, roadCoverage = 1) {
  const near = smoothstep(16, 34, projectedPixels);
  const mid = smoothstep(6, 15, projectedPixels);
  return {
    near, mid,
    width: grassViewCoverage(distance) * smoothstep(1.1, 3, projectedPixels) * roadCoverage,
    compensation: 1 + (1 - mid) * 0.45 + (1 - near) * 0.15,
    wind: smoothstep(4, 12, projectedPixels),
  };
}

/** Persistent basal leaves and full-height structure; later bands add detail, not silhouette. */
export function createGrassGeometry() {
  const rng = makeRng(0x62a8f3);
  const positions = [], centers = [], roots = [], parameters = [], colors = [], indices = [];
  const layers = [], range = values => values[0] + rng() * (values[1] - values[0]);
  let bladeCount = 0;
  for (let band = 0; band < GRASS_LAYERS.length; band++) {
    const layer = GRASS_LAYERS[band], vertexStart = positions.length / 3, indexStart = indices.length;
    for (let blade = 0; blade < layer.blades; blade++, bladeCount++) {
      const basal = band === 0 && blade < layer.basalBlades, structure = band === 0 && !basal;
      const coreMiddle = basal && blade < 6;
      const role = basal && !coreMiddle ? 0 : structure ? 1 : 2, profile = structure ? STRUCTURE_LEAF : layer;
      const angle = (structure ? (blade - layer.basalBlades) * Math.PI / 3 : bladeCount * 2.399963)
        + (rng() - 0.5) * (structure ? 0.35 : 0.75);
      const rootRadius = (basal
        ? Math.sqrt((blade + 0.35 + rng() * 0.30) / layer.basalBlades) * layer.radius[1] : range(profile.radius)) * (coreMiddle ? 0.45 : 1);
      const rootX = Math.cos(angle) * rootRadius, rootZ = Math.sin(angle) * rootRadius;
      const droop = basal ? 0.30 + rng() * 0.20 : structure ? 0.18 + rng() * 0.12 : 0.12 + rng() * 0.14;
      const height = structure
        ? (blade === layer.basalBlades ? 1 : 0.88 + rng() * 0.10) / (1 - droop) : range(layer.height);
      const lean = range(profile.lean), halfWidth = range(profile.halfWidth);
      const bend = angle + (rng() - 0.5) * (basal ? 0.85 : 0.65);
      const curl = (rng() - 0.5) * (basal ? 0.055 : 0.11);
      const twist = (rng() - 0.5) * 0.80;
      const variation = 0.90 + rng() * 0.16;
      const bladeSeed = rng(), first = positions.length / 3;
      const arched = coreMiddle || structure && (blade - layer.basalBlades) % 3 !== 1;
      const peakHeight = coreMiddle ? 0.65 + 0.17 * (height - layer.height[0]) / (layer.height[1] - layer.height[0]) : height * (1 - droop);
      const tipHeight = coreMiddle ? peakHeight * (0.90 - (droop - 0.30) / 0.20 * 0.08)
        : arched ? peakHeight * (0.90 - (droop - 0.18) / 0.12 * 0.10) : peakHeight;
      for (const t of layer.rows) {
        const curve = lean * t * t, sideways = curl * t * t * t;
        const x = rootX + Math.cos(bend) * curve - Math.sin(bend) * sideways;
        const y = arched ? peakHeight * Math.sin(Math.PI * 0.5 * t / 0.75) : height * (t - droop * t * t * t);
        const z = rootZ + Math.sin(bend) * curve + Math.cos(bend) * sideways;
        const orientation = bend + twist * t;
        const width = halfWidth * (0.22 + 1.20 * Math.sin(Math.PI * t)) * (1 - t);
        for (const side of [-1, 1]) {
          positions.push(x - Math.sin(orientation) * width * side, y, z + Math.cos(orientation) * width * side);
          centers.push(x, y, z);
          roots.push(rootX, 0, rootZ);
          parameters.push(t, band, bladeSeed, role);
          // Dark, self-shadowed roots and lit tips (about the same mid-blade mean) so
          // tufts read as volume against the turf rather than as a flat carpet.
          const light = (0.34 + 0.58 * smoothstep(0, 0.9, t)) * variation * profile.shade * (side < 0 ? 0.92 : 1.04);
          colors.push(light * (1 + t * 0.035), light, light * (0.94 - t * 0.035));
        }
      }
      const tip = [rootX + Math.cos(bend) * lean - Math.sin(bend) * curl,
        tipHeight, rootZ + Math.sin(bend) * lean + Math.cos(bend) * curl];
      positions.push(...tip); centers.push(...tip); parameters.push(1, band, bladeSeed, role);
      roots.push(rootX, 0, rootZ);
      const tipLight = variation * profile.shade;
      colors.push(tipLight * 0.92, tipLight * 0.89, tipLight * 0.82);
      for (let row = 0; row < layer.rows.length - 1; row++) {
        const at = first + row * 2;
        indices.push(at, at + 1, at + 2, at + 1, at + 3, at + 2);
      }
      const last = first + (layer.rows.length - 1) * 2;
      indices.push(last, last + 1, last + 2);
    }
    layers.push(Object.freeze({ band, bladeCount: layer.blades, verticesPerBlade: layer.rows.length * 2 + 1,
      basalBladeCount: band === 0 ? layer.basalBlades - 6 : 0, middleBladeCount: band === 0 ? 6 : 0,
      structureBladeCount: band === 0 ? layer.blades - layer.basalBlades : 0,
      basalVertexStart: band === 0 ? vertexStart + 6 * (layer.rows.length * 2 + 1) : null,
      structureVertexStart: band === 0 ? vertexStart + layer.basalBlades * (layer.rows.length * 2 + 1) : null,
      vertexStart, vertexCount: positions.length / 3 - vertexStart,
      leafVertexCount: positions.length / 3 - vertexStart, leafIndexCount: indices.length - indexStart,
      indexStart, indexCount: indices.length - indexStart, prefixCount: indices.length }));
  }
  let top = 0, radius = 0;
  for (let i = 0; i < positions.length; i += 3) {
    top = Math.max(top, positions[i + 1]);
    radius = Math.max(radius, Math.hypot(positions[i], positions[i + 2]));
  }
  // Records describe metres, not scale multipliers for an arbitrary template.
  // Keep the root origin fixed while making height=1 and radial diameter=1.
  for (const array of [positions, centers, roots]) for (let i = 0; i < array.length; i += 3) {
    array[i] /= 2 * radius; array[i + 1] /= top; array[i + 2] /= 2 * radius;
  }
  // Replace two near-only leaves with one small panicle, keeping their 14-triangle budget.
  const seedStart = positions.length / 3, seedIndexStart = indices.length;
  const seedRoot = [0.03, 0, -0.025], stemRows = [0, 0.5, 0.82, 0.93];
  const stemCenter = t => [seedRoot[0] + 0.13 * t * t, 0.88 * t, seedRoot[2] + 0.045 * t * t];
  const seedVertex = (point, center, t, role, light) => {
    positions.push(...point); centers.push(...center); roots.push(...seedRoot);
    parameters.push(t, 2, 0.371, role);
    colors.push(light, light * 0.98, light * 0.90);
  };
  for (const t of stemRows) {
    const center = stemCenter(t), width = 0.0019 * (1 - t * 0.55);
    for (const side of [-1, 1]) {
      seedVertex([center[0] + width * side, center[1], center[2]], center, t, 3, 0.52 + t * 0.32);
    }
  }
  const stemTip = stemCenter(1);
  seedVertex(stemTip, stemTip, 1, 3, 0.84);
  for (let row = 0; row < 3; row++) {
    const at = seedStart + row * 2;
    indices.push(at, at + 1, at + 2, at + 1, at + 3, at + 2);
  }
  indices.push(seedStart + 6, seedStart + 7, seedStart + 8);
  for (let branch = 0; branch < 7; branch++) {
    const terminal = branch === 6, t = terminal ? 1 : [0.82, 0.93, 1][Math.floor(branch / 2)];
    const center = stemCenter(t), angle = 0.65 + (branch % 2) * Math.PI + (Math.floor(branch / 2) - 1) * 0.23;
    const length = terminal ? 0.006 : 0.025 + (branch % 3) * 0.004;
    const width = terminal ? 0.0016 : 0.0018 + (branch % 2) * 0.0003;
    const tip = [center[0] + Math.cos(angle) * length,
      terminal ? 0.90 : center[1] + (branch % 2 ? 0.009 : 0.017), center[2] + Math.sin(angle) * length];
    const first = positions.length / 3, light = 0.82 + (branch % 3) * 0.03;
    for (const side of [-1, 1]) {
      seedVertex([center[0] - Math.sin(angle) * width * side, center[1], center[2] + Math.cos(angle) * width * side], center, t, 4, light);
    }
    seedVertex(tip, tip, Math.min(1, tip[1] / 0.88), 4, light);
    indices.push(first, first + 1, first + 2);
  }
  const seedHead = Object.freeze({ vertexStart: seedStart, vertexCount: 30, indexStart: seedIndexStart, indexCount: 42,
    stemVertexCount: 9, stemIndexCount: 21, spikeletCount: 7, rootVertexCount: 2, maxHeight: 0.90 });
  const nearLayer = layers[2];
  layers[2] = Object.freeze({ ...nearLayer, vertexCount: positions.length / 3 - nearLayer.vertexStart,
    indexCount: indices.length - nearLayer.indexStart, prefixCount: indices.length, seedHead });
  const geometry = tuftGeometry('field-grass-thirty-six-leaf-panicle', { positions, centers, roots, parameters, colors, indices });
  geometry.userData.grassLayout = Object.freeze({ bladeCount, rootVertexCount: bladeCount * 2 + 2, seedStemCount: 1, seedHead,
    basalBladeCount: layers[0].basalBladeCount, coreMiddleBladeCount: layers[0].middleBladeCount, structureBladeCount: layers[0].structureBladeCount,
    vertexCount: positions.length / 3, triangleCount: indices.length / 3,
    prefixIndices: Object.freeze(layers.map(layer => layer.prefixCount)), layers: Object.freeze(layers) });
  return geometry;
}

/** Shared blade attributes, upward-biased normals and a rotation-safe bound. */
function tuftGeometry(name, { positions, centers, roots, parameters, colors, indices }) {
  const geometry = new THREE.BufferGeometry();
  geometry.name = name;
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aBladeCenter', new THREE.Float32BufferAttribute(centers, 3));
  geometry.setAttribute('aBladeRoot', new THREE.Float32BufferAttribute(roots, 3));
  geometry.setAttribute('aBladeParam', new THREE.Float32BufferAttribute(parameters, 4));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const normals = geometry.getAttribute('normal'), n = new THREE.Vector3();
  for (let i = 0; i < normals.count; i++) {
    n.fromBufferAttribute(normals, i).set(n.x * 0.65, 0.52 + Math.abs(n.y) * 0.35, n.z * 0.65).normalize();
    normals.setXYZ(i, n.x, n.y, n.z);
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  // Bound every root-centered blade rotation, including its winter ground projection.
  const position = geometry.getAttribute('position'), root = geometry.getAttribute('aBladeRoot');
  const sphere = geometry.boundingSphere;
  for (let i = 0; i < position.count; i++) {
    const horizontal = Math.hypot(root.getX(i) - sphere.center.x, root.getZ(i) - sphere.center.z)
      + Math.hypot(position.getX(i) - root.getX(i), position.getZ(i) - root.getZ(i));
    const vertical = Math.max(Math.abs(sphere.center.y), Math.abs(position.getY(i) - sphere.center.y));
    sphere.radius = Math.max(sphere.radius, Math.hypot(horizontal, vertical));
  }
  geometry.boundingSphere.radius += LOCAL_PADDING;
  geometry.userData.cullerPadding = LOCAL_PADDING;
  return geometry;
}

// Open-pasture tuft (pasture.js): nine slender, upright three-triangle leaves
// rooted across the whole footprint persist at any range; ten finer curved
// leaves only render above ~16 px (shader band 2, the roadside near-detail
// band). Spread roots and little lean keep a patch of standing grass rather
// than a flat rosette when seen from above. Same attributes and shader as the
// roadside tuft, so palette, straw, meadow field, wind, snow and lighting match.
const PASTURE_BANDS = [
  { detail: 0, blades: 9, structure: 3, rows: [0, 0.55], height: [0.62, 1.0], halfWidth: [0.034, 0.048],
    radius: 0.42, lean: [0.06, 0.16], droop: [0.04, 0.14], shade: 0.90 },
  { detail: 2, blades: 10, structure: 0, rows: [0, 0.4, 0.75], height: [0.50, 0.92], halfWidth: [0.020, 0.032],
    radius: 0.44, lean: [0.06, 0.18], droop: [0.08, 0.20], shade: 0.96 },
];

export function createPastureGeometry() {
  const rng = makeRng(0x3a91c7), range = values => values[0] + rng() * (values[1] - values[0]);
  const positions = [], centers = [], roots = [], parameters = [], colors = [], indices = [], prefix = [];
  let bladeCount = 0;
  for (let band = 0; band < PASTURE_BANDS.length; band++) {
    const layer = PASTURE_BANDS[band];
    for (let blade = 0; blade < layer.blades; blade++, bladeCount++) {
      // Structure leaves survive snow like the roadside tuft's central arches.
      const structure = blade < layer.structure, role = band === 0 ? (structure ? 1 : 0) : 2;
      const angle = bladeCount * 2.399963 + (rng() - 0.5) * 0.6;
      const rootRadius = Math.sqrt(rng()) * layer.radius * (structure ? 0.35 : 1);
      const rootX = Math.cos(angle) * rootRadius, rootZ = Math.sin(angle) * rootRadius;
      const height = range(layer.height), lean = range(layer.lean) * (structure ? 0.55 : 1);
      const halfWidth = range(layer.halfWidth), droop = range(layer.droop);
      const bend = angle + (rng() - 0.5) * 1.4, twist = (rng() - 0.5) * 0.8;
      const variation = 0.90 + rng() * 0.16, bladeSeed = rng(), first = positions.length / 3;
      for (const t of layer.rows) {
        const curve = lean * t * t, y = height * (t - droop * t * t * t);
        const x = rootX + Math.cos(bend) * curve, z = rootZ + Math.sin(bend) * curve;
        const orientation = bend + twist * t, width = halfWidth * (0.75 + 0.60 * Math.sin(Math.PI * t)) * (1 - 0.6 * t);
        for (const side of [-1, 1]) {
          positions.push(x - Math.sin(orientation) * width * side, y, z + Math.cos(orientation) * width * side);
          centers.push(x, y, z);
          roots.push(rootX, 0, rootZ);
          parameters.push(t, layer.detail, bladeSeed, role);
          const light = (0.34 + 0.58 * smoothstep(0, 0.9, t)) * variation * layer.shade * (side < 0 ? 0.92 : 1.04);
          colors.push(light * (1 + t * 0.035), light, light * (0.94 - t * 0.035));
        }
      }
      const tip = [rootX + Math.cos(bend) * lean, height * (1 - droop), rootZ + Math.sin(bend) * lean];
      positions.push(...tip); centers.push(...tip); roots.push(rootX, 0, rootZ);
      parameters.push(1, layer.detail, bladeSeed, role);
      const tipLight = variation * layer.shade;
      colors.push(tipLight * 0.92, tipLight * 0.89, tipLight * 0.82);
      for (let row = 0; row < layer.rows.length - 1; row++) {
        const at = first + row * 2;
        indices.push(at, at + 1, at + 2, at + 1, at + 3, at + 2);
      }
      const last = first + (layer.rows.length - 1) * 2;
      indices.push(last, last + 1, last + 2);
    }
    prefix.push(indices.length);
  }
  let top = 0, radius = 0;
  for (let i = 0; i < positions.length; i += 3) {
    top = Math.max(top, positions[i + 1]);
    radius = Math.max(radius, Math.hypot(positions[i], positions[i + 2]));
  }
  // Height=1 and radial diameter=1, like the roadside template.
  for (const array of [positions, centers, roots]) for (let i = 0; i < array.length; i += 3) {
    array[i] /= 2 * radius; array[i + 1] /= top; array[i + 2] /= 2 * radius;
  }
  const geometry = tuftGeometry('field-grass-pasture-tuft', { positions, centers, roots, parameters, colors, indices });
  geometry.userData.grassLayout = Object.freeze({ bladeCount, vertexCount: positions.length / 3,
    triangleCount: indices.length / 3, prefixIndices: Object.freeze([prefix[0], prefix[0], prefix[1]]) });
  return geometry;
}

const VERTEX_HEAD = /* glsl */`
attribute vec3 aBladeCenter;
attribute vec3 aBladeRoot;
attribute vec4 aBladeParam;
attribute vec4 iGrassStyle;
attribute float iGrassRoad;
attribute float iGrassMaturity;
attribute float iGrassRank;
uniform float uGrassTime;
uniform float uGrassFocalPixels;
uniform vec3 uGrassLush;
uniform vec3 uGrassDry;
uniform vec3 uGrassTip;
uniform float uGrassRegionalWarmth;
uniform vec3 uGrassSeedTint;
uniform float uGrassSeedGrowth;
uniform float uGrassSnow;
uniform float uGrassDensity;
uniform vec3 uGrassCured;
uniform float uGrassCuredAmount;
varying float vGrassHeight;
` + GRASS_COVERAGE_GLSL + SURFACE_HASH_GLSL + MEADOW_FIELD_GLSL;

const VERTEX_BODY = /* glsl */`
  vec3 grassRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float grassDistance = length(grassRoot - cameraPosition);
  float grassHeight = length((modelMatrix * instanceMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  float grassPixels = grassHeight * uGrassFocalPixels / max(grassDistance, 1.0);
  float nearDetail = smoothstep(16.0, 34.0, grassPixels);
  float midDetail = smoothstep(6.0, 15.0, grassPixels);
  float detail = aBladeParam.y < 0.5 ? 1.0 : (aBladeParam.y < 1.5 ? midDetail : nearDetail);
  if (aBladeParam.w < 0.5 || aBladeParam.w > 1.5) detail *= 1.0 - uGrassSnow;
  if (aBladeParam.w > 2.5) detail *= iGrassMaturity * uGrassSeedGrowth;
  float farWidth = grassViewCoverage(grassDistance) * smoothstep(1.1, 3.0, grassPixels) * iGrassRoad;
  // Winter: only scattered tufts in the densest clumps break the snowpack;
  // metre-scale cells thin each patch so it never reads as a hard-edged mat.
  float grassWinterTuft = grassWinterExposure(iGrassStyle.z) * smoothstep(0.45, 0.80, surfaceHash(floor(grassRoot.xz * 0.85)));
#ifdef GRASS_PASTURE
  grassWinterTuft = 0.0;   // open pasture lies buried under the snow
#endif
  farWidth *= mix(1.0, grassWinterTuft, uGrassSnow);
  float widthCompensation = 1.0 + (1.0 - midDetail) * 0.45 + (1.0 - nearDetail) * 0.15;
#ifdef GRASS_PASTURE
  float grassDensityMinimum = ${PASTURE_DENSITY_MINIMUM.toFixed(2)};
#else
  float grassDensityMinimum = ${GRASS_DENSITY.minimum.toFixed(2)};
#endif
  float density = grassDensityMinimum + (${(1 + GRASS_DENSITY.transition).toFixed(2)} - grassDensityMinimum)
    * smoothstep(${GRASS_DENSITY.low.toFixed(1)}, ${GRASS_DENSITY.high.toFixed(1)}, grassPixels);
  density = mix(${(1 + GRASS_DENSITY.transition).toFixed(2)}, density,
    smoothstep(${GRASS_DENSITY.nearStart.toFixed(1)}, ${GRASS_DENSITY.nearEnd.toFixed(1)}, grassDistance));
  float densityEnabled = step(0.0, iGrassRank) * uGrassDensity;
  farWidth *= mix(1.0, 1.0 - smoothstep(density - ${GRASS_DENSITY.transition.toFixed(2)}, density, iGrassRank), densityEnabled);
  widthCompensation *= mix(1.0, 1.0 / clamp(density - ${(GRASS_DENSITY.transition / 2).toFixed(2)}, 0.25, 1.0), densityEnabled);
  // Open-pasture tufts keep their leaves slender and instead spread their
  // footprint to restore coverage, so the far sward reads as fine streaks
  // rather than a field of separate fattened blobs.
#ifdef GRASS_PASTURE
  float grassLeafCompensation = min(widthCompensation, ${PASTURE_LEAF_COMPENSATION.toFixed(2)});
  float grassSpread = sqrt(widthCompensation / grassLeafCompensation);
#else
  float grassLeafCompensation = widthCompensation;
#endif
  transformed = aBladeCenter + (transformed - aBladeCenter) * detail * grassLeafCompensation * farWidth;
  vec3 grassShapeOffset = transformed - aBladeRoot;
  grassShapeOffset.xz = mat2(grassShapeRotation.x, grassShapeRotation.y, -grassShapeRotation.y, grassShapeRotation.x)
    * grassShapeOffset.xz * grassShapeLean;
  grassShapeOffset.y *= grassShapeLength;
  // Through the road-coverage fade tufts also shorten into the turf, so the
  // thinning edge does not leave a scatter of needle-thin full-height blades.
  grassShapeOffset *= mix(0.22, 1.0, smoothstep(0.0, 0.85, iGrassRoad));
  transformed = aBladeRoot + grassShapeOffset;
#ifdef GRASS_PASTURE
  transformed.xz *= grassSpread;
#endif
  float winterHeight = aBladeParam.w < 0.5 ? 0.12 : (aBladeParam.w < 1.5 ? 0.42 : 0.24);
  transformed.y *= mix(1.0, winterHeight * (0.88 + 0.12 * grassBladeVariation), uGrassSnow);
  transformed.xz += vec2(0.56, 0.83) * uGrassSnow * 0.04 * aBladeParam.x * aBladeParam.x;
  // Lodged swaths lay the upper blade down the shared world wind direction,
  // mapped into this instance's yawed frame; roots stay where they were placed.
  mat4 grassWorld = modelMatrix * instanceMatrix;
  vec2 grassLodgeLocal = vec2(dot(MEADOW_WIND, normalize(grassWorld[0].xz)), dot(MEADOW_WIND, normalize(grassWorld[2].xz)))
    * grassHeight / max(length(grassWorld[0].xyz), 0.05);
  transformed.xz += grassLodgeLocal * ${GRASS_SWARD.lodgeLean.toFixed(3)} * grassSward.z * aBladeParam.x * aBladeParam.x
    * mix(1.0, 0.5, uGrassSnow);
  float grassPhase = uGrassTime * 0.8 + grassRoot.x * 0.025 + grassRoot.z * 0.019 + iGrassStyle.w * 0.18;
  float grassWind = (sin(grassPhase) + 0.24 * sin(grassPhase * 1.63)) * 0.036;
  grassWind *= aBladeParam.x * aBladeParam.x * smoothstep(4.0, 12.0, grassPixels) * mix(1.0, 0.25, uGrassSnow);
  transformed.xz += vec2(0.765, 0.644) * grassWind;
`;

const SPOT_DIRECT = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
const DIRECTIONAL_INFO = 'getDirectionalLightInfo( directionalLight, directLight );';

// Spot lights (the headlight) shade the photopic albedo; directional key
// lights are attenuated by the sward transmittance. Unrolled loops: no declarations.
function grassLightsChunk() {
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  const spot = chunk.indexOf('#if ( NUM_SPOT_LIGHTS > 0 )');
  const spotCall = spot < 0 ? -1 : chunk.indexOf(SPOT_DIRECT, spot);
  const directional = chunk.indexOf('#if ( NUM_DIR_LIGHTS > 0 )');
  const directionalInfo = directional < 0 ? -1 : chunk.indexOf(DIRECTIONAL_INFO, directional);
  if (spotCall < 0 || directionalInfo < spotCall) throw new Error('three.js lights_fragment_begin layout changed');
  const infoEnd = directionalInfo + DIRECTIONAL_INFO.length;
  return `${chunk.slice(0, spotCall)}
    material.diffuseColor += grassPhotopicShift;
    ${SPOT_DIRECT}
    material.diffuseColor -= grassPhotopicShift;
  ${chunk.slice(spotCall + SPOT_DIRECT.length, infoEnd)}
    directLight.color *= grassKeyTransmit;
  ${chunk.slice(infoEnd)}`;
}

export class GrassField {
  constructor(atmo) {
    this.atmo = atmo;
    this.geometry = createGrassGeometry();
    this.pastureGeometry = createPastureGeometry();
    this.cellRendering = true;
    this.meshes = new Set();
    this.uniforms = {
      uGrassTime: { value: 0 },
      uGrassFocalPixels: { value: 900 },
      uGrassLush: { value: new THREE.Color(...GRASS_PALETTES.summer.lush) },
      uGrassDry: { value: new THREE.Color(...GRASS_PALETTES.summer.dry) },
      uGrassTip: { value: new THREE.Color(...GRASS_PALETTES.summer.tip) },
      uGrassRegionalWarmth: { value: 1 },
      uGrassSeedTint: { value: new THREE.Color(...GRASS_PALETTES.summer.seed) },
      uGrassSeedGrowth: { value: GRASS_PALETTES.summer.seedGrowth },
      uGrassSnow: { value: 0 },
      uGrassDensity: { value: 1 },
      uGrassCured: { value: new THREE.Color(...GRASS_PALETTES.summer.cured) },
      uGrassCuredAmount: { value: GRASS_PALETTES.summer.curedAmount },
      uGrassWrap: { value: 0.025 },
      uGrassNight: { value: 0 },
      uGrassKeyElevation: { value: 1 },
    };
    this.material = new THREE.MeshStandardMaterial({
      name: 'field-grass', vertexColors: true, roughness: 0.97,
      metalness: 0, side: THREE.DoubleSide, transparent: false, depthWrite: true,
    });
    this.material.userData.uniforms = this.uniforms;
    this._compile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + VERTEX_HEAD)
        .replace('#include <color_vertex>', `#include <color_vertex>
          float grassBladeVariation = sin(iGrassStyle.w + aBladeParam.z * 6.2831853);
          // Shared meadow field at the tuft root plus a ~3 m cluster octave.
          vec3 grassFieldRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vec3 grassSward = meadowSward(grassFieldRoot.xz, iGrassStyle.x, 1.0);
          float grassCluster = meadowNoise(grassFieldRoot.xz * ${(1 / GRASS_SWARD.clusterScale).toFixed(5)} + vec2(17.3, -5.1));
          float grassClusterHeight = (${GRASS_SWARD.clusterHeight[0].toFixed(3)} + ${(GRASS_SWARD.clusterHeight[1] - GRASS_SWARD.clusterHeight[0]).toFixed(3)} * grassCluster)
            * (1.0 - ${GRASS_SWARD.lodgeShorten.toFixed(3)} * grassSward.z);
          float grassTuftLean = sin(iGrassStyle.w * 0.61) * 0.28;
          float grassShapeAngle = grassTuftLean + grassBladeVariation * 0.22;
          vec2 grassShapeRotation = vec2(cos(grassShapeAngle), sin(grassShapeAngle));
          float grassShapeLength = (0.90 + 0.10 * (0.65 * (0.5 + 0.5 * sin(iGrassStyle.w * 0.73))
            + 0.35 * (0.5 + 0.5 * sin(iGrassStyle.w * 0.73 + aBladeParam.z * 17.17)))) * grassClusterHeight;
          float grassShapeLean = 0.84 + 0.16 * (0.5 + 0.5 * grassBladeVariation);
          vec3 grassTint = mix(uGrassDry, uGrassLush, clamp(iGrassStyle.x * 0.86 + 0.08, 0.0, 1.0));
          float grassTip = smoothstep(0.42, 1.0, aBladeParam.x);
          float grassWarmth = grassTip * (0.36 + (1.0 - clamp(iGrassStyle.x, 0.0, 1.0)) * 0.26);
          // Spring/summer tips stay greener in moist, shaded swards; dry hay retains warmth.
          // Reuse the regional field, bounded to 0.55–1.0; other seasons retain their palette response.
          float grassRegionalWarmth = 0.55 + 0.45 * clamp(0.35 + grassSward.x * 0.65 - grassSward.y * 0.35
            + (1.0 - clamp(iGrassStyle.x, 0.0, 1.0)) * 0.30 - clamp(iGrassStyle.y, 0.0, 1.0) * 0.35, 0.0, 1.0);
          grassWarmth *= mix(1.0, grassRegionalWarmth, uGrassRegionalWarmth);
          grassTint = mix(grassTint, uGrassTip, grassWarmth);
          // Cured straw blades mixed through green tufts. The share rises in hay
          // patches, dry ground and per tuft; each blade rolls independently, so
          // one clump carries both golden and green leaves. Toward the outer
          // coverage edge the sward turns short and green like the turf it meets.
          float grassCuredShare = clamp(0.06 + grassSward.x * 0.42 + (1.0 - clamp(iGrassStyle.x, 0.0, 1.0)) * 0.30
            + (0.5 + 0.5 * sin(iGrassStyle.w * 1.37 + 2.1)) * 0.28 - grassSward.y * 0.22, 0.0, 0.92)
            * smoothstep(0.25, 0.90, iGrassRoad);
          float grassBladeRoll = 0.5 + 0.5 * sin(aBladeParam.z * 47.3 + iGrassStyle.w * 2.93);
          float grassCured = smoothstep(grassBladeRoll - 0.10, grassBladeRoll + 0.10, grassCuredShare) * uGrassCuredAmount;
          grassTint = mix(grassTint, uGrassCured * (0.86 + 0.24 * grassTip), grassCured);
          grassTint *= (0.90 + iGrassStyle.z * 0.20) * (1.0 - iGrassStyle.y * 0.16) * (1.0 + grassBladeVariation * 0.065);
          // Same patch tint and lodged sheen as the turf, then cluster and per-tuft hue.
          grassTint *= meadowTint(grassSward) * meadowSheen(grassFieldRoot.xz, cameraPosition, grassSward.z);
          grassTint *= mix(vec3(${GRASS_SWARD.clusterTint[0].map(v => v.toFixed(2)).join(', ')}),
            vec3(${GRASS_SWARD.clusterTint[1].map(v => v.toFixed(2)).join(', ')}), grassCluster);
          grassTint *= 1.0 + vec3(${GRASS_SWARD.tuftHue.toFixed(3)}, 0.0, ${(-1.6 * GRASS_SWARD.tuftHue).toFixed(3)}) * sin(iGrassStyle.w * 2.31 + 0.7);
          float grassFrost = (aBladeParam.w < 0.5 ? 0.62 : (aBladeParam.w < 1.5 ? 0.16 : 0.40))
            * (0.72 + clamp(iGrassStyle.z, 0.0, 1.0) * 0.28) * (0.75 + 0.25 * grassTip);
          grassTint = mix(grassTint, vec3(0.69, 0.74, 0.75), uGrassSnow * grassFrost);
          if (aBladeParam.w > 2.5) grassTint = mix(grassTint, uGrassSeedTint, aBladeParam.w > 3.5 ? 0.85 : 0.32);
          vColor.rgb *= grassTint;
          // Lower blade sections sit inside the snowpack, so tufts emerge from it
          // instead of standing on top of a grey plane.
          vColor.rgb = mix(vColor.rgb, vec3(0.80, 0.84, 0.88), uGrassSnow * (1.0 - smoothstep(0.08, 0.42, aBladeParam.x)) * 0.85);
          vGrassHeight = aBladeParam.x;`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          objectNormal.xz = mat2(grassShapeRotation.x, grassShapeRotation.y, -grassShapeRotation.y, grassShapeRotation.x)
            * objectNormal.xz / grassShapeLean;
          objectNormal.y /= grassShapeLength;`)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERTEX_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uGrassWrap;
          uniform float uGrassNight;
          uniform float uGrassKeyElevation;
          varying float vGrassHeight;`)
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);')
        .replace('#include <lights_physical_fragment>', `
          // Scotopic vision: moonlit blades lose chroma toward a warm, dark
          // straw-brown; the removed albedo is restored only for the headlight.
          float grassNightLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          vec3 grassPhotopicColor = diffuseColor.rgb;
          diffuseColor.rgb = mix(diffuseColor.rgb, grassNightLuma * vec3(${GRASS_LIGHT.scotopicTint.map(v => v.toFixed(2)).join(', ')}),
            ${GRASS_LIGHT.scotopic.toFixed(2)} * uGrassNight);
          #include <lights_physical_fragment>
          vec3 grassPhotopicShift = (grassPhotopicColor - diffuseColor.rgb) * (1.0 - metalnessFactor);
          // Sward transmittance of the key light; daylight keeps the sunlit sward.
          float grassKeyTransmit = exp(-${GRASS_LIGHT.density.toFixed(2)} * (1.0 - clamp(vGrassHeight, 0.0, 1.0))
            * max(0.0, 1.0 / max(uGrassKeyElevation, ${GRASS_LIGHT.minElevation.toFixed(2)}) - ${GRASS_LIGHT.freePath.toFixed(2)}) * uGrassNight);`)
        .replace('#include <lights_fragment_begin>', grassLightsChunk())
        .replace('#include <aomap_fragment>', `
          // Night sky fill reaches the lower blades only through the sward.
          reflectedLight.indirectDiffuse *= mix(1.0, mix(${GRASS_LIGHT.nightSkyFill[0].toFixed(2)}, ${GRASS_LIGHT.nightSkyFill[1].toFixed(2)},
            smoothstep(0.0, 1.0, vGrassHeight)), uGrassNight);
          #include <aomap_fragment>`)
        .replace('#include <opaque_fragment>', `
          outgoingLight += diffuseColor.rgb * uGrassWrap * (0.7 + 0.3 * (1.0 - abs(dot(normal, normalize(vViewPosition)))));
          #include <opaque_fragment>`);
    };
    this.material.onBeforeCompile = this._compile;
    this.material.customProgramCacheKey = () => 'field-grass-cell-density-v17';
    this.pastureMaterial = null;
    atmo?.register?.(this.material);
  }

  /** Open-pasture variant, created on first use: the same program plus the GRASS_PASTURE footprint spread. */
  _pastureMaterial() {
    if (this.pastureMaterial) return this.pastureMaterial;
    const material = this.material.clone();
    material.name = 'field-grass-pasture';
    material.defines = { GRASS_PASTURE: '' };
    material.userData = { uniforms: this.uniforms };
    material.onBeforeCompile = this._compile;
    material.customProgramCacheKey = () => 'field-grass-pasture-cell-density-v1';
    this.atmo?.register?.(material);
    return (this.pastureMaterial = material);
  }

  build(records) {
    const iterator = this.buildSteps(records);
    let step;
    do { step = iterator.next(); } while (!step.done);
    return step.value;
  }

  /** `pasture` builds open-pasture records (pasture.js) with the low-triangle tuft. */
  *buildCellsSteps(records, pasture = false) {
    const cellSize = pasture ? PASTURE.renderCell : GRASS_RENDER_CELL;
    const cells = new Map(), meshes = [];
    let completed = false;
    try {
      for (let i = 0; i < records.length; i++) {
        if (i > 0 && i % 128 === 0) yield;
        const record = records[i];
        const key = `${Math.floor(record.x / cellSize)}:${Math.floor(record.z / cellSize)}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(record);
      }
      for (const cell of cells.values()) {
        cell.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
        const built = yield* this.buildSteps(cell, true, pasture);
        for (const mesh of built) {
          // Small static cells avoid per-frame instance compaction and uploads.
          mesh.userData.batchCullOnly = true;
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrix();
          meshes.push(mesh);
        }
        yield;
      }
      completed = true;
      return meshes;
    } finally {
      if (!completed) for (const mesh of meshes) this.disposeMesh(mesh);
    }
  }

  *buildSteps(records, densityLod = false, pasture = false) {
    densityLod = densityLod === true;
    if (this.disposed || !records.length) return [];
    const template = pasture ? this.pastureGeometry : this.geometry;
    const geometry = new THREE.BufferGeometry();
    geometry.name = pasture ? 'field-grass-pasture-population' : 'field-grass-population';
    for (const [name, attribute] of Object.entries(template.attributes)) geometry.setAttribute(name, attribute);
    geometry.setIndex(template.index);
    geometry.boundingSphere = template.boundingSphere;
    geometry.boundingBox = template.boundingBox;
    geometry.userData.grassLayout = template.userData.grassLayout;
    const style = new Float32Array(records.length * 4);
    geometry.setAttribute('iGrassStyle', new THREE.InstancedBufferAttribute(style, 4));
    const road = new Float32Array(records.length);
    geometry.setAttribute('iGrassRoad', new THREE.InstancedBufferAttribute(road, 1));
    const maturity = new Float32Array(records.length);
    geometry.setAttribute('iGrassMaturity', new THREE.InstancedBufferAttribute(maturity, 1));
    const ranks = new Float32Array(records.length);
    geometry.setAttribute('iGrassRank', new THREE.InstancedBufferAttribute(ranks, 1));
    const mesh = new THREE.InstancedMesh(geometry, pasture ? this._pastureMaterial() : this.material, records.length);
    mesh.name = pasture ? 'field-grass-pasture' : 'field-grass';
    mesh.addEventListener('dispose', () => this.meshes.delete(mesh));
    this.meshes.add(mesh);
    let completed = false;
    try {
      const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), ground = new THREE.Quaternion();
      const position = new THREE.Vector3(), scale = new THREE.Vector3(), normal = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      const rootBounds = new THREE.Box3(), worldRootBounds = new THREE.Box3(), eye = new THREE.Vector3();
      let maxHeight = 0, maxScale = 0, hasRoadCoverage = false, hasWinterCoverage = false;
      for (let i = 0; i < records.length; i++) {
        if (i > 0 && i % 128 === 0) yield;
        const record = records[i];
        position.set(record.x, record.surfaceY ?? record.y, record.z);
        if (densityLod) position.set(Math.fround(position.x), Math.fround(position.y), Math.fround(position.z));
        normal.set(-(record.surfaceDx ?? record.groundDx ?? 0), 1, -(record.surfaceDz ?? record.groundDz ?? 0)).normalize();
        ground.setFromUnitVectors(up, normal);
        rotation.setFromAxisAngle(up, record.yaw || 0).premultiply(ground);
        const height = Math.max(0.05, record.height ?? 0.65), width = Math.max(0.05, record.width ?? 1);
        rootBounds.expandByPoint(position);
        maxHeight = Math.max(maxHeight, height);
        maxScale = Math.max(maxScale, height, width);
        scale.set(width, height, width);
        matrix.compose(position, rotation, scale);
        mesh.setMatrixAt(i, matrix);
        style.set([record.moisture ?? 0.5, record.cover ?? 0, record.clump ?? record.rank ?? 0.5, record.phase ?? 0], i * 4);
        road[i] = pasture ? pastureCoverage(record.roadDist, record.clump ?? 0.5)
          : record.roadDist == null ? 1 : grassRoadCoverage(record.roadDist, record.clump ?? 0.5);
        maturity[i] = grassSeedPresence(record.phase ?? 0);
        ranks[i] = densityLod ? record.rank ?? 0 : -1;
        hasRoadCoverage ||= road[i] > 0;
        hasWinterCoverage ||= road[i] > 0 && grassWinterExposure(style[i * 4 + 2]) > 0;
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.boundingSphere = new THREE.Sphere();
      const instanceSphere = new THREE.Sphere();
      for (let i = 0; i < records.length; i++) {
        if (i % 128 === 0) yield;
        mesh.getMatrixAt(i, matrix);
        instanceSphere.copy(geometry.boundingSphere).applyMatrix4(matrix);
        mesh.boundingSphere.union(instanceSphere);
      }
      mesh.userData.population = { kind: 'grass', ids: records.map(record => record.id) };
      mesh.userData.populationIds = mesh.userData.population.ids;
      const prefixHeights = densityLod ? new Float32Array(records.length) : null;
      if (densityLod) for (let i = 0; i < records.length; i++) {
        prefixHeights[i] = Math.max(prefixHeights[i - 1] || 0, Math.max(0.05, records[i].height ?? 0.65));
      }
      mesh.userData.cullerPadding = LOCAL_PADDING;
      // Width compensation reaches 4x in the far field; only leaf half-widths
      // expand, so this also conservatively encloses those wider ribbons.
      // Pasture tufts instead spread their footprint up to sqrt(6.4 / 1.8) ~ 1.9x.
      mesh.userData.batchCullPadding = maxScale * (pasture ? 0.7 : 0.4);
      mesh.userData.instanceVisibilityVersion = 0;
      mesh.onBeforeRender = (_renderer, _scene, camera, drawGeometry) => {
        worldRootBounds.copy(rootBounds).applyMatrix4(mesh.matrixWorld);
        eye.setFromMatrixPosition(camera.matrixWorld);
        const nearest = worldRootBounds.distanceToPoint(eye);
        const scaleBound = worldScaleBound(mesh.matrixWorld);
        const largestHeight = maxHeight * scaleBound;
        const pixels = largestHeight * this.uniforms.uGrassFocalPixels.value / Math.max(nearest, 1);
        let drawnPixels = pixels;
        if (densityLod) {
          const limit = this.uniforms.uGrassDensity.value === 1
            ? grassDensityLimit(pixels, nearest, pasture ? PASTURE_DENSITY_MINIMUM : GRASS_DENSITY.minimum) + 0.001 : 2;
          let low = 0, high = records.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (ranks[middle] <= limit) low = middle + 1; else high = middle;
          }
          mesh.count = low;
          drawnPixels = (prefixHeights[low - 1] || 0) * scaleBound * this.uniforms.uGrassFocalPixels.value / Math.max(nearest, 1);
        }
        // Omit only shader-collapsed bands, on the actual (possibly packed) draw wrapper.
        const prefix = drawnPixels < 5.99 ? 0 : drawnPixels < 15.99 ? 1 : 2;
        drawGeometry.setDrawRange(0, geometry.userData.grassLayout.prefixIndices[prefix]);
      };
      if (densityLod) mesh.onAfterRender = () => { mesh.count = records.length; };
      mesh.userData.batchVisible = (camera) => {
        if (!hasRoadCoverage) return false;
        if (this.uniforms.uGrassSnow.value === 1 && (pasture || !hasWinterCoverage)) return false;
        worldRootBounds.copy(rootBounds).applyMatrix4(mesh.matrixWorld);
        eye.setFromMatrixPosition(camera.matrixWorld);
        const nearest = worldRootBounds.distanceToPoint(eye);
        if (nearest >= GRASS_COVERAGE.viewEnd + 0.005) return false;
        const largestHeight = maxHeight * worldScaleBound(mesh.matrixWorld);
        return largestHeight * this.uniforms.uGrassFocalPixels.value / Math.max(nearest, 1) >= 1.099;
      };
      mesh.userData.instanceVisible = (index, camera) => {
        if (mesh.geometry.getAttribute('iGrassRoad').getX(index) <= 0) return false;
        if (this.uniforms.uGrassSnow.value === 1 && (pasture || grassWinterExposure(mesh.geometry.getAttribute('iGrassStyle').getZ(index)) === 0)) return false;
        const instance = mesh.instanceMatrix.array, at = index * 16, m = mesh.matrixWorld.elements;
        const x = instance[at + 12], y = instance[at + 13], z = instance[at + 14];
        const view = camera.matrixWorld.elements;
        const dx = m[0] * x + m[4] * y + m[8] * z + m[12] - view[12];
        const dy = m[1] * x + m[5] * y + m[9] * z + m[13] - view[13];
        const dz = m[2] * x + m[6] * y + m[10] * z + m[14] - view[14];
        const distance = Math.hypot(dx, dy, dz);
        if (distance >= GRASS_COVERAGE.viewEnd + 0.005) return false;
        const ux = instance[at + 4], uy = instance[at + 5], uz = instance[at + 6];
        const h = Math.hypot(m[0] * ux + m[4] * uy + m[8] * uz,
          m[1] * ux + m[5] * uy + m[9] * uz, m[2] * ux + m[6] * uy + m[10] * uz);
        return h * this.uniforms.uGrassFocalPixels.value / Math.max(distance, 1) >= 1.099;
      };
      completed = true;
      return [mesh];
    } finally {
      if (!completed) this.disposeMesh(mesh);
    }
  }

  update(camera, time, seasonName, viewportHeight) {
    this.uniforms.uGrassTime.value = Number.isFinite(time) ? time : 0;
    const height = Math.max(1, Number.isFinite(viewportHeight) ? viewportHeight : 900);
    const focal = height * Math.abs(camera?.projectionMatrix?.elements[5] ?? 2) / 2;
    const snow = seasonName === 'winter' ? 1 : 0;
    if (focal !== this.uniforms.uGrassFocalPixels.value || snow !== this.uniforms.uGrassSnow.value) {
      this.uniforms.uGrassFocalPixels.value = focal;
      this.uniforms.uGrassSnow.value = snow;
      for (const mesh of this.meshes) mesh.userData.instanceVisibilityVersion++;
    }
    const palette = GRASS_PALETTES[Object.hasOwn(GRASS_PALETTES, seasonName) ? seasonName : 'summer'];
    this.uniforms.uGrassLush.value.setRGB(...palette.lush);
    this.uniforms.uGrassDry.value.setRGB(...palette.dry);
    this.uniforms.uGrassTip.value.setRGB(...palette.tip);
    this.uniforms.uGrassRegionalWarmth.value = palette === GRASS_PALETTES.spring || palette === GRASS_PALETTES.summer ? 1 : 0;
    this.uniforms.uGrassSeedTint.value.setRGB(...palette.seed);
    this.uniforms.uGrassSeedGrowth.value = palette.seedGrowth;
    this.uniforms.uGrassCured.value.setRGB(...palette.cured);
    this.uniforms.uGrassCuredAmount.value = palette.curedAmount;
    // Key-light (sun or moon) elevation drives the sward transmittance; the
    // wrap term models sunlit translucency and is absent under moonlight.
    const atmoPalette = this.atmo?.palette, daylight = (atmoPalette?.dayness ?? 1) > 0.02;
    const keyDirection = daylight ? this.atmo?.sunDir : this.atmo?.moonDir;
    this.uniforms.uGrassNight.value = Math.min(1, Math.max(0, atmoPalette?.nightness ?? 0));
    this.uniforms.uGrassKeyElevation.value = Number.isFinite(keyDirection?.y) ? keyDirection.y : 1;
    this.uniforms.uGrassWrap.value = daylight ? Math.min(0.04, Math.max(0, this.atmo?.sun?.intensity ?? 1) * 0.012) : 0;
  }

  disposeMesh(mesh) {
    if (!this.meshes.has(mesh)) return;
    mesh.removeFromParent();
    for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
      if (!attribute.isInstancedBufferAttribute) mesh.geometry.deleteAttribute(name);
    }
    mesh.geometry.setIndex(null);
    mesh.geometry.dispose();
    mesh.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of this.meshes) this.disposeMesh(mesh);
    this.geometry.dispose();
    this.pastureGeometry.dispose();
    this.material.dispose();
    this.pastureMaterial?.dispose();
  }
}
