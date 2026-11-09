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
const { createHeadlight, createTailSpill } = await import('../src/vehicle/lamps.js');
const { Vehicle } = await import('../src/vehicle/vehicle.js');

// three.js physical spot light: cookie (bilinear, via the spot's shadow
// matrix) × cone smoothstep × distance attenuation × incidence cosine.
function cookieSampler(texture) {
  const { data, width, height } = texture.image, half = THREE.DataUtils.fromHalfFloat;
  const texel = (i, j) => half(data[(j * width + i) * 4]);
  return (u, v) => {
    const x = THREE.MathUtils.clamp(u * width - 0.5, 0, width - 1), y = THREE.MathUtils.clamp(v * height - 0.5, 0, height - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1), fx = x - x0, fy = y - y0;
    return (texel(x0, y0) * (1 - fx) + texel(x1, y0) * fx) * (1 - fy) + (texel(x0, y1) * (1 - fx) + texel(x1, y1) * fx) * fy;
  };
}
function irradiance(light, point, normal = new THREE.Vector3(0, 1, 0)) {
  const origin = new THREE.Vector3().setFromMatrixPosition(light.matrixWorld);
  const axis = new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld).sub(origin).normalize();
  const ray = point.clone().sub(origin), d = ray.length(); ray.divideScalar(d);
  const cone = THREE.MathUtils.smoothstep(ray.dot(axis), Math.cos(light.angle), Math.cos(light.angle * (1 - light.penumbra)));
  const fade = light.distance > 0 ? Math.max(0, 1 - (d / light.distance) ** 4) ** 2 : 1;
  let cookie = 1;
  if (light.map) {
    const q = new THREE.Vector4(point.x, point.y, point.z, 1).applyMatrix4(light.shadow.matrix);
    const u = q.x / q.w, v = q.y / q.w, z = q.z / q.w;
    if (Math.abs(u * 2 - 1) < 1 && Math.abs(v * 2 - 1) < 1 && Math.abs(z * 2 - 1) < 1) cookie = light.sample(u, v);
  }
  return light.intensity * cookie * cone * fade / Math.max(d ** light.decay, 0.01) * Math.max(0, -normal.dot(ray));
}

