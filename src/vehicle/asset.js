import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { VEHICLE as V } from './params.js';
import { VehicleEnvironment } from './environment.js';
import { rigModelYWheels } from './wheels.js';

export async function loadVehicleAsset(vehicle) {
  const draco = new DRACOLoader().setDecoderPath('/draco/').setDecoderConfig({ type: 'wasm' });
  draco.setWorkerLimit(1);
  try {
    const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync('/models/tesla-model-y-2025-awd-compact.glb');
    return prepareVehicleAsset(vehicle, gltf.scene, new VehicleEnvironment(vehicle.atmo));
  } finally { draco.dispose(); }
}

export function prepareVehicleAsset(vehicle, scene, env) {
  scene.updateMatrixWorld(true);
  const root = new THREE.Group();
  root.name = 'tesla-model-y-2025-awd';
  const materials = new Map();
  const bounds = new THREE.Box3();
  const partBounds = new THREE.Box3();
  scene.traverse((source) => {
    if (!source.isMesh) return;
    const sourceMaterials = Array.isArray(source.material) ? source.material : [source.material];
    const interior = sourceMaterials.every(material => material.name.startsWith('M_Int_'));
    const shadow = sourceMaterials.some(material => material.name === 'M_ExtCarShadow');
    // The viewer's broad baked plane intersects a curved road and inherits body
    // roll. Road-space contact shading replaces it without any shadow-map pass.
    if (shadow) return;
    const convert = (original) => {
      if (materials.has(original)) return materials.get(original);
      const mat = original.clone();
      mat.envMap = env.texture;
      mat.envMapIntensity = 0.6;
      if (mat.transparent) mat.depthWrite = false;
      vehicle.atmo.register(mat);
      materials.set(original, mat);
      return mat;
    };
    const mesh = new THREE.Mesh(source.geometry, Array.isArray(source.material) ? source.material.map(convert) : convert(source.material));
    mesh.name = source.name;
    mesh.applyMatrix4(source.matrixWorld);
    mesh.userData.asset = true;
    mesh.userData.interior = interior;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    root.add(mesh);
    // The authored contact-shadow plane is wider than the car; it must not
    // shrink the vehicle or determine the wheel/road contact height.
    bounds.union(partBounds.setFromObject(mesh));
  });
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  if (bounds.isEmpty() || !Number.isFinite(size.z) || size.z <= 0) throw new Error('Vehicle asset has invalid bounds');
  const scale = V.bodyLength / size.z;
  root.scale.setScalar(scale);
  root.position.set(-center.x * scale, -bounds.min.y * scale - V.rideHeight + 0.04, -center.z * scale);
  const wheels = rigModelYWheels(root, scale);
  // Authored Model Y axes: +Z forward, +X driver's side, metres. Compact
  // material batching removes the original named steering-wheel hierarchy.
  vehicle.cockpitEye = new THREE.Vector3(0.379, 1.30, -0.10).multiplyScalar(scale).add(root.position);
  vehicle.headlight.position.set(0, 0.73, V.bodyLength / 2 - 0.08);

  vehicle.group.traverse((mesh) => {
    if (mesh.isMesh) { mesh.userData.fallback = true; mesh.visible = false; }
  });
  vehicle.group.add(root);
  vehicle.asset = root;
  vehicle.assetWheels = wheels;
  vehicle.assetMaterials = [...materials.values()];
  vehicle.assetEnvironment = env;
  vehicle.assetReady = true;
  vehicle.setCockpit(vehicle.cockpitMode || false);
}
