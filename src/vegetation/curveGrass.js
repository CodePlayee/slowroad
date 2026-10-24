import * as THREE from 'three';

// Three rotated, tapered ribbons. Unlike the old alpha cards, each blade bends
// in depth and has a matching curved normal, so a clump keeps volume as the
// camera moves around it.
export function buildCurveBladeGeometry(segments = 5) {
  const positions = [];
  const normals = [];
  const planes = [];
  const indices = [];
  for (let plane = 0; plane < 3; plane++) {
    const base = positions.length / 3;
    for (let j = 0; j <= segments; j++) {
      const t = j / segments;
      positions.push(-0.5, t, 0, 0.5, t, 0);
      normals.push(0, 0, 1, 0, 0, 1);
      planes.push(plane, plane);
    }
    for (let j = 0; j < segments; j++) {
      const a = base + j * 2;
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('bladePlane', new THREE.Float32BufferAttribute(planes, 1));
  g.setIndex(indices);
  g.computeBoundingSphere();
  return g;
}

export function curveGrassMaterial() {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x18220f,
    emissiveIntensity: 0.22,
    roughness: 0.88,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: 0,
  });
  m.userData.uniforms = {
    uWind: { value: new THREE.Vector4(0, Math.cos(0.7), Math.sin(0.7), 0) },
    uBase: { value: new THREE.Color(0x40552a) },
    uTip: { value: new THREE.Color(0xb2c76d) },
    uSway: { value: 0.24 },
  };
  m.defines = { CURVE_GRASS: '' };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, m.userData.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float bladePlane;
        attribute float iGrassHeight;
        attribute float iGrassWidth;
        attribute float iGrassPhase;
        attribute float iGrassCurl;
        attribute float iGrassColor;
        varying float vGrassT;
        varying float vGrassColor;
        uniform vec4 uWind;
        uniform float uSway;`)
      .replace('#include <beginnormal_vertex>', `
        float curveA = max(0.10, iGrassCurl);
        float curveT = clamp(position.y, 0.0, 1.0);
        float bladeAngle = bladePlane * 1.04719755;
        vec2 arcAxis = vec2(-sin(bladeAngle), cos(bladeAngle));
        vec3 objectNormal = normalize(vec3(arcAxis.x * cos(curveA * curveT),
          -sin(curveA * curveT), arcAxis.y * cos(curveA * curveT)));
      `)
      .replace('#include <begin_vertex>', `
        float curveA2 = max(0.10, iGrassCurl);
        float t = clamp(position.y, 0.0, 1.0);
        float h = iGrassHeight;
        float arcY = h * sin(curveA2 * t) / curveA2;
        float arcZ = h * (1.0 - cos(curveA2 * t)) / curveA2;
        float bladeAngle2 = bladePlane * 1.04719755;
        vec2 sideAxis = vec2(cos(bladeAngle2), sin(bladeAngle2));
        vec2 arcAxis2 = vec2(-sin(bladeAngle2), cos(bladeAngle2));
        float side = position.x;
        float width = iGrassWidth * pow(1.0 - t, 0.74) * side;
        vec3 transformed = vec3(sideAxis.x * width + arcAxis2.x * arcZ,
          arcY, sideAxis.y * width + arcAxis2.y * arcZ);
        float phase = iGrassPhase + instanceMatrix[3][0] * 0.011 + instanceMatrix[3][2] * 0.017;
        float gust = sin(uWind.x + phase) * 0.65 + sin(uWind.x * 1.71 + phase * 1.9) * 0.35;
        transformed.xz += uWind.yz * (uSway * gust * pow(t, 1.65));
        vGrassT = t;
        vGrassColor = iGrassColor;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vGrassT;
        varying float vGrassColor;
        uniform vec3 uBase;
        uniform vec3 uTip;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 grassColor = mix(uBase, uTip, smoothstep(0.04, 1.0, vGrassT));
        grassColor *= mix(0.72, 1.22, clamp(vGrassColor, 0.0, 1.0));
        diffuseColor.rgb = grassColor;
      `);
  };
  m.customProgramCacheKey = () => 'curve-grass-v1';
  return m;
}
