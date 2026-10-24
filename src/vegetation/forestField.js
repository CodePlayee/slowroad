import * as THREE from 'three';
import { loadFoliageAssets } from './foliageAssets.js';
import { TERRAIN } from '../terrain/params.js';
import { TREE_SPECIES, isEvergreenSpecies } from './treeSpecies.js';
const IDENTITY_MATRIX = new THREE.Matrix4();

export const FOREST_LOD = Object.freeze({ tree: { low: 160, high: 260, fadeStart: 1800, fadeEnd: 2000 },
  shrub: { low: 60, high: 110, fadeStart: 190, fadeEnd: 220 } });
export const MIDSTORY = Object.freeze({ minimumHeight: 2.5, maximumHeight: 4.5, maximumRadius: 2.75 });
const smoothstep = (a, b, value) => { const t = Math.max(0, Math.min(1, (value - a) / (b - a))); return t * t * (3 - 2 * t); };
const ridgePadding = distance => TERRAIN.farRidgeAmp * smoothstep(TERRAIN.farRidgeNear, TERRAIN.farRidgeFar, distance);

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
  const height = MIDSTORY.minimumHeight + (MIDSTORY.maximumHeight - MIDSTORY.minimumHeight) * size;
  const shape = template.impostor.shape;
  // The baked radius covers every yaw/view, unlike half the axis-aligned width.
  const sway = 0.012 * Math.max(1, shape.top) ** 2;
  const safeWidth = MIDSTORY.maximumRadius * shape.width / (shape.radius + sway);
  const width = Math.min(Math.max(record.width * 1.5, height * 0.70), safeWidth);
  return { height, width, midstory: true };
}

export function projectedPlantHeight(record, camera, pixelScale, template) {
  const { height } = foliageRenderDimensions(record, template);
  const lift = foliageRidgeOffset(record.x, record.z, camera.position.x, camera.position.z);
  const distance = Math.hypot(record.x - camera.position.x, record.y + lift + height * 0.5 - camera.position.y, record.z - camera.position.z);
  return height * pixelScale / Math.max(0.5, distance);
}

export function foliageTemplateKey(record, kind = 'tree') {
  return kind === 'tree' ? (Object.hasOwn(TREE_SPECIES, record.species) ? record.species : 'oak') : `shrub-${Math.abs(record.variant || 0) % 2}`;
}

// Mirrors terrain's visual-only far ridge lift, which is not in its height sampler.
export function foliageRidgeOffset(x, z, cameraX, cameraZ) {
  const distance = Math.hypot(x - cameraX, z - cameraZ);
  if (distance <= TERRAIN.farRidgeNear) return 0;
  return foliageRidgeShape(x, z) * smoothstep(TERRAIN.farRidgeNear, TERRAIN.farRidgeFar, distance);
}