test('low beam: long soft road pool, soft lateral edges, dark above the cut-off', () => {
  const group = new THREE.Group(), road = -VEHICLE.rideHeight, lamp = VEHICLE.bodyLength / 2 - 0.08;
  const beam = createHeadlight();
  beam.intensity = VEHICLE.headlight.intensity; beam.sample = cookieSampler(beam.map);
  // The replaced beam: uncookied 55 cd spot, 24 deg cone aimed at the road 28 m out.
  const legacy = new THREE.SpotLight(0xfff0d4, 55, 90, 0.42, 0.55, 1.2);
  legacy.position.set(0, 0.73, lamp); legacy.target.position.set(0, 0, 30);
  group.add(beam, beam.target, legacy, legacy.target);
  group.rotation.y = 0.7; group.position.set(120, 40, -60);
  group.updateMatrixWorld(true); beam.shadow.updateMatrices(beam);
  const at = (x, y, z) => group.localToWorld(new THREE.Vector3(x, y, z));
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(group.quaternion);
  assert.equal(beam.map.type, THREE.HalfFloatType);
  assert.equal(beam.map.generateMipmaps, false);
  assert.equal(beam.map.magFilter, THREE.LinearFilter);
  assert.ok(beam.shadow.camera.near < 0.1, 'the bumper-side foreground stays inside the cookie projection');
  // Kerb side (vehicle -X, drive on the right) maps to u > 0.5; the road ahead to v < 0.5.
  const kerb = new THREE.Vector4(...at(-3, road, lamp + 10).toArray(), 1).applyMatrix4(beam.shadow.matrix);
  assert.ok(kerb.x / kerb.w > 0.6 && kerb.y / kerb.w < 0.5);

  const centre = z => irradiance(beam, at(0, road, lamp + z), up);
  const old = z => irradiance(legacy, at(0, road, lamp + z), up);
  let previous = Infinity;
  for (let z = 2; z <= 120; z += 0.5) {
    const e = centre(z);
    assert.ok(e <= previous * 1.0001, `road light rises again at ${z} m`);
    // Within the pool, never steeper than a bare grazing point source (∝ h/z³):
    // no ring or cone edge. Beyond 60 m the light's distance window fades it out.
    assert.ok(z === 2 || z > 60 || e > previous * ((z - 0.5) / z) ** 3, `road light drops abruptly at ${z} m`);
    previous = e;
  }
  assert.ok(centre(40) / centre(5) > 0.07, 'the pool reaches far down the road');
  assert.ok(old(40) / old(5) < 0.011);
  assert.ok(centre(3) < old(3) * 0.5, 'no hot spot in front of the bumper');
  assert.ok(centre(20) > old(20) * 4);

  // Lateral edges on the asphalt: the steepest relative fall-off across the
  // paved width stays below 3.4/z per metre and well under the replaced cone's
  // (the hard wedge edge). Past the paved edges the beam fades to the verge
  // floor within a few metres, but never as a hard cut (< 1/m relative).
  const paved = 3.5 + 0.58; // lane + shoulder half-width (road/params.js)
  const kerbEdge = paved - VEHICLE.laneOffset, farEdge = -(paved + VEHICLE.laneOffset);
  const steepest = (light, z, lo = -12, hi = 12) => {
    const across = x => irradiance(light, at(-x, road, lamp + z), up), peak = across(0);
    let slope = 0;
    for (let x = lo; x + 0.05 <= hi + 1e-9; x += 0.05) slope = Math.max(slope, Math.abs(across(x + 0.05) - across(x)) / peak / 0.05);
    return slope;
  };
  for (const z of [4, 8, 15, 25]) {
    const slope = steepest(beam, z, farEdge, kerbEdge);
    assert.ok(slope < 3.4 / z, `edge slope ${slope.toFixed(3)}/m at ${z} m`);
    assert.ok(slope < steepest(legacy, z) * 0.7);
    const verge = steepest(beam, z);
    assert.ok(verge < 1, `verge fade ${verge.toFixed(3)}/m at ${z} m`);
  }
  // 15 m ahead: both road edges lit, the far verge dark.
  const across = x => irradiance(beam, at(-x, road, lamp + 15), up);
  const peak = across(0);
  assert.ok(across(kerbEdge) > peak * 0.9, 'kerb-side edge fully lit');
  assert.ok(across(farEdge) > peak * 0.25, 'far edge still reached');
  assert.ok(across(10) < peak * 0.02 && across(-10) < peak * 0.02);

  // Surfaces facing the lamp get ~z/h times the road's incidence cosine. Verge
  // grass (0.4 m up, 1.5 m past either paved edge, bent normal facing the
  // lamp), cut slopes (1:1.4 beyond the 3.8 m verge) and a wall at lamp height
  // stay in the road's irradiance range at the same distance.
  const local = v => v.normalize().applyQuaternion(group.quaternion);
  const back = local(new THREE.Vector3(0, 0, -1));
  const wallAt = (z, y) => irradiance(beam, at(0, road + y, lamp + z), back);
  const lampY = VEHICLE.headlight.mountY + VEHICLE.rideHeight;
  for (const z of [10, 15, 20, 30, 40]) {
    const e = centre(z);
    const kerbGrass = irradiance(beam, at(-(kerbEdge + 1.5), road + 0.4, lamp + z), local(new THREE.Vector3(0.45, 0.62, -0.64)));
    const farGrass = irradiance(beam, at(-(farEdge - 1.5), road + 0.4, lamp + z), local(new THREE.Vector3(-0.45, 0.62, -0.64)));
    assert.ok(kerbGrass < e * 2 && farGrass < e * 2, `verge grass ${kerbGrass.toFixed(3)}/${farGrass.toFixed(3)} vs road ${e.toFixed(3)} at ${z} m`);
    for (const y of [0.5, 2]) {
      const kerbSlope = irradiance(beam, at(-(kerbEdge + 3.8 + y / 0.72), road + y, lamp + z), local(new THREE.Vector3(0.58, 0.81, 0)));
      const farSlope = irradiance(beam, at(-(farEdge - 3.8 - y / 0.72), road + y, lamp + z), local(new THREE.Vector3(-0.58, 0.81, 0)));
      assert.ok(kerbSlope < e && farSlope < e, `cut slope ${kerbSlope.toFixed(3)}/${farSlope.toFixed(3)} vs road ${e.toFixed(3)} at ${z} m`);
    }
    if (z >= 15) assert.ok(wallAt(z, lampY) < e * 4, `wall at lamp height ${wallAt(z, lampY).toFixed(3)} vs road ${e.toFixed(3)} at ${z} m`);
  }
  // Above the cut-off (3 m up a wall 20 m out) only stray light remains.
  const wall = y => wallAt(20, y);
  assert.ok(wall(3) < wall(0.3) * 0.06);
  const cookie = beam.map.image, half = THREE.DataUtils.fromHalfFloat;
  let step = 0;
  for (let j = 0; j < cookie.height; j++) for (let i = 0; i + 1 < cookie.width; i++) {
    step = Math.max(step, Math.abs(half(cookie.data[(j * cookie.width + i + 1) * 4]) - half(cookie.data[(j * cookie.width + i) * 4])));
  }
  assert.ok(step < 0.06, `cookie lateral step ${step}`);
  beam.map.dispose();
});

