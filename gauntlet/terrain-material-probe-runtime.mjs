import * as THREE from 'three';
import { withRendererState } from '../src/vegetation/foliageAssets.js';

export const TERRAIN_PROBE_MODES = Object.freeze([
  { id: 1, fields: ['rk', 'woodlandSurface', 'woodlandWeight'], expression: 'vec3(rk, woodlandSurface, woodlandWeight)' },
  { id: 2, fields: ['canopy', 'clump', 'moist'], expression: 'vec3(canopy, clump, moist)' },
  { id: 3, fields: ['litterWeight', 'mossWeight', 'meadowContact'], expression: 'vec3(litterWeight, mossWeight, meadowContact)' },
  { id: 4, fields: ['rockA', 'slope', 'shore'], expression: 'vec3(rockA, slope, shore)' },
  { id: 5, fields: ['distanceOver500', 'nearLayer', 'farLayer'], expression: 'vec3(length(vViewPosition) / 500.0, nearLayer, farLayer)' },
]);

export const TERRAIN_PROBE_POINTS = Object.freeze([
  { name: 'gray_forest_left', x: 240, y: 450 },
  { name: 'near_grass_base', x: 1440, y: 910 },
  { name: 'far_forest_floor', x: 1060, y: 480 },
  { name: 'grass_slope', x: 570, y: 565 },
]);

export function probePixel(point, width, height) {
  if (!Number.isInteger(point.x) || !Number.isInteger(point.y) || point.x < 0 || point.y < 0
    || point.x >= width || point.y >= height) throw new RangeError(`Probe pixel outside target: ${point.name}`);
  return { x: point.x, glY: height - 1 - point.y,
    ndc: [(point.x + 0.5) / width * 2 - 1, 1 - (point.y + 0.5) / height * 2] };
}

export function createTerrainProbeMaterial(original, mode) {
  const material = original.clone();
  material.name = `${original.name}-raw-material-probe`;
  material.blending = THREE.NoBlending;
  material.transparent = false;
  material.depthWrite = material.depthTest = material.colorWrite = true;
  material.toneMapped = material.dithering = false;
  material.customProgramCacheKey = () => `${original.customProgramCacheKey()}:raw-terrain-material-probe-v1`;
  material.onBeforeCompile = (shader, renderer) => {
    original.onBeforeCompile.call(material, shader, renderer);
    const marker = '#include <opaque_fragment>';
    if (!shader.fragmentShader.includes(marker)) throw new Error('Terrain probe cannot find the opaque output stage');
    shader.uniforms.uTerrainProbeMode = mode;
    const output = TERRAIN_PROBE_MODES.map((entry, index) =>
      `${index ? 'else ' : ''}if (uTerrainProbeMode == ${entry.id}) gl_FragColor = vec4(${entry.expression}, 1.0);`).join('\n');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform int uTerrainProbeMode;')
      .replace(marker, `${output}\nelse gl_FragColor = vec4(0.0);\nreturn;\n${marker}`);
  };
  return material;
}

