import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import * as THREE from 'three';
const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(new URL(url), 'utf8'), shortCircuit: true } : next(url, context);
} });
const { prepareVehicleAsset } = await import('../src/vehicle/asset.js');
const { Vehicle } = await import('../src/vehicle/vehicle.js');
const { VEHICLE: V } = await import('../src/vehicle/params.js');
const { CAMERAS } = await import('../src/camera/params.js');

// Minimal GLB reader: decodes the Draco primitives with the served decoder and
// rebuilds the node hierarchy as plain meshes carrying the authored material names.
async function loadCompactModelY() {
  const file = readFileSync(new URL('../public/models/tesla-model-y-2025-awd-compact.glb', import.meta.url));
  const jsonLength = file.readUInt32LE(12);
  const json = JSON.parse(file.toString('utf8', 20, 20 + jsonLength));
  const bin = 20 + jsonLength + 8;
  const DracoDecoderModule = createRequire(import.meta.url)('../public/draco/draco_wasm_wrapper.js');
  const wasmBinary = readFileSync(new URL('../public/draco/draco_decoder.wasm', import.meta.url));
  const { draco } = await new Promise(resolve => DracoDecoderModule({ wasmBinary }).then(module => resolve({ draco: module })));
  const materials = json.materials.map(spec => Object.assign(new THREE.MeshStandardMaterial({
    transparent: spec.alphaMode === 'BLEND', metalness: spec.pbrMetallicRoughness?.metallicFactor ?? 1,
    roughness: spec.pbrMetallicRoughness?.roughnessFactor ?? 1 }), { name: spec.name }));
  for (const [i, spec] of json.materials.entries()) if (spec.occlusionTexture) materials[i].aoMap = new THREE.Texture();
  const decoder = new draco.Decoder();
  const primitive = (spec) => {
    const ext = spec.extensions.KHR_draco_mesh_compression, view = json.bufferViews[ext.bufferView];
    const buffer = new draco.DecoderBuffer();
    buffer.Init(new Int8Array(file.buffer, file.byteOffset + bin + (view.byteOffset || 0), view.byteLength), view.byteLength);
    const mesh = new draco.Mesh();
    assert.ok(decoder.DecodeBufferToMesh(buffer, mesh).ok());
    const geometry = new THREE.BufferGeometry(), points = mesh.num_points();
    for (const [name, id] of Object.entries(ext.attributes)) {
      const attribute = decoder.GetAttributeByUniqueId(mesh, id), size = attribute.num_components();
      const values = new draco.DracoFloat32Array();
      decoder.GetAttributeFloatForAllPoints(mesh, attribute, values);
      const array = new Float32Array(points * size);
      for (let i = 0; i < array.length; i++) array[i] = values.GetValue(i);
      draco.destroy(values);
      geometry.setAttribute({ POSITION: 'position', NORMAL: 'normal', TEXCOORD_0: 'uv' }[name], new THREE.BufferAttribute(array, size));
    }
    const faces = new draco.DracoInt32Array(), index = new Uint32Array(mesh.num_faces() * 3);
    for (let f = 0; f < mesh.num_faces(); f++) {
      decoder.GetFaceFromMesh(mesh, f, faces);
      for (let k = 0; k < 3; k++) index[f * 3 + k] = faces.GetValue(k);
    }
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    draco.destroy(faces); draco.destroy(mesh); draco.destroy(buffer);
    return new THREE.Mesh(geometry, materials[spec.material]);
  };
  const scene = new THREE.Group();
  for (const node of json.nodes) {
    if (node.mesh === undefined) continue;
    const object = new THREE.Group();
    if (node.translation) object.position.fromArray(node.translation);
    if (node.rotation) object.quaternion.fromArray(node.rotation);
    if (node.scale) object.scale.fromArray(node.scale);
    const prims = json.meshes[node.mesh].primitives.map(primitive);
    for (const mesh of prims) { mesh.name = node.name; object.add(mesh); }
    scene.add(object);
  }
  draco.destroy(decoder);
  return scene;
}

function preparedModelY(scene) {
  const vehicle = Object.assign(Object.create(Vehicle.prototype), { group: new THREE.Group(), interior: new THREE.Group(),
    atmo: { register() {} }, headlight: new THREE.SpotLight() });
  prepareVehicleAsset(vehicle, scene, { texture: new THREE.Texture() });
  vehicle.group.updateMatrixWorld(true);
  return vehicle;
}

