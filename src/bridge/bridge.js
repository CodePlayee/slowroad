// src/bridge/bridge.js — a bridge is a CONTINUATION OF THE ROAD that happens to have
// a parapet and a structure hanging under it (BRIDGE_SPEC §0), not an object the road
// sits on. Deck axis == road axis, deck grade == road grade, always.
// Owned by the BRIDGE builder agent.

import * as THREE from 'three';
import { BRIDGE as B } from './params.js';
import { ROAD as R } from '../road/params.js';
import { crossSection, ROAD_EDGES } from '../world/world.js';
import { clamp, lerp, smoothstep } from '../core/rng.js';

const { HALF_PAVE } = ROAD_EDGES;
const CLEAR_HALF = HALF_PAVE + B.clearGap;
const OUT_HALF = CLEAR_HALF + B.parapetThk;

class Builder {
  constructor() { this.p = []; this.c = []; this.i = []; this.n = 0; }
  v(x, y, z, col) { this.p.push(x, y, z); this.c.push(col[0], col[1], col[2]); return this.n++; }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  /** Add a quad from 4 xyz triples, winding a->b->c->d. */
  face(A, BB, C, D, col) {
    const a = this.v(A[0], A[1], A[2], col), b = this.v(BB[0], BB[1], BB[2], col);
    const c = this.v(C[0], C[1], C[2], col), d = this.v(D[0], D[1], D[2], col);
    this.quad(a, b, c, d);
  }
  box(cx, cy, cz, ax, az, hx, hy, hz, col, taper = 0) {
    // ax/az = unit long axis in the XZ plane; hx = half length along it,
    // hz = half thickness across it, hy = half height. taper widens the base.
    const bx = -az, bz = ax;
    const corner = (sx, sy, sz) => {
      const grow = sy < 0 ? taper : 0;
      return [
        cx + ax * hx * sx + bx * (hz + grow) * sz,
        cy + hy * sy,
        cz + az * hx * sx + bz * (hz + grow) * sz,
      ];
    };
    const p000 = corner(-1, -1, -1), p100 = corner(1, -1, -1), p110 = corner(1, -1, 1), p010 = corner(-1, -1, 1);
    const q000 = corner(-1, 1, -1), q100 = corner(1, 1, -1), q110 = corner(1, 1, 1), q010 = corner(-1, 1, 1);
    this.face(q000, q100, q110, q010, col);                 // top
    this.face(p010, p110, p100, p000, col);                 // bottom
    this.face(p000, p100, q100, q000, col);                 // side -z
    this.face(p110, p010, q010, q110, col);                 // side +z
    this.face(p100, p110, q110, q100, col);                 // end +x
    this.face(p010, p000, q000, q010, col);                 // end -x
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const CONCRETE_FRAG_HEAD = /* glsl */`
varying vec3 vWPosB;
uniform float uWaterY;
float bhash( vec2 p ) { p = fract( p * vec2( 443.897, 441.423 ) ); p += dot( p, p + 19.19 ); return fract( p.x * p.y ); }
float bvn( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( bhash( i ), bhash( i + vec2( 1, 0 ) ), f.x ), mix( bhash( i + vec2( 0, 1 ) ), bhash( i + vec2( 1, 1 ) ), f.x ), f.y );
}
float bfbm( vec2 p ) { float s = 0.0, a = 0.5; for ( int i = 0; i < 4; i ++ ) { s += a * bvn( p ); p *= 2.09; a *= 0.5; } return s; }
`;
const CONCRETE_FRAG_BODY = /* glsl */`
  vec3 w = vWPosB;
  // per-pour tonal variation
  float pour = bvn( vec2( floor( w.y / 0.78 ) * 3.7, floor( ( w.x + w.z ) / 2.6 ) * 1.9 ) );
  float tone = 0.93 + 0.14 * pour;
  // horizontal form-lift lines every 0.78 m
  float lift = abs( fract( w.y / 0.78 ) - 0.5 ) * 2.0;
  tone *= 1.0 - 0.10 * smoothstep( 0.86, 1.0, lift );
  // vertical drip streaks running downward
  float streak = bfbm( vec2( ( w.x * 2.6 + w.z * 2.6 ), w.y * 0.22 ) );
  tone *= 0.90 + 0.18 * streak;
  tone *= 0.94 + 0.12 * bfbm( w.xz * 6.0 + w.y * 0.7 );
  // three waterline bands
  float above = w.y - uWaterY;
  float wet = 1.0 - smoothstep( 0.0, 0.42, above );
  float mineral = ( 1.0 - smoothstep( 0.42, 1.6, above ) ) * step( 0.42, above );
  vec3 col = diffuseColor.rgb * tone;
  col = mix( col, col * vec3( 0.30, 0.36, 0.30 ), wet * 0.85 );
  col = mix( col, col * vec3( 0.82, 0.78, 0.70 ), mineral * 0.7 );
  diffuseColor.rgb = col;
`;

export class BridgeSystem {
  constructor(world, atmo, scheduler) {
    this.world = world;
    this.atmo = atmo;
    this.scheduler = scheduler;
    this.route = world.route;
    this.group = new THREE.Group();
    this.group.name = 'bridges';
    this.built = new Map();
    this.version = 0;
    this.range = { behind: 900, ahead: 3200 };
  }

  _material(waterY) {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.78, metalness: 0.0, dithering: true,
    });
    m.name = 'bridge-concrete';
    const u = { uWaterY: { value: waterY } };
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uWaterY = u.uWaterY;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPosB;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWPosB = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + CONCRETE_FRAG_HEAD)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + CONCRETE_FRAG_BODY);
    };
    m.customProgramCacheKey = () => 'bridge-concrete';
    this.atmo.register(m);
    return m;
  }

  rebuildAll() {
    this.version++;
    for (const [, o] of this.built) this._dispose(o);
    this.built.clear();
    this.scheduler.drop((k) => k.startsWith('bridge:'));
  }

  _dispose(o) {
    this.group.remove(o);
    o.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
  }

  update(carS) {
    const s0 = carS - this.range.behind, s1 = carS + this.range.ahead;
    const want = new Set();
    this.route.bridges.forEach((b, i) => {
      if (b.s1 > s0 && b.s0 < s1) want.add(`bridge:${this.version}:${i}`);
    });
    for (const [k, o] of this.built) if (!want.has(k)) { this._dispose(o); this.built.delete(k); }
    this.scheduler.drop((k) => k.startsWith('bridge:') && !want.has(k));
    this.required = want.size;
    this.route.bridges.forEach((b, i) => {
      const key = `bridge:${this.version}:${i}`;
      if (!want.has(key) || this.built.has(key) || this.scheduler.has(key)) return;
      this.scheduler.push(key, Math.abs(b.s0 - carS) * 0.01 - 5, () => this._build(key, b));
    });
  }

  get resident() { return this.built.size; }

  /** In-view bridges that are not yet resident (used by __rig.ready). */
  pending() { return (this.required || 0) - this.built.size; }

  _build(key, b) {
    const rt = this.route, world = this.world;
    const g = new THREE.Group();
    g.name = key;
    const org = rt.at((b.s0 + b.s1) / 2, {});
    const OX = org.x, OY = org.y, OZ = org.z;
    const mb = new Builder();
    const C = B.concrete, CD = B.concreteDark;

    const n = Math.max(3, Math.ceil((b.s1 - b.s0) / B.longStep) + 1);
    const step = (b.s1 - b.s0) / (n - 1);
    const X = [];
    const q = {};
    for (let i = 0; i < n; i++) {
      const s = b.s0 + i * step;
      const p = rt.at(s, {});
      const nx = -p.tz, nz = p.tx;
      const deckTop = p.y + crossSection(CLEAR_HALF) + R.surfaceLift;
      const fasciaTop = deckTop - B.deckTopInset;
      const soffitY = fasciaTop - b.deckDepth;
      X.push({ s, p, nx, nz, deckTop, fasciaTop, soffitY });
    }

    const pt = (k, lat, y) => {
      const c = X[k];
      return [c.p.x + c.nx * lat - OX, y - OY, c.p.z + c.nz * lat - OZ];
    };

    // ---------- parapets, fascia, soffit ----------
    for (const side of [-1, 1]) {
      const inner = side * CLEAR_HALF;
      const outer = side * OUT_HALF;
      const fasc = side * (OUT_HALF + B.fasciaProject);
      for (let i = 0; i < n - 1; i++) {
        const a = i, c = i + 1;
        const topA = X[a].deckTop, topC = X[c].deckTop;
        const railA = topA + B.parapetH, railC = topC + B.parapetH;
        const fA = X[a].fasciaTop, fC = X[c].fasciaTop;
        const sA = X[a].soffitY, sC = X[c].soffitY;
        const w = side > 0;
        const F = (P0, P1, P2, P3, col) => w ? mb.face(P0, P1, P2, P3, col) : mb.face(P3, P2, P1, P0, col);

        // parapet inner face
        F(pt(a, inner, topA), pt(c, inner, topC), pt(c, inner, railC), pt(a, inner, railA), C);
        // coping top
        F(pt(a, inner - side * B.copingOverhang, railA), pt(a, outer + side * B.copingOverhang, railA),
          pt(c, outer + side * B.copingOverhang, railC), pt(c, inner - side * B.copingOverhang, railC),
          [C[0] * 1.06, C[1] * 1.06, C[2] * 1.06]);
        // parapet outer face down to the fascia top
        F(pt(a, outer, railA), pt(c, outer, railC), pt(c, outer, fC), pt(a, outer, fA), C);
        // fascia band (projects outward -> shadow line)
        F(pt(a, fasc, fA), pt(c, fasc, fC), pt(c, fasc, sC - B.fasciaLip), pt(a, fasc, sA - B.fasciaLip), C);
        // small top ledge between parapet face and fascia face
        F(pt(a, outer, fA), pt(c, outer, fC), pt(c, fasc, fC), pt(a, fasc, fA), CD);
        // fascia lip underside
        F(pt(a, fasc, sA - B.fasciaLip), pt(c, fasc, sC - B.fasciaLip), pt(c, outer, sC - B.fasciaLip), pt(a, outer, sA - B.fasciaLip), CD);
      }
    }
    // soffit (facing down, dark)
    for (let i = 0; i < n - 1; i++) {
      const a = i, c = i + 1;
      mb.face(pt(a, -OUT_HALF, X[a].soffitY), pt(a, OUT_HALF, X[a].soffitY),
        pt(c, OUT_HALF, X[c].soffitY), pt(c, -OUT_HALF, X[c].soffitY),
        [CD[0] * 0.62, CD[1] * 0.62, CD[2] * 0.64]);
    }

    // ---------- piers ----------
    const fr = b.nSpans === 2 ? [0.44, 0.56] : b.nSpans === 3 ? [0.30, 0.40, 0.30]
      : new Array(b.nSpans).fill(1 / b.nSpans);
    let acc = 0;
    for (let k = 0; k < b.nSpans - 1; k++) {
      acc += fr[k];
      const s = b.s0 + acc * (b.s1 - b.s0);
      const p = rt.at(s, q);
      const riv = world.hf.river(p.x, p.z);
      const gl = Math.hypot(riv.gx, riv.gz) || 1e-9;
      let ax = -riv.gz / gl, az = riv.gx / gl;   // along the flow
      if (!Number.isFinite(ax)) { ax = p.tx; az = p.tz; }
      const bed = world.hf.ground(p.x, p.z);
      const soffit = p.y + crossSection(CLEAR_HALF) + R.surfaceLift - B.deckTopInset - b.deckDepth;
      const top = soffit - 0.05;
      const bot = bed - B.pierEmbed;
      const h = Math.max(1.2, top - bot);
      const hx = (B.pierThk * B.pierLenRatio) / 2;
      const taper = h * B.pierBatter;
      mb.box(p.x - OX, (top + bot) / 2 - OY, p.z - OZ, ax, az, hx, h / 2, B.pierThk / 2, C, taper);
      // pier cap flare just under the soffit
      mb.box(p.x - OX, top - 0.18 - OY, p.z - OZ, ax, az, hx * 1.04, 0.20, B.pierThk / 2 + 0.16, C, 0);
    }

    // ---------- abutments + wingwalls ----------
    for (const endIdx of [0, n - 1]) {
      const c = X[endIdx];
      const dirIn = endIdx === 0 ? 1 : -1;
      const gy = world.hf.ground(c.p.x, c.p.z);
      const top = c.soffitY - 0.02;
      const bot = Math.min(gy, c.soffitY - 2.2) - B.abutEmbed;
      const h = Math.max(1.5, top - bot);
      const cx = c.p.x - c.p.tx * dirIn * (B.abutThk / 2);
      const cz = c.p.z - c.p.tz * dirIn * (B.abutThk / 2);
      // wall across the road, long axis = road normal
      mb.box(cx - OX, (top + bot) / 2 - OY, cz - OZ, c.nx, c.nz, OUT_HALF + 0.1, h / 2, B.abutThk / 2, C, 0.12);
      // wingwalls splaying back into the bank, buried by the graded fill
      for (const side of [-1, 1]) {
        const sx = c.p.x + c.nx * side * (OUT_HALF - 0.1);
        const sz = c.p.z + c.nz * side * (OUT_HALF - 0.1);
        const ex = sx - c.p.tx * dirIn * B.wingLen + c.nx * side * B.wingLen * 0.55;
        const ez = sz - c.p.tz * dirIn * B.wingLen + c.nz * side * B.wingLen * 0.55;
        const mx = (sx + ex) / 2, mz = (sz + ez) / 2;
        const dl = Math.hypot(ex - sx, ez - sz) || 1;
        const uxx = (ex - sx) / dl, uzz = (ez - sz) / dl;
        const gEnd = world.ground(ex, ez);
        // wall is SHORTER than the earth it retains -> the fill buries its outer end
        const wTop = lerp(top, gEnd - 0.55, 0.5);
        const wBot = Math.min(gEnd, bot + 0.8) - 2.0;
        mb.box(mx - OX, (wTop + wBot) / 2 - OY, mz - OZ, uxx, uzz, dl / 2, (wTop - wBot) / 2, 0.42, C, 0.10);
      }
    }

    const geo = mb.geometry();
    const mat = this._material(b.waterY);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(OX, OY, OZ);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);

    // ---------- approach guardrail, physically joined to the parapet ends ----------
    const steelMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.52, metalness: 0.35, vertexColors: true,
    });
    this.atmo.register(steelMat);
    const gb = new Builder();
    for (const end of [0, 1]) {
      const sEnd = end === 0 ? b.s0 : b.s1;
      const dir = end === 0 ? -1 : 1;
      const m = Math.ceil(B.guardrailLen / 2.0);
      for (const side of [-1, 1]) {
        for (let i = 0; i < m; i++) {
          const sa = sEnd + dir * (i * 2.0), sb = sEnd + dir * ((i + 1) * 2.0);
          if (sa < 0 || sb > rt.length) continue;
          const pa = rt.at(sa, {}), pb = rt.at(sb, {});
          const flare = (i / m) * 0.9;
          const lat = side * (HALF_PAVE + R.shoulderWidth * 0.55 + flare);
          const la = side * (HALF_PAVE + R.shoulderWidth * 0.55 + ((i) / m) * 0.9);
          const ya = pa.y + crossSection(Math.abs(la)) + B.guardrailH;
          const yb = pb.y + crossSection(Math.abs(lat)) + B.guardrailH;
          const ax = pa.x + (-pa.tz) * la - OX, az = pa.z + pa.tx * la - OZ;
          const bx = pb.x + (-pb.tz) * lat - OX, bz = pb.z + pb.tx * lat - OZ;
          const dx = bx - ax, dz = bz - az;
          const dl = Math.hypot(dx, dz) || 1;
          const ux = dx / dl, uz = dz / dl;
          gb.box((ax + bx) / 2, (ya + yb) / 2 - OY, (az + bz) / 2, ux, uz, dl / 2, 0.16, 0.045, B.steel, 0);
          if (i % 2 === 0) {
            gb.box(ax, ya - OY - 0.42, az, ux, uz, 0.055, 0.42, 0.055, [0.40, 0.41, 0.42], 0);
          }
        }
      }
    }
    if (gb.n) {
      const gm = new THREE.Mesh(gb.geometry(), steelMat);
      gm.position.set(OX, OY, OZ);
      gm.castShadow = true;
      g.add(gm);
    }

    this.group.add(g);
    this.built.set(key, g);
  }
}
