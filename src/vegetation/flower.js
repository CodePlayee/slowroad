import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function wildflowerCluster(stem) {
  const position = stem.getAttribute('position'), tip = new THREE.Vector3();
  const top = stem.boundingBox.max.y;
  let tipVertices = 0;
  for (let i = 0; i < position.count; i++) if (position.getY(i) >= top - 1e-4) {
    tip.add(new THREE.Vector3().fromBufferAttribute(position, i)); tipVertices++;
  }
  tip.divideScalar(tipVertices);
  const heads = [
    { center: tip.clone(), radius: 0.075, petals: 7, tilt: [0.16, 0, -0.11] },
    { center: tip.clone().add(new THREE.Vector3(-0.10, -top * 0.13, 0.025)), radius: 0.062, petals: 6, tilt: [-0.32, 0.8, 0.20] },
    { center: tip.clone().add(new THREE.Vector3(0.10, -top * 0.22, -0.05)), radius: 0.058, petals: 5, tilt: [0.24, -0.6, -0.25] },
  ];
  const positions = [], colors = [], branches = [];
  let combinedStem = null, blossom = null, completed = false;
  const white = [0.96, 0.98, 0.94], underside = [0.72, 0.78, 0.69], gold = [0.78, 0.46, 0.045];
  const triangle = (points, indices, tint, rotation, center) => {
    for (const index of indices) {
      const point = points[index].clone().applyQuaternion(rotation).add(center);
      positions.push(point.x, point.y, point.z); colors.push(...tint);
    }
  };
  try {
    for (const [headIndex, head] of heads.entries()) {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...head.tilt));
      for (let petal = 0; petal < head.petals; petal++) {
        const angle = petal * Math.PI * 2 / head.petals + headIndex * 0.37;
        const radius = head.radius * (0.94 + Math.sin(petal * 2.7 + headIndex) * 0.07);
        const width = radius * 0.24, thickness = radius * 0.025;
        const points = [[radius * 0.19, 0, -width * 0.28], [radius * 0.19, 0, width * 0.28],
          [radius * 0.64, radius * 0.10, -width], [radius * 0.64, radius * 0.14, width],
          [radius, radius * (0.05 + 0.06 * Math.sin(petal)), 0], [radius * 0.61, radius * 0.22, 0]]
          .map(([x, y, z]) => new THREE.Vector3(x * Math.cos(angle) - z * Math.sin(angle), y,
            x * Math.sin(angle) + z * Math.cos(angle)));
        points.push(...points.map(point => point.clone().add(new THREE.Vector3(0, -thickness, 0))));
        const faces = [[0, 1, 5], [0, 5, 2], [2, 5, 4], [5, 3, 4], [1, 3, 5]];
        for (const face of faces) {
          triangle(points, face, white, rotation, head.center);
          triangle(points, [...face].reverse().map(index => index + 6), underside, rotation, head.center);
        }
        const rim = [0, 1, 3, 4, 2];
        for (let i = 0; i < rim.length; i++) {
          const a = rim[i], b = rim[(i + 1) % rim.length];
          triangle(points, [a, a + 6, b + 6], underside, rotation, head.center);
          triangle(points, [a, b + 6, b], white, rotation, head.center);
        }
      }
      const center = new THREE.SphereGeometry(head.radius * 0.24, 8, 4);
      try {
        center.scale(1, 0.48, 1); center.translate(0, head.radius * 0.10, 0);
        const points = Array.from({ length: center.attributes.position.count }, (_, i) =>
          new THREE.Vector3().fromBufferAttribute(center.attributes.position, i));
        for (let i = 0; i < center.index.count; i += 3) {
          triangle(points, [center.index.getX(i), center.index.getX(i + 1), center.index.getX(i + 2)], gold, rotation, head.center);
        }
      } finally { center.dispose(); }
      if (headIndex > 0) {
        const base = new THREE.Vector3(tip.x, top * 0.55, tip.z);
        const direction = head.center.clone().sub(base);
        const branch = new THREE.CylinderGeometry(0.0045, 0.007, direction.length(), 5);
        branches.push(branch);
        branch.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
        branch.translate(...base.add(head.center).multiplyScalar(0.5).toArray());
      }
    }
    for (const geometry of [stem, ...branches]) {
      for (const name of Object.keys(geometry.attributes)) if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
      if (!geometry.index) geometry.setIndex(Array.from({ length: geometry.attributes.position.count }, (_, index) => index));
    }
    combinedStem = mergeGeometries([stem, ...branches]);
    if (!combinedStem) throw new Error('Flower stem geometry could not be combined');
    blossom = new THREE.BufferGeometry();
    blossom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    blossom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    blossom.setIndex(Array.from({ length: positions.length / 3 }, (_, index) => index));
    blossom.computeVertexNormals();
    blossom.userData.flowerHeads = heads.map(head => ({ center: head.center.toArray(), radius: head.radius, petals: head.petals }));
    completed = true;
    return { stem: combinedStem, blossom };
  } finally {
    for (const branch of branches) branch.dispose();
    if (!completed) { combinedStem?.dispose(); blossom?.dispose(); }
  }
}

// Bake authored node transforms before applying one shared root/height transform.
export function prepareFlowerPair(gltf) {
  const found = {};
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const name = String(obj.name || '').toLowerCase();
    const part = name.includes('stem') ? 'stem' : name.includes('blossom') ? 'blossom' : null;
    if (part && !found[part]) found[part] = obj;
  });
  if (!found.stem || !found.blossom) throw new Error('flower-nature.glb missing Stem/Blossom meshes');
  const bake = (obj) => obj.geometry.clone().applyMatrix4(obj.matrixWorld);
  let stem = null, authoredBlossom = null, pair = null;
  try {
    stem = bake(found.stem); authoredBlossom = bake(found.blossom);
    stem.computeBoundingBox(); authoredBlossom.computeBoundingBox();
    const box = stem.boundingBox, baseY = box.min.y;
    const height = Math.max(1e-5, Math.max(box.max.y, authoredBlossom.boundingBox.max.y) - baseY);
    const cx = (box.min.x + box.max.x) * 0.5, cz = (box.min.z + box.max.z) * 0.5;
    stem.translate(-cx, -baseY, -cz);
    stem.scale(0.24 / height, 1 / height, 0.24 / height);
    if (!stem.getAttribute('normal')) stem.computeVertexNormals();
    stem.computeBoundingBox();
    pair = wildflowerCluster(stem);
    pair.blossom.computeBoundingBox();
    const top = Math.max(stem.boundingBox.max.y, pair.blossom.boundingBox.max.y);
    for (const geometry of Object.values(pair)) {
      geometry.scale(1 / top, 1 / top, 1 / top);
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    }
    for (const head of pair.blossom.userData.flowerHeads) {
      head.center = head.center.map(value => value / top); head.radius /= top;
    }
    return pair;
  } catch (error) {
    for (const geometry of Object.values(pair || {})) geometry.dispose();
    throw error;
  } finally { stem?.dispose(); authoredBlossom?.dispose(); }
}

export function flowerMaterials() {
  // Instance tints vary the petals; template colors preserve their golden centers.
  return {
    flowerStem: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 }),
    flowerBlossom: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.90 }),
  };
}
