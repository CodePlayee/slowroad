import * as THREE from 'three';
import { TERRAIN } from '../terrain/params.js';

const UNPUBLISHED = new THREE.Matrix4().set(NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN);

export class CullingGroup extends THREE.Group {
  constructor(children) {
    super();
    this.isCullingGroup = true;
    this.matrixAutoUpdate = false;
    // World matrix most recently pushed to the children (see updateMatrixWorld).
    this._publishedWorld = UNPUBLISHED.clone();
    this.userData.cullBounds = new THREE.Box3();
    this.userData.cullPadding = TERRAIN.farRidgeAmp * 2;
    for (const child of children) {
      this.userData.cullBounds.union(child.userData.staticCullBox || child.userData.cullBounds);
      this.add(child);
    }
    // Outer groups query their inner groups, and traversal then queries the
    // inner groups again; a culling pass token memoizes each answer for one pass.
    let visiblePass, visible = false, validPass, valid = false;
    this.userData.batchVisible = (camera, pass) => {
      if (pass !== undefined && pass === visiblePass) return visible;
      visible = children.some(child => child.visible &&
        (!child.userData.batchVisible || child.userData.batchVisible(camera, pass)));
      visiblePass = pass;
      return visible;
    };
    this.userData.cullValid = (pass) => {
      if (pass !== undefined && pass === validPass) return valid;
      valid = children.length === this.children.length &&
        children.every((child, i) => child === this.children[i] &&
          (child.userData.cullValid?.(pass) ?? child.userData.staticCullValid?.(pass) ?? false));
      validPass = pass;
      return valid;
    };
  }

  // The renderer forces a world-matrix recomputation of the entire scene each
  // frame because the scene root auto-updates. Forest members are static
  // (identity, non-auto-updating), so only push a world matrix down when this
  // group's own world matrix actually changed or a child asks for an update.
  updateMatrixWorld(force) {
    if (this.matrixAutoUpdate) this.updateMatrix();
    if (this.matrixWorldNeedsUpdate || force) {
      if (this.matrixWorldAutoUpdate === true) {
        if (this.parent === null) this.matrixWorld.copy(this.matrix);
        else this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
      }
      this.matrixWorldNeedsUpdate = false;
    }
    const moved = !this.matrixWorld.equals(this._publishedWorld);
    if (moved) this._publishedWorld.copy(this.matrixWorld);
    // A hidden (culled) subtree is not drawn. Members that still need an update
    // keep their own dirty flags, and the culler updates each object it visits
    // before testing it, so nothing reads a stale world matrix.
    else if (!this.visible) return;
    for (const child of this.children) {
      if (moved || child.isCullingGroup || child.matrixAutoUpdate || child.matrixWorldNeedsUpdate) child.updateMatrixWorld(moved);
    }
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