function foliageRidgeShape(x, z) {
  const crestA = 1 - Math.abs(Math.sin(x * 0.00016 + z * 0.000095 + Math.sin(x * 0.000047) * 1.7 + Math.sin(z * 0.000031) * 0.8));
  const crestB = 1 - Math.abs(Math.sin(x * -0.000071 + z * 0.00019 + Math.sin(z * 0.000061) * 1.4 + Math.sin(x * 0.000022) * 0.9));
  const crestC = 1 - Math.abs(Math.sin(x * 0.00031 - z * 0.00022 + Math.sin(x * 0.00009 + z * 0.00013) * 0.55));
  const contourA = 0.5 + 0.5 * Math.sin(x * 0.000043 - z * 0.000027 + Math.sin(x * 0.000019 + z * 0.000013) * 1.2);
  const contourB = 0.5 + 0.5 * Math.cos(x * -0.000021 + z * 0.000036 + Math.sin(z * 0.000016) * 0.9);
  const shape = smoothstep(0.16, 0.86, crestA) * (0.38 + contourA * 0.18) + smoothstep(0.18, 0.84, crestB) * (0.24 + contourB * 0.16)
    + smoothstep(0.22, 0.82, crestC) * 0.18 - 0.34;
  const shoulder = smoothstep(0.34, 0.72, crestA * (0.46 + contourA * 0.16) + crestB * (0.30 + contourB * 0.08));
  return shape * TERRAIN.farRidgeAmp + (shoulder - 0.42) * TERRAIN.farRidgeAmp * 0.34;
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
          if (Number.isNaN(ridges[index])) ridges[index] = foliageRidgeShape(record.x, record.z);
          lift = ridges[index] * smoothstep(TERRAIN.farRidgeNear, TERRAIN.farRidgeFar, horizontal);
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

export const FOLIAGE_RIDGE_GLSL = `
  float foliageRidgeOffset(vec2 uv) {
    float a = 1.0 - abs(sin(dot(uv, vec2(0.00016, 0.000095)) + sin(uv.x * 0.000047) * 1.7 + sin(uv.y * 0.000031) * 0.8));
    float b = 1.0 - abs(sin(dot(uv, vec2(-0.000071, 0.00019)) + sin(uv.y * 0.000061) * 1.4 + sin(uv.x * 0.000022) * 0.9));
    float c = 1.0 - abs(sin(dot(uv, vec2(0.00031, -0.00022)) + sin(dot(uv, vec2(0.00009, 0.00013))) * 0.55));
    float ca = 0.5 + 0.5 * sin(dot(uv, vec2(0.000043, -0.000027)) + sin(uv.x * 0.000019 + uv.y * 0.000013) * 1.2);
    float cb = 0.5 + 0.5 * cos(dot(uv, vec2(-0.000021, 0.000036)) + sin(uv.y * 0.000016) * 0.9);
    float shape = smoothstep(0.16, 0.86, a) * (0.38 + ca * 0.18) + smoothstep(0.18, 0.84, b) * (0.24 + cb * 0.16) + smoothstep(0.22, 0.82, c) * 0.18 - 0.34;
    float shoulder = smoothstep(0.34, 0.72, a * (0.46 + ca * 0.16) + b * (0.30 + cb * 0.08));
    return (shape + (shoulder - 0.42) * 0.34) * ${TERRAIN.farRidgeAmp.toFixed(1)} * smoothstep(${TERRAIN.farRidgeNear.toFixed(1)}, ${TERRAIN.farRidgeFar.toFixed(1)}, distance(uv, cameraPosition.xz));
  }
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

export function makeFoliageMaterial(template, part, uniforms, atmo) {
  const far = part === 'impostor';
  const leaf = part === 'leaf';
  const evergreen = isEvergreenSpecies(template.species);
  const autumn = template.growthForm === 'fern' ? [[0.37, 0.21, 0.045], [0.66, 0.48, 0.12]] : {
    oak: [[0.36, 0.105, 0.024], [0.58, 0.29, 0.050]],
    birch: [[0.46, 0.22, 0.028], [0.68, 0.45, 0.065]],
    aspen: [[0.48, 0.27, 0.032], [0.72, 0.52, 0.085]],
    maple: [[0.38, 0.045, 0.020], [0.66, 0.22, 0.038]],
  }[template.species] || [[0.36, 0.105, 0.024], [0.58, 0.29, 0.050]];
  const material = new THREE.MeshStandardMaterial({ name: `field-${template.kind}-${template.name}-${part}`,
    map: far ? template.impostor.texture : template.maps[part], roughness: 0.96,
    color: new THREE.Color().setRGB(...(!far && template.tints?.[part] || [1, 1, 1])),
    side: THREE.DoubleSide, alphaTest: leaf || far ? 0.32 : 0.01, alphaToCoverage: true,
    transparent: false, depthWrite: true });
  const range = FOREST_LOD[template.kind];
  const lod = { value: new THREE.Vector4(range.low, range.high, range.fadeStart, range.fadeEnd) };
  const normalMap = { value: template.impostor.normalTexture };
  material.userData.uniforms = uniforms;
  material.userData.foliageTemplate = template;
  material.userData.foliagePart = part;
  material.userData.foliageNormalMap = normalMap;
  Object.defineProperties(material.userData, {
    foliageLodRange: { value: range, enumerable: true },
    foliageLodUniform: { value: lod, enumerable: true },
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uFoliageLod: lod, uFoliageNormalMap: normalMap });
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
      attribute vec4 iFoliage;
      uniform float uFoliageTime;
      uniform float uFoliagePixelScale;
      uniform vec4 uFoliageLod;
      varying float vFoliageCoverage;
      varying float vFoliageView;
      varying float vFoliageTint;
      varying float vFoliageGroundHeight;
      varying float vFoliageCanopyHeight;
      float foliageAngle;
      ${far ? 'varying mat3 vFoliageNormalTransform;' : ''}
      ${FOLIAGE_RIDGE_GLSL}
    `).replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
      vec3 foliageRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      float foliageLift = foliageRidgeOffset(foliageRoot.xz);
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
      vFoliageTint = 0.94 + iFoliage.w * 0.12;
      vFoliageGroundHeight = position.y * iFoliage.x;
      vFoliageCanopyHeight = clamp(position.y, 0.0, 1.0);
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
      varying float vFoliageCoverage;
      varying float vFoliageView;
      varying float vFoliageTint;
      varying float vFoliageGroundHeight;
      varying float vFoliageCanopyHeight;
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
      diffuseColor.a *= vFoliageCoverage;
      diffuseColor.rgb *= mix(0.66, 1.0, smoothstep(0.0, 0.85, vFoliageGroundHeight));
      ${leaf && !evergreen ? 'diffuseColor.a *= 1.0 - uFoliageBare;' : ''}
      ${leaf || far ? `${far && !evergreen ? 'if (uFoliageBare < 0.5) {' : ''}
      ${evergreen ? 'diffuseColor.rgb *= vec3(0.96, 1.0, 0.97) * vFoliageTint;' : `
      float foliagePigmentMask = ${leaf ? '1.0' : 'smoothstep(0.0, 0.035, diffuseColor.g - max(diffuseColor.r, diffuseColor.b))'};
      float foliageLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      float foliageVariation = clamp((vFoliageTint - 0.94) / 0.12, 0.0, 1.0);
      vec3 foliageAutumnColor = mix(vec3(${autumn[0].join(', ')}), vec3(${autumn[1].join(', ')}), foliageVariation)
        * clamp(foliageLuma * 5.0, 0.18, 1.20);
      diffuseColor.rgb *= mix(vec3(1.0), uFoliageTint, foliagePigmentMask);
      diffuseColor.rgb = mix(diffuseColor.rgb, foliageAutumnColor, uFoliageAutumn * foliagePigmentMask) * vFoliageTint;
      `}
      diffuseColor.rgb *= mix(0.76, 1.04, smoothstep(0.18, 0.92, vFoliageCanopyHeight));
      ${far && !evergreen ? '}' : ''}` : ''}
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `
      if (uFoliageSnow > 0.0) {
      vec3 foliageWorldNormal = inverseTransformDirection(normal, viewMatrix);
      float foliageRootSnow = clamp(uFoliageSnow * 1.6, 0.0, 1.0) * (1.0 - smoothstep(0.12, 0.45, vFoliageGroundHeight))
        * smoothstep(0.15, 0.75, foliageWorldNormal.y);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.70, 0.76, 0.80), foliageRootSnow);
      ${leaf || far ? `
      ${far && !evergreen ? 'if (uFoliageBare < 0.5) {' : ''}
      float foliageSnowFace = smoothstep(0.12, 0.84, abs(foliageWorldNormal.y));
      float foliageLeafSignal = smoothstep(0.0, 0.045, diffuseColor.g - max(diffuseColor.r, diffuseColor.b));
      float foliageSnowCover = uFoliageSnow * foliageLeafSignal * (0.07 + 0.83 * foliageSnowFace);
      vec3 foliageSnowColor = vec3(0.70, 0.76, 0.80) * mix(0.76, 1.0, vFoliageCanopyHeight);
      diffuseColor.rgb = mix(diffuseColor.rgb, foliageSnowColor, foliageSnowCover);
      ${far && !evergreen ? '}' : ''}
      ` : ''}
      }
      #include <lights_physical_fragment>
    `);
  };
  material.customProgramCacheKey = () => `forest-field-seasonal-roots-v5-${template.kind}-${template.species}-${template.growthForm || 'woody'}-${part}`;
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
      uFoliageAutumn: { value: 0 } };
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
          foliage.set([height, record.yaw, record.phase || 0, record.rank ?? 0.5], i * 4);
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
    for (const group of this.materials.values()) {
      const material = group.impostor;
      const template = material.userData.foliageTemplate;
      material.map = seasonName === 'winter' && template.bareImpostor ? template.bareImpostor.texture : template.impostor.texture;
      material.userData.foliageNormalMap.value = seasonName === 'winter' && template.bareImpostor
        ? template.bareImpostor.normalTexture : template.impostor.normalTexture;
    }
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
