import * as THREE from 'three';
import { skyUniforms, SKY_UNIFORM_DECL, SKY_FUNCS, NOISE_FUNCS } from '../atmosphere/skylib.js';

// Bake only the shared sky and a ground hemisphere, never the streamed world.
// Driving reuses this texture; only explicit lighting/weather changes rebake it.
export class VehicleEnvironment {
  constructor(atmo) {
    this.generator = new THREE.PMREMGenerator(atmo.renderer);
    this.scene = new THREE.Scene();
    const uniforms = THREE.UniformsUtils.clone(skyUniforms);
    uniforms.uVehicleGround = { value: new THREE.Color() };
    this.material = new THREE.ShaderMaterial({
      uniforms, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
      vertexShader: `varying vec3 vDirection;
        void main() { vDirection = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec3 vDirection;
        uniform vec3 uVehicleGround;
        ${SKY_UNIFORM_DECL}
        ${NOISE_FUNCS}
        ${SKY_FUNCS}
        void main() {
          vec3 direction = normalize(vDirection);
          vec3 radiance = skyFull(direction);
          // Sky ramps are display-tuned (blue can be 40x red), not measured
          // radiance. Match the hemisphere fill's restrained chroma for IBL.
          float peak = max(radiance.r, max(radiance.g, radiance.b));
          radiance = mix(vec3(peak), radiance, 0.22) * (min(peak, 1.4) / max(peak, 0.00001));
          radiance = mix(radiance, uVehicleGround, 1.0 - smoothstep(-0.22, -0.015, direction.y));
          gl_FragColor = vec4(radiance, 1.0);
        }`,
    });
    this.geometry = new THREE.SphereGeometry(50, 24, 16);
    this.scene.add(new THREE.Mesh(this.geometry, this.material));
    this.bakes = 0;
    this.update(atmo);
  }

  get texture() { return this.target.texture; }

  update(atmo) {
    if (this.target && this.time === atmo.time && this.season === atmo.seasonName && this.weather === atmo.weatherName) return false;
    const uniforms = this.material.uniforms;
    for (const [name, source] of Object.entries(skyUniforms)) {
      if (source.value?.clone) uniforms[name].value.copy(source.value);
      else uniforms[name].value = source.value;
    }
    // Keep capture/revisit results deterministic and avoid adding the sun disc
    // twice: the scene's directional light already supplies direct highlights.
    uniforms.uSkyTime.value = 0;
    uniforms.uCloudDrift.value.set(0, 0, 0, uniforms.uCloudDrift.value.w);
    uniforms.uSunLobe.value.z = 0;
    const palette = atmo.palette;
    uniforms.uVehicleGround.value.setRGB(...palette.grassLush)
      .lerp(new THREE.Color(0.12, 0.125, 0.13), 0.65)
      .lerp(new THREE.Color(0.65, 0.69, 0.72), (palette.snowAmount || 0) * 0.7)
      .multiplyScalar(0.06 + 0.94 * palette.dayness);
    const next = this.generator.fromScene(this.scene, 0, 0.1, 100, { size: 128 });
    next.texture.name = 'vehicle-sky-ground-pmrem';
    this.target?.dispose();
    this.target = next;
    this.time = atmo.time; this.season = atmo.seasonName; this.weather = atmo.weatherName;
    this.bakes++;
    return true;
  }

  dispose() {
    this.target?.dispose(); this.generator.dispose();
    this.geometry.dispose(); this.material.dispose();
  }
}