/** Synchronous: no application frames interleave the five offscreen passes. */
export function probeTerrainMaterials(app, { width = 1920, height = 1080, points = TERRAIN_PROBE_POINTS } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError('Invalid probe dimensions');
  if (!points.length) throw new Error('Terrain probe requires at least one pixel');
  if (app.residencyOk && !app.residencyOk()) throw new Error('Wait for __rig.ready() before probing terrain');
  const pixels = points.map(point => ({ ...point, ...probePixel(point, width, height) }));
  const renderer = app.renderer, terrain = app.terrain, mode = { value: 1 };
  const floating = Boolean(renderer.getContext().getExtension('EXT_color_buffer_float'));
  const scene = new THREE.Scene(), camera = app.cameras.camera.clone();
  camera.matrixWorld.copy(app.cameras.camera.matrixWorld);
  camera.matrixWorldInverse.copy(app.cameras.camera.matrixWorldInverse);
  camera.matrixAutoUpdate = camera.matrixWorldAutoUpdate = false;
  scene.fog = app.scene.fog;
  const materials = new Map(), sources = new Map();
  let target;
  const shadowState = renderer.shadowMap && { autoUpdate: renderer.shadowMap.autoUpdate, needsUpdate: renderer.shadowMap.needsUpdate };
  const probeMaterial = original => {
    if (!materials.has(original)) materials.set(original, createTerrainProbeMaterial(original, mode));
    return materials.get(original);
  };
  try {
    for (const entry of terrain.chunks.values()) sources.set(entry.mesh, entry);
    terrain.group.traverseVisible(source => {
      if (!source.isMesh || !sources.has(source)) return;
      const material = Array.isArray(source.material) ? source.material.map(probeMaterial) : probeMaterial(source.material);
      const mesh = new THREE.Mesh(source.geometry, material);
      mesh.matrix.copy(source.matrixWorld);
      mesh.matrixAutoUpdate = false;
      mesh.layers.mask = source.layers.mask;
      mesh.renderOrder = source.renderOrder;
      mesh.userData.probeEntry = sources.get(source);
      scene.add(mesh);
    });
    if (!scene.children.length) throw new Error('No visible terrain meshes to probe');
    scene.updateMatrixWorld(true);
    target = new THREE.WebGLRenderTarget(width, height, { format: THREE.RGBAFormat,
      type: floating ? THREE.FloatType : THREE.UnsignedByteType, depthBuffer: true, stencilBuffer: false, samples: 0 });
    target.texture.colorSpace = THREE.NoColorSpace;
    target.texture.generateMipmaps = false;
    target.texture.minFilter = target.texture.magFilter = THREE.NearestFilter;
    target.viewport.set(0, 0, width, height);
    target.scissor.copy(target.viewport);
    target.scissorTest = false;
    const rows = pixels.map(point => ({ name: point.name, pixel: [point.x, point.y], raw: {}, values: {}, hit: null }));
    const buffer = floating ? new Float32Array(4) : new Uint8Array(4);
    withRendererState(renderer, () => {
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      if (renderer.shadowMap) { renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = false; }
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      for (const entry of TERRAIN_PROBE_MODES) {
        mode.value = entry.id;
        renderer.clear(true, true, true);
        renderer.render(scene, camera);
        for (let i = 0; i < pixels.length; i++) {
          renderer.readRenderTargetPixels(target, pixels[i].x, pixels[i].glY, 1, 1, buffer);
          const rgba = Array.from(buffer, value => floating ? value : value / 255);
          if (!rgba.every(Number.isFinite)) throw new Error('Non-finite terrain probe output');
          rows[i].raw[entry.id] = rgba;
          entry.fields.forEach((name, channel) => { rows[i].values[name] = rgba[3] > 0.5 ? rgba[channel] : null; });
        }
      }
    });
    const raycaster = new THREE.Raycaster();
    raycaster.layers.mask = camera.layers.mask;
    raycaster.near = camera.near; raycaster.far = camera.far;
    rows.forEach((row, index) => {
      row.distanceClipped = !floating && row.values.distanceOver500 >= 1;
      row.gpuDistance = row.values.distanceOver500 === null || row.distanceClipped ? null : row.values.distanceOver500 * 500;
      row.gpuDistanceAtLeast = row.distanceClipped ? 500 : null;
      raycaster.setFromCamera(new THREE.Vector2(...pixels[index].ndc), camera);
      const hit = raycaster.intersectObjects(scene.children, false)[0];
      if (!hit) return;
      const entry = hit.object.userData.probeEntry;
      const baseVertices = (entry.data.resolution + 1) ** 2;
      const distanceXZ = Math.hypot(hit.point.x - camera.matrixWorld.elements[12], hit.point.z - camera.matrixWorld.elements[14]);
      row.hit = { world: hit.point.toArray(), distance: hit.distance, tile: entry.tile.key,
        lod: entry.tile.l, cellSize: entry.tile.C / entry.data.resolution, faceIndex: hit.faceIndex,
        skirt: [hit.face.a, hit.face.b, hit.face.c].some(vertex => vertex >= baseVertices),
        shaderDisplacementPossible: !entry.settled || distanceXZ > (terrain.uniforms.uFarRidgeNear?.value ?? Infinity) };
    });
    if (!rows.some(row => row.raw[1][3] > 0.5)) throw new Error('All probe pixels missed rendered terrain');
    return { viewport: [width, height], encoding: floating ? 'float32-linear-raw' : 'unorm8-linear-raw',
      quantization: floating ? null : 1 / 255, modes: TERRAIN_PROBE_MODES.map(({ id, fields }) => ({ id, fields })),
      materialKeys: [...materials.keys()].map(material => material.customProgramCacheKey()),
      meshes: scene.children.length, points: rows,
      note: 'Terrain-only shader values, not visual acceptance. CPU ray hits exclude shader-only vertex displacement.' };
  } finally {
    if (shadowState) Object.assign(renderer.shadowMap, shadowState);
    scene.clear();
    for (const material of materials.values()) material.dispose();
    target?.dispose();
  }
}