test('night lights: tail lamps glow red with a short red road spill; day turns them off', () => {
  const tail = new THREE.MeshStandardMaterial(), head = new THREE.MeshStandardMaterial();
  tail.userData.lampRole = 'tail'; head.userData.lampRole = 'head';
  const spill = createTailSpill();
  assert.ok(spill.color.r > 0.9 && spill.color.g < 0.05 && spill.color.b < 0.05);
  assert.equal(spill.decay, 2);
  assert.ok(spill.distance > 0 && spill.distance <= 8 && spill.position.z < -VEHICLE.bodyLength / 2);
  const straight = { at: (s, q) => Object.assign(q, { x: s, y: 0, z: 0, tx: 1, tz: 0, grade: 0, curv: 0 }), kmToS: () => 0, clampS: s => s };
  const vehicle = Object.assign(Object.create(Vehicle.prototype), {
    route: straight, atmo: { palette: { dayness: 0 } }, group: new THREE.Group(), pos: new THREE.Vector3(), _q: {},
    speed: 20, s: 100, wheels: [], assetWheels: [], assetMaterials: [], lampMaterials: [tail, head],
    headlight: new THREE.SpotLight(), lampF: new THREE.MeshStandardMaterial(), lampR: new THREE.MeshStandardMaterial(), tailSpill: spill,
  });
  vehicle.update(0);
  assert.equal(tail.emissiveIntensity, VEHICLE.tailLight.emissive);
  assert.equal(head.emissiveIntensity, VEHICLE.headlampEmissive);
  assert.equal(spill.intensity, VEHICLE.tailLight.spill);
  assert.equal(vehicle.headlight.intensity, VEHICLE.headlight.intensity);
  // Faint: the road 1.5 m behind the spill gets well under the beam's 10 m road light.
  vehicle.group.add(spill); vehicle.group.updateMatrixWorld(true);
  const behind = vehicle.group.localToWorld(new THREE.Vector3(0, -VEHICLE.rideHeight, VEHICLE.tailLight.position[2] - 1.5));
  const towardSpill = new THREE.Vector3().setFromMatrixPosition(spill.matrixWorld).sub(behind);
  const d = towardSpill.length();
  assert.ok(spill.intensity * (towardSpill.y / d) / (d * d) < 0.5);
  vehicle.atmo.palette.dayness = 1;
  vehicle.update(0);
  assert.equal(tail.emissiveIntensity, 0);
  assert.equal(head.emissiveIntensity, 0);
  assert.equal(spill.intensity, 0);
  assert.equal(vehicle.headlight.intensity, 0);
});

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
  road.material.dispose(); Object.values(road.furnitureMaterials).forEach(material => material.dispose());
});
