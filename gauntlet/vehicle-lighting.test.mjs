import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import * as THREE from 'three';
const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(new URL(url), 'utf8'), shortCircuit: true } : next(url, context);
} });
const { VehicleEnvironment } = await import('../src/vehicle/environment.js');
const { skyUniforms } = await import('../src/atmosphere/skylib.js');
const { RoadMesh } = await import('../src/road/roadmesh.js');
const { VEHICLE } = await import('../src/vehicle/params.js');

test('vehicle IBL uses the shared linear sky, rebakes only for lighting changes, and releases replaced targets', t => {
  const targets = [];
  t.mock.method(THREE.PMREMGenerator.prototype, 'fromScene', (scene, sigma, near, far, options) => {
    assert.equal(scene.children.length, 1, 'the streamed world must not enter reflection captures');
    assert.equal(options.size, 128);
    assert.equal(scene.children[0].material.toneMapped, false);
    const target = new THREE.WebGLRenderTarget(384, 512, { type: THREE.HalfFloatType });
    target.disposed = false;
    target.addEventListener('dispose', () => { target.disposed = true; });
    targets.push(target); return target;
  });
  const atmo = { renderer: {}, time: 12, seasonName: 'summer', weatherName: 'clear',
    palette: { grassLush: [0.17, 0.34, 0.09], dayness: 1, snowAmount: 0 } };
  const globalCloudDrift = skyUniforms.uCloudDrift.value.clone();
  const environment = new VehicleEnvironment(atmo);
  t.after(() => environment.dispose());
  assert.ok(environment.material.fragmentShader.includes('skyFull(direction)'));
  assert.ok(environment.material.uniforms.uSkyZenith.value.equals(skyUniforms.uSkyZenith.value));
  assert.notEqual(environment.material.uniforms.uSkyZenith.value, skyUniforms.uSkyZenith.value);
  assert.ok(skyUniforms.uCloudDrift.value.equals(globalCloudDrift));
  const daytimeGround = environment.material.uniforms.uVehicleGround.value.r;
  for (let i = 0; i < 120; i++) assert.equal(environment.update(atmo), false);
  assert.equal(environment.bakes, 1);
  atmo.time = 23; atmo.palette.dayness = 0;
  assert.equal(environment.update(atmo), true);
  assert.equal(environment.bakes, 2);
  assert.equal(targets[0].disposed, true);
  assert.equal(environment.texture, targets[1].texture);
  assert.ok(environment.material.uniforms.uVehicleGround.value.r < daytimeGround * 0.1);
  atmo.weatherName = 'overcast'; environment.update(atmo);
  atmo.seasonName = 'winter'; atmo.palette.snowAmount = 1; environment.update(atmo);
  assert.equal(environment.bakes, 4);
});

test('contact shading uses the road itself, tracks pose without new objects, and includes tyre contact', () => {
  const road = new RoadMesh({ route: {} }, { register() {} }, {}, { uniforms: {} });
  const contact = road.uniforms.uVehicleContact.value, footprint = road.uniforms.uVehicleFootprint.value;
  assert.equal(road.uniforms.uVehicleShadowOpacity.value, 0);
  const vehicle = { pos: new THREE.Vector3(10, 100, 20), heading: Math.PI / 2, dimensions: VEHICLE };
  road.setVehicleContact(vehicle);
  assert.equal(road.uniforms.uVehicleContact.value, contact);
  assert.equal(road.uniforms.uVehicleFootprint.value, footprint);
  assert.equal(contact.x, 10); assert.equal(contact.y, 20);
  assert.ok(Math.abs(contact.z) < 1e-12); assert.equal(contact.w, 1);
  assert.deepEqual(footprint.toArray(), [0.991, 2.395, 0.815, 1.445]);
  vehicle.pos.set(-400, 800, 200); vehicle.heading = 0; road.setVehicleContact(vehicle);
  assert.deepEqual(contact.toArray(), [-400, 200, 1, 0]);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  road.material.onBeforeCompile(shader);
  assert.ok(shader.fragmentShader.includes('vWPosR.xz - uVehicleContact.xy'));
  assert.ok(shader.fragmentShader.includes('wheelContact'));
  assert.ok(shader.fragmentShader.indexOf('float occlusion') > shader.fragmentShader.indexOf('col = mix( col, uPaint, paint )'));
  assert.equal(road.group.children.length, 0, 'no extra shadow plane or draw call');
  road.material.dispose(); road.fenceMaterial.dispose();
});
