import * as THREE from 'three';
import { loadFoliageAssets } from './foliageAssets.js';
import { TERRAIN } from '../terrain/params.js';
import { farRidgeShape, farRidgeEnvelope, farRidgeOffset, farRidgeGlsl } from '../terrain/farRidge.js';
import { TREE_SPECIES, isEvergreenSpecies } from './treeSpecies.js';
import { shrubVariant } from './params.js';
const IDENTITY_MATRIX = new THREE.Matrix4();

export const FOREST_LOD = Object.freeze({ tree: { low: 160, high: 260, fadeStart: 1800, fadeEnd: 2000 },
  shrub: { low: 60, high: 110, fadeStart: 190, fadeEnd: 220 } });
export const MIDSTORY = Object.freeze({ minimumHeight: 2.5, maximumHeight: 4.5, maximumRadius: 2.75 });
const smoothstep = (a, b, value) => { const t = Math.max(0, Math.min(1, (value - a) / (b - a))); return t * t * (3 - 2 * t); };
const ridgePadding = distance => TERRAIN.farRidgeAmp * smoothstep(TERRAIN.farRidgeNear, TERRAIN.farRidgeFar, distance);

// Reuse the tint slot for a world-fixed ecological signal: wet, closed stands
// stay darker/cooler than dry edges, with only 15% individual variation. This is
// render-only: rank, dimensions, population and near/far visibility are untouched.
function foliageTintFactor(record) {
  const cover = Math.max(0, Math.min(1, record.cover ?? 0.5));
  const moisture = Math.max(0, Math.min(1, record.moisture ?? 0.5));
  const variation = Math.max(0, Math.min(1, record.rank ?? 0.5));
  return (1 - cover) * 0.55 + (1 - moisture) * 0.30 + variation * 0.15;
}

export function foliageCoverage(projectedHeight, kind = 'tree') {
  const { low, high } = FOREST_LOD[kind];
  const blend = smoothstep(low, high, projectedHeight);
  return { near: Math.min(1, blend * 2), far: Math.min(1, (1 - blend) * 2) };
}

export function foliageRenderDimensions(record, template) {
  const original = { height: record.height * (template?.heightScale ?? 1), width: record.width, midstory: false };
  if (template?.kind !== 'shrub' || template.growthForm !== 'woody' || record.kind === 'tree' ||
      !Number.isFinite(record.cover) || !Number.isFinite(record.rank)) return original;
  const cover = Math.max(0, Math.min(1, record.cover));
  if (record.rank < 0 || record.rank >= 0.30 + 0.06 * cover) return original;
  const size = Math.max(0, Math.min(1, record.height - 0.65));
  const moisture = Number.isFinite(record.moisture) ? Math.max(0, Math.min(1, record.moisture)) : 0.5;
  // R13: dry, open edges retain a lower woody layer; moist, closed stands
  // retain the existing upper envelope. Membership and root placement stay fixed.
  const vigor = smoothstep(0, 1, cover * 0.55 + moisture * 0.45);
  const fullHeight = MIDSTORY.minimumHeight + (MIDSTORY.maximumHeight - MIDSTORY.minimumHeight) * size;
  const height = fullHeight * (0.66 + 0.34 * vigor);
  const shape = template.impostor.shape;
  // The baked radius covers every yaw/view, unlike half the axis-aligned width.
  const sway = 0.012 * Math.max(1, shape.top) ** 2;
  const safeWidth = MIDSTORY.maximumRadius * shape.width / (shape.radius + sway);
  // Scale the pre-existing crown envelope, shared by geometry and impostors,
  // rather than widening shorter plants or changing fern dimensions.
  const width = Math.min(Math.max(record.width * 1.5, fullHeight * 0.70), safeWidth) * (0.76 + 0.24 * vigor);
  return { height, width, midstory: true };
}

export function projectedPlantHeight(record, camera, pixelScale, template) {
  const { height } = foliageRenderDimensions(record, template);
  const lift = foliageRidgeOffset(record.x, record.z, camera.position.x, camera.position.z, record.y, camera.position.y);
  const distance = Math.hypot(record.x - camera.position.x, record.y + lift + height * 0.5 - camera.position.y, record.z - camera.position.z);
  return height * pixelScale / Math.max(0.5, distance);
}

// Shrub keys and winter burial share worker-safe variant metadata.
export function foliageTemplateKey(record, kind = 'tree') {
  if (kind === 'tree') return Object.hasOwn(TREE_SPECIES, record.species) ? record.species : 'oak';
  return shrubVariant(record).key;
}

// Mirrors terrain's visual-only far ridge lift, which is not in its height sampler.
// `y` is the plant root height; the lift only depends on it through height above the eye.
export function foliageRidgeOffset(x, z, cameraX, cameraZ, y = 0, cameraY = 0) {
  return farRidgeOffset(x, z, y, cameraX, cameraY, cameraZ);
}

