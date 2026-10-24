import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { prepareFlowerPair, flowerMaterials } from './flower.js';

function disposeLoadedScene(gltf) {
  const resources = new Set();
  for (const scene of new Set([gltf.scene, ...(gltf.scenes || [])])) scene?.traverse((object) => {
    if (object.geometry) resources.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      resources.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
    }
  });
  for (const resource of resources) resource.dispose();
}

function disposeCellGeometry(geometry) {
  // Cell geometry borrows every authored vertex/index buffer from the field.
  for (const name of Object.keys(geometry.attributes)) geometry.deleteAttribute(name);
  geometry.setIndex(null);
  geometry.dispose();
}

export class FlowerField {
  constructor(atmo) {
    this.geometry = null;
    this.disposed = false;
    this.meshes = new Set();
    this.assetError = null;
    this.uniforms = { uFlowerSeason: { value: 1 } };
    this.materials = flowerMaterials();
    for (const [name, material] of Object.entries(this.materials)) {
      material.name = `field-${name}`;
      material.alphaToCoverage = true;
      material.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, this.uniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying float vFlowerDistance;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFlowerDistance = length((modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz - cameraPosition);');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uFlowerSeason;\nvarying float vFlowerDistance;')
          .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\ndiffuseColor.a *= uFlowerSeason * (1.0 - smoothstep(55.0, 72.0, vFlowerDistance));');
      };
      material.customProgramCacheKey = () => 'field-flower-v1';
      atmo.register(material);
    }
    this.assetPromise = new GLTFLoader().loadAsync('/models/flower-nature.glb')
      .then(gltf => {
        try { if (!this.disposed) this.geometry = prepareFlowerPair(gltf); }
        finally { disposeLoadedScene(gltf); }
      })
      .catch(error => { if (!this.disposed) this.assetError = String(error.message || error); });
  }

  build(records) {
    if (!this.geometry || this.disposed) return [];
    const flowers = records.filter(r => r.rank < 0.022 && r.cover < 0.65);
    if (!flowers.length) return [];
    const result = [], matrix = new THREE.Matrix4(), position = new THREE.Vector3();
    const rotation = new THREE.Quaternion(), scale = new THREE.Vector3(), color = new THREE.Color();
    let pendingGeometry = null;
    try {
      for (const part of ['stem', 'blossom']) {
        const source = this.geometry[part], geometry = new THREE.BufferGeometry();
        pendingGeometry = geometry;
        for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, attribute);
        geometry.setIndex(source.index);
        geometry.boundingSphere = source.boundingSphere;
        const material = this.materials[part === 'stem' ? 'flowerStem' : 'flowerBlossom'];
        const mesh = new THREE.InstancedMesh(geometry, material, flowers.length);
        const rootBounds = new THREE.Box3(), worldRootBounds = new THREE.Box3(), eye = new THREE.Vector3();
        this.meshes.add(mesh);
        result.push(mesh);
        pendingGeometry = null;
        flowers.forEach((r, i) => {
          position.set(r.x, r.surfaceY ?? r.y, r.z);
          rootBounds.expandByPoint(position);
          rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.yaw);
          const size = r.height * 0.75;
          matrix.compose(position, rotation, scale.setScalar(size));
          mesh.setMatrixAt(i, matrix);
          color.setRGB(...(part === 'stem' ? [0.16, 0.34, 0.075] : r.variant ? [0.98, 0.94, 0.72] : [0.95, 0.97, 0.94]));
          mesh.setColorAt(i, color);
        });
        mesh.computeBoundingSphere();
        mesh.userData.population = { kind: 'flower', ids: flowers.map(r => `${r.id}:flower`) };
        mesh.userData.instanceVisibilityVersion = 0;
        mesh.userData.instanceVisible = (i, camera) => {
          if (this.uniforms.uFlowerSeason.value <= 0) return false;
          const instance = mesh.instanceMatrix.array, at = i * 16, m = mesh.matrixWorld.elements;
          const x = instance[at + 12], y = instance[at + 13], z = instance[at + 14], view = camera.matrixWorld.elements;
          return Math.hypot(m[0] * x + m[4] * y + m[8] * z + m[12] - view[12],
            m[1] * x + m[5] * y + m[9] * z + m[13] - view[13],
            m[2] * x + m[6] * y + m[10] * z + m[14] - view[14]) < 72.01;
        };
        mesh.userData.batchVisible = camera => {
          if (this.uniforms.uFlowerSeason.value <= 0) return false;
          worldRootBounds.copy(rootBounds).applyMatrix4(mesh.matrixWorld);
          eye.setFromMatrixPosition(camera.matrixWorld);
          return worldRootBounds.distanceToPoint(eye) < 72.01;
        };
      }
      return result;
    } catch (error) {
      for (const mesh of result) this.disposeMesh(mesh);
      if (pendingGeometry) disposeCellGeometry(pendingGeometry);
      throw error;
    }
  }

  update(season) {
    const amount = season === 'winter' ? 0 : season === 'autumn' ? 0.4 : 1;
    if (amount === this.uniforms.uFlowerSeason.value) return;
    this.uniforms.uFlowerSeason.value = amount;
    for (const mesh of this.meshes) mesh.userData.instanceVisibilityVersion++;
  }

  disposeMesh(mesh) {
    if (!this.meshes.delete(mesh)) return;
    mesh.removeFromParent();
    disposeCellGeometry(mesh.geometry);
    mesh.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of [...this.meshes]) this.disposeMesh(mesh);
    for (const geometry of Object.values(this.geometry || {})) geometry.dispose();
    this.geometry = null;
    for (const material of Object.values(this.materials)) material.dispose();
  }
}