// Nearest visible depth of front-facing cabin surfaces inside the cockpit
// frustum (16:9), clipping each triangle to the four side planes.
function nearestCabinDepth(vehicle) {
  const eye = new THREE.Vector3(), aim = new THREE.Vector3();
  vehicle.cockpitPose(eye, aim);
  const camera = new THREE.PerspectiveCamera(CAMERAS.cockpit.fov, 16 / 9, CAMERAS.near, CAMERAS.far);
  camera.position.copy(eye); camera.lookAt(aim); camera.updateMatrixWorld(true);
  const view = camera.matrixWorldInverse, t = Math.tan(THREE.MathUtils.degToRad(CAMERAS.cockpit.fov / 2));
  const planes = [[1, 0, t * 16 / 9], [-1, 0, t * 16 / 9], [0, 1, t], [0, -1, t]].map(n => new THREE.Vector3(...n));
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  let nearest = Infinity;
  vehicle.group.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.visible || !mesh.userData.interior) return;
    const toView = view.clone().multiply(mesh.matrixWorld), position = mesh.geometry.attributes.position, index = mesh.geometry.index.array;
    const mirrored = mesh.matrixWorld.determinant() < 0;
    for (let i = 0; i < index.length; i += 3) {
      for (let k = 0; k < 3; k++) p[k].fromBufferAttribute(position, index[i + k]).applyMatrix4(toView);
      const facing = e1.subVectors(p[1], p[0]).cross(e2.subVectors(p[2], p[0])).dot(p[0]);
      if (mirrored ? facing <= 0 : facing >= 0) continue;
      let poly = p.map(v => v.clone());
      for (const plane of planes) {
        const next = [];
        for (let k = 0; k < poly.length; k++) {
          const a = poly[k], b = poly[(k + 1) % poly.length], da = a.dot(plane), db = b.dot(plane);
          if (da <= 0) next.push(a);
          if ((da <= 0) !== (db <= 0)) next.push(a.clone().lerp(b, da / (da - db)));
        }
        poly = next;
        if (!poly.length) break;
      }
      for (const v of poly) nearest = Math.min(nearest, -v.z);
    }
  });
  return nearest;
}

test('real Model Y: tail/head lamp triangles get emissive lamp materials, reflectors and badges do not', async () => {
  const vehicle = preparedModelY(await loadCompactModelY());
  const byName = name => vehicle.asset.children.find(mesh => mesh.name === name);
  const roleTriangles = (mesh) => Object.fromEntries(mesh.geometry.groups.map(group =>
    [mesh.material[group.materialIndex].userData.lampRole || 'base', group.count / 3]));
  assert.deepEqual(roleTriangles(byName('Trunk_Lamp_Glass')), { tail: 988 });
  assert.deepEqual(roleTriangles(byName('Body_Lamp_Glass')), { head: 120 });
  for (const side of ['L', 'R']) assert.deepEqual(roleTriangles(byName(`Body_Lamp_Glass_${side}`)), { base: 23, tail: 25 });
  // 102 rear light-bar/internals triangles (incl. the bar's centre badge), the
  // 70-triangle head strip; bumper reflectors (y < 0.6) stay unlit.
  assert.deepEqual(roleTriangles(byName('Body_Lamp_Image')), { base: 240, tail: 102, head: 70 });
  assert.equal(vehicle.lampMaterials.length, 4);
  for (const material of vehicle.lampMaterials) {
    assert.equal(material.emissiveIntensity, 0);
    assert.ok(vehicle.assetMaterials.includes(material));
    assert.ok(material.userData.lampRole === 'tail' ? material.emissive.r > 10 * material.emissive.g : material.emissive.g > 0.8);
  }
  const cloth = vehicle.assetMaterials.find(material => material.name === 'M_Int_Cloth');
  assert.equal(cloth.metalness, 0);
  assert.equal(cloth.aoMapIntensity, 0.5);
  assert.equal(vehicle.assetMaterials.find(material => material.name === 'M_Ext_Paint').metalness, 0.93);
});

