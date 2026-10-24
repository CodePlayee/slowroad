import * as THREE from 'three';
import { TERRAIN } from '../terrain/params.js';

export class CullingGroup extends THREE.Group {
  constructor(children) {
    super();
    this.matrixAutoUpdate = false;
    this.userData.cullBounds = new THREE.Box3();
    this.userData.cullPadding = TERRAIN.farRidgeAmp * 2;
    for (const child of children) {
      this.userData.cullBounds.union(child.userData.staticCullBox || child.userData.cullBounds);
      this.add(child);
    }
    this.userData.batchVisible = camera => children.some(child => child.visible &&
      (!child.userData.batchVisible || child.userData.batchVisible(camera)));
    this.userData.cullValid = () => children.length === this.children.length &&
      children.every((child, i) => child === this.children[i] &&
        (child.userData.cullValid?.() ?? child.userData.staticCullValid?.() ?? false));
  }

  traverseVisible(callback) {
    if (!this.visible) return;
    callback(this);
    // Native traverseVisible does not recheck visibility after its callback.
    if (!this.visible) return;
    for (const child of this.children) child.traverseVisible(callback);
  }
}

export function groupFoliage(meshes) {
  if (!meshes.length || meshes.some(mesh => !mesh.userData.staticCullBox)) return null;
  const near = meshes.filter(mesh => mesh.userData.foliageLevel === 'near');
  const far = meshes.filter(mesh => mesh.userData.foliageLevel === 'far');
  return new CullingGroup([near, far].filter(group => group.length).map(group => new CullingGroup(group)));
}
