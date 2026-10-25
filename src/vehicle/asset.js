import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { VEHICLE as V } from './params.js';
import { VehicleEnvironment } from './environment.js';
import { rigModelYWheels } from './wheels.js';
import { lampMaterial, placeHeadlight, splitLampGeometry } from './lamps.js';
import { MIRROR_MESH, createRearMirrorMaterial, splitMirrorGlass } from './mirror.js';

// Lens and internals meshes that carry the head/tail lamps.
const LAMP_MESHES = new Set(['Body_Lamp_Image', 'Body_Lamp_Glass', 'Body_Lamp_Glass_L', 'Body_Lamp_Glass_R', 'Trunk_Lamp_Glass']);
// Fabric and leather are dielectrics; the asset authors them as 0.54/0.23
// metallic, which removes half the diffuse response and leaves the dash and
// pillars near black under sky light.
const DIELECTRIC_INTERIOR = new Set(['M_Int_Cloth', 'M_Int_Leather', 'M_Int_Leather02']);
// The baked cabin AO has a median of ~0.25 and is applied to all indirect
// light; halve its strength so surfaces facing away from the sun keep detail.
const INTERIOR_AO = 0.5;
// Driver's eye in authored model space (+Z forward, +X driver's side, metres).
const COCKPIT_EYE = new THREE.Vector3(0.379, 1.30, -0.10);

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
  const lamps = new Map();
  const bounds = new THREE.Box3();
  const partBounds = new THREE.Box3();
  let mirror = null, mirrorCentre = null;
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
      if (DIELECTRIC_INTERIOR.has(mat.name)) mat.metalness = 0;
      if (mat.name.startsWith('M_Int_') && mat.aoMap) mat.aoMapIntensity = INTERIOR_AO;
      vehicle.atmo.register(mat);
      materials.set(original, mat);
      return mat;
    };
    const mesh = new THREE.Mesh(source.geometry, Array.isArray(source.material) ? source.material.map(convert) : convert(source.material));
    mesh.name = source.name;
    if (LAMP_MESHES.has(source.name) && !Array.isArray(mesh.material)) {
      const roles = splitLampGeometry(source.geometry, source.matrixWorld);
      if (roles) {
        const base = mesh.material;
        mesh.material = roles.map((role) => {
          if (role === 'base') return base;
          const key = `${base.name}:${role}`;
          if (!lamps.has(key)) {
            const lamp = lampMaterial(base, role);
            vehicle.atmo.register(lamp);
            lamps.set(key, lamp);
          }
          return lamps.get(key);
        });
      }
    }
    // The authored mirror glass is white polished metal that can only reflect
    // the sky-only IBL; give it the rear-view material instead.
    if (source.name === MIRROR_MESH && !Array.isArray(mesh.material) && !mirror) {
      mirrorCentre = splitMirrorGlass(source.geometry, source.matrixWorld);
      if (mirrorCentre) {
        mirror = createRearMirrorMaterial(source.matrixWorld, COCKPIT_EYE, mirrorCentre);
        vehicle.atmo.register(mirror);
        mesh.material = [mesh.material, mirror];
      }
    }
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
  vehicle.cockpitEye = COCKPIT_EYE.clone().multiplyScalar(scale).add(root.position);
  if (mirror) mirror.userData.mirrorUniforms.uMirrorHeight.value = mirrorCentre.y * scale + root.position.y + V.rideHeight;
  vehicle.assetBase = { position: root.position.clone(), scale };
  placeHeadlight(vehicle.headlight, V.bodyLength / 2 - 0.08);

  vehicle.group.traverse((mesh) => {
    if (mesh.isMesh) { mesh.userData.fallback = true; mesh.visible = false; }
  });
  vehicle.group.add(root);
  vehicle.asset = root;
  vehicle.assetWheels = wheels;
  vehicle.assetMaterials = [...materials.values(), ...lamps.values()];
  vehicle.lampMaterials = [...lamps.values()];
  vehicle.rearMirror = mirror;
  vehicle.assetEnvironment = env;
  vehicle.assetReady = true;
  vehicle.setCockpit(vehicle.cockpitMode || false);
}
