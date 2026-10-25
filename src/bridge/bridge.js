// src/bridge/bridge.js — a bridge is a CONTINUATION OF THE ROAD that happens to have
// a rail and a structure hanging under it (BRIDGE_SPEC §0), not an object the road
// sits on. Deck axis == road axis, deck grade == road grade, always.
// Owned by the BRIDGE builder agent.
//
// Two meshes per bridge: weathered concrete (deck edge, kerbs, end blocks, piers,
// abutments) and galvanised steel (open bridge rail + approach guardrail). Both are
// ordinary lit MeshStandardMaterials registered with the atmosphere, so they take the
// sun/hemisphere/fog of the scene. Without realtime shadows, the shade under the deck
// is carried per vertex: every concrete vertex knows the soffit height above it and
// the ground height below it (`aRef`), and the fragment shader derives the under-deck
// shade (sun blocked, sky partly occluded), fascia drip grime, the soil/gravel
// transition into the bank and the waterline bands from those.

import * as THREE from 'three';
import { BRIDGE as B } from './params.js';
import { ROAD as R } from '../road/params.js';
import { crossSection, ROAD_EDGES } from '../world/world.js';
import { SURFACE_HASH_GLSL } from '../core/shaderNoise.js';
import { lerp } from '../core/rng.js';

const { HALF_PAVE } = ROAD_EDGES;
export const CLEAR_HALF = HALF_PAVE + B.clearGap;
export const OUT_HALF = CLEAR_HALF + B.kerbThk;
export const RAIL_LAT = CLEAR_HALF + B.kerbThk / 2;   // rail/post centreline over the kerb
export const GUARDRAIL_LAT = HALF_PAVE + R.shoulderWidth * 0.55;
const NO_REF = -1e4;   // "no soffit above / no ground below" for aRef

const scale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