function createVisibilityCache(population, bounds, sphere, heights) {
  const ridges = new Float64Array(population.length).fill(NaN);
  const pixels = new Float64Array(population.length);
  const versions = new Uint32Array(population.length);
  return {
    x: NaN, y: NaN, z: NaN, pixelScale: NaN, version: 0, distance: 0, horizontalDistance: 0,
    update(camera, pixelScale) {
      const { x, y, z } = camera.position;
      if (x !== this.x || y !== this.y || z !== this.z || pixelScale !== this.pixelScale) {
        this.x = x; this.y = y; this.z = z; this.pixelScale = pixelScale;
        if (++this.version > 0xffffffff) { versions.fill(0); this.version = 1; }
        this.distance = sphere.center.distanceTo(camera.position);
        this.horizontalDistance = Math.hypot(Math.max(bounds.min.x - x, 0, x - bounds.max.x),
          Math.max(bounds.min.z - z, 0, z - bounds.max.z));
      }
      return this;
    },
    projected(index) {
      if (versions[index] !== this.version) {
        const record = population[index];
        const horizontal = Math.hypot(record.x - this.x, record.z - this.z);
        let lift = 0;
        if (horizontal > TERRAIN.farRidgeNear) {
          if (Number.isNaN(ridges[index])) ridges[index] = farRidgeShape(record.x, record.z);
          const envelope = farRidgeEnvelope(horizontal, record.y - this.y);
          lift = envelope === 0 ? 0 : ridges[index] * envelope;
        }
        const height = heights[index];
        const distance = Math.hypot(record.x - this.x, record.y + lift + height * 0.5 - this.y, record.z - this.z);
        pixels[index] = height * this.pixelScale / Math.max(0.5, distance);
        versions[index] = this.version;
      }
      return pixels[index];
    },
  };
}

export const FOLIAGE_RIDGE_GLSL = `${farRidgeGlsl()}
  float foliageRidgeOffset(vec3 root) { return farRidgeLift(root); }
`;

function sharedGeometry(source) {
  const geometry = new THREE.BufferGeometry();
  try {
    for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, attribute);
    geometry.setIndex(source.index);
    geometry.boundingBox = source.boundingBox?.clone() || null;
    geometry.boundingSphere = source.boundingSphere?.clone() || null;
    return geometry;
  } catch (error) { disposeFieldGeometry(geometry); throw error; }
}

function disposeFieldGeometry(geometry) {
  // Wrappers borrow authored attributes; only their per-instance data is owned.
  for (const name of Object.keys(geometry.attributes)) if (name !== 'iFoliage') geometry.deleteAttribute(name);
  geometry.setIndex(null);
  geometry.dispose();
}

function billboardGeometry(shape) {
  const geometry = new THREE.PlaneGeometry(shape.radius * 2, shape.top - shape.bottom);
  geometry.translate(0, (shape.top + shape.bottom) * 0.5, 0);
  geometry.computeBoundingSphere();
  return geometry;
}

export async function warmupFoliagePrograms(renderer, targetScene, templates, materials, billboards) {
  if (typeof renderer?.compileAsync !== 'function' || !targetScene) return;
  const group = new THREE.Group(), camera = new THREE.PerspectiveCamera(54), owned = [];
  try {
    for (const [key, template] of templates) for (const part of ['bark', 'leaf', 'impostor']) {
      const source = part === 'impostor' ? billboards.get(key) : template.parts[part];
      const geometry = sharedGeometry(source), entry = { geometry, mesh: null };
      owned.push(entry);
      geometry.setAttribute('iFoliage', new THREE.InstancedBufferAttribute(new Float32Array([1, 0, 0, 0.5]), 4));
      const mesh = entry.mesh = new THREE.InstancedMesh(geometry, materials.get(key)[part], 1);
      mesh.castShadow = false; mesh.receiveShadow = false; mesh.frustumCulled = false;
      group.add(mesh);
    }
    // The detached meshes select the real instancing programs without entering the population.
    await renderer.compileAsync(group, camera, targetScene);
  } finally {
    for (const { mesh, geometry } of owned) {
      mesh?.removeFromParent(); disposeFieldGeometry(geometry); mesh?.dispose();
    }
  }
}

// Crown ellipsoid (radius, centre height, half height) in template space,
// measured once per template from its foliage part.
const crownShapes = new WeakMap();
function foliageCrownShape(template) {
  if (crownShapes.has(template)) return crownShapes.get(template);
  const shape = template.impostor.shape, crown = template.parts.leaf;
  let radius = shape.radius, bottom = 0.35 * shape.top, top = shape.top;
  const position = crown?.getAttribute?.('position');
  if (position?.count) {
    crown.computeBoundingBox();
    let leafRadius = 0;
    for (let i = 0; i < position.count; i++) leafRadius = Math.max(leafRadius, Math.hypot(position.getX(i), position.getZ(i)));
    radius = leafRadius; bottom = crown.boundingBox.min.y; top = crown.boundingBox.max.y;
  }
  const value = new THREE.Vector4(Math.max(0.05, radius), (bottom + top) * 0.5, Math.max(0.05, (top - bottom) * 0.5), 0);
  crownShapes.set(template, value);
  return value;
}

const SPOT_DIRECT = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';

// Spot lights (the headlight) are kept out of the key-light crown term: they
// shade the photopic albedo, take the crown hull facing their own direction,
// and are added back after the key/sky occlusion. Unrolled loop: no declarations.
function foliageLightsChunk(crownWeight) {
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  const spot = chunk.indexOf('#if ( NUM_SPOT_LIGHTS > 0 )');
  const call = spot < 0 ? -1 : chunk.indexOf(SPOT_DIRECT, spot);
  if (call < 0) throw new Error('three.js lights_fragment_begin has no spot RE_Direct call to wrap');
  return `${chunk.slice(0, call)}
    foliageSpotBase = reflectedLight.directDiffuse;
    directLight.color *= mix(1.0, smoothstep(-0.40, 0.60, dot(normalize(vFoliageHull),
      inverseTransformDirection(directLight.direction, viewMatrix))) * (1.0 - 0.65 * foliageInterior), ${crownWeight.toFixed(2)});
    material.diffuseColor += foliagePhotopicShift;
    ${SPOT_DIRECT}
    material.diffuseColor -= foliagePhotopicShift;
    foliageSpotDiffuse += reflectedLight.directDiffuse - foliageSpotBase;
    reflectedLight.directDiffuse = foliageSpotBase;
  ${chunk.slice(call + SPOT_DIRECT.length)}`;
}