test('real Model Y cockpit: no visible cabin surface is cut by the camera near plane', async () => {
  const vehicle = preparedModelY(await loadCompactModelY());
  vehicle.cockpitMode = false;
  const restingDepth = nearestCabinDepth(vehicle);
  assert.ok(restingDepth < CAMERAS.near, `unscaled headliner reaches ${restingDepth.toFixed(3)} m`);
  const eye = new THREE.Vector3(), aim = new THREE.Vector3(), pose = () => { vehicle.cockpitPose(eye, aim); return [...eye.toArray(), ...aim.toArray()]; };
  const restingPose = pose(), position = vehicle.asset.position.clone(), scale = vehicle.asset.scale.x;
  vehicle.setCockpit(true);
  vehicle.group.updateMatrixWorld(true);
  const cockpitDepth = nearestCabinDepth(vehicle);
  assert.ok(cockpitDepth > CAMERAS.near * 1.03, `cabin starts ${cockpitDepth.toFixed(3)} m from the eye`);
  assert.ok(Math.abs(cockpitDepth / restingDepth - 1.45) < 1e-6, 'uniform scale about the eye keeps the projection');
  assert.deepEqual(pose(), restingPose);
  vehicle.setCockpit(false);
  assert.ok(vehicle.asset.position.equals(position));
  assert.equal(vehicle.asset.scale.x, scale);
});

test('real Model Y rear-view mirror: the glass reflects the rear window, not the white sky IBL', async () => {
  const vehicle = preparedModelY(await loadCompactModelY());
  const mesh = vehicle.asset.children.find(child => child.name === 'Roof_Internal_ChromePlastic');
  const mirror = vehicle.rearMirror;
  // The authored glass is white, metallic texels; it gets its own unlit material.
  assert.ok(mirror?.isMeshBasicMaterial);
  assert.equal(mesh.material[1], mirror);
  assert.equal(mesh.material[0].name, 'M_Int_ChromePlastic');
  assert.deepEqual(mesh.geometry.groups.map(group => [group.materialIndex, group.count / 3]), [[0, 21997], [1, 32]]);
  assert.ok(!vehicle.assetMaterials.includes(mirror), 'per-frame envMap assignment must not reach the mirror');
  assert.equal(mirror.envMap, null);
  const uniforms = mirror.userData.mirrorUniforms;
  assert.ok(uniforms.uMirrorHeight.value > 1.3 && uniforms.uMirrorHeight.value < 1.6);

  // Planar reflection of the driver's view: every glass vertex shows the scene
  // behind the car (through the rear window), slightly below the horizon.
  const reflected = () => {
    vehicle.group.updateMatrixWorld(true);
    const eye = new THREE.Vector3(), aim = new THREE.Vector3();
    vehicle.cockpitPose(eye, aim);
    const basis = new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld);
    const normal = uniforms.uMirrorNormal.value.clone().applyMatrix3(basis).normalize();
    const forward = uniforms.uMirrorForward.value.clone().applyMatrix3(basis).normalize();
    const side = uniforms.uMirrorSide.value.clone().applyMatrix3(basis).normalize();
    const group = mesh.geometry.groups[1], index = mesh.geometry.index.array, position = mesh.geometry.attributes.position;
    const rays = [];
    for (let i = group.start; i < group.start + group.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(position, index[i]).applyMatrix4(mesh.matrixWorld);
      const r = p.sub(eye).normalize().reflect(normal);
      rays.push({ back: -r.dot(forward), elevation: Math.asin(r.y), azimuth: Math.atan2(r.dot(side), -r.dot(forward)) });
    }
    return rays;
  };
  const resting = reflected();
  for (const { back, elevation, azimuth } of resting) {
    assert.ok(back > 0.95, `reflected ray points back (${back.toFixed(3)})`);
    assert.ok(elevation > -0.12 && elevation < 0.04, `elevation ${elevation.toFixed(3)} rad`);
    assert.ok(Math.abs(azimuth) < 0.3, `azimuth ${azimuth.toFixed(3)} rad`);
  }
  const elevations = resting.map(ray => ray.elevation);
  assert.ok(Math.min(...elevations) < -0.03 && Math.max(...elevations) > -0.01, 'road below, horizon in view');
  vehicle.setCockpit(true);
  const cockpit = reflected();
  for (let i = 0; i < resting.length; i++) assert.ok(Math.abs(cockpit[i].elevation - resting[i].elevation) < 1e-3);
  vehicle.setCockpit(false);
});

