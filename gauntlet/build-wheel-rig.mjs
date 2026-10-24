// Offline asset preparation. Uses the source model project's existing tooling;
// the game only needs the generated JSON and its unchanged compact GLB.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const sourceRoot = process.env.CAR_ASSET_TOOLS_ROOT || '/Users/minimax/Documents/Play/cars-high-model';
const require = createRequire(resolve(sourceRoot, 'package.json'));
const { NodeIO } = await import(require.resolve('@gltf-transform/core'));
const { ALL_EXTENSIONS } = await import(require.resolve('@gltf-transform/extensions'));
const { MeshBVH } = await import(require.resolve('three-mesh-bvh'));
const T = await import(require.resolve('three'));
const decoder = await require('draco3dgltf').createDecoderModule();
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': decoder });
const sourcePath = resolve(sourceRoot, 'public/models/tesla-model-y-2025-awd.glb');
const compactPath = new URL('../public/models/tesla-model-y-2025-awd-compact.glb', import.meta.url);
const source = await io.read(sourcePath), compact = await io.read(compactPath.pathname);
for (const animation of source.getRoot().listAnimations()) for (const channel of animation.listChannels()) {
  const sampler = channel.getSampler(), node = channel.getTargetNode();
  const value = sampler.getOutput().getElement(sampler.getInterpolation() === 'CUBICSPLINE' ? 1 : 0, []);
  const setter = { translation: 'setTranslation', rotation: 'setRotation', scale: 'setScale' }[channel.getTargetPath()];
  if (setter) node[setter](value);
}
const names = ['Wheel_LF', 'Wheel_RF', 'Wheel_LB', 'Wheel_RB'];
const wheels = names.map(name => {
  const node = source.getRoot().listNodes().find(node => node.getName() === name);
  if (!node) throw new Error(`Missing authored axle: ${name}`);
  return { name, center: node.getWorldTranslation(), front: name.endsWith('F'), radius: 0 };
});
const materials = new Map(['M_Ext_Wheel', 'M_Ext_ChromePlastic'].map(name => [name, { positions: [], labels: [] }]));
const vertex = new T.Vector3(), matrix = new T.Matrix4();
for (const node of source.getRoot().listNodes()) {
  matrix.fromArray(node.getWorldMatrix());
  let wheel = -1;
  for (let parent = node; parent; parent = parent.getParentNode()) {
    const index = names.indexOf(parent.getName());
    if (index >= 0) { wheel = index; break; }
  }
  const label = wheel < 0 ? 0 : 1 + wheel * 2 + (/Caliper$/.test(node.getName()) ? 1 : 0);
  for (const primitive of node.getMesh()?.listPrimitives() || []) {
    const data = materials.get(primitive.getMaterial()?.getName());
    if (!data) continue;
    const p = primitive.getAttribute('POSITION').getArray(), indices = primitive.getIndices().getArray();
    for (let i = 0; i < indices.length; i++) {
      vertex.fromArray(p, indices[i] * 3).applyMatrix4(matrix);
      data.positions.push(vertex.x, vertex.y, vertex.z);
      if (wheel >= 0 && /Tire$/.test(node.getName())) {
        wheels[wheel].radius = Math.max(wheels[wheel].radius, Math.abs(vertex.y - wheels[wheel].center[1]));
      }
      if (i % 3 === 0) data.labels.push(label);
    }
  }
}
for (const data of materials.values()) {
  const geometry = new T.BufferGeometry().setAttribute('position', new T.Float32BufferAttribute(data.positions, 3));
  data.bvh = new MeshBVH(geometry, { indirect: true });
  data.geometry = geometry; delete data.positions;
}
const report = { version: 1, assetSha256: createHash('sha256').update(readFileSync(compactPath)).digest('hex'),
  sourceSha256: createHash('sha256').update(readFileSync(sourcePath)).digest('hex'), wheels, meshes: [] };
const center = new T.Vector3(), nearest = {};
for (const node of compact.getRoot().listNodes()) for (const primitive of node.getMesh()?.listPrimitives() || []) {
  const material = primitive.getMaterial()?.getName(), reference = materials.get(material);
  if (!reference) continue;
  matrix.fromArray(node.getWorldMatrix());
  const positions = primitive.getAttribute('POSITION').getArray(), indices = primitive.getIndices().getArray();
  let hash = 2166136261, maxDistance = 0;
  const parts = new Map();
  for (let i = 0; i < indices.length; i += 3) {
    center.set(0, 0, 0);
    for (let k = 0; k < 3; k++) {
      hash = Math.imul(hash ^ indices[i + k], 16777619) >>> 0;
      center.add(vertex.fromArray(positions, indices[i + k] * 3).applyMatrix4(matrix));
    }
    center.multiplyScalar(1 / 3);
    reference.bvh.closestPointToPoint(center, nearest);
    const label = reference.labels[nearest.faceIndex];
    if (label) maxDistance = Math.max(maxDistance, nearest.distance);
    if (!parts.has(label)) parts.set(label, { wheel: label ? names[Math.floor((label - 1) / 2)] : null,
      rolling: label > 0 && label % 2 === 1, triangles: 0, ranges: [] });
    const part = parts.get(label), last = part.ranges.at(-1);
    if (last && last[0] + last[1] === i / 3) last[1]++;
    else part.ranges.push([i / 3, 1]);
    part.triangles++;
  }
  if (maxDistance > 0.015) throw new Error(`Wheel classification error: ${maxDistance}m`);
  report.meshes.push({ name: node.getName(), material, indexCount: indices.length, indexHash: hash,
    maxWheelSurfaceError: maxDistance, parts: [...parts.values()] });
}
for (const wheel of wheels) {
  const parts = report.meshes.flatMap(mesh => mesh.parts).filter(part => part.wheel === wheel.name);
  if (parts.filter(part => part.rolling).reduce((sum, part) => sum + part.triangles, 0) < 500 ||
      parts.filter(part => !part.rolling).reduce((sum, part) => sum + part.triangles, 0) < 20 || wheel.radius < 0.3) {
    throw new Error(`Incomplete wheel: ${wheel.name}`);
  }
}
writeFileSync(new URL('../src/vehicle/model-y-wheel-rig.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ wheels, meshes: report.meshes.map(({ parts, ...mesh }) => ({ ...mesh,
  parts: parts.map(({ ranges, ...part }) => ({ ...part, ranges: ranges.length })) })) }, null, 2));
for (const data of materials.values()) data.geometry.dispose();