export function makeFoliageMaterial(template, part, uniforms, atmo) {
  const far = part === 'impostor';
  const leaf = part === 'leaf';
  const evergreen = isEvergreenSpecies(template.species);
  const autumn = template.growthForm === 'fern' ? [[0.37, 0.21, 0.045], [0.66, 0.48, 0.12]]
    : template.growthForm === 'tussock' ? [[0.46, 0.33, 0.13], [0.74, 0.58, 0.30]] : {
    oak: [[0.36, 0.105, 0.024], [0.58, 0.29, 0.050]],
    birch: [[0.46, 0.22, 0.028], [0.68, 0.45, 0.065]],
    aspen: [[0.48, 0.27, 0.032], [0.72, 0.52, 0.085]],
    maple: [[0.38, 0.045, 0.020], [0.66, 0.22, 0.038]],
  }[template.species] || [[0.36, 0.105, 0.024], [0.58, 0.29, 0.050]];
  const woody = template.kind === 'shrub' && (template.growthForm === 'woody' || template.growthForm === 'flowering');
  const material = new THREE.MeshStandardMaterial({ name: `field-${template.kind}-${template.name}-${part}`,
    map: far ? template.impostor.texture : template.maps[part], roughness: 0.96,
    color: new THREE.Color().setRGB(...(!far && template.tints?.[part] || [1, 1, 1])),
    vertexColors: !far && Boolean(template.parts[part]?.getAttribute?.('color')),
    side: template.singleSided && !far ? THREE.FrontSide : THREE.DoubleSide, alphaTest: leaf || far ? 0.32 : 0.01, alphaToCoverage: true,
    transparent: false, depthWrite: true });
  const range = FOREST_LOD[template.kind];
  const lod = { value: new THREE.Vector4(range.low, range.high, range.fadeStart, range.fadeEnd) };
  const normalMap = { value: template.impostor.normalTexture };
  const crown = { value: foliageCrownShape(template) };
  material.userData.uniforms = uniforms;
  material.userData.foliageTemplate = template;
  material.userData.foliagePart = part;
  material.userData.foliageNormalMap = normalMap;
  Object.defineProperties(material.userData, {
    foliageLodRange: { value: range, enumerable: true },
    foliageLodUniform: { value: lod, enumerable: true },
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uFoliageLod: lod, uFoliageNormalMap: normalMap, uFoliageCrown: crown });
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
      attribute vec4 iFoliage;
      uniform float uFoliageTime;
      uniform float uFoliagePixelScale;
      uniform vec4 uFoliageLod;
      uniform vec4 uFoliageCrown;
      varying float vFoliageCoverage;
      varying float vFoliageView;
      varying float vFoliageTint;
      varying float vFoliageGroundHeight;
      varying float vFoliageCanopyHeight;
      varying float vFoliageCrownDepth;
      varying vec3 vFoliageHull;
      varying vec4 vFoliageCluster;
      float foliageAngle;
      ${far ? 'varying mat3 vFoliageNormalTransform;' : ''}
      ${FOLIAGE_RIDGE_GLSL}
    `).replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
      vec3 foliageRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      float foliageLift = foliageRidgeOffset(foliageRoot);
      foliageRoot.y += foliageLift;
      vec3 foliageToEye = cameraPosition - foliageRoot;
      foliageAngle = atan(foliageToEye.x, foliageToEye.z) - iFoliage.y;
      ${far ? `vFoliageNormalTransform = normalMatrix * mat3(
        instanceMatrix[0].xyz / dot(instanceMatrix[0].xyz, instanceMatrix[0].xyz),
        instanceMatrix[1].xyz / dot(instanceMatrix[1].xyz, instanceMatrix[1].xyz),
        instanceMatrix[2].xyz / dot(instanceMatrix[2].xyz, instanceMatrix[2].xyz));` : ''}
    `).replace('#include <begin_vertex>', `#include <begin_vertex>
      float foliageDistance = length(foliageToEye - vec3(0.0, iFoliage.x * 0.5, 0.0));
      float foliagePixels = iFoliage.x * uFoliagePixelScale / max(0.5, foliageDistance);
      float foliageBlend = smoothstep(uFoliageLod.x, uFoliageLod.y, foliagePixels);
      vFoliageCoverage = ${far ? 'min(1.0, (1.0 - foliageBlend) * 2.0)' : 'min(1.0, foliageBlend * 2.0)'};
      vFoliageCoverage *= 1.0 - smoothstep(uFoliageLod.z, uFoliageLod.w, foliageDistance);
      vFoliageView = mod(foliageAngle / 6.28318530718 + 1.0, 1.0) * 8.0;
      vFoliageTint = 0.86 + iFoliage.w * 0.20;
      vFoliageGroundHeight = position.y * iFoliage.x;
      vFoliageCanopyHeight = clamp(position.y, 0.0, 1.0);
      // Crown-scale ellipsoid coordinates: the cards have no self-shadowing, so
      // depth into the crown and the hull normal stand in for canopy occlusion.
      ${far ? `
      float foliageHullX = position.x / uFoliageCrown.x;
      float foliageHullY = (position.y - uFoliageCrown.y) / uFoliageCrown.z;
      float foliageHullZ = sqrt(max(0.0, 1.0 - foliageHullX * foliageHullX - foliageHullY * foliageHullY));
      float foliageHullC = cos(foliageAngle), foliageHullS = sin(foliageAngle);
      vec3 foliageHullLocal = vec3(foliageHullX * foliageHullC + foliageHullZ * foliageHullS, foliageHullY,
        -foliageHullX * foliageHullS + foliageHullZ * foliageHullC);
      // Billboards only show the crown's outer surface; keep their mean occlusion
      // equal to the visible outer leaves of the near model.
      vFoliageCrownDepth = mix(0.82, 1.0, smoothstep(0.5, 1.0, length(vec2(foliageHullX, foliageHullY))));
      vFoliageCluster = vec4(foliageHullX, foliageHullY, 0.0, iFoliage.z);` : `
      vec3 foliageHullLocal = vec3(position.x / uFoliageCrown.x, (position.y - uFoliageCrown.y) / uFoliageCrown.z,
        position.z / uFoliageCrown.x);
      vFoliageCrownDepth = length(foliageHullLocal);
      vFoliageCluster = vec4(foliageHullLocal, iFoliage.z);`}
      vec3 foliageHullGradient = foliageHullLocal / uFoliageCrown.xzx;
      vFoliageHull = mat3(modelMatrix) * (
        instanceMatrix[0].xyz * foliageHullGradient.x / dot(instanceMatrix[0].xyz, instanceMatrix[0].xyz) +
        instanceMatrix[1].xyz * foliageHullGradient.y / dot(instanceMatrix[1].xyz, instanceMatrix[1].xyz) +
        instanceMatrix[2].xyz * foliageHullGradient.z / dot(instanceMatrix[2].xyz, instanceMatrix[2].xyz))
        + vec3(0.0, 1e-5, 0.0);
      ${far ? 'transformed = vec3(transformed.x * cos(foliageAngle), transformed.y, -transformed.x * sin(foliageAngle));' : ''}
      float foliageSway = sin(uFoliageTime * 0.65 + iFoliage.z + transformed.y * 1.7) * 0.012 * max(transformed.y, 0.0) * max(transformed.y, 0.0);
      transformed.x += foliageSway;
      transformed.y += foliageLift / max(iFoliage.x, 0.001);
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      uniform vec3 uFoliageTint;
      uniform float uFoliageSnow;
      uniform float uFoliageBare;
      uniform float uFoliageAutumn;
      uniform vec3 uFoliageLightDir;
      uniform vec3 uFoliageLightColor;
      uniform float uFoliageNight;
      uniform float uFoliageBacklight;
      varying float vFoliageCoverage;
      varying float vFoliageView;
      varying float vFoliageTint;
      varying float vFoliageGroundHeight;
      varying float vFoliageCanopyHeight;
      varying float vFoliageCrownDepth;
      varying vec3 vFoliageHull;
      varying vec4 vFoliageCluster;
      ${far ? 'uniform sampler2D uFoliageNormalMap;\nvarying mat3 vFoliageNormalTransform;' : ''}
      ${far ? `vec2 foliageAtlasUv(float view, vec2 uv, float inset) {
        vec2 cell = vec2(mod(view, 4.0), floor(view / 4.0));
        return (cell + clamp(uv, vec2(inset), vec2(1.0 - inset))) / vec2(4.0, 2.0);
      }` : ''}
    `);
    if (far) shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      float foliageView0 = floor(vFoliageView);
      float foliageView1 = mod(foliageView0 + 1.0, 8.0);
      vec2 foliageDx = dFdx(vMapUv);
      vec2 foliageDy = dFdy(vMapUv);
      float foliageFootprint = max(length(foliageDx), length(foliageDy)) * 256.0;
      float foliageMipScale = min(1.0, 64.0 / max(foliageFootprint, 0.001));
      float foliageInset = max(0.5, min(64.0, foliageFootprint)) / 256.0;
      vec4 foliageSample0 = textureGrad(map, foliageAtlasUv(foliageView0, vMapUv, foliageInset), foliageDx * foliageMipScale / vec2(4.0, 2.0), foliageDy * foliageMipScale / vec2(4.0, 2.0));
      vec4 foliageSample1 = textureGrad(map, foliageAtlasUv(foliageView1, vMapUv, foliageInset), foliageDx * foliageMipScale / vec2(4.0, 2.0), foliageDy * foliageMipScale / vec2(4.0, 2.0));
      float foliageViewBlend = fract(vFoliageView);
      float foliageAlpha = mix(foliageSample0.a, foliageSample1.a, foliageViewBlend);
      vec3 foliageColor = mix(foliageSample0.rgb * foliageSample0.a, foliageSample1.rgb * foliageSample1.a, foliageViewBlend) / max(0.001, foliageAlpha);
      diffuseColor *= vec4(foliageColor, foliageAlpha);
    `).replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      vec3 foliageNormal0 = textureGrad(uFoliageNormalMap, foliageAtlasUv(foliageView0, vMapUv, foliageInset), foliageDx * foliageMipScale / vec2(4.0, 2.0), foliageDy * foliageMipScale / vec2(4.0, 2.0)).rgb * 2.0 - 1.0;
      vec3 foliageNormal1 = textureGrad(uFoliageNormalMap, foliageAtlasUv(foliageView1, vMapUv, foliageInset), foliageDx * foliageMipScale / vec2(4.0, 2.0), foliageDy * foliageMipScale / vec2(4.0, 2.0)).rgb * 2.0 - 1.0;
      vec3 foliageObjectNormal = mix(foliageNormal0 * foliageSample0.a, foliageNormal1 * foliageSample1.a, foliageViewBlend);
      if (dot(foliageObjectNormal, foliageObjectNormal) < 0.00001) foliageObjectNormal = foliageNormal0;
      normal = normalize(vFoliageNormalTransform * foliageObjectNormal);
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
      // Albedo removed by the scotopic shift below; the photopic headlight adds it back.
      vec3 foliageScotopicShift = vec3(0.0);
      diffuseColor.a *= vFoliageCoverage;
      diffuseColor.rgb *= mix(0.66, 1.0, smoothstep(0.0, 0.85, vFoliageGroundHeight));
      ${leaf && !evergreen ? 'diffuseColor.a *= 1.0 - uFoliageBare;' : ''}
      ${leaf || far ? `${far && !evergreen ? 'if (uFoliageBare < 0.5) {' : ''}
      float foliageEcology = clamp((vFoliageTint - 0.86) / 0.20, 0.0, 1.0);
      vec3 foliageEcologyColor = mix(vec3(0.94, 1.0, 1.02), vec3(1.03, 1.0, 0.94), foliageEcology);
      ${evergreen ? 'diffuseColor.rgb *= vec3(0.96, 1.0, 0.97) * foliageEcologyColor * vFoliageTint;' : `
      float foliagePigmentMask = ${leaf ? '1.0' : 'smoothstep(0.0, 0.035, diffuseColor.g - max(diffuseColor.r, diffuseColor.b))'};
      float foliageLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      // Pigment follows crown-scale leaf masses, not each texel's luminance, so
      // autumn crowns read as clustered colour patches instead of pixel noise.
      float foliageCluster = 0.5 + 0.5 * sin(vFoliageCluster.x * 3.7 + vFoliageCluster.z * 2.3 + vFoliageCluster.w * 1.9)
        * cos(vFoliageCluster.y * 4.1 - vFoliageCluster.z * 3.1 + vFoliageCluster.w * 2.7);
      float foliageVariation = clamp(foliageEcology * 0.50 + foliageCluster * 0.50, 0.0, 1.0);
      vec3 foliageAutumnColor = mix(vec3(${autumn[0].join(', ')}), vec3(${autumn[1].join(', ')}), foliageVariation)
        * mix(0.80, clamp(foliageLuma * 5.0, 0.18, 1.20), 0.45);
      // Autumn keeps its authored species palette; snow and night/headlight
      // treatment still run after this bounded summer pigment adjustment.
      diffuseColor.rgb *= mix(vec3(1.0), uFoliageTint * mix(foliageEcologyColor, vec3(1.0), uFoliageAutumn), foliagePigmentMask);
      diffuseColor.rgb = mix(diffuseColor.rgb, foliageAutumnColor, uFoliageAutumn * foliagePigmentMask) * vFoliageTint;
      `}
      ${woody ? `diffuseColor.rgb *= mix(mix(0.76, 1.04, smoothstep(0.18, 0.92, vFoliageCanopyHeight)), mix(mix(0.76, 0.94, foliageEcology), 1.04, smoothstep(0.18, 0.92, vFoliageCanopyHeight)), (1.0 - max(uFoliageAutumn, uFoliageBare)) * (1.0 - uFoliageNight));` : 'diffuseColor.rgb *= mix(0.76, 1.04, smoothstep(0.18, 0.92, vFoliageCanopyHeight));'}
      ${template.growthForm === 'flowering' ? `{
        // Blossom: yellow (broom/gorse) or white (elder/may) per plant, gathered
        // in patches over the sunlit outer crown; gone by autumn.
        float bloomA = sin(vFoliageCluster.x * 13.1 + vFoliageCluster.w * 3.1) * cos(vFoliageCluster.y * 11.3 - vFoliageCluster.z * 9.7 + vFoliageCluster.w);
        float bloomB = sin(vFoliageCluster.z * 17.9 - vFoliageCluster.x * 5.3 + vFoliageCluster.w * 1.7) * cos(vFoliageCluster.y * 19.1 + vFoliageCluster.w * 2.3);
        float bloomOuter = smoothstep(0.50, 0.92, vFoliageCrownDepth) * smoothstep(0.20, 0.65, vFoliageCanopyHeight);
        float bloom = smoothstep(0.05, 0.55, 0.65 * bloomA + 0.35 * bloomB) * bloomOuter * (1.0 - max(uFoliageAutumn, uFoliageBare));
        vec3 bloomColor = fract(vFoliageCluster.w * 0.731) < 0.62 ? vec3(0.95, 0.76, 0.10) : vec3(0.93, 0.93, 0.86);
        diffuseColor.rgb = mix(diffuseColor.rgb, bloomColor * mix(0.70, 1.05, clamp(foliageLuma * 4.0, 0.0, 1.0)), bloom * 0.9);
      }` : ''}
      // Scotopic vision: moonlit foliage loses chroma and shifts cool. Headlit
      // foliage is photopic, so the lamp is shaded with the albedo before this shift.
      float foliageNightLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 foliagePhotopicColor = diffuseColor.rgb;
      diffuseColor.rgb = mix(diffuseColor.rgb, foliageNightLuma * vec3(0.78, 0.92, 1.14), 0.60 * uFoliageNight);
      foliageScotopicShift = foliagePhotopicColor - diffuseColor.rgb;
      ${far && !evergreen ? '}' : ''}` : ''}
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `
      if (uFoliageSnow > 0.0) {
      vec3 foliageWorldNormal = inverseTransformDirection(normal, viewMatrix);
      float foliageRootSnow = clamp(uFoliageSnow * 1.6, 0.0, 1.0) * (1.0 - smoothstep(0.12, 0.45, vFoliageGroundHeight))
        * smoothstep(0.15, 0.75, foliageWorldNormal.y);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.70, 0.76, 0.80), foliageRootSnow);
      foliageScotopicShift *= 1.0 - foliageRootSnow;
      ${leaf || far ? `
      ${far && !evergreen ? 'if (uFoliageBare < 0.5) {' : ''}
      float foliageSnowFace = smoothstep(0.12, 0.84, abs(foliageWorldNormal.y));
      float foliageLeafSignal = smoothstep(0.0, 0.045, diffuseColor.g - max(diffuseColor.r, diffuseColor.b));
      float foliageSnowCover = uFoliageSnow * foliageLeafSignal * (0.07 + 0.83 * foliageSnowFace);
      vec3 foliageSnowColor = vec3(0.70, 0.76, 0.80) * mix(0.76, 1.0, vFoliageCanopyHeight);
      diffuseColor.rgb = mix(diffuseColor.rgb, foliageSnowColor, foliageSnowCover);
      foliageScotopicShift *= 1.0 - foliageSnowCover;
      // Snow settles on the upper, outward crown surface of each tree.
      float foliageSnowCap = smoothstep(0.05, 0.65, normalize(vFoliageHull).y) * smoothstep(0.22, 0.80, vFoliageCanopyHeight)
        * (0.55 + 0.45 * foliageSnowFace) * smoothstep(0.55, 0.95, vFoliageCrownDepth);
      float foliageSnowCapCover = min(1.0, uFoliageSnow * 1.35) * foliageLeafSignal * foliageSnowCap;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80, 0.85, 0.90), foliageSnowCapCover);
      foliageScotopicShift *= 1.0 - foliageSnowCapCover;
      ${far && !evergreen ? '}' : ''}
      ` : ''}
      }
      #include <lights_physical_fragment>
      // Canopy self-occlusion: interior cards see less sky, and the crown side
      // facing away from a light is in the crown's own shadow.
      float foliageInterior = (1.0 - smoothstep(0.30, 1.0, vFoliageCrownDepth)) * ${leaf || far ? '1.0' : '0.5'};
      vec3 foliagePhotopicShift = foliageScotopicShift * (1.0 - metalnessFactor);
      vec3 foliageSpotDiffuse = vec3(0.0);
      vec3 foliageSpotBase;
    `).replace('#include <lights_fragment_begin>', foliageLightsChunk(leaf || far ? 0.65 : 0.30))
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
      ${template.kind === 'tree' && (leaf || far) ? `
      // R17: dry, open mature crowns admit slightly more downward sky light.
      // Reuse R11 ecology; shrubs, snow, bare crowns and full night keep their AO.
      float foliageSkyEcology = clamp((vFoliageTint - 0.86) / 0.20, 0.0, 1.0);
      float foliageSkyRelief = (uFoliageSnow > 0.0 || uFoliageBare > 0.0) ? 0.0 : (1.0 - uFoliageNight);
      float foliageSkyFloor = mix(0.80, 0.92, foliageSkyEcology * foliageSkyRelief);
      ` : 'float foliageSkyFloor = 0.80;'}
      float foliageSkyAO = mix(1.0, 0.42, foliageInterior) * mix(foliageSkyFloor, 1.0, smoothstep(-0.6, 0.5, normalize(vFoliageHull).y));
      float foliageHullLight = smoothstep(-0.40, 0.60, dot(normalize(vFoliageHull), uFoliageLightDir));
      reflectedLight.directDiffuse *= mix(1.0, foliageHullLight * (1.0 - 0.65 * foliageInterior), ${leaf || far ? '0.65' : '0.30'});
      reflectedLight.indirectDiffuse *= foliageSkyAO * mix(1.0, 0.55, uFoliageNight);
      reflectedLight.directDiffuse += foliageSpotDiffuse;
    `);
    if (leaf || far) shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      // Low sun behind the crown transmits a warm rim through the outer leaves.
      vec3 foliageLightView = normalize((viewMatrix * vec4(uFoliageLightDir, 0.0)).xyz);
      float foliageForward = max(dot(normalize(-vViewPosition), foliageLightView), 0.0);
      float foliageRim = smoothstep(0.60, 1.05, vFoliageCrownDepth);
      outgoingLight += diffuseColor.rgb * uFoliageLightColor * uFoliageBacklight
        * pow(foliageForward, 5.0) * (0.30 + 0.70 * foliageRim);
      #include <opaque_fragment>
    `);
  };
  material.customProgramCacheKey = () => `forest-field-crown-light-v9-${template.kind}-${template.species}-${template.growthForm || 'woody'}-${part}`;
  try { atmo.register(material); }
  catch (error) { material.dispose(); throw error; }
  return material;
}

export class ForestField {
  constructor(atmo, renderer, { loadAssets = loadFoliageAssets } = {}) {
    this.atmo = atmo;
    this.assets = null;
    this.assetError = null;
    this.materials = new Map();
    this.billboards = new Map();
    this.meshes = new Set();
    this.disposed = false;
    this._initializing = false;
    this._pendingAssets = null;
    this.pixelScale = 1000;
    this.uniforms = { uFoliageTime: { value: 0 }, uFoliagePixelScale: { value: 1000 },
      uFoliageTint: { value: new THREE.Color(1, 1, 1) }, uFoliageSnow: { value: 0 }, uFoliageBare: { value: 0 },
      uFoliageAutumn: { value: 0 }, uFoliageLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uFoliageLightColor: { value: new THREE.Color(0, 0, 0) }, uFoliageNight: { value: 0 }, uFoliageBacklight: { value: 0 } };
    this.assetPromise = Promise.resolve().then(() => loadAssets(renderer)).then(async assets => {
      if (this.disposed) { assets.dispose(); return; }
      this._pendingAssets = assets; this._initializing = true;
      let ready = false;
      try {
        for (const [key, template] of assets.templates) {
          const group = {};
          this.materials.set(key, group);
          for (const part of ['bark', 'leaf', 'impostor']) group[part] = makeFoliageMaterial(template, part, this.uniforms, atmo);
          this.billboards.set(key, billboardGeometry(template.impostor.shape));
        }
        if (this.disposed) return;
        await warmupFoliagePrograms(renderer, atmo.scene, assets.templates, this.materials, this.billboards);
        if (!this.disposed) { this.assets = assets; this._pendingAssets = null; ready = true; }
      } finally {
        this._initializing = false;
        if (!ready) this._disposeAssets();
      }
    }).catch(error => { if (!this.disposed) this.assetError = String(error.message || error); });
  }

  build(records, kind = 'tree') {
    const iterator = this.buildSteps(records, kind);
    let step;
    do { step = iterator.next(); } while (!step.done);
    return step.value;
  }

  *buildSteps(records, kind = 'tree') {
    if (!this.assets || this.disposed || records.length === 0) return [];
    const groups = new Map();
    for (let i = 0; i < records.length; i++) {
      if (i > 0 && i % 128 === 0) yield;
      const record = records[i];
      const key = foliageTemplateKey(record, kind);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    }
    const result = [];
    let completed = false;
    try {
      const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
      const position = new THREE.Vector3(), axis = new THREE.Vector3(0, 1, 0);
      for (const [key, population] of groups) {
        const template = this.assets.templates.get(key);
        const bounds = new THREE.Box3();
        const heights = new Float64Array(population.length);
        const matrices = new Float32Array(population.length * 16), foliage = new Float32Array(population.length * 4);
        let minimumHeight = Infinity, maximumHeight = 0, maximumScale = 0;
        for (let i = 0; i < population.length; i++) {
          if (i > 0 && i % 128 === 0) yield;
          const record = population[i];
          const dimensions = foliageRenderDimensions(record, template);
          const height = heights[i] = dimensions.height;
          bounds.expandByPoint(position.set(record.x, record.y + height * 0.5, record.z));
          minimumHeight = Math.min(minimumHeight, height); maximumHeight = Math.max(maximumHeight, height);
          const widthScale = dimensions.width / template.impostor.shape.width;
          maximumScale = Math.max(maximumScale, height, widthScale);
          position.set(record.x, record.y, record.z);
          scale.set(widthScale, height, widthScale);
          rotation.setFromAxisAngle(axis, record.yaw);
          matrix.compose(position, rotation, scale).toArray(matrices, i * 16);
          foliage.set([height, record.yaw, record.phase || 0, foliageTintFactor(record)], i * 4);
        }
        const sphere = bounds.getBoundingSphere(new THREE.Sphere());
        const range = FOREST_LOD[kind];
        const visibility = createVisibilityCache(population, bounds, sphere, heights);
        for (const part of ['bark', 'leaf', 'impostor']) {
          const far = part === 'impostor';
          const source = far ? this.billboards.get(key) : template.parts[part];
          const geometry = sharedGeometry(source);
          const attributes = new Float32Array(population.length * 4);
          geometry.setAttribute('iFoliage', new THREE.InstancedBufferAttribute(attributes, 4));
          const mesh = new THREE.InstancedMesh(geometry, this.materials.get(key)[part], population.length);
          this.meshes.add(mesh);
          result.push(mesh);
          mesh.name = `field-${kind}-${key}-${part}`;
          mesh.matrixAutoUpdate = false;
          mesh.frustumCulled = false;
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          mesh.userData.population = population;
          mesh.userData.foliageLevel = far ? 'far' : 'near';
          mesh.userData.instanceVisibilityVersion = 0;
          mesh.userData.foliageMaximumHeight = maximumHeight;
          mesh.userData.foliageKind = kind;
          mesh.userData.worldBoundsPadding = ridgePadding(far ? range.fadeEnd : Math.min(range.fadeEnd, maximumHeight * this.pixelScale / range.low));
          mesh.userData.instanceVisible = (index, camera) => {
            const pixels = visibility.update(camera, this.pixelScale).projected(index);
            if (far ? pixels > range.high + 0.01 : pixels < range.low - 0.01) return false;
            const distance = heights[index] * this.pixelScale / Math.max(pixels, 1e-8);
            return distance <= range.fadeEnd + 1;
          };
          mesh.userData.batchVisible = (camera) => {
            if (part === 'leaf' && !isEvergreenSpecies(template.species) && this.uniforms.uFoliageBare.value >= 1) return false;
            // Ferns and tussocks die back under the snowpack.
            if (template.winterBuried && this.uniforms.uFoliageSnow.value > 0) return false;
            const view = visibility.update(camera, this.pixelScale);
            // Ridge lift changes only y; leave a margin around floating-point cutoffs.
            if (view.horizontalDistance > range.fadeEnd + 1 + 1e-8) return false;
            if (!far && maximumHeight * this.pixelScale / Math.max(0.5, view.horizontalDistance) + 1e-8 < range.low - 0.01) return false;
            const distance = view.distance;
            const radius = sphere.radius + mesh.userData.worldBoundsPadding;
            const minimumDistance = Math.max(0.5, distance - radius);
            const maximumDistance = Math.max(0.5, distance + radius);
            if (minimumDistance > range.fadeEnd + 1) return false;
            return far ? minimumHeight * this.pixelScale / maximumDistance <= range.high + 0.01
              : maximumHeight * this.pixelScale / minimumDistance >= range.low - 0.01;
          };
          mesh.userData.batchAllVisible = camera => {
            const distance = visibility.update(camera, this.pixelScale).distance;
            const radius = sphere.radius + mesh.userData.worldBoundsPadding;
            const nearest = Math.max(0.5, distance - radius), farthest = distance + radius;
            if (farthest > range.fadeEnd) return false;
            return far ? maximumHeight * this.pixelScale / nearest < range.high - 0.02
              : minimumHeight * this.pixelScale / Math.max(0.5, farthest) > range.low + 0.02;
          };
          for (let index = 0; index < population.length; index += 128) {
            if (index > 0) yield;
            const end = Math.min(index + 128, population.length);
            mesh.instanceMatrix.array.set(matrices.subarray(index * 16, end * 16), index * 16);
            attributes.set(foliage.subarray(index * 4, end * 4), index * 4);
          }
          mesh.instanceMatrix.needsUpdate = true;
          if (!geometry.boundingSphere) geometry.computeBoundingSphere();
          const local = geometry.boundingSphere.clone().expandByPoint(new THREE.Vector3());
          const reach = (local.radius + 0.25 + local.center.distanceTo(new THREE.Vector3(0, 0.5, 0))) * maximumScale + 0.01;
          mesh.userData.staticCullBox = bounds.clone().expandByScalar(reach);
          mesh.userData.staticCullGeometry = geometry;
          mesh.userData.staticCullMatrix = mesh.instanceMatrix;
          mesh.userData.staticCullVersion = mesh.instanceMatrix.version;
          mesh.userData.staticCullCount = mesh.count;
          mesh.userData.staticCullPositionVersion = geometry.attributes.position.version;
          const positionAttribute = geometry.attributes.position;
          const foliageAttribute = geometry.attributes.iFoliage;
          mesh.userData.staticCullValid = () => mesh.geometry === geometry &&
            mesh.instanceMatrix === mesh.userData.staticCullMatrix &&
            mesh.instanceMatrix.version === mesh.userData.staticCullVersion &&
            mesh.count === mesh.userData.staticCullCount && mesh.matrix.equals(IDENTITY_MATRIX) &&
            geometry.attributes.position === positionAttribute && positionAttribute.version === mesh.userData.staticCullPositionVersion &&
            geometry.attributes.iFoliage === foliageAttribute && foliageAttribute.version === 0;
          yield;
        }
      }
      completed = true;
      return result;
    } finally {
      if (!completed) for (const mesh of result) this.disposeMesh(mesh);
    }
  }

  update(camera, time, seasonName, viewportHeight = 1080) {
    const pixelScale = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov || 54) * 0.5));
    if (pixelScale !== this.pixelScale) {
      this.pixelScale = pixelScale;
      this.uniforms.uFoliagePixelScale.value = pixelScale;
      for (const mesh of this.meshes) {
        mesh.userData.instanceVisibilityVersion++;
        const range = FOREST_LOD[mesh.userData.foliageKind];
        mesh.userData.worldBoundsPadding = ridgePadding(mesh.userData.foliageLevel === 'far' ? range.fadeEnd
          : Math.min(range.fadeEnd, mesh.userData.foliageMaximumHeight * this.pixelScale / range.low));
      }
    }
    this.uniforms.uFoliageTime.value = time;
    const tint = seasonName === 'autumn' ? [1.14, 0.83, 0.62] : seasonName === 'spring' ? [1.0, 1.03, 0.90] : [1, 1, 1];
    this.uniforms.uFoliageTint.value.setRGB(...tint);
    this.uniforms.uFoliageSnow.value = seasonName === 'winter' ? 0.65 : 0;
    this.uniforms.uFoliageBare.value = seasonName === 'winter' ? 1 : 0;
    this.uniforms.uFoliageAutumn.value = seasonName === 'autumn' ? 1 : 0;
    this._syncLight();
    for (const group of this.materials.values()) {
      const material = group.impostor;
      const template = material.userData.foliageTemplate;
      material.map = seasonName === 'winter' && template.bareImpostor ? template.bareImpostor.texture : template.impostor.texture;
      material.userData.foliageNormalMap.value = seasonName === 'winter' && template.bareImpostor
        ? template.bareImpostor.normalTexture : template.impostor.normalTexture;
    }
  }

  /** Mirror the atmosphere's key light (sun by day, moon at night) for crown shading. */
  _syncLight() {
    const atmo = this.atmo, palette = atmo?.palette;
    if (!atmo?.sun || !palette) return;
    const day = palette.dayness > 0.02;
    this.uniforms.uFoliageLightDir.value.copy(day ? atmo.sunDir : atmo.moonDir);
    this.uniforms.uFoliageLightColor.value.copy(atmo.sun.color).multiplyScalar(atmo.sun.intensity);
    this.uniforms.uFoliageNight.value = palette.nightness;
    // Transmission rim only for a low sun; a high sun is never behind the crowns.
    this.uniforms.uFoliageBacklight.value = day ? 0.24 * palette.dayness * (1 - smoothstep(0.10, 0.45, atmo.sunDir.y)) : 0;
  }

  disposeMesh(mesh) {
    if (!this.meshes.delete(mesh)) return;
    mesh.removeFromParent();
    disposeFieldGeometry(mesh.geometry);
    mesh.dispose();
  }

  _disposeAssets() {
    for (const group of this.materials.values()) for (const material of Object.values(group)) material.dispose();
    for (const geometry of this.billboards.values()) geometry.dispose();
    this.materials.clear(); this.billboards.clear();
    for (const assets of new Set([this.assets, this._pendingAssets])) assets?.dispose();
    this.assets = null; this._pendingAssets = null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of [...this.meshes]) this.disposeMesh(mesh);
    // Three's asynchronous readiness poll still owns these materials/programs.
    if (!this._initializing) this._disposeAssets();
  }
}
