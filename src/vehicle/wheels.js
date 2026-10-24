import * as THREE from 'three';
import rig from './model-y-wheel-rig.json' with { type: 'json' };

export function indexHash(indices) {
  let hash = 2166136261;
  for (let i = 0; i < indices.length; i++) hash = Math.imul(hash ^ indices[i], 16777619) >>> 0;
  return hash;
}

// Compact each part once at load time. Copy every attribute without changing
// its values; frame updates subsequently touch joint transforms only.
export function geometrySubset(source, ranges) {
  const sourceIndex = source.index.array, vertices = [], remap = new Map(), indices = [];
  for (const [start, count] of ranges) for (let at = start * 3; at < (start + count) * 3; at++) {
    const original = sourceIndex[at];
    if (!remap.has(original)) { remap.set(original, vertices.length); vertices.push(original); }
    indices.push(remap.get(original));
  }
  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    if (attribute.isInterleavedBufferAttribute) throw new Error('Wheel rig requires packed vertex attributes');
    const array = new attribute.array.constructor(vertices.length * attribute.itemSize);
    for (let i = 0; i < vertices.length; i++) {
      const start = vertices[i] * attribute.itemSize;
      array.set(attribute.array.subarray(start, start + attribute.itemSize), i * attribute.itemSize);
    }
    const target = new THREE.BufferAttribute(array, attribute.itemSize, attribute.normalized);
    target.gpuType = attribute.gpuType;
    geometry.setAttribute(name, target);
  }
  geometry.setIndex(indices);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

export function rigModelYWheels(root, scale) {
  const sources = rig.meshes.map(part => root.children.find(mesh => mesh.name === part.name));
  if (sources.every(mesh => !mesh)) return []; // Procedural fixtures contain no imported wheels.
  for (let i = 0; i < sources.length; i++) {
    const mesh = sources[i], spec = rig.meshes[i];
    if (!mesh || mesh.material.name !== spec.material || mesh.geometry.index?.count !== spec.indexCount ||
        indexHash(mesh.geometry.index.array) !== spec.indexHash) throw new Error(`Wheel rig does not match ${spec.name}`);
  }
  const axleX = rig.wheels.reduce((sum, wheel) => sum + wheel.center[0], 0) / 4;
  const wheelbase = (rig.wheels.filter(wheel => wheel.front).reduce((sum, wheel) => sum + wheel.center[2], 0)
    - rig.wheels.filter(wheel => !wheel.front).reduce((sum, wheel) => sum + wheel.center[2], 0)) / 2 * scale;
  const wheels = new Map(rig.wheels.map(spec => {
    const wheel = new THREE.Group(); wheel.name = spec.name;
    wheel.position.fromArray(spec.center);
    wheel.rollGroup = new THREE.Group(); wheel.rollGroup.name = `${spec.name}_rolling`;
    wheel.add(wheel.rollGroup);
    Object.assign(wheel.userData, { front: spec.front, radius: spec.radius * scale,
      lateral: (spec.center[0] - axleX) * scale, wheelbase });
    return [spec.name, wheel];
  }));
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]; source.updateMatrix();
    for (const part of rig.meshes[i].parts) {
      const mesh = new THREE.Mesh(geometrySubset(source.geometry, part.ranges), source.material);
      mesh.name = `${source.name}_${part.wheel || 'body'}_${part.rolling ? 'rolling' : 'fixed'}`;
      mesh.applyMatrix4(source.matrix);
      mesh.userData = { ...source.userData, wheelSource: source.name, wheelRanges: part.ranges,
        wheelName: part.wheel, wheelRole: part.wheel ? part.rolling ? 'rolling' : 'caliper' : 'body' };
      mesh.castShadow = false; mesh.receiveShadow = false;
      if (part.wheel) {
        const wheel = wheels.get(part.wheel);
        mesh.position.sub(wheel.position);
        (part.rolling ? wheel.rollGroup : wheel).add(mesh);
      } else root.add(mesh);
    }
    source.removeFromParent();
  }
  for (const wheel of wheels.values()) root.add(wheel);
  return [...wheels.values()];
}

export function animateWheels(wheels, distance, roadCurvature, laneOffset = 0) {
  // Route heading increases toward model-local -X; positive local yaw turns +Z
  // toward +X. Account for the lane offset when deriving the turning radius.
  const curvature = Number.isFinite(roadCurvature) ? THREE.MathUtils.clamp(roadCurvature, -0.2, 0.2) : 0;
  const localCurvature = curvature === 0 ? 0 : -curvature / Math.max(0.2, 1 - laneOffset * curvature);
  for (const wheel of wheels) {
    const { front, radius, lateral, wheelbase } = wheel.userData;
    const steering = front ? Math.atan2(wheelbase * localCurvature, 1 - lateral * localCurvature) : 0;
    wheel.rotation.set(0, THREE.MathUtils.clamp(steering, -Math.PI / 5, Math.PI / 5), 0);
    // Positive X rotation rolls +Z travel forward; the bottom tread moves -Z.
    wheel.rollGroup.rotation.x = (distance / radius) % (2 * Math.PI);
  }
}