test('the supplied compact GLB is unchanged and its Draco decoder is served locally', () => {
  const file = readFileSync(new URL('../public/models/tesla-model-y-2025-awd-compact.glb', import.meta.url));
  assert.equal(createHash('sha256').update(file).digest('hex'), 'b3301a2b4b4935c9323d1a430461cfca85096b674b7d8535c5dd6e3693492c90');
  const json = JSON.parse(file.toString('utf8', 20, 20 + file.readUInt32LE(12)));
  assert.ok(json.extensionsRequired.includes('KHR_draco_mesh_compression'));
  assert.ok(json.extensionsRequired.includes('EXT_texture_webp'));
  assert.equal(json.images.length, 16);
  assert.equal(json.animations?.length || 0, 0);
  assert.equal(json.meshes.reduce((sum, mesh) => sum + mesh.primitives.length, 0), 22);
  const wasm = readFileSync(new URL('../public/draco/draco_decoder.wasm', import.meta.url));
  assert.deepEqual([...wasm.subarray(0, 4)], [0, 97, 115, 109]);
  assert.ok(readFileSync(new URL('../public/draco/draco_wasm_wrapper.js', import.meta.url)).length > 10000);
});

test('Model Y keeps its materials and interior, excludes the shadow from scale, and grounds its tyres', () => {
  const source = new THREE.Group(), registered = [];
  const material = (name, options = {}) => Object.assign(new THREE.MeshStandardMaterial(options), { name });
  const paint = material('M_Ext_Paint', { color: 0xaaa6b1, metalness: 0.93, roughness: 0.51 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.63, 4.75).translate(0, 0.815, 0), paint);
  body.name = 'Roof_Paint'; source.add(body);
  const interior = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.1, 0.5), material('M_Int_ChromePlastic'));
  interior.position.set(0, 0.9, 0.6); source.add(interior);
  const glassMaterial = material('M_Ext_Glass', { transparent: true, opacity: 0.4 });
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), glassMaterial);
  glass.name = 'Door_RF_Glass'; glass.position.set(-0.8, 1.2, 0); glass.scale.x = -1; source.add(glass);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(8, 8).rotateX(-Math.PI / 2), material('M_ExtCarShadow', { transparent: true }));
  shadow.position.y = -0.2; source.add(shadow);
  const fallback = new THREE.Mesh(new THREE.BoxGeometry(), paint), group = new THREE.Group();
  group.add(fallback);
  const vehicle = Object.assign(Object.create(Vehicle.prototype), { group, interior: new THREE.Group(),
    atmo: { register: mat => registered.push(mat) }, headlight: new THREE.SpotLight() });
  const env = { texture: new THREE.Texture() };
  prepareVehicleAsset(vehicle, source, env);
  vehicle.group.updateMatrixWorld(true);
  assert.equal(vehicle.assetReady, true);
  assert.equal(vehicle.asset.name, 'tesla-model-y-2025-awd');
  const meshes = vehicle.asset.children;
  const renderedBody = meshes.find(mesh => mesh.name === 'Roof_Paint');
  const bounds = new THREE.Box3().setFromObject(renderedBody);
  assert.ok(Math.abs(bounds.getSize(new THREE.Vector3()).z - 4.79) < 1e-6);
  assert.ok(Math.abs(bounds.min.y + V.rideHeight - 0.04) < 1e-6);
  assert.equal(renderedBody.material.metalness, paint.metalness);
  assert.equal(renderedBody.material.roughness, paint.roughness);
  assert.ok(renderedBody.material.color.equals(paint.color));
  assert.notEqual(renderedBody.material, paint);
  assert.equal(renderedBody.material.envMap, env.texture);
  assert.equal(paint.envMap, null);
  const renderedGlass = meshes.find(mesh => mesh.name === 'Door_RF_Glass');
  assert.equal(renderedGlass.material.opacity, 0.4);
  assert.equal(renderedGlass.material.transparent, true);
  assert.equal(renderedGlass.material.depthWrite, false);
  assert.ok(renderedGlass.scale.x < 0);
  assert.equal(registered.length, 3);
  assert.equal(meshes.length, 3);
  assert.ok(meshes.every(mesh => !mesh.castShadow && !mesh.receiveShadow));
  assert.ok(meshes.every(mesh => mesh.material.name !== 'M_ExtCarShadow'));
  assert.equal(fallback.visible, false);
  assert.equal(vehicle.assetWheels.length, 0, 'this synthetic fixture contains no wheel primitives');
  assert.ok(vehicle.cockpitEye.x > 0 && vehicle.cockpitEye.y > 1 && vehicle.cockpitEye.y < 1.6);
  vehicle.setCockpit(true);
  assert.ok(meshes.filter(mesh => mesh.visible).every(mesh => mesh.userData.interior));
  assert.ok(meshes.some(mesh => mesh.visible));
  vehicle.setCockpit(false);
  assert.ok(meshes.every(mesh => mesh.visible));
  assert.equal(fallback.visible, false);
});