class Builder {
  constructor() {
    this.p = []; this.c = []; this.r = []; this.i = []; this.n = 0;
    this.ref = [NO_REF, NO_REF];   // [soffitY, groundY] in mesh-local metres
    this.groundAt = null;          // (x, z) -> local ground Y: per-vertex ground reference
  }
  v(x, y, z, col, soffit, along) {
    this.p.push(x, y, z);
    this.c.push(col[0], col[1], col[2]);
    const ground = this.groundAt ? this.groundAt(x, z) : this.ref[1];
    this.r.push(soffit ?? this.ref[0], ground, along ?? NO_REF);
    return this.n++;
  }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  /**
   * Quad from 4 points [x, y, z, soffit?, along?], winding a->b->c->d; col = rgb or
   * 4 rgbs. `along` is the texture coordinate along the structure (deck arclength);
   * without it the shader derives one from the face normal.
   */
  face(A, BB, C, D, col) {
    const cs = Array.isArray(col[0]) ? col : [col, col, col, col];
    const a = this.v(A[0], A[1], A[2], cs[0], A[3], A[4]), b = this.v(BB[0], BB[1], BB[2], cs[1], BB[3], BB[4]);
    const c = this.v(C[0], C[1], C[2], cs[2], C[3], C[4]), d = this.v(D[0], D[1], D[2], cs[3], D[3], D[4]);
    this.quad(a, b, c, d);
  }
  /** Same, but the winding is chosen so the face normal points along `out`. */
  faceOut(A, BB, C, D, col, out) {
    const ux = BB[0] - A[0], uy = BB[1] - A[1], uz = BB[2] - A[2];
    const wx = C[0] - A[0], wy = C[1] - A[1], wz = C[2] - A[2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    if (nx * out[0] + ny * out[1] + nz * out[2] >= 0) this.face(A, BB, C, D, col);
    else {
      const cs = Array.isArray(col[0]) ? col : [col, col, col, col];
      this.face(D, C, BB, A, [cs[3], cs[2], cs[1], cs[0]]);
    }
  }
  box(cx, cy, cz, ax, az, hx, hy, hz, col, taper = 0) {
    // ax/az = unit long axis in the XZ plane; hx = half length along it,
    // hz = half thickness across it, hy = half height. taper widens the base
    // across the long axis (negative = flares out towards the top).
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
    this.faceOut(q000, q100, q110, q010, col, [0, 1, 0]);
    this.faceOut(p010, p110, p100, p000, col, [0, -1, 0]);
    this.faceOut(p000, p100, q100, q000, col, [-bx, 0, -bz]);
    this.faceOut(p110, p010, q010, q110, col, [bx, 0, bz]);
    this.faceOut(p100, p110, q110, q100, col, [ax, 0, az]);
    this.faceOut(p010, p000, q000, q010, col, [-ax, 0, -az]);
  }
  /** Sloped beam from A to Bp (centre points), half height hy, half width hz. */
  beam(A, Bp, hy, hz, col) {
    const dx = Bp[0] - A[0], dz = Bp[2] - A[2];
    const dl = Math.hypot(dx, dz) || 1;
    const tx = dx / dl, tz = dz / dl, nx = -tz, nz = tx;
    const ring = (P) => [
      [P[0] - nx * hz, P[1] - hy, P[2] - nz * hz], [P[0] + nx * hz, P[1] - hy, P[2] + nz * hz],
      [P[0] + nx * hz, P[1] + hy, P[2] + nz * hz], [P[0] - nx * hz, P[1] + hy, P[2] - nz * hz],
    ];
    const a = ring(A), b = ring(Bp);
    this.faceOut(a[3], a[2], b[2], b[3], col, [0, 1, 0]);
    this.faceOut(a[0], a[1], b[1], b[0], col, [0, -1, 0]);
    this.faceOut(a[1], a[2], b[2], b[1], col, [nx, 0, nz]);
    this.faceOut(a[0], a[3], b[3], b[0], col, [-nx, 0, -nz]);
    this.faceOut(a[0], a[1], a[2], a[3], col, [-tx, 0, -tz]);
    this.faceOut(b[0], b[1], b[2], b[3], col, [tx, 0, tz]);
  }
  /**
   * Battered vertical prism: convex `outline` of [along, across] points around
   * (cx, cz) with long axis (ax, az); every face leans out by `grow` metres at the
   * base. Only the side walls are emitted (the top hides under the cap, the base is
   * buried).
   */
  prism(cx, cz, ax, az, outline, yBot, yTop, grow, col) {
    const bx = -az, bz = ax;
    const P = (a, c, y) => [cx + ax * a + bx * c, y, cz + az * a + bz * c];
    const m = outline.length;
    for (let k = 0; k < m; k++) {
      const [a0, c0] = outline[k], [a1, c1] = outline[(k + 1) % m];
      const t0 = P(a0, c0, yTop), t1 = P(a1, c1, yTop);
      const b0 = P(a0 + Math.sign(a0) * grow, c0 + Math.sign(c0) * grow, yBot);
      const b1 = P(a1 + Math.sign(a1) * grow, c1 + Math.sign(c1) * grow, yBot);
      const am = (a0 + a1) / 2, cm = (c0 + c1) / 2;
      this.faceOut(b0, b1, t1, t0, col, [ax * am + bx * cm, 0, az * am + bz * cm]);
    }
  }
  geometry(withRef) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    if (withRef) g.setAttribute('aRef', new THREE.Float32BufferAttribute(this.r, 3));
    g.setIndex(this.i);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

export const CONCRETE_VERT_HEAD = /* glsl */`
attribute vec3 aRef;
varying vec3 vPosB;
varying vec3 vNrmB;
varying vec3 vRefB;
`;
export const CONCRETE_VERT_BODY = /* glsl */`
  vPosB = transformed;
  vNrmB = objectNormal;
  vRefB = aRef;
`;
// All noise runs in mesh-local metres (origin = bridge midpoint), hashed with the
// shared integer hash, so the pattern stays crisp kilometres down the route.
export const CONCRETE_FRAG_HEAD = /* glsl */`
varying vec3 vPosB;
varying vec3 vNrmB;
varying vec3 vRefB;
uniform float uWaterY;
${SURFACE_HASH_GLSL}
float bvn( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( surfaceHash( i ), surfaceHash( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( surfaceHash( i + vec2( 0.0, 1.0 ) ), surfaceHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
float bfbm( vec2 p ) { float s = 0.0, a = 0.5; for ( int i = 0; i < 4; i ++ ) { s += a * bvn( p ); p = p * 2.07 + 13.1; a *= 0.5; } return s; }
float bline( float x, float halfW ) {
  // anti-aliased thin line at integer x; fades out once it is sub-pixel
  float fw = fwidth( x ), d = abs( fract( x + 0.5 ) - 0.5 );
  return ( 1.0 - smoothstep( 0.0, max( halfW, fw ), d ) ) * ( 1.0 - smoothstep( 0.12, 0.4, fw ) );
}
`;
export const CONCRETE_FRAG_BODY = /* glsl */`
  vec3 bp = vPosB;
  vec3 bn = normalize( vNrmB );
  float wall = step( 0.6, 1.0 - abs( bn.y ) );
  vec2 bt = normalize( vec2( -bn.z, bn.x ) + vec2( 1e-4, 0.0 ) );
  // walls: (along-face, height) — deck faces carry their arclength in vRefB.z, other
  // walls use the horizontal axis of their own plane; kerb tops / soffits: plan xz
  float along = vRefB.z > -1000.0 ? vRefB.z : dot( bp.xz, bt );
  vec2 fc = mix( bp.xz, vec2( along, bp.y ), wall );
  float u = fc.x, h = fc.y;

  // cast panels: adjacent pours never match (+-8%), form-lift lines every 0.72 m,
  // dark panel joints every 4.8 m
  vec2 cell = mix( vec2( 3.0 ), vec2( 4.8, 0.72 ), wall );
  float tone = 0.92 + 0.16 * surfaceHash( floor( fc / cell ) + 41.0 );
  tone *= 1.0 - wall * ( 0.11 * bline( h / 0.72, 0.035 ) + 0.26 * bline( u / 4.8, 0.011 ) );

  // weathering: broad blotches, vertical drip streaks, sparse rust bleed, lichen
  tone *= 0.84 + 0.32 * bfbm( fc * vec2( 0.55, 0.9 ) + 7.0 );
  float streak = smoothstep( 0.52, 0.9, bvn( vec2( u * 2.3, h * 0.16 ) ) ) * ( 0.6 + 0.4 * bvn( vec2( u * 7.0, h * 0.5 ) ) );
  tone *= 1.0 - 0.26 * streak * wall;
  vec3 col = diffuseColor.rgb * tone;
  float rust = smoothstep( 0.83, 0.95, bvn( vec2( u * 0.9, 5.0 ) ) ) * smoothstep( 0.35, 0.8, bvn( vec2( u * 5.0, h * 0.35 ) ) ) * wall;
  col = mix( col, col * vec3( 0.80, 0.60, 0.44 ), rust * 0.6 );
  float lichen = smoothstep( 0.62, 0.8, bfbm( bp.xz * 1.7 + bp.y ) ) * ( 1.0 - wall );
  col = mix( col, col * vec3( 1.0, 0.92, 0.70 ), lichen * 0.35 );

  // relation to the deck: grime collecting at the bottom of the fascia
  float below = vRefB.x - bp.y;
  float drip = ( 1.0 - smoothstep( 0.0, 0.8, -below ) ) * step( below, 0.0 ) * wall;
  col *= 1.0 - 0.22 * drip;

  // Under-deck shade. There are no realtime shadows, so below the soffit reference the
  // deck's shadow is carried here: the sun is blocked (fading out ~6.5 m down) and walls
  // lose part of the sky. The blocked direct share is taken off the albedo with the
  // scene's own light uniforms, so a sun-facing pier and a shaded one settle to the same
  // ambient level instead of one glowing and the other going black. Down-facing faces
  // (slab bays, girder bottoms) already get only the ground bounce from the lighting,
  // so they are not darkened a second time.
  float bUnder = step( 0.0, below );
  float bOpen = smoothstep( 0.0, 6.5, below );
  float aoSky = mix( 1.0, mix( 0.72, 1.0, bOpen ), bUnder * wall );
  float shade = aoSky;
#if NUM_DIR_LIGHTS > 0
  vec3 bLuma = vec3( 0.2126, 0.7152, 0.0722 );
  vec3 bnV = normalize( vNormal );
  float eSun = max( dot( bnV, directionalLights[ 0 ].direction ), 0.0 ) * dot( directionalLights[ 0 ].color, bLuma );
  vec3 eAmb = ambientLightColor;
#if NUM_HEMI_LIGHTS > 0
  eAmb += mix( hemisphereLights[ 0 ].groundColor, hemisphereLights[ 0 ].skyColor, 0.5 * dot( bnV, hemisphereLights[ 0 ].direction ) + 0.5 );
#endif
  float eInd = max( dot( eAmb, bLuma ), 1e-3 );
  // The hemisphere's fixed ground colour under-states the bounce beneath a deck: the
  // sunlit bank and water around the footprint (albedo ~0.18) light it from below, most
  // on the down-facing slab and girder bottoms, half on the webs and pier heads.
  float eBounce = 0.18 * max( dot( viewMatrix[ 1 ].xyz, directionalLights[ 0 ].direction ), 0.0 )
    * dot( directionalLights[ 0 ].color, bLuma ) * ( 0.5 - 0.5 * bn.y ) * bUnder * ( 1.0 - bOpen );
  shade = ( aoSky * eInd + eBounce + ( 1.0 - bUnder * ( 1.0 - bOpen ) ) * eSun ) / ( eInd + eSun );
#endif

  // Ground contact, following the real ground line (per-vertex ground on abutments and
  // wingwalls): a dense earth band matching the terrain's road-rim soil, fines splashed
  // up the face in a ragged fringe with gravel grit, and moss in the damp foot.
  float hg = bp.y - vRefB.y;
  float earth = 1.0 - smoothstep( 0.05, 0.35 + 0.45 * bvn( vec2( u * 1.1, 4.0 ) ), hg );
  float splash = ( 1.0 - smoothstep( 0.0, 1.2 + 1.3 * bvn( vec2( u * 0.45, 2.0 ) ), hg ) )
    * ( 0.6 + 0.4 * bfbm( fc * vec2( 1.3, 2.2 ) + 5.0 ) );
  float grit = smoothstep( 0.62, 0.9, bvn( fc * 7.0 + 11.0 ) ) * ( 1.0 - smoothstep( 0.15, 0.5, fwidth( fc.x * 7.0 ) ) );
  col = mix( col, col * vec3( 0.62, 0.55, 0.44 ), splash * 0.85 );
  col = mix( col, vec3( 0.16, 0.13, 0.09 ), grit * splash * 0.5 );
  col = mix( col, vec3( 0.19, 0.15, 0.10 ) * ( 0.85 + 0.3 * bvn( fc * 3.0 ) ), earth * 0.9 );
  float moss = splash * smoothstep( 0.45, 0.75, bfbm( fc * 1.4 + 3.0 ) ) * ( 1.0 - earth );
  col = mix( col, vec3( 0.075, 0.095, 0.045 ), moss * 0.45 );

  // waterline: wet/algal band, then the blotchy mineral high-water band (§4)
  float above = bp.y - uWaterY;
  float wet = 1.0 - smoothstep( 0.0, 0.42, above );
  float mineral = ( 1.0 - smoothstep( 0.42, 1.6 + 0.4 * bvn( vec2( u * 0.6, 9.0 ) ), above ) ) * step( 0.42, above );
  col = mix( col, col * vec3( 0.30, 0.36, 0.30 ), wet * 0.85 );
  col = mix( col, col * vec3( 0.82, 0.78, 0.70 ), mineral * 0.7 );
  diffuseColor.rgb = col * shade;
`;

/**
 * Structural depth under the fascia top. The route sizes `deckDepth` at span/16 for
 * its soffit clearance; the visible deck d = deckTopInset + depth is held inside both
 * span/20-span/14 and 0.55-1.6x the rail height (§3, CHECKS 8) — the rail ratio wins
 * where the two disagree — so long spans never read as a slab under a light rail and
 * short ones never as cardboard. Long spans only get thinner (soffit rises); the short
 * end thickens by at most ~0.1 m, inside the route's >= 1.6 m water clearance.
 */
export function deckDepthFor(b) {
  const d = B.deckTopInset + b.deckDepth;
  const rLo = 0.55 * B.railH, rHi = 1.6 * B.railH;
  const lo = Math.max(b.span / 20, rLo), hi = Math.min(b.span / 14, rHi);
  const v = lo <= hi ? Math.min(hi, Math.max(lo, d)) : Math.min(rHi, Math.max(rLo, d));
  return v - B.deckTopInset;
}

/**
 * Pure geometry for one crossing. Returns the concrete and steel builders (mesh-local
 * coordinates around `origin`) plus the structural facts the tests check.
 */
export function buildBridgeGeometry(world, b) {
  const rt = world.route;
  const org = rt.at((b.s0 + b.s1) / 2, {});
  const OX = org.x, OY = org.y, OZ = org.z;
  const mb = new Builder(), gb = new Builder();
  const C = B.concrete, CD = B.concreteDark;
  const kerbCol = scale(C, 0.95), fasciaCol = scale(C, 1.04);
  const depth = deckDepthFor(b);
  const info = { origin: [OX, OY, OZ], depth, sections: [], piers: [], abutments: [], posts: [], guardrails: [] };

  const n = Math.max(3, Math.ceil((b.s1 - b.s0) / B.longStep) + 1);
  const step = (b.s1 - b.s0) / (n - 1);
  const deckTopAt = (p) => p.y + crossSection(CLEAR_HALF) + R.surfaceLift;
  const X = [];
  for (let i = 0; i < n; i++) {
    const s = b.s0 + i * step;
    const p = rt.at(s, {});
    const deckTop = deckTopAt(p);
    const fasciaTop = deckTop - B.deckTopInset;
    const soffitY = fasciaTop - depth;
    X.push({ s, p, nx: -p.tz, nz: p.tx, deckTop, kerbTop: deckTop + B.kerbH, fasciaTop, soffitY });
  }
  info.sections = X;

  // The deck's own faces must never count as "under the soffit": their reference is
  // the bottom of the fascia lip. Deck faces carry their arclength so joints, lifts and
  // streaks run continuously round a curved deck.
  const sMid = (b.s0 + b.s1) / 2;
  const pt = (k, lat, y, along = true) => {
    const c = X[k];
    return [c.p.x + c.nx * lat - OX, y - OY, c.p.z + c.nz * lat - OZ,
      c.soffitY - B.fasciaLip - 0.01 - OY, along ? c.s - sMid : undefined];
  };
  const UP = [0, 1, 0], DOWN = [0, -1, 0];

  // ---------- kerbs, fascia, soffit ----------
  for (const side of [-1, 1]) {
    const inner = side * CLEAR_HALF, outer = side * OUT_HALF;
    const fasc = side * (OUT_HALF + B.fasciaProject);
    for (let a = 0; a < n - 1; a++) {
      const c = a + 1, A = X[a], Cc = X[c];
      const nOut = [side * (A.nx + Cc.nx) / 2, 0, side * (A.nz + Cc.nz) / 2];
      const nIn = [-nOut[0], 0, -nOut[2]];
      const lipA = A.soffitY - B.fasciaLip, lipC = Cc.soffitY - B.fasciaLip;
      mb.faceOut(pt(a, inner, A.deckTop), pt(c, inner, Cc.deckTop), pt(c, inner, Cc.kerbTop), pt(a, inner, A.kerbTop), kerbCol, nIn);
      mb.faceOut(pt(a, inner, A.kerbTop), pt(a, outer, A.kerbTop), pt(c, outer, Cc.kerbTop), pt(c, inner, Cc.kerbTop), scale(C, 1.02), UP);
      mb.faceOut(pt(a, outer, A.kerbTop), pt(c, outer, Cc.kerbTop), pt(c, outer, Cc.fasciaTop), pt(a, outer, A.fasciaTop), kerbCol, nOut);
      // fascia band projects past the kerb -> crisp shadow line under its lip
      mb.faceOut(pt(a, fasc, A.fasciaTop), pt(c, fasc, Cc.fasciaTop), pt(c, fasc, lipC), pt(a, fasc, lipA), fasciaCol, nOut);
      mb.faceOut(pt(a, outer, A.fasciaTop), pt(c, outer, Cc.fasciaTop), pt(c, fasc, Cc.fasciaTop), pt(a, fasc, A.fasciaTop), CD, UP);
      mb.faceOut(pt(a, fasc, lipA), pt(c, fasc, lipC), pt(c, outer, lipC), pt(a, outer, lipA), CD, DOWN);
      // inner face of the lip: the step up to the fascia beam's bottom
      mb.faceOut(pt(a, outer, lipA), pt(c, outer, lipC), pt(c, outer, Cc.soffitY), pt(a, outer, A.soffitY), scale(C, 0.8), nIn);
    }
  }
  // ---------- underside: slab on girders ----------
  // The structure under the fascia is a slab carried by girders bearing on the pier caps
  // and abutments at the soffit line (the route's clearance plane); the outer girders
  // are the fascia beams. Ribs, bays and lit girder bottoms are what make the underside
  // read as a structure from the bank instead of one flat dark plane. Every face under
  // the slab carries a soffit reference just above it (the shader's under-deck shade)
  // and the real ground below it. Its colours hold only the bays' own occlusion: the
  // down-facing lighting already supplies the "no sun, ground bounce only" darkness, so
  // baking that darkness into the albedo as well (the old 0.46 x dark-concrete soffit)
  // counted it twice and turned the underside black.
  const ribD = depth - Math.min(B.slabMax, Math.max(B.slabMin, B.slabRatio * depth));
  const ribs = ribD >= B.ribMin;
  info.ribDepth = ribs ? ribD : 0;
  const slabAt = (k) => X[k].soffitY + (ribs ? ribD : 0);
  const ptU = (k, lat, y) => { const v = pt(k, lat, y); v[3] = slabAt(k) + 0.02 - OY; return v; };
  const groundLocal = (x, z) => world.ground(x + OX, z + OZ) - OY;
  const SLAB = scale(C, 0.78), RIB_BOT = C, WEB_TOP = scale(C, 0.78), WEB_BOT = scale(C, 0.96);
  const EIN = OUT_HALF - B.edgeBeamW, GL = B.girderLat, GW = B.girderW / 2;
  mb.groundAt = groundLocal;
  for (let a = 0; a < n - 1; a++) {
    const c = a + 1;
    const ya = X[a].soffitY, yc = X[c].soffitY, ua = slabAt(a), uc = slabAt(c);
    const lx = (X[a].nx + X[c].nx) / 2, lz = (X[a].nz + X[c].nz) / 2;
    const under = (l0, l1, y0, y1, col) => mb.faceOut(ptU(a, l0, y0), ptU(a, l1, y0), ptU(c, l1, y1), ptU(c, l0, y1), col, DOWN);
    if (!ribs) { under(-OUT_HALF, OUT_HALF, ya, yc, scale(C, 0.9)); continue; }
    // slab bays between the fascia beams and the interior girders
    for (const [l0, l1] of [[-EIN, -GL - GW], [-GL + GW, GL - GW], [GL + GW, EIN]]) under(l0, l1, ua, uc, SLAB);
    // girder bottoms: fascia beams, interior girders
    for (const [l0, l1] of [[-OUT_HALF, -EIN], [-GL - GW, -GL + GW], [GL - GW, GL + GW], [EIN, OUT_HALF]]) under(l0, l1, ya, yc, RIB_BOT);
    // girder webs, darkest in the corner against the slab; facing +-lateral
    for (const [lat, s] of [[-EIN, 1], [-GL - GW, -1], [-GL + GW, 1], [GL - GW, -1], [GL + GW, 1], [EIN, -1]]) {
      mb.faceOut(ptU(a, lat, ya), ptU(c, lat, yc), ptU(c, lat, uc), ptU(a, lat, ua), [WEB_BOT, WEB_BOT, WEB_TOP, WEB_TOP], [s * lx, 0, s * lz]);
    }
  }
  mb.groundAt = null;
  // close the deck section at both ends (normally swallowed by the embankment)
  for (const k of [0, n - 1]) {
    const c = X[k], d = k === 0 ? -1 : 1, out = [c.p.tx * d, 0, c.p.tz * d];
    mb.faceOut(pt(k, -OUT_HALF, c.soffitY, false), pt(k, OUT_HALF, c.soffitY, false), pt(k, OUT_HALF, c.deckTop, false), pt(k, -OUT_HALF, c.deckTop, false), CD, out);
    for (const side of [-1, 1]) {
      const outer = side * OUT_HALF, fasc = side * (OUT_HALF + B.fasciaProject);
      mb.faceOut(pt(k, outer, c.soffitY - B.fasciaLip, false), pt(k, fasc, c.soffitY - B.fasciaLip, false), pt(k, fasc, c.fasciaTop, false), pt(k, outer, c.fasciaTop, false), CD, out);
    }
  }

  // ---------- end blocks: concrete posts terminating rail and guardrail ----------
  const railAt = (s, side) => {
    const p = rt.at(s, {});
    return { p, x: p.x - p.tz * side * RAIL_LAT, z: p.z + p.tx * side * RAIL_LAT, deck: deckTopAt(p) };
  };
  info.endBlocks = [];
  for (const [sMid, s] of [[b.s0 + B.endBlockLen / 2, b.s0], [b.s1 - B.endBlockLen / 2, b.s1]]) {
    for (const side of [-1, 1]) {
      const r = railAt(sMid, side), y0 = Math.min(r.deck, deckTopAt(rt.at(s, {}))) - 0.02, y1 = r.deck + B.railH + 0.06;
      const hz = B.kerbThk / 2 + 0.04;
      mb.box(r.x - OX, (y0 + y1) / 2 - OY, r.z - OZ, r.p.tx, r.p.tz, B.endBlockLen / 2, (y1 - y0) / 2, hz, scale(C, 0.98));
      info.endBlocks.push({ s, side, lat0: RAIL_LAT - hz, lat1: RAIL_LAT + hz, top: y1, deck: r.deck });
    }
  }

  // ---------- open steel rail: posts on the kerb, top rail and mid rail ----------
  const sA = b.s0 + B.endBlockLen, sB = b.s1 - B.endBlockLen;
  const postCount = Math.max(1, Math.round((sB - sA) / B.railPostGap));
  for (const side of [-1, 1]) {
    for (let j = 1; j < postCount; j++) {
      const s = sA + (j / postCount) * (sB - sA);
      const r = railAt(s, side);
      const y0 = r.deck + B.kerbH - 0.02, y1 = r.deck + B.railH - B.railTopH * 0.5;
      const tint = 0.94 + 0.03 * ((j * 7 + (side > 0 ? 3 : 0)) % 5);   // posts weather unevenly
      gb.box(r.x - OX, (y0 + y1) / 2 - OY, r.z - OZ, r.p.tx, r.p.tz, B.railPost / 2, (y1 - y0) / 2, B.railPost / 2, scale(B.steelPost, tint));
      info.posts.push({ s, side, top: y1 + B.railTopH * 0.5 - r.deck });
    }
    const rail = (yc, hh, hw, col) => {
      const m = Math.max(2, Math.ceil((sB - sA) / B.longStep));
      let prev = null;
      for (let j = 0; j <= m; j++) {
        const r = railAt(sA + (j / m) * (sB - sA), side);
        const nx = -r.p.tz, nz = r.p.tx, y = r.deck + yc - OY;
        const at = (dl, dy) => [r.x + nx * dl - OX, y + dy, r.z + nz * dl - OZ];
        const ring = [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)];
        if (prev) {
          gb.faceOut(prev[3], prev[2], ring[2], ring[3], col, UP);
          gb.faceOut(prev[0], prev[1], ring[1], ring[0], scale(col, 0.8), DOWN);
          gb.faceOut(prev[1], prev[2], ring[2], ring[1], col, [nx, 0, nz]);
          gb.faceOut(prev[0], prev[3], ring[3], ring[0], col, [-nx, 0, -nz]);
        }
        prev = ring;
      }
    };
    rail(B.railH - B.railTopH / 2, B.railTopH / 2, B.railTopW / 2, B.steel);
    rail(B.railMidY, B.railMidH / 2, B.railMidH / 2, scale(B.steel, 0.94));
  }

  // ---------- piers ----------
  const fr = b.nSpans === 2 ? [0.44, 0.56] : b.nSpans === 3 ? [0.30, 0.40, 0.30]
    : new Array(b.nSpans).fill(1 / b.nSpans);
  const hx = (B.pierThk * B.pierLenRatio) / 2, hz = B.pierThk / 2, nose = hz * B.pierNose;
  const outline = [[hx, -hz], [hx + nose, 0], [hx, hz], [-hx, hz], [-hx - nose, 0], [-hx, -hz]];
  let acc = 0;
  for (let k = 0; k < b.nSpans - 1; k++) {
    acc += fr[k];
    const s = b.s0 + acc * (b.s1 - b.s0);
    const p = rt.at(s, {});
    const riv = world.hf.river(p.x, p.z);
    const gl = Math.hypot(riv.gx, riv.gz);
    let ax = -riv.gz / gl, az = riv.gx / gl;   // along the flow
    if (!(gl > 0) || !Number.isFinite(ax)) { ax = -p.tz; az = p.tx; }
    const bx = -az, bz = ax;
    const soffit = deckTopAt(p) - B.deckTopInset - depth;
    const shaftTop = soffit - B.capH + 0.05;
    // The pier goes INTO the bed under its whole battered footprint. The footprint
    // widens as the base goes deeper, so settle base depth and batter together.
    const g0 = world.ground(p.x, p.z);
    let gMin = g0, gMax = g0, bot = g0 - B.pierEmbed;
    for (let it = 0; it < 4; it++) {
      const reach = (shaftTop - bot) * B.pierBatter * 1.1 + 0.2;
      const lowest = gMin;
      for (let k2 = 0; k2 < outline.length; k2++) {
        const [a0, c0] = outline[k2], [a1, c1] = outline[(k2 + 1) % outline.length];
        for (const [a, c] of [[a0, c0], [(a0 + a1) / 2, (c0 + c1) / 2]]) {
          const aa = a + Math.sign(a) * reach, cc = c + Math.sign(c) * reach;
          const g = world.ground(p.x + ax * aa + bx * cc, p.z + az * aa + bz * cc);
          gMin = Math.min(gMin, g); gMax = Math.max(gMax, g);
        }
      }
      bot = gMin - B.pierEmbed;
      if (it > 0 && gMin === lowest) break;
    }
    const grow = (shaftTop - bot) * B.pierBatter;
    mb.ref = [soffit - OY, gMax - OY];
    mb.prism(p.x - OX, p.z - OZ, ax, az, outline, bot - OY, shaftTop - OY, grow, C);
    // cap flares up to the soffit (§4: batter down, flare up)
    mb.box(p.x - OX, soffit - B.capH / 2 - OY, p.z - OZ, ax, az, hx + nose * 0.5, B.capH / 2, hz + B.capFlare, C, -B.capFlare);
    // diaphragm tying the girders together over the cap (pier04, girder06)
    if (ribs) {
      const dh = (ribD - B.diaphragmGap) / 2;
      mb.ref = [soffit + ribD + 0.02 - OY, NO_REF];
      mb.groundAt = groundLocal;
      mb.box(p.x - OX, soffit + B.diaphragmGap + dh - OY, p.z - OZ, -p.tz, p.tx, EIN, dh, B.diaphragmThk / 2, scale(C, 0.9));
      mb.groundAt = null;
    }
    info.piers.push({ s, x: p.x, z: p.z, ax, az, top: soffit, shaftTop, bot, groundMin: gMin, groundMax: gMax, grow });
  }

  // ---------- abutments + wingwalls ----------
  for (const endIdx of [0, n - 1]) {
    const c = X[endIdx];
    const dirIn = endIdx === 0 ? 1 : -1;
    const top = c.soffitY - 0.02;
    const cx = c.p.x - c.p.tx * dirIn * (B.abutThk / 2);
    const cz = c.p.z - c.p.tz * dirIn * (B.abutThk / 2);
    const hw = OUT_HALF + 0.1;
    let gMin = Infinity;
    for (const [sl, st] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
      const g = world.ground(cx + c.nx * hw * sl + c.p.tx * st * B.abutThk / 2, cz + c.nz * hw * sl + c.p.tz * st * B.abutThk / 2);
      gMin = Math.min(gMin, g);
    }
    const bot = Math.min(gMin, c.soffitY - 2.2) - B.abutEmbed;
    const h = Math.max(1.5, top - bot);
    // per-vertex ground: the splash and earth band follow the bank's real contact line
    // across the face instead of one height for the whole block
    mb.ref = [c.soffitY - OY, NO_REF];
    mb.groundAt = groundLocal;
    mb.box(cx - OX, top - h / 2 - OY, cz - OZ, c.nx, c.nz, hw, h / 2, B.abutThk / 2, C, 0.12);
    info.abutments.push({ s: c.s, top, bot, groundMin: gMin });
    // wingwalls splaying back into the bank, buried by the graded fill
    for (const side of [-1, 1]) {
      const sx = c.p.x + c.nx * side * (OUT_HALF - 0.1);
      const sz = c.p.z + c.nz * side * (OUT_HALF - 0.1);
      const ex = sx - c.p.tx * dirIn * B.wingLen + c.nx * side * B.wingLen * 0.55;
      const ez = sz - c.p.tz * dirIn * B.wingLen + c.nz * side * B.wingLen * 0.55;
      const mx = (sx + ex) / 2, mz = (sz + ez) / 2;
      const dl = Math.hypot(ex - sx, ez - sz) || 1;
      const uxx = (ex - sx) / dl, uzz = (ez - sz) / dl;
      const gEnd = world.ground(ex, ez), gStart = world.ground(sx, sz);
      // wall is SHORTER than the earth it retains -> the fill buries its outer end
      const wTop = lerp(top, gEnd - 0.55, 0.5);
      const wBot = Math.min(gEnd, gStart, bot + 0.8) - 2.0;
      // wingwalls stand outside the deck: open to sun and sky, only the ground matters
      mb.ref = [NO_REF, NO_REF];
      mb.box(mx - OX, (wTop + wBot) / 2 - OY, mz - OZ, uxx, uzz, dl / 2, (wTop - wBot) / 2, 0.42, C, 0.10);
    }
  }
  mb.ref = [NO_REF, NO_REF];
  mb.groundAt = null;

  // ---------- approach guardrail, bolted into the end blocks ----------
  const segs = Math.ceil(B.guardrailLen / B.guardrailSeg);
  const flareAt = (k) => {
    const d = k * B.guardrailSeg - B.guardrailStiffLen;
    return d <= 0 ? 0 : (d / (B.guardrailLen - B.guardrailStiffLen)) * B.guardrailFlare;
  };
  for (const end of [0, 1]) {
    const sEnd = end === 0 ? b.s0 : b.s1;
    const dir = end === 0 ? -1 : 1;
    for (const side of [-1, 1]) {
      for (let i = 0; i < segs; i++) {
        const sa = sEnd + dir * i * B.guardrailSeg, sb = sEnd + dir * (i + 1) * B.guardrailSeg;
        if (Math.min(sa, sb) < 0 || Math.max(sa, sb) > rt.length) break;
        const pa = rt.at(sa, {}), pb = rt.at(sb, {});
        const la = side * (GUARDRAIL_LAT + flareAt(i)), lb = side * (GUARDRAIL_LAT + flareAt(i + 1));
        const ya = pa.y + crossSection(Math.abs(la)) + B.guardrailH;
        // the free end is turned down into the verge
        const yb = pb.y + crossSection(Math.abs(lb)) + (i === segs - 1 ? 0.12 : B.guardrailH);
        const ax = pa.x - pa.tz * la - OX, az = pa.z + pa.tx * la - OZ;
        const bx = pb.x - pb.tz * lb - OX, bz = pb.z + pb.tx * lb - OZ;
        gb.beam([ax, ya - OY, az], [bx, yb - OY, bz], 0.16, 0.045, B.steel);
        const dx = bx - ax, dz = bz - az, dl = Math.hypot(dx, dz) || 1;
        if (i === 0) info.guardrails.push({ s: sa, side, lat: Math.abs(la), y: ya });
        // stiffened run next to the bridge: a post every segment, then every other
        if (i > 0 && (i * B.guardrailSeg < B.guardrailStiffLen || i % 2 === 0)) {
          gb.box(ax, ya - OY - 0.42, az, dx / dl, dz / dl, 0.055, 0.42, 0.055, B.steelPost);
        }
      }
    }
  }

  return { concrete: mb, steel: gb, info };
}

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

  _material(waterYLocal) {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.82, metalness: 0.0, dithering: true,
    });
    m.name = 'bridge-concrete';
    const u = { uWaterY: { value: waterYLocal } };
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uWaterY = u.uWaterY;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + CONCRETE_VERT_HEAD)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + CONCRETE_VERT_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + CONCRETE_FRAG_HEAD)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + CONCRETE_FRAG_BODY);
    };
    m.customProgramCacheKey = () => 'bridge-concrete-v3';
    this.atmo.register(m);
    return m;
  }

  _steelMaterial() {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.5, metalness: 0.35, vertexColors: true,
    });
    m.name = 'bridge-steel';
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
    const g = new THREE.Group();
    g.name = key;
    const { concrete, steel, info } = buildBridgeGeometry(this.world, b);
    const [OX, OY, OZ] = info.origin;

    const mesh = new THREE.Mesh(concrete.geometry(true), this._material(b.waterY - OY));
    mesh.position.set(OX, OY, OZ);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);

    if (steel.n) {
      const gm = new THREE.Mesh(steel.geometry(false), this._steelMaterial());
      gm.position.set(OX, OY, OZ);
      gm.castShadow = true;
      g.add(gm);
    }

    this.group.add(g);
    this.built.set(key, g);
  }
}
