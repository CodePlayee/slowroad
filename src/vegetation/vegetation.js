// src/vegetation/vegetation.js — layered instanced plant cover.
// Owned by the VEGETATION builder agent.
//
// ---------------------------------------------------------------------------
// DIAGNOSIS (round 1) — our baseline vs refs/slowroads/official
// ---------------------------------------------------------------------------
// 1. SOLID FACETED GEOMETRY. Every tree was an opaque cone / icosahedron. The bar's
//    trees (sr_16, sr_17, sr_22, sr_23) are alpha-tested foliage CARDS: every
//    silhouette is ragged and you see sky through the canopy. This is the single
//    biggest "programmer art" tell.  -> cards + generated alpha textures.
// 2. ONE FLAT GREEN. Three palette entries and a brightness multiplier. The bar spans
//    dark blue-green through olive to yellow-green WITHIN ONE FRAME, and each tree is
//    brighter on top than underneath.  -> per-instance HSL jitter + baked crown ramp.
// 3. EVEN SCATTER. forestSharpness 0.30 gave a kilometre-long density gradient, i.e. a
//    sprinkle. The bar's forests are MASSES with crisp edges against open grass, and
//    species stand together.  -> sharpened forest mask * 80 m grove field * species field.
// 4. NO SHRUB LAYER. Ours went lawn -> cone. Every ref has a continuous 0.5-2 m band of
//    scrub / bracken / tussock / flowers between grass and trees (sr_22, sr_23, sr_17,
//    sr_12).  -> real shrub layer with its own density field peaking at forest edges,
//    dry open slopes, and the road verge.
// 5. GRASS TOO SHORT, TOO SPARSE, TOO LIME, TOO SPIKY. In sr_07/sr_17/sr_22 verge grass
//    reaches car-door height, is khaki-olive, fine-bladed, arcing, and forms a solid
//    mass.  -> 2 grass rings, taller cards, finer blades, desaturated palette, coherent
//    gust lean.
// 6. NO CANOPY DARKENING. -> ground cover under closed canopy is darkened and browned
//    towards litter, plus real leaf-shaped shadow casting.
// 7. DISTANT TREES = NEAR TREES. The far layer used a different RNG so the LOD ring was
//    a visible discontinuity of blob-circles. -> impostors painted FROM THE SAME layout
//    schedule as the 3D trees.
//
// ---------------------------------------------------------------------------
// TECHNIQUE
// ---------------------------------------------------------------------------
// ONE texture atlas carries bark + needles + leaves + scrub + fern + plume + flowers, so
// a whole tree (trunk AND canopy) is a single draw call per species per tile. Per-instance
// hue rides on a custom `iTint` instanced attribute rather than instanceColor, and a
// per-vertex `tintable` flag keeps bark and flower petals out of that multiply. A custom
// `iUv` attribute lets one impostor geometry serve four painted variants.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { prepareFlowerPair, flowerMaterials } from './flower.js';
import { buildCurveBladeGeometry, curveGrassMaterial } from './curveGrass.js';
import { buildMeadowGeometry, meadowGrassMaterial } from './meadowGrass.js';
import { loadUnderstory } from './understory.js';
import { Woodland } from './woodland.js';
import { VEG as V, SEASON_HOOKS } from './params.js';
import { fbm } from '../core/noise.js';
import { hash2i, makeRng, clamp, smoothstep, lerp } from '../core/rng.js';
import { forestCover } from './biome.js';

const GOLD = 2.39996323;
const TAU = Math.PI * 2;

// ===========================================================================
// atlas
// ===========================================================================

/** Shelf-pack {name,w,h} into a `size`-wide canvas. Returns px rects. */
function pack(items, size) {
  const rects = {};
  let x = 0, y = 0, rowH = 0;
  for (const it of items) {
    if (x + it.w > size) { x = 0; y += rowH; rowH = 0; }
    rects[it.name] = { x, y, w: it.w, h: it.h };
    x += it.w; rowH = Math.max(rowH, it.h);
  }
  return rects;
}

const grey = (v) => { const l = Math.max(0, Math.min(255, Math.round(255 * v))); return `rgb(${l},${l},${l})`; };

/** One tapered, arcing blade. Luminance only: hue arrives per-instance. */
function blade(g, x0, yBase, len, wid, bend, lo, hi) {
  const tipX = x0 + bend, tipY = yBase - len;
  const cx = x0 + bend * 0.35, cy = yBase - len * 0.55;
  g.beginPath();
  g.moveTo(x0 - wid, yBase);
  g.quadraticCurveTo(cx - wid * 0.75, cy, tipX, tipY);
  g.quadraticCurveTo(cx + wid * 0.75, cy, x0 + wid, yBase);
  g.closePath();
  const gr = g.createLinearGradient(0, tipY, 0, yBase);
  gr.addColorStop(0, grey(hi));
  gr.addColorStop(0.45, grey(lerp(lo, hi, 0.62)));
  gr.addColorStop(1, grey(lo));
  g.fillStyle = gr;
  g.fill();
}

/** A single leaf: a rounded lozenge. */
function leaf(g, x, y, r, ang, aspect, shade) {
  g.save();
  g.translate(x, y); g.rotate(ang);
  g.beginPath();
  g.moveTo(0, -r);
  g.quadraticCurveTo(r * aspect, -r * 0.15, 0, r);
  g.quadraticCurveTo(-r * aspect, -r * 0.15, 0, -r);
  g.closePath();
  g.fillStyle = grey(shade);
  g.fill();
  g.restore();
}

function paintBark(g, R, rng) {
  // real colour — bark verts are flagged untintable so this survives the foliage tint
  g.fillStyle = '#4a3c30';
  g.fillRect(R.x, R.y, R.w, R.h);
  for (let i = 0; i < 190; i++) {
    const x = R.x + rng() * R.w;
    const w = 1 + rng() * 5;
    const h = 12 + rng() * (R.h * 0.55);
    const yy = R.y + rng() * R.h;
    const v = 0.42 + rng() * 0.92;
    const r = Math.round(84 * v), gg = Math.round(68 * v), b = Math.round(55 * v);
    g.fillStyle = `rgba(${r},${gg},${b},${0.32 + rng() * 0.5})`;
    g.fillRect(x, yy, w, h);
  }
  // pale lichen / highlight side
  for (let i = 0; i < 26; i++) {
    g.fillStyle = `rgba(150,146,128,${0.05 + rng() * 0.14})`;
    g.fillRect(R.x + rng() * R.w, R.y + rng() * R.h, 2 + rng() * 9, 6 + rng() * 40);
  }
}

/**
 * Feathery needle spray. The rachis runs along the cell WIDTH (it becomes a branch
 * reaching out from the trunk); needles fan perpendicular to it and comb back towards
 * the trunk, which is what gives a conifer its ragged, see-through silhouette.
 */
function paintNeedle(g, R, rng, opts) {
  const { pairs, needleLen, spread, comb, thin } = opts;
  const y0 = R.y + R.h * 0.5;
  const x0 = R.x + R.w * 0.02, x1 = R.x + R.w * 0.995;
  const axisLen = x1 - x0;
  // secondary branchlets so the spray is a branch system, not one feather
  const branches = [{ t0: 0, t1: 1, off: 0, s: 1 }];
  for (let b = 0; b < 5; b++) {
    branches.push({
      t0: 0.10 + rng() * 0.42, t1: 0.68 + rng() * 0.32,
      off: (rng() - 0.5) * R.h * 0.62, s: 0.50 + rng() * 0.38,
    });
  }
  g.lineCap = 'round';
  for (const br of branches) {
    const bx0 = x0 + axisLen * br.t0, bx1 = x0 + axisLen * br.t1;
    g.strokeStyle = grey(0.30);
    g.lineWidth = 1.9 * br.s;
    g.beginPath();
    g.moveTo(bx0, y0 + br.off * 0.18);
    g.quadraticCurveTo((bx0 + bx1) / 2, y0 + br.off * 0.72, bx1, y0 + br.off);
    g.stroke();
    const n = Math.max(5, Math.round(pairs * br.s));
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const ax = lerp(bx0, bx1, t);
      const ay = y0 + br.off * (0.18 + 0.82 * t);
      // needles shorten towards the branch tip
      const L = needleLen * R.h * br.s * (1.05 - 0.55 * t) * (0.78 + rng() * 0.5);
      for (const side of [-1, 1]) {
        const a = side * (spread + (rng() - 0.5) * 0.45);
        const tx = ax - comb * L;                  // combed back toward the trunk
        const ty = ay + Math.sin(a) * L;
        const v = 0.40 + rng() * 0.82;
        g.strokeStyle = grey(v);
        g.lineWidth = thin * (0.7 + rng() * 0.7);
        g.beginPath();
        g.moveTo(ax, ay);
        g.quadraticCurveTo(ax - comb * L * 0.3, ay + Math.sin(a) * L * 0.55, tx, ty);
        g.stroke();
      }
    }
  }
}

/** Ragged mass of small leaves — the broadleaf canopy card. Must have holes. */
function paintLeafMass(g, R, rng, opts) {
  const { count, leafR, aspect, lobes, fill } = opts;
  const cx = R.x + R.w / 2, cy = R.y + R.h / 2;
  const rx = R.w * 0.47, ry = R.h * 0.47;
  // twiglets first, so leaves sit on visible structure
  g.lineCap = 'round';
  for (let i = 0; i < 16; i++) {
    const a = rng() * TAU;
    g.strokeStyle = grey(0.30);
    g.lineWidth = 1.2 + rng() * 1.6;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * rx * 0.05, cy + Math.sin(a) * ry * 0.05);
    g.lineTo(cx + Math.cos(a) * rx * (0.5 + rng() * 0.5), cy + Math.sin(a) * ry * (0.5 + rng() * 0.5));
    g.stroke();
  }
  // lobe centres give the mass a multi-blob (not circular) silhouette
  const cs = [];
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * TAU + rng() * 0.8;
    const rr = 0.30 + rng() * 0.46;
    cs.push([cx + Math.cos(a) * rx * rr, cy + Math.sin(a) * ry * rr, 0.5 + rng() * 0.55]);
  }
  cs.push([cx, cy, 0.95]);
  for (let i = 0; i < count; i++) {
    const c = cs[(rng() * cs.length) | 0];
    const a = rng() * TAU;
    const rr = Math.pow(rng(), fill);
    const x = c[0] + Math.cos(a) * rx * c[2] * rr;
    const y = c[1] + Math.sin(a) * ry * c[2] * rr;
    if (Math.hypot((x - cx) / rx, (y - cy) / ry) > 1.02) continue;
    // upper leaves catch light
    const up = 1 - (y - R.y) / R.h;
    const sh = clamp(0.30 + up * 0.72 + (rng() - 0.5) * 0.46, 0.12, 1.0);
    leaf(g, x, y, leafR * R.h * (0.62 + rng() * 0.8), rng() * TAU, aspect, sh);
  }
}

/** Pinnate fern / bracken frond, tip at the top of the cell. */
function paintFern(g, R, rng) {
  const bx = R.x + R.w * 0.5, by = R.y + R.h * 0.99;
  const tipY = R.y + R.h * 0.04;
  const bend = (rng() - 0.5) * R.w * 0.18;
  g.lineCap = 'round';
  g.strokeStyle = grey(0.34); g.lineWidth = 2.4;
  g.beginPath(); g.moveTo(bx, by);
  g.quadraticCurveTo(bx + bend, (by + tipY) / 2, bx + bend * 2, tipY);
  g.stroke();
  const n = 15;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const ax = lerp(bx, bx + bend * 2, t) + bend * 0.2;
    const ay = lerp(by, tipY, t);
    const L = R.w * 0.46 * Math.sin(Math.PI * (0.10 + 0.86 * (1 - t))) * (0.85 + rng() * 0.3);
    for (const side of [-1, 1]) {
      // each pinna is itself toothed
      const seg = 5;
      g.strokeStyle = grey(0.40 + rng() * 0.7);
      g.lineWidth = 2.1;
      g.beginPath(); g.moveTo(ax, ay);
      for (let s = 1; s <= seg; s++) {
        const u = s / seg;
        g.lineTo(ax + side * L * u, ay + L * u * 0.34 + (s % 2 ? -1 : 1) * 1.6);
      }
      g.stroke();
    }
  }
}

/** Bunchgrass tussock card: dense fine blades, a few with seed heads. */
function paintTussock(g, R, rng, opts) {
  const { blades, plume, tall } = opts;
  const baseLight = opts.baseLight ?? 0.24;
  const base = R.y + R.h * 0.995;
  for (let i = 0; i < blades; i++) {
    const x0 = R.x + R.w * (0.07 + rng() * 0.86);
    const cen = (x0 - (R.x + R.w / 2)) / (R.w / 2);
    const len = R.h * tall * (0.36 + rng() * 0.64) * (1 - Math.abs(cen) * 0.30);
    blade(g, x0, base, len, 1.1 + rng() * 2.0, cen * R.w * 0.16 + (rng() - 0.5) * R.w * 0.14,
      baseLight + rng() * 0.22, 0.72 + rng() * 0.5);
  }
  if (plume > 0) {
    for (let i = 0; i < plume; i++) {
      const x0 = R.x + R.w * (0.2 + rng() * 0.6);
      const len = R.h * (0.72 + rng() * 0.26);
      const bend = (rng() - 0.5) * R.w * 0.2;
      g.strokeStyle = grey(0.44); g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x0, base); g.lineTo(x0 + bend, base - len); g.stroke();
      // feathery seed head
      const hy = base - len, hx = x0 + bend;
      for (let k = 0; k < 34; k++) {
        const a = -Math.PI / 2 + (rng() - 0.5) * 1.5;
        const rl = R.h * (0.05 + rng() * 0.15);
        g.strokeStyle = grey(0.80 + rng() * 0.45);
        g.lineWidth = 0.9;
        g.beginPath();
        g.moveTo(hx, hy + R.h * 0.04 * rng());
        g.lineTo(hx + Math.cos(a) * rl * 0.6, hy + Math.sin(a) * rl);
        g.stroke();
      }
    }
  }
}

/** Flower spray painted in TRUE colour (its verts are flagged untintable). */
function paintFlowers(g, R, rng, kind) {
  const base = R.y + R.h * 0.99;
  const heads = kind === 'umbel' ? 5 : 7;
  for (let i = 0; i < heads; i++) {
    const x0 = R.x + R.w * (0.13 + rng() * 0.74);
    const len = R.h * (0.45 + rng() * 0.5);
    const bend = (rng() - 0.5) * R.w * 0.16;
    g.strokeStyle = 'rgba(96,110,58,0.95)'; g.lineWidth = 1.7;
    g.beginPath(); g.moveTo(x0, base); g.lineTo(x0 + bend, base - len); g.stroke();
    const hx = x0 + bend, hy = base - len;
    if (kind === 'umbel') {
      for (let k = 0; k < 26; k++) {
        const a = rng() * TAU, rr = Math.pow(rng(), 0.6) * R.w * 0.11;
        const px = hx + Math.cos(a) * rr, py = hy + Math.sin(a) * rr * 0.55;
        g.fillStyle = `rgba(255,254,246,${0.7 + rng() * 0.3})`;
        g.beginPath(); g.arc(px, py, 1.1 + rng() * 1.5, 0, TAU); g.fill();
      }
    } else {
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * TAU + rng();
        const rr = R.w * 0.055;
        g.fillStyle = `rgba(${232 + rng() * 20 | 0},${182 + rng() * 40 | 0},${48 + rng() * 40 | 0},0.96)`;
        g.beginPath();
        g.ellipse(hx + Math.cos(a) * rr, hy + Math.sin(a) * rr * 0.8, rr * 0.85, rr * 0.6, a, 0, TAU);
        g.fill();
      }
      g.fillStyle = 'rgba(250,224,120,0.98)';
      g.beginPath(); g.arc(hx, hy, R.w * 0.035, 0, TAU); g.fill();
    }
  }
}

/** Bare twig mass — the winter/bareness hook and dry desert brush. */
function paintTwigs(g, R, rng) {
  const cx = R.x + R.w / 2, cy = R.y + R.h * 0.96;
  g.lineCap = 'round';
  const rec = (x, y, a, len, w, d) => {
    if (d > 4 || len < 2) return;
    const nx = x + Math.cos(a) * len, ny = y + Math.sin(a) * len;
    g.strokeStyle = `rgba(${104 - d * 8 | 0},${88 - d * 7 | 0},${72 - d * 6 | 0},${0.95 - d * 0.1})`;
    g.lineWidth = w;
    g.beginPath(); g.moveTo(x, y); g.lineTo(nx, ny); g.stroke();
    const k = 2 + (rng() * 2 | 0);
    for (let i = 0; i < k; i++) rec(nx, ny, a + (rng() - 0.5) * 1.25, len * (0.55 + rng() * 0.25), w * 0.62, d + 1);
  };
  for (let i = 0; i < 5; i++) rec(cx + (rng() - 0.5) * R.w * 0.2, cy, -Math.PI / 2 + (rng() - 0.5) * 1.1, R.h * 0.30, 3.2, 0);
}

// ---------------------------------------------------------------------------

function paintConiferMass(g, R, rng, pine) {
  const start = pine ? 0.44 : 0.09;
  for (let row = 0; row < 28; row++) {
    const t = row / 27, height = start + t * (1 - start);
    const radius = R.w * 0.45 * (pine ? Math.pow(Math.sin((0.14 + t * 0.86) * Math.PI), 0.65) : Math.pow(1 - t, 0.78));
    for (let branch = -5; branch <= 5; branch++) {
      const side = branch / 5;
      const cx = R.x + R.w * 0.5 + side * radius;
      const cy = R.y + R.h * (1 - height) + Math.abs(side) * R.h * 0.028;
      const cluster = (0.8 + rng() * 0.4) * Math.max(3, radius * 0.24);
      const shade = Math.round(108 + t * 70 + rng() * 28);
      g.fillStyle = `rgb(${shade},${shade},${shade})`;
      g.beginPath(); g.ellipse(cx, cy, cluster, cluster * 0.36, side * 0.24, 0, TAU); g.fill();
      g.strokeStyle = `rgba(${shade + 25},${shade + 25},${shade + 25},0.9)`;
      g.lineWidth = 1.4;
      for (let needle = 0; needle < 14; needle++) {
        const x = cx + (rng() - 0.5) * cluster * 2;
        const y = cy + (rng() - 0.5) * cluster * 0.6;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rng() - 0.5) * 8, y - 3 - rng() * 9); g.stroke();
      }
    }
  }
}

const ATLAS_SIZE = 2048;

function buildAtlas(season) {
  const items = [
    { name: 'solid', w: 12, h: 12 },
    { name: 'treeFir', w: 384, h: 768 },
    { name: 'treePine', w: 384, h: 768 },
    { name: 'bark', w: 128, h: 512 },
    { name: 'needleFir', w: 384, h: 168 },
    { name: 'needleSpruce', w: 384, h: 168 },
    { name: 'needlePine', w: 384, h: 168 },
    { name: 'leafA', w: 256, h: 224 },
    { name: 'leafB', w: 256, h: 224 },
    { name: 'leafC', w: 256, h: 224 },
    { name: 'scrub', w: 224, h: 200 },
    { name: 'scrubDry', w: 224, h: 200 },
    { name: 'fern', w: 200, h: 256 },
    { name: 'tussock', w: 224, h: 256 },
    { name: 'plume', w: 224, h: 256 },
    { name: 'flowerW', w: 168, h: 200 },
    { name: 'flowerY', w: 168, h: 200 },
    { name: 'twigs', w: 224, h: 224 },
  ];
  const R = pack(items, ATLAS_SIZE);
  let hMax = 0;
  for (const k in R) hMax = Math.max(hMax, R[k].y + R[k].h);
  const H = Math.min(2048, 1 << Math.ceil(Math.log2(hMax)));
  const c = document.createElement('canvas');
  c.width = ATLAS_SIZE; c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, ATLAS_SIZE, H);
  const rng = makeRng(0x5eed1);
  // 2 px padding so linear filtering cannot bleed between cells
  const pad = (r) => ({ x: r.x + 2, y: r.y + 2, w: r.w - 4, h: r.h - 4 });

  g.fillStyle = '#ffffff';
  g.fillRect(R.solid.x, R.solid.y, R.solid.w, R.solid.h);
  paintConiferMass(g, pad(R.treeFir), rng, false);
  paintConiferMass(g, pad(R.treePine), rng, true);

  paintBark(g, pad(R.bark), rng);
  paintNeedle(g, pad(R.needleFir), rng, { pairs: 30, needleLen: 0.34, spread: 0.78, comb: 0.26, thin: 1.6 });
  paintNeedle(g, pad(R.needleSpruce), rng, { pairs: 36, needleLen: 0.44, spread: 0.98, comb: 0.34, thin: 1.25 });
  paintNeedle(g, pad(R.needlePine), rng, { pairs: 20, needleLen: 0.60, spread: 1.14, comb: 0.14, thin: 1.8 });
  paintLeafMass(g, pad(R.leafA), rng, { count: 1500, leafR: 0.025, aspect: 0.68, lobes: 5, fill: 0.58 });
  paintLeafMass(g, pad(R.leafB), rng, { count: 1700, leafR: 0.020, aspect: 0.55, lobes: 6, fill: 0.52 });
  paintLeafMass(g, pad(R.leafC), rng, { count: 1350, leafR: 0.029, aspect: 0.80, lobes: 4, fill: 0.66 });
  paintLeafMass(g, pad(R.scrub), rng, { count: 430, leafR: 0.036, aspect: 0.72, lobes: 4, fill: 0.80 });
  paintLeafMass(g, pad(R.scrubDry), rng, { count: 240, leafR: 0.030, aspect: 0.42, lobes: 6, fill: 0.44 });
  paintFern(g, pad(R.fern), rng);
  paintTussock(g, pad(R.tussock), rng, { blades: 88, plume: 0, tall: 0.98 });
  paintTussock(g, pad(R.plume), rng, { blades: 62, plume: 4, tall: 0.66 });
  paintFlowers(g, pad(R.flowerW), rng, 'umbel');
  paintFlowers(g, pad(R.flowerY), rng, 'spike');
  paintTwigs(g, pad(R.twigs), rng);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Filter high-frequency leaf detail before minification rather than sampling
  // individual texels into shimmering, disconnected marks.
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  // normalised UV rects, inset half a texel
  const uv = {};
  for (const k in R) {
    const r = pad(R[k]);
    uv[k] = [(r.x + 0.5) / ATLAS_SIZE, 1 - (r.y + r.h - 0.5) / H,
      (r.x + r.w - 0.5) / ATLAS_SIZE, 1 - (r.y + 0.5) / H];
  }
  return { tex, uv, canvas: c, px: R, H };
}

/** Grass blade cards live in their own 512 texture so blades stay crisp up close. */
function buildGrassTex() {
  const S = 512, c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  const rng = makeRng(0x9a11);
  const cells = {
    tall: { x: 0, y: 0, w: 256, h: 256 },
    fine: { x: 256, y: 0, w: 256, h: 256 },
    mass: { x: 0, y: 256, w: 256, h: 256 },
    dry: { x: 256, y: 256, w: 256, h: 256 },
  };
  const pad = (r) => ({ x: r.x + 2, y: r.y + 2, w: r.w - 4, h: r.h - 4 });
  paintTussock(g, pad(cells.tall), rng, { blades: 74, plume: 0, tall: 0.99, baseLight: 0.56 });
  paintTussock(g, pad(cells.fine), rng, { blades: 116, plume: 0, tall: 0.86, baseLight: 0.56 });
  paintTussock(g, pad(cells.mass), rng, { blades: 132, plume: 0, tall: 0.70, baseLight: 0.56 });
  paintTussock(g, pad(cells.dry), rng, { blades: 54, plume: 3, tall: 0.92, baseLight: 0.56 });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  const uv = {};
  for (const k in cells) {
    const r = pad(cells[k]);
    uv[k] = [(r.x + 0.5) / S, 1 - (r.y + r.h - 0.5) / S, (r.x + r.w - 0.5) / S, 1 - (r.y + 0.5) / S];
  }
  return { tex, uv };
}

// ===========================================================================
// geometry builder — everything is cards + tubes, height-normalised to 1.0
// ===========================================================================

class CardMesh {
  constructor() {
    this.p = []; this.n = []; this.u = []; this.q = []; this.c = []; this.t = []; this.i = []; this.v = 0;
  }

  /** corners bl,br,tr,tl ; nrm ; uv rect [u0,v0,u1,v1] ; cols[4] ; tintable 0|1 */
  quad(bl, br, tr, tl, nrm, uv, cols, tintable = 1) {
    const b = this.v;
    const cs = [bl, br, tr, tl];
    const uvs = [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]];
    for (let k = 0; k < 4; k++) {
      this.p.push(cs[k][0], cs[k][1], cs[k][2]);
      this.n.push(nrm[0], nrm[1], nrm[2]);
      this.u.push(uvs[k][0], uvs[k][1]);
      // Keep a local 0..1 card coordinate alongside the atlas UV.  The
      // fragment pass uses it to feather the otherwise rectangular card
      // boundary into a different, deterministic organic silhouette per
      // instance.
      this.q.push(k === 0 || k === 3 ? 0 : 1, k < 2 ? 0 : 1);
      const col = cols[k] || cols[0];
      this.c.push(col[0], col[1], col[2]);
      this.t.push(tintable);
    }
    this.i.push(b, b + 1, b + 2, b, b + 2, b + 3);
    this.v += 4;
  }

  /**
   * A card placed by centre + two basis vectors, with a vertical value ramp
   * (`shTop`/`shBot`) so every card is brighter at its top edge.
   */
  card(cx, cy, cz, ax, ay, az, bx, by, bz, nrm, uv, base, shBot, shTop, tintable = 1) {
    const bl = [cx - ax - bx, cy - ay - by, cz - az - bz];
    const br = [cx + ax - bx, cy + ay - by, cz + az - bz];
    const tr = [cx + ax + bx, cy + ay + by, cz + az + bz];
    const tl = [cx - ax + bx, cy - ay + by, cz - az + bz];
    const cb = [base[0] * shBot, base[1] * shBot, base[2] * shBot];
    const ct = [base[0] * shTop, base[1] * shTop, base[2] * shTop];
    this.quad(bl, br, tr, tl, nrm, uv, [cb, cb, ct, ct], tintable);
  }

  /** Vertical trapezoid in a plane at yaw `a` — conifer spine / silhouette filler. */
  spine(y0, y1, w0, w1, a, uv, base, shBot, shTop, tintable = 1) {
    const dx = Math.cos(a), dz = Math.sin(a);
    const bl = [-dx * w0, y0, -dz * w0], br = [dx * w0, y0, dz * w0];
    const tr = [dx * w1, y1, dz * w1], tl = [-dx * w1, y1, -dz * w1];
    const cb = [base[0] * shBot, base[1] * shBot, base[2] * shBot];
    const ct = [base[0] * shTop, base[1] * shTop, base[2] * shTop];
    // an up-biased normal: a conifer skirt reads as a lit surface, not a black wall
    this.quad(bl, br, tr, tl, [0, 0.94, 0], uv, [cb, cb, ct, ct], tintable);
  }

  /** Tapered tube from a to b. Untintable (bark colour is baked). */
  tube(a, b, r0, r1, seg, uv, colA, colB) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L = Math.hypot(d[0], d[1], d[2]) || 1e-5;
    const dz = [d[0] / L, d[1] / L, d[2] / L];
    let up = Math.abs(dz[1]) > 0.94 ? [1, 0, 0] : [0, 1, 0];
    let dx = [up[1] * dz[2] - up[2] * dz[1], up[2] * dz[0] - up[0] * dz[2], up[0] * dz[1] - up[1] * dz[0]];
    const dl = Math.hypot(dx[0], dx[1], dx[2]) || 1e-5;
    dx = [dx[0] / dl, dx[1] / dl, dx[2] / dl];
    const dy = [dz[1] * dx[2] - dz[2] * dx[1], dz[2] * dx[0] - dz[0] * dx[2], dz[0] * dx[1] - dz[1] * dx[0]];
    const base = this.v;
    for (let s = 0; s <= seg; s++) {
      const th = (s / seg) * TAU;
      const ca = Math.cos(th), sa = Math.sin(th);
      const nx = dx[0] * ca + dy[0] * sa, ny = dx[1] * ca + dy[1] * sa, nz = dx[2] * ca + dy[2] * sa;
      for (let e = 0; e < 2; e++) {
        const r = e ? r1 : r0, o = e ? b : a;
        this.p.push(o[0] + nx * r, o[1] + ny * r, o[2] + nz * r);
        this.n.push(nx, ny, nz);
        this.u.push(lerp(uv[0], uv[2], (s / seg) * 2 % 1), e ? uv[3] : uv[1]);
        this.q.push(0, 0);
        const col = e ? colB : colA;
        this.c.push(col[0], col[1], col[2]);
        this.t.push(0);
      }
    }
    for (let s = 0; s < seg; s++) {
      const i0 = base + s * 2, i1 = i0 + 1, i2 = i0 + 2, i3 = i0 + 3;
      this.i.push(i0, i2, i3, i0, i3, i1);
    }
    this.v += (seg + 1) * 2;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('cardUv', new THREE.Float32BufferAttribute(this.q, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('tintable', new THREE.Float32BufferAttribute(this.t, 1));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

// ===========================================================================
// tree layouts — SHARED by the 3D builder and the impostor painter, which is
// what makes the LOD swap invisible.
// ===========================================================================

function coniferLayout(rng, kind) {
  const L = { kind, plates: [], spines: [], needle: 'needleFir', maxR: 0.26, trunkTop: 1.0, trunkR: 0.040 };
  if (kind === 'spruce') {
    L.needle = 'needleSpruce';
    L.maxR = 0.20 + rng() * 0.055;
    L.trunkR = 0.030 + rng() * 0.012;
    const n = 12 + (rng() * 4 | 0);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      L.plates.push({
        y: 0.10 + t * 0.87,
        r: L.maxR * Math.pow(1 - t * 0.97, 0.70) * (0.84 + rng() * 0.34),
        tilt: -0.46 - 0.20 * (1 - t) + rng() * 0.12,
        yaw: i * GOLD + rng() * 0.5,
        sh: 0.52 + 0.66 * t,
      });
    }
    L.spines.push({ y0: 0.07, y1: 1.0, w0: L.maxR * 1.02, w1: L.maxR * 0.06, a: rng() * Math.PI, sh: [0.44, 1.06] });
    L.spines.push({ y0: 0.09, y1: 0.97, w0: L.maxR * 0.88, w1: L.maxR * 0.05, a: rng() * Math.PI + 1.57, sh: [0.40, 1.00] });
  } else if (kind === 'fir') {
    L.needle = 'needleFir';
    L.maxR = 0.24 + rng() * 0.06;
    L.trunkR = 0.034 + rng() * 0.014;
    const n = 11 + (rng() * 4 | 0);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      L.plates.push({
        y: 0.14 + t * 0.83,
        r: L.maxR * Math.pow(1 - t * 0.94, 0.86) * (0.86 + rng() * 0.30),
        tilt: -0.30 - 0.14 * (1 - t) + rng() * 0.10,
        yaw: i * GOLD + rng() * 0.5,
        sh: 0.56 + 0.60 * t,
      });
    }
    L.spines.push({ y0: 0.11, y1: 0.995, w0: L.maxR * 0.98, w1: L.maxR * 0.10, a: rng() * Math.PI, sh: [0.46, 1.04] });
    L.spines.push({ y0: 0.13, y1: 0.96, w0: L.maxR * 0.84, w1: L.maxR * 0.08, a: rng() * Math.PI + 1.57, sh: [0.42, 0.98] });
  } else {
    // pine: long bare trunk, open umbrella crown (refs sr_03, sr_23, sr_12)
    L.needle = 'needlePine';
    L.maxR = 0.30 + rng() * 0.08;
    L.trunkR = 0.036 + rng() * 0.016;
    L.bare = 0.40 + rng() * 0.16;
    const n = 8 + (rng() * 3 | 0);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      L.plates.push({
        y: L.bare + t * (1 - L.bare) * 0.99,
        r: L.maxR * (0.46 + 0.56 * Math.sin(Math.PI * (0.20 + 0.76 * (1 - t)))) * (0.84 + rng() * 0.34),
        tilt: -0.16 - 0.10 * (1 - t) + rng() * 0.14,
        yaw: i * GOLD + rng() * 0.6,
        sh: 0.54 + 0.62 * t,
      });
    }
    L.spines.push({ y0: L.bare - 0.03, y1: 1.0, w0: L.maxR * 0.66, w1: L.maxR * 0.20, a: rng() * Math.PI, sh: [0.46, 1.02] });
  }
  return L;
}

function broadleafLayout(rng, kind) {
  const wide = kind === 'oak';
  const L = {
    kind, clumps: [], limbs: [], trunkTop: 0.26 + rng() * 0.12, trunkR: 0.036 + rng() * 0.016,
    leaf: kind === 'oak' ? 'leafA' : (kind === 'birch' ? 'leafB' : 'leafC'),
  };
  const cy = wide ? 0.62 : 0.66;
  const rx = (wide ? 0.38 : 0.29) + rng() * 0.05;
  const ry = (wide ? 0.26 : 0.32) + rng() * 0.05;
  L.crown = [0, cy, rx, ry];
  const nl = 3 + (rng() * 2 | 0);
  for (let i = 0; i < nl; i++) {
    const a = (i / nl) * TAU + rng() * 0.9;
    const reach = 0.42 + rng() * 0.55;
    L.limbs.push({
      a, from: L.trunkTop * (0.55 + rng() * 0.4),
      to: [Math.cos(a) * rx * reach, cy - ry * (0.20 + rng() * 0.4), Math.sin(a) * rx * reach],
      r0: L.trunkR * 0.60, r1: L.trunkR * 0.26,
    });
  }
  const nc = wide ? 15 : 13;
  for (let i = 0; i < nc; i++) {
    // stratified over the crown surface so no side is bald
    const u = (i + rng() * 0.85) / nc;
    const phi = u * TAU * 2.7 + rng() * 0.5;
    const cosT = 1 - 2 * ((i + 0.5) / nc) * 0.86 - 0.07;
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const rr = 0.62 + rng() * 0.42;
    const dir = [sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)];
    L.clumps.push({
      x: dir[0] * rx * rr, y: cy + dir[1] * ry * rr, z: dir[2] * rx * rr,
      s: (wide ? 0.20 : 0.17) + rng() * 0.11,
      yaw: rng() * TAU, pitch: (rng() - 0.5) * 1.0, roll: (rng() - 0.5) * 0.8,
      nrm: [dir[0] * 0.6, 0.8 + dir[1] * 0.25, dir[2] * 0.6],
      sh: 0.64 + 0.46 * clamp(0.5 + 0.62 * dir[1], 0, 1),
      up: dir[1],
    });
  }
  return L;
}

// ---------------------------------------------------------------- 3D builders

const WHITE = [1, 1, 1];

export function buildConifer(L, uv, season) {
  const m = new CardMesh();
  const bark = uv.bark;
  const barkLo = [0.86, 0.86, 0.86], barkHi = [1.06, 1.06, 1.06];
  m.tube([0, 0, 0], [0, L.trunkTop, 0], L.trunkR, L.trunkR * 0.22, 6, bark, barkLo, barkHi);
  const bare = season.bareness;
  const snow = season.snow;
  const nu = uv[L.needle];
  // Use a whole-tree silhouette for the core, not a branch stretched to tree
  // height. The same silhouette already supplies the distant impostor core.
  const coreUv = uv[L.bare ? 'treePine' : 'treeFir'];
  for (const spine of L.spines) {
    const cy = (spine.y0 + spine.y1) * 0.5;
    m.card(0, cy, 0,
      Math.cos(spine.a) * spine.w0 * 0.90, 0, Math.sin(spine.a) * spine.w0 * 0.90,
      0, (spine.y1 - spine.y0) * 0.5, 0,
      [0, 0.94, 0], coreUv, WHITE, spine.sh[0], spine.sh[1] * (1 + 0.30 * snow));
  }
  for (const p of L.plates) {
    const sh = p.sh * (1 - 0.25 * bare);
    const ca = Math.cos(p.yaw), sa = Math.sin(p.yaw);
    // A branch spray needs a vertical cross-axis. Horizontal plates collapse
    // into comb-like lines at driving height, regardless of needle density.
    const ax = ca * Math.cos(p.tilt), ay = Math.sin(p.tilt), az = sa * Math.cos(p.tilt);
    const w = p.r, d = p.r * 0.56;
    // outward-tilted normal so plates on the sunny side are brighter
    const nrm = [ca * 0.28, 0.94, sa * 0.28];
    m.card(ca * w * 0.34, p.y, sa * w * 0.34,
      ax * w, ay * w, az * w, 0, d, 0,
      nrm, nu, WHITE, sh * 0.70, sh * (1 + 0.30 * snow));
  }
  return m.build();
}

function buildBroadleaf(L, uv, season) {
  const m = new CardMesh();
  const bark = uv.bark;
  const pale = L.kind === 'birch';
  const barkLo = pale ? [1.30, 1.30, 1.26] : [0.80, 0.80, 0.80];
  const barkHi = pale ? [1.70, 1.70, 1.62] : [1.10, 1.10, 1.10];
  m.tube([0, 0, 0], [0, L.trunkTop, 0], L.trunkR, L.trunkR * 0.74, 6, bark, barkLo, barkHi);
  for (const lb of L.limbs) {
    m.tube([0, lb.from, 0], lb.to, lb.r0, lb.r1, 4, bark, barkHi, barkLo);
    // a second order twig continues the limb into the canopy
    m.tube(lb.to, [lb.to[0] * 1.5, lb.to[1] + 0.16, lb.to[2] * 1.5], lb.r1, lb.r1 * 0.5, 4, bark, barkLo, barkLo);
  }
  const leafUv = uv[L.leaf];
  const twigUv = uv.twigs;
  const bare = season.bareness;
  const snow = season.snow;
  for (const cl of L.clumps) {
    const useTwig = bare > 0.5;
    const u = useTwig ? twigUv : leafUv;
    const s = cl.s * (useTwig ? 1.05 : 1) * (1 + 0.10 * snow);
    // two crossed cards, rotated in 3 axes so no silhouette repeats
    for (let k = 0; k < 2; k++) {
      const yaw = cl.yaw + k * 1.5708 + (k ? cl.roll * 0.42 : 0);
      const cy2 = Math.cos(yaw), sy = Math.sin(yaw);
      const cp = Math.cos(cl.pitch * (k ? -0.6 : 1)), sp = Math.sin(cl.pitch * (k ? -0.6 : 1));
      const cr = Math.cos(cl.roll), sr2 = Math.sin(cl.roll);
      const sk = s * (k ? 0.88 + cl.up * 0.10 : 0.98 - cl.up * 0.06);
      const ox = cy2 * s * (k ? 0.035 : -0.018), oz = sy * s * (k ? 0.035 : -0.018);
      // a = "right" of the card, b = "up" of the card
      const ax = cy2 * cr * sk / s, ay = sr2 * sk / s, az = sy * cr * sk / s;
      const bx = -cy2 * sp * 0.5 * sk / s - sy * 0, by = cp * sk / s, bz = -sy * sp * 0.5 * sk / s;
      const nrm = [cl.nrm[0], cl.nrm[1], cl.nrm[2]];
      const shT = cl.sh * (1 + 0.42 * snow) * (1 - 0.30 * bare);
      m.card(cl.x + ox, cl.y, cl.z + oz, ax * s, ay * s, az * s, bx * s, by * s, bz * s,
        nrm, u, WHITE, shT * 0.58, shT * 1.14);
    }
  }
  return m.build();
}

// ------------------------------------------------------------------- shrubs

function buildBush(rng, uv, season, dry) {
  const m = new CardMesh();
  const cell = dry ? uv.scrubDry : uv.scrub;
  const n = dry ? 7 : 8;
  const twigUv = uv.twigs;
  // a stubby woody base grounds the bush
  m.tube([0, 0, 0], [0, 0.26, 0], 0.055, 0.030, 4, uv.bark, [0.82, 0.82, 0.82], [1.0, 1.0, 1.0]);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const a = i * GOLD + rng() * 0.4;
    const rr = 0.30 + rng() * 0.46;
    const y = 0.24 + Math.pow(rng(), 0.7) * 0.66;
    const x = Math.cos(a) * rr * 0.62, z = Math.sin(a) * rr * 0.62;
    const s = 0.28 + rng() * 0.20;
    const dir = [x, (y - 0.35) * 1.5 + 0.35, z];
    const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const nrm = [dir[0] / dl * 0.7, dir[1] / dl * 0.7 + 0.5, dir[2] / dl * 0.7];
    const sh = (0.36 + 0.86 * clamp(y, 0, 1)) * (1 + 0.4 * season.snow);
    const u = (season.bareness > 0.6 && !dry) ? twigUv : cell;
    for (let k = 0; k < 2; k++) {
      const yaw = a + k * 1.5708 + rng() * 0.3;
      const cy2 = Math.cos(yaw), sy = Math.sin(yaw);
      const tilt = (rng() - 0.5) * 0.7;
      m.card(x, y, z, cy2 * s, Math.sin(tilt) * s * 0.5, sy * s,
        -sy * s * 0.10, Math.cos(tilt) * s * 0.9, cy2 * s * 0.10,
        nrm, u, WHITE, sh * 0.50, sh * 1.10);
    }
  }
  // flower sprays sit on the bush, in TRUE colour (untintable)
  const fa = season.flowerAmount * (1 - season.snow);
  if (fa > 0.02 && !dry) {
    const nf = Math.round(3 * fa);
    for (let i = 0; i < nf; i++) {
      const a = rng() * TAU, rr = 0.20 + rng() * 0.30;
      const s = 0.20 + rng() * 0.10;
      m.card(Math.cos(a) * rr, 0.60 + rng() * 0.34, Math.sin(a) * rr,
        Math.cos(a) * s, 0, Math.sin(a) * s, 0, s * 1.1, 0,
        [0, 1, 0], rng() < 0.5 ? uv.flowerW : uv.flowerY, WHITE, 0.85, 1.05, 0);
    }
  }
  return m.build();
}

function buildFern(rng, uv, season) {
  const m = new CardMesh();
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = i * GOLD + rng() * 0.4;
    const lean = 0.52 + rng() * 0.42;                 // fronds splay outwards
    const s = 0.62 + rng() * 0.40;
    const cx = Math.cos(a) * 0.10, cz = Math.sin(a) * 0.10;
    const sh = 0.42 + rng() * 0.62;
    // frond card: base at ground, tip leaning out along `a`
    const bx = Math.cos(a) * Math.sin(lean), by = Math.cos(lean), bz = Math.sin(a) * Math.sin(lean);
    const ax = -Math.sin(a), az = Math.cos(a);
    const nrm = [bx * 0.4, 0.9, bz * 0.4];
    m.card(cx + bx * s * 0.5, by * s * 0.5, cz + bz * s * 0.5,
      ax * s * 0.42, 0, az * s * 0.42, bx * s * 0.5, by * s * 0.5, bz * s * 0.5,
      nrm, uv.fern, WHITE, sh * 0.62, sh * 1.16);
  }
  return m.build();
}

function buildTussock(rng, uv, season, plume) {
  const m = new CardMesh();
  const n = plume ? 4 : 3;
  for (let i = 0; i < n; i++) {
    const a = i * (Math.PI / n) + rng() * 0.3;
    const s = 0.78 + rng() * 0.34;
    const lean = (rng() - 0.5) * 0.26;
    const sh = 0.50 + rng() * 0.52;
    m.card(0, s * 0.5, 0,
      Math.cos(a) * s * 0.52, 0, Math.sin(a) * s * 0.52,
      Math.sin(lean) * s * 0.5 * Math.cos(a), Math.cos(lean) * s * 0.5, Math.sin(lean) * s * 0.5 * Math.sin(a),
      [0, 1, 0], plume ? uv.plume : uv.tussock, WHITE, sh * 0.42, sh * 1.20);
  }
  const fa = season.flowerAmount * (1 - season.snow);
  if (fa > 0.02) {
    const nf = Math.round(2 * fa);
    for (let i = 0; i < nf; i++) {
      const a = rng() * TAU, rr = 0.10 + rng() * 0.22;
      const s = 0.24 + rng() * 0.12;
      m.card(Math.cos(a) * rr, 0.34 + rng() * 0.22, Math.sin(a) * rr,
        Math.cos(a) * s, 0, Math.sin(a) * s, 0, s * 1.2, 0,
        [0, 1, 0], rng() < 0.55 ? uv.flowerW : uv.flowerY, WHITE, 0.82, 1.04, 0);
    }
  }
  return m.build();
}

// -------------------------------------------------------------------- grass

function buildGrassClump(cells, cardW, tall, planes) {
  const m = new CardMesh();
  for (let i = 0; i < planes; i++) {
    const a = (i / planes) * Math.PI + 0.31;
    const w = cardW * (i === 0 ? 1 : 0.86);
    const h = tall * (i === 0 ? 1 : 0.80 + 0.16 * (i % 2));
    const cell = cells[i % cells.length];
    // splay the card's top edge outwards -> the clump reads as a rounded tuft
    const sp = 0.10;
    m.card(0, h * 0.5, 0,
      Math.cos(a) * w * 0.5, 0, Math.sin(a) * w * 0.5,
      Math.cos(a) * h * sp, h * 0.5, Math.sin(a) * h * sp,
      [0, 1, 0], cell, WHITE, 0.42, 1.04);
  }
  return m.build();
}

// ----------------------------------------------------------------- impostors

/** Paint one impostor cell by replaying a tree layout with drawImage. */
function paintImpostor(g, src, srcRects, cell, L, rng) {
  const W = cell.w, H = cell.h;
  const px = (x) => cell.x + W * (0.5 + x * 0.92);
  const py = (y) => cell.y + H * (1 - 0.035 - y * 0.955);
  const put = (rect, cx, cy, w, h, rot, alpha) => {
    g.save();
    g.globalAlpha = alpha;
    g.translate(cx, cy);
    if (rot) g.rotate(rot);
    g.drawImage(src, rect.x + 2, rect.y + 2, rect.w - 4, rect.h - 4, -w / 2, -h / 2, w, h);
    g.restore();
  };
  // trunk
  const tr = srcRects.bark;
  const tw = Math.max(2, L.trunkR * 2.1 * W);
  put(tr, px(0), cell.y + H * (1 - 0.035) - H * 0.955 * L.trunkTop * 0.5,
    tw, H * 0.955 * L.trunkTop, 0, 1);

  if (L.plates) {
    const tree = srcRects[L.bare ? 'treePine' : 'treeFir'];
    put(tree, px(0), cell.y + H * 0.49, L.maxR * 2 * W * 0.92, H * 0.955, 0, 1);
    const nu = srcRects[L.needle];
    const items = L.plates.slice().sort((a, b) => a.y - b.y);
    for (const p of items) {
      for (let k = 0; k < 3; k++) {
        const ph = (k / 3) * TAU + p.yaw;
        const xo = Math.cos(ph) * p.r * 0.55;
        const w = p.r * 1.9 * W * 0.92;
        const h = w * 0.34;
        put(nu, px(xo), py(p.y) + Math.sin(-p.tilt) * p.r * H * 0.30,
          w, h, Math.sin(ph) * 0.12 - p.tilt * 0.45, clamp(p.sh * 0.85, 0.25, 1));
      }
    }
    for (const s of L.spines) {
      put(nu, px(0), py((s.y0 + s.y1) / 2), s.w0 * 2.0 * W * 0.92, (s.y1 - s.y0) * H * 0.955, 0, 0.9);
    }
  } else {
    const lu = srcRects[L.leaf];
    const items = L.clumps.slice().sort((a, b) => a.up - b.up);
    for (const lb of L.limbs) {
      put(tr, px(lb.to[0] * 0.5), py((lb.from + lb.to[1]) / 2),
        Math.max(2, lb.r0 * 2.2 * W), Math.hypot(lb.to[0], lb.to[1] - lb.from, lb.to[2]) * H * 0.9,
        Math.atan2(lb.to[0], lb.to[1] - lb.from), 1);
    }
    for (const cl of items) {
      const w = cl.s * 2.5 * W * 0.92;
      put(lu, px(cl.x), py(cl.y), w, w * 0.92, cl.roll, clamp(cl.sh * 0.9, 0.28, 1));
    }
  }
}

function buildImpostorAtlas(atlas, seed) {
  // Two painted silhouettes per species keep the far ring from becoming a
  // four-stamp billboard field.  The atlas is still a single texture/draw
  // path; only the per-instance UV rect changes.
  // Six species columns, with two deterministic silhouettes each.  Keeping
  // the atlas in one draw path lets the far ring switch species without a
  // second material or per-instance texture upload.
  const S = 1024, cols = 6, rows = 2;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  const cw = S / cols, ch = S / rows;
  const rng = makeRng(seed ^ 0x11ee);
  const kinds = [
    coniferLayout(makeRng(seed ^ 1), 'spruce'), coniferLayout(makeRng(seed ^ 0x101), 'spruce'),
    coniferLayout(makeRng(seed ^ 2), 'fir'), coniferLayout(makeRng(seed ^ 0x102), 'fir'),
    coniferLayout(makeRng(seed ^ 3), 'pine'), coniferLayout(makeRng(seed ^ 0x103), 'pine'),
    broadleafLayout(makeRng(seed ^ 4), 'oak'), broadleafLayout(makeRng(seed ^ 0x104), 'oak'),
    broadleafLayout(makeRng(seed ^ 5), 'birch'), broadleafLayout(makeRng(seed ^ 0x105), 'birch'),
    broadleafLayout(makeRng(seed ^ 6), 'maple'), broadleafLayout(makeRng(seed ^ 0x106), 'maple'),
  ];
  const uv = [];
  for (let i = 0; i < kinds.length; i++) {
    const cx = (i % cols) * cw, cy = ((i / cols) | 0) * ch;
    paintImpostor(g, atlas.canvas, atlas.px, { x: cx + 2, y: cy + 2, w: cw - 4, h: ch - 4 }, kinds[i], rng);
    uv.push([(cx + 3) / S, 1 - (cy + ch - 3) / S, (cx + cw - 3) / S, 1 - (cy + 3) / S]);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return { tex, uv };
}

/** Crossed quads whose UV is picked per-instance via the iUv attribute. */
function impostorGeo(aspect) {
  const m = new CardMesh();
  for (let i = 0; i < 2; i++) {
    const a = i * 1.5708 + 0.4;
    m.card(0, 0.5, 0, Math.cos(a) * aspect * 0.5, 0, Math.sin(a) * aspect * 0.5,
      0, 0.5, 0, [0, 1, 0], [0, 0, 1, 1], WHITE, 0.62, 1.10);
  }
  return m.build();
}

// ===========================================================================
// material
// ===========================================================================

/**
 * One patched MeshStandardMaterial serves every card layer.
 *  - `tintable` + `iTint`  : per-instance foliage hue that does NOT touch bark/flowers
 *  - `iUv`                 : per-instance atlas cell (impostor variants), opt-in
 *  - `uSway`               : animated wind, amplitude scaled by local height
 *  - normals are NEVER flipped by DoubleSide, so baked radial/up normals survive and
 *    a canopy shades like a volume instead of a black wall.
 */
function vegMaterial(map, alphaTest, sway, uvSelect) {
  const m = new THREE.MeshStandardMaterial({
    map, alphaTest, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.94, metalness: 0,
    vertexColors: true, transparent: false,
  });
  m.userData.uniforms = {
    uSway: { value: sway },
    uWind: { value: new THREE.Vector4(0, Math.cos(V.windDir), Math.sin(V.windDir), 0) },
    // Optional real ground detail.  It is sampled only by the grass pass and
    // fades in at the root, so the cards inherit the same broken-up material
    // language as the terrain instead of ending in a solid green stamp.
    uGroundDetail: { value: null },
    uGroundReady: { value: 0 },
  };
  m.defines = { VEG_INST: '' };
  if (uvSelect) m.defines.VEG_UVSEL = '';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, m.userData.uniforms);
      shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float tintable;
        attribute vec3 iTint;
        attribute float iShape;
        attribute float iVariant;
        attribute vec2 cardUv;
        varying float vVegHeight;
        varying float vVegTintable;
        varying float vVegShape;
        varying float vVegVariant;
        varying vec2 vCardUv;
        varying vec3 vVegWorld;
        #ifdef VEG_UVSEL
        attribute vec4 iUv;
        #endif
        uniform float uSway;
        uniform vec4 uWind;`)
      // three >= r152 uses per-map UV varyings; `map` gives us vMapUv.
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        #if defined( VEG_UVSEL ) && defined( USE_MAP )
        vMapUv = mix( iUv.xy, iUv.zw, vMapUv );
        #endif
        #if defined( VEG_UVSEL ) && defined( USE_ALPHAMAP )
        vAlphaMapUv = mix( iUv.xy, iUv.zw, vAlphaMapUv );
        #endif`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        vColor.rgb *= mix( vec3( 1.0 ), iTint, tintable );`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          // Cards are normalised to one metre in local space. Keeping this
          // height as a varying gives the fragment pass a cheap, stable contact
          // ramp without adding an attribute or another draw call.
          vVegHeight = clamp( position.y, 0.0, 1.0 );
          vVegTintable = tintable;
          vVegShape = iShape;
          vVegVariant = iVariant;
          vCardUv = cardUv;
          float hh = clamp( position.y, 0.0, 1.0 );
          float ph = 0.0;
          #ifdef USE_INSTANCING
          ph = instanceMatrix[ 3 ][ 0 ] * 0.21 + instanceMatrix[ 3 ][ 2 ] * 0.17;
          #endif
          float s = sin( uWind.x + ph ) * 0.68 + sin( uWind.x * 1.73 + ph * 2.1 ) * 0.32;
          transformed.xz += uWind.yz * ( uSway * s * pow( hh, 1.7 ) * tintable );
          // Break up the repeated planar outline without adding geometry.  The
          // instance seed gives every near/mid card a different, deterministic
          // crown wobble; trunks remain rigid via the tintable flag.
          float sh = iShape * 6.2831853;
          float rag = sin( position.y * 8.0 + position.x * 3.7 + sh ) * 0.55
            + sin( position.y * 13.0 - position.x * 2.1 + sh * 1.7 ) * 0.30;
          float organic = 0.74 + 0.26 * fract( vVegVariant * 1.73 + 0.11 );
          transformed.xz += vec2( cos( sh + position.y * 2.4 ), sin( sh + position.y * 2.4 ) )
            * rag * ( 0.035 + 0.074 * hh ) * organic * tintable;
          transformed.xz *= 1.0 + rag * ( 0.020 + 0.044 * hh ) * organic * tintable;
          vec4 vegWorldPos = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
          vegWorldPos = instanceMatrix * vegWorldPos;
          #endif
          vVegWorld = ( modelMatrix * vegWorldPos ).xyz;
        }`);
    // A DoubleSide material flips the shading normal on back faces, which turns an
    // authored up/radial normal black. Keep the authored normal on both sides.
      shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vVegHeight;
        varying float vVegTintable;
        varying float vVegShape;
        varying float vVegVariant;
        varying vec2 vCardUv;
        varying vec3 vVegWorld;
        uniform sampler2D uGroundDetail;
        uniform float uGroundReady;`)
      .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
        // Preserve texture coverage here. Three's alphatest_fragment applies
        // the alpha-to-coverage ramp once, after all silhouette masks.
        // A texture can make a leaf mass ragged, but its enclosing quad still
        // reads as a repeated paper plane at grazing angles.  Mask just the
        // foliage cards with a low-frequency rounded/irregular boundary.  The
        // per-instance shape/variant values change the exponent and phase, so
        // neighbouring clumps do not share one billboard silhouette.  Bark and
        // flower cards are tintable=0 and retain their authored alpha.
        #ifdef VEG_GRASS
        // Grass cards use the authored meadow alpha atlas for blade detail, but
        // a broad corner feather keeps the enclosing quad from reading as a
        // repeated planar stamp. Preserve the lower root band so the cards stay
        // visually attached to the ground even when the upper silhouette fades.
        {
          vec2 gcq = vCardUv * 2.0 - 1.0;
          float gvm = fract( vVegVariant * 0.53 + 0.19 );
          float gedge = pow( abs( gcq.x ), mix( 1.05, 1.52, gvm ) )
            + pow( abs( gcq.y ), 1.04 + gvm * 0.24 );
          float gwobble = sin( gcq.x * 6.0 + gcq.y * 3.0 + vVegShape * 6.2831853 ) * 0.065
            + sin( gcq.y * 9.0 - gcq.x * 2.0 + vVegVariant * 4.1 ) * 0.035;
          float glimit = 1.80 + gwobble * 1.45;
          float gaa = max( fwidth( gedge ) * ${V.cardEdgeSoftness.toFixed(3)}, 0.006 );
          float gmask = 1.0 - smoothstep( glimit - gaa, glimit + gaa, gedge );
          float rootKeep = smoothstep( 0.035, 0.19, vCardUv.y );
          diffuseColor.a *= mix( 1.0, gmask, rootKeep );
        }
        #else
        if ( vVegTintable > 0.5 ) {
          vec2 cq = vCardUv * 2.0 - 1.0;
          float vm = fract( vVegVariant * 0.37 + 0.17 );
          // Keep the atlas alpha as the primary silhouette.  A broad,
          // irregular guard only trims the most obvious quad corners; the old
          // tight superellipse made every shrub read as the same paper stamp.
          float exponent = mix( 0.92, 1.42, vm );
          float edge = pow( abs( cq.x ), exponent ) + pow( abs( cq.y ), 0.96 + vm * 0.28 );
          float phase = vVegShape * 6.2831853;
          float wobble = sin( cq.x * 7.0 + cq.y * 3.0 + phase ) * 0.055
            + sin( cq.y * 11.0 - cq.x * 2.0 + phase * 1.7 ) * 0.035
            + sin( ( cq.x + cq.y ) * 17.0 - phase * 0.6 ) * 0.022;
          float limit = 1.78 + wobble * 1.65;
          float edgeAa = max( fwidth( edge ) * 1.8, 0.006 );
          diffuseColor.a *= 1.0 - smoothstep( limit - edgeAa, limit + edgeAa, edge );
        }
        #endif
        // Root tinting uses the same CC0 ground photographs as the terrain. A
        // shallow world-space sample breaks up repeated clumps while retaining
        // the authored blade/canopy colour higher up the card. Woody foliage
        // receives forest-floor litter; grass receives leafy-grass through the
        // material-specific uniform binding above. Bark and flowers stay intact.
        if ( uGroundReady > 0.5 && vVegTintable > 0.5 && vVegHeight < 0.56 ) {
          vec3 groundSample = texture2D( uGroundDetail, vVegWorld.xz * 0.16 ).rgb;
          float root = 1.0 - smoothstep( 0.035, 0.46, vVegHeight );
          float gv = dot( groundSample, vec3( 0.2126, 0.7152, 0.0722 ) );
          diffuseColor.rgb *= mix( vec3( 0.95 ), vec3( 0.76 + gv * 0.38 ), root * 0.54 );
        }
        // A local contact ramp makes cards settle into the terrain instead of
        // reading as floating decals. It is deliberately colour-only, so alpha
        // sorting and the shadow-pass budget are unchanged.
        diffuseColor.rgb *= mix( ${V.groundContactDarken.toFixed(3)}, 1.0,
          smoothstep( 0.018, 0.16, vVegHeight ) );`,
    )
      .replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>
        normal = normalize( vNormal );`,
    );
  };
  m.customProgramCacheKey = () => 'veg-card' + (uvSelect ? '-uvsel' : '') + ('VEG_GRASS' in m.defines ? '-grass' : '');
  return m;
}

// ===========================================================================
// system
// ===========================================================================

const LAYERS = ['grassNear', 'grassFar', 'shrub', 'tree', 'far'];
const GROUND_LEVEL = { grassNear: 0, grassFar: 1, shrub: 1, tree: 2, far: 4 };
const GROUND_SPREAD = { grassNear: 8, grassFar: 8, shrub: 3, tree: 30, far: 30 };

export class Vegetation {
  constructor(world, atmo, scheduler, terrain = null) {
    this.study = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('plants') !== 'baseline';
    this._treeRevision = 0;
    this.world = world;
    this.atmo = atmo;
    this.scheduler = scheduler;
    this.terrain = terrain;
    this._coverageRevision = -1;
    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    this.tiles = new Map();
    this.version = 0;
    this.seed = world.seed ^ 0x2b7c1f03;
    this.windT = 0;
    this._lastNow = 0;
    // Clipmap membership only changes when the focus crosses a layer tile. Keep
    // the last tile signature so the hot per-frame path does not allocate five
    // arrays, sort the same jobs, or scan the tile map while the camera is still
    // inside its current cells.
    this._streamSignature = '';
    this._streamJobs = [];
    this._streamWant = new Set();
    this._builds = new Map();
    // Leaving a clipmap tile should not synchronously delete several large GPU
    // buffers in the driving frame. Keep retired entries hidden for a few
    // frames; a returning tile can be restored without rebuilding it.
    this._retireQueue = [];
    this._retireHead = 0;
    this._retired = new Map();
    this._retireBudgetMs = 0.8;

    this.setSeason(this.atmo.seasonName, false);
    this.atlas = buildAtlas(V.season);
    this.impostor = buildImpostorAtlas(this.atlas, 0x7ea1);

    this.mat = {
      card: vegMaterial(this.atlas.tex, V.cardAlphaTest, V.windAnim, false),
      curveGrass: curveGrassMaterial(),
      imp: vegMaterial(this.impostor.tex, V.cardAlphaTest, 0, true),
      ...flowerMaterials(),
    };
    if (this.study) {
      this.mat.meadowNear = meadowGrassMaterial(false);
      this.mat.meadowFar = meadowGrassMaterial(true);
    }
    for (const k in this.mat) { this.mat[k].name = 'veg-' + k; atmo.register(this.mat[k]); }
    this.woodland = this.study ? new Woodland(this.group, atmo) : null;
    this.understory = null;
    const understoryPromise = this.study ? loadUnderstory().then(asset => {
      this.understory = asset;
      atmo.register(asset.materials.bark);
      atmo.register(asset.materials.leaf);
      this.rebuildAll();
    }) : Promise.resolve();

    // Reuse both repository CC0 ground assets for subtle root-level blends.
    // Grass inherits the leafy surface while woody cards use the forest-floor
    // litter texture, so every layer settles into the same continuous ground
    // material without adding geometry or changing residency.
    const detailLoader = new THREE.TextureLoader();
    this.assetError = null;
    this.flower = null;
    this.needleAssetReady = false;
    const flowerLoader = new GLTFLoader();
    const detailPromise = detailLoader.loadAsync('/textures/forest-floor.jpg').then((forestTex) => {
      forestTex.colorSpace = THREE.SRGBColorSpace;
      forestTex.wrapS = forestTex.wrapT = THREE.RepeatWrapping;
      forestTex.anisotropy = Math.min(8, atmo.renderer.capabilities.getMaxAnisotropy());
      for (const key of ['card', 'imp']) {
        this.mat[key].userData.uniforms.uGroundDetail.value = forestTex;
        this.mat[key].userData.uniforms.uGroundReady.value = 1;
      }
    });
    const flowerPromise = flowerLoader.loadAsync('/models/flower-nature.glb').then((flowerGltf) => {
      this.flower = prepareFlowerPair(flowerGltf);
      // Tiles can begin streaming before the asynchronous model arrives. Rebuild
      // once so already-resident close grass tiles receive the shared flower draws.
      this.rebuildAll();
    });
    const needlePromise = detailLoader.loadAsync('/textures/pine-branch-eztree.png').then((texture) => {
      const context = this.atlas.canvas.getContext('2d');
      // Pack the redistributable branch into the existing atlas. Grayscale
      // preserves the scene's per-instance seasonal palette and adds no sampler.
      for (const name of ['needleFir', 'needleSpruce', 'needlePine']) {
        const cell = this.atlas.px[name];
        const w = cell.w - 4, h = cell.h - 4;
        context.clearRect(cell.x, cell.y, cell.w, cell.h);
        context.save();
        context.translate(cell.x + cell.w / 2, cell.y + cell.h / 2);
        context.rotate(Math.PI / 2);
        context.filter = 'grayscale(1) brightness(1.6)';
        context.drawImage(texture.image, -h / 2, -w / 2, h, w);
        context.restore();
      }
      texture.dispose();
      this.atlas.tex.needsUpdate = true;
      const previous = this.impostor.tex;
      this.impostor = buildImpostorAtlas(this.atlas, 0x7ea1);
      this.mat.imp.map = this.impostor.tex;
      previous.dispose();
      this.needleAssetReady = true;
    });
    // A missing optional mesh must not prevent the ground textures installing.
    // Rig readiness still reports any failed asset, rather than hiding it.
    const woodlandPromise = this.woodland?.assetPromise.then(() => {
      if (this.woodland.error) throw new Error(this.woodland.error);
    });
    this.assetPromise = Promise.allSettled([detailPromise, flowerPromise, needlePromise, woodlandPromise, understoryPromise]).then((results) => {
      const failures = results.filter((r) => r.status === 'rejected');
      this.assetError = failures.length ? failures.map((r) => String(r.reason?.message || r.reason)).join('; ') : null;
    });

    this._buildGeometries();
  }

  /** Apply the season contract shared with Atmosphere. Returns whether hooks changed. */
  setSeason(name, rebuild = true) {
    const next = SEASON_HOOKS[name] || SEASON_HOOKS.summer;
    const prev = V.season;
    const changed = Object.keys(next).some((k) => {
      const a = prev[k], b = next[k];
      return Array.isArray(a) ? a.some((v, i) => v !== b[i]) : a !== b;
    });
    for (const k of Object.keys(next)) {
      V.season[k] = Array.isArray(next[k]) ? next[k].slice() : next[k];
    }
    this.seasonName = name in SEASON_HOOKS ? name : 'summer';
    if (rebuild && changed && this.geo) this.rebuildAll();
    return changed;
  }

  /** Geometry depends on the season hooks, so it is (re)built by rebuildAll(). */
  _buildGeometries() {
    if (this.geo) for (const k in this.geo) this.geo[k].dispose();
    const S = V.season;
    const uv = this.atlas.uv;
    const R = (s) => makeRng(s);
    this.geo = {
      // Distribute individual cards instead of identical crossed stamps. The
      // per-instance UV selects an atlas variant; total card budget is unchanged.
      grassNear: this.study ? buildMeadowGeometry() : buildCurveBladeGeometry(5),
      grassFar: this.study ? buildMeadowGeometry(14) : buildCurveBladeGeometry(3),
      bush: buildBush(R(0x31), uv, S, false),
      bushDry: buildBush(R(0x32), uv, S, true),
      fern: buildFern(R(0x33), uv, S),
      tussock: buildTussock(R(0x34), uv, S, false),
      plume: buildTussock(R(0x35), uv, S, true),
      spruce: buildConifer(coniferLayout(R(0x41), 'spruce'), uv, S),
      fir: buildConifer(coniferLayout(R(0x42), 'fir'), uv, S),
      pine: buildConifer(coniferLayout(R(0x43), 'pine'), uv, S),
      oak: buildBroadleaf(broadleafLayout(R(0x44), 'oak'), uv, S),
      birch: buildBroadleaf(broadleafLayout(R(0x45), 'birch'), uv, S),
      maple: buildBroadleaf(broadleafLayout(R(0x46), 'maple'), uv, S),
      impConifer: impostorGeo(0.62),
      impBroad: impostorGeo(0.86),
    };
    // Two atlas cells per species: base and alternate silhouette.
    this.impCell = { spruce: 0, fir: 2, pine: 4, oak: 6, birch: 8, maple: 10 };
  }

  rebuildAll() {
    this._cancelBuilds(() => true);
    this.woodland?.clear();
    this.version++;
    for (const [, t] of this.tiles) this._dispose(t);
    this.tiles.clear();
    for (const [, t] of this._retired) this._dispose(t);
    this._retired.clear();
    this._retireQueue.length = 0;
    this._retireHead = 0;
    this.scheduler.drop((k) => k.startsWith('veg:'));
    this._streamSignature = '';
    this._streamJobs.length = 0;
    this._streamWant.clear();
    this._buildGeometries();
  }

  _dispose(entry) {
    if (entry.meshes.some(m => m.userData.woodlandSource)) this._treeRevision++;
    for (const m of entry.meshes) {
      this.group.remove(m);
      // InstancedMesh.dispose() only emits its own event. Each tile owns a wrapper
      // geometry (while sharing template attributes), so release that wrapper too.
      if (m.geometry) {
        for (const name of ['position', 'normal', 'uv', 'cardUv', 'color', 'tintable', 'bladePlane', 'iTint', 'iShape', 'iVariant', 'iUv', 'iGrassHeight', 'iGrassWidth', 'iGrassPhase', 'iGrassCurl', 'iGrassColor', 'instanceColor']) m.geometry.deleteAttribute(name);
        m.geometry.setIndex(null);
        m.geometry.dispose();
      }
      m.dispose();
    }
  }

  _retire(key, entry) {
    if (entry.meshes.some(m => m.userData.woodlandSource)) this._treeRevision++;
    // A tile may be revisited before its deferred disposal runs. The map is the
    // cancellation token; the queue itself remains append-only and cheap.
    for (const m of entry.meshes) m.visible = false;
    this._retired.set(key, entry);
    this._retireQueue.push({ key, entry });
  }

  _drainRetireQueue() {
    if (!this._retireQueue.length) return;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    while (this._retireHead < this._retireQueue.length) {
      const item = this._retireQueue[this._retireHead++];
      // It was restored after leaving the queue, or superseded by a newer
      // entry with the same key. Never dispose an active tile.
      if (this._retired.get(item.key) !== item.entry) continue;
      this._retired.delete(item.key);
      this._dispose(item.entry);
      if (typeof performance !== 'undefined' && performance.now() - t0 >= this._retireBudgetMs) break;
    }
    if (this._retireHead >= this._retireQueue.length) {
      this._retireQueue.length = 0;
      this._retireHead = 0;
    } else if (this._retireHead > 16) {
      this._retireQueue.splice(0, this._retireHead);
      this._retireHead = 0;
    }
  }

  // ------------------------------------------------------------ density fields

  /** Forest MASS: crisp-edged, kilometre scale. */
  forest(x, z) {
    const n = 0.5 + 0.5 * fbm(x * V.forestFreq, z * V.forestFreq, this.seed ^ 0x991a, 4);
    return smoothstep(V.forestThreshold - V.forestSharpness, V.forestThreshold + V.forestSharpness, n);
  }

  /** Grove: the ~80 m scale that makes trees clump instead of sprinkle. */
  grove(x, z) {
    const n = 0.5 + 0.5 * fbm(x * V.groveFreq, z * V.groveFreq, this.seed ^ 0x4c17, 3);
    return smoothstep(V.groveLo, V.groveHi, n);
  }

  /** Combined tree cover mask: the shared biome field (masses, clearings, lone stands). */
  cover(x, z) {
    return forestCover(x, z, this.seed);
  }

  /** 0..1 conifer share, coherent over ~250 m so species form stands. */
  speciesField(x, z, y, moisture) {
    const n = 0.5 + 0.5 * fbm(x * V.speciesFreq, z * V.speciesFreq, this.seed ^ 0x7d31, 2);
    const bias = clamp(V.coniferShare + smoothstep(120, 400, y) * 0.44 - moisture * 0.26, 0.03, 0.97);
    return clamp(lerp(bias, n > 0.5 ? 0.94 : 0.08, V.speciesCoherence * 0.72) * 0.5 + bias * 0.5, 0, 1);
  }

  /**
   * World-stable species pick shared by the 3D and impostor rings.  It is
   * keyed to a coarse world cell rather than each layer's PRNG stream, so a
   * tree crossing the LOD boundary keeps its species silhouette.
   */
  speciesKind(x, z, y, moisture) {
    const conShare = this.speciesField(x, z, y, moisture);
    const cellX = Math.floor(x / 28), cellZ = Math.floor(z / 28);
    const n = hash2i(cellX, cellZ, this.seed ^ 0x53a91f) / 4294967296;
    if (n < conShare) {
      const alt = smoothstep(80, 340, y);
      const q = hash2i(cellX, cellZ, this.seed ^ 0x9d31b7) / 4294967296;
      if (moisture < 0.32 && q > 0.30) return 'pine';
      return q < 0.34 + alt * 0.34 ? 'spruce' : (q < 0.68 ? 'fir' : 'pine');
    }
    const broad = hash2i(cellX, cellZ, this.seed ^ 0xa71ce5) / 4294967296;
    return broad < 0.58 ? 'oak' : (broad < 0.84 ? 'birch' : 'maple');
  }

  treeDensity(x, z, y, slope, moisture, roadDist, waterY, cover) {
    if (y < waterY + V.waterClear) return 0;
    let d = cover !== undefined ? cover : this.cover(x, z);
    d *= smoothstep(V.slopeLimitTree, V.slopeLimitTree - 0.34, slope);
    d *= smoothstep(V.treeLine + V.treeLineFade, V.treeLine - V.treeLineFade, y);
    d *= 0.30 + 0.85 * moisture;
    d *= smoothstep(V.roadClear, V.roadClear + V.roadFade, roadDist);
    return clamp(d, 0, 1);
  }

  /**
   * Shrubs live where trees do NOT: forest edges, dry open slopes, the road verge.
   * This is the layer that was missing, and it is what stops the ground reading as a
   * lawn with cones on it.
   */
  shrubDensity(x, z, y, slope, moisture, roadDist, waterY, cover) {
    if (y < waterY + 0.7) return 0;
    const c = cover !== undefined ? cover : this.cover(x, z);
    const edge = 1 - Math.abs(c * 2 - 1);              // peaks at the canopy edge
    const dryOpen = (1 - moisture) * (1 - c * 0.7);    // sagebrush country
    let d = 0.10 + 0.72 * edge * edge + 0.52 * dryOpen + 0.20 * c;
    // verge band: past the mown strip, before the tree clear line
    const vb = smoothstep(V.shrubClear, V.shrubClear + 3.0, roadDist) *
      smoothstep(V.vergeShrubRange, V.vergeShrubRange * 0.45, roadDist);
    d *= 1 + (V.vergeShrubBoost - 1) * vb;
    d *= smoothstep(V.slopeLimitShrub, V.slopeLimitShrub - 0.45, slope);
    d *= smoothstep(V.shrubClear, V.shrubClear + 2.0, roadDist);
    d *= smoothstep(V.treeLine + 300, V.treeLine - 40, y);
    return clamp(d, 0, 1);
  }

  grassDensity(x, z, y, slope, moisture, roadDist, waterY, cover) {
    if (y < waterY + 0.4) return 0;
    const c = cover !== undefined ? cover : this.cover(x, z);
    let d = 1 - 0.68 * c;                              // real shade suppression
    const verge = smoothstep(4.5, 7.0, roadDist) * (1 - smoothstep(18, 35, roadDist));
    d = Math.max(d, verge * 0.92);
    d *= smoothstep(V.slopeLimitGrass, V.slopeLimitGrass - 0.45, slope);
    d *= 0.42 + 0.72 * moisture;
    d *= smoothstep(V.grassClear, V.grassClear + V.grassFade, roadDist);
    d *= smoothstep(V.treeLine + 220, V.treeLine - 60, y);
    return clamp(d * V.season.lushness, 0, 1);
  }

  /** Static, spatially coherent gust strength (-1..1) — visible in a still frame. */
  gust(x, z) {
    return fbm(x * V.windFreq, z * V.windFreq, this.seed ^ 0x2ee1, 2);
  }

  // ------------------------------------------------------------------ streaming

  _groundReady(job) {
    if (!this.terrain) return true;
    const L = V.layers[job.layer], pad = GROUND_SPREAD[job.layer];
    const bounds = job.groundBounds || (job.groundBounds = [
      job.i * L.tile - pad, job.j * L.tile - pad,
      (job.i + 1) * L.tile + pad, (job.j + 1) * L.tile + pad,
    ]);
    return this.terrain.coversBounds(...bounds, GROUND_LEVEL[job.layer]);
  }

  _setGroundReady(entry, ready) {
    if (entry.groundReady === ready && entry.meshes.every(m => m.visible === ready)) return;
    entry.groundReady = ready;
    for (const mesh of entry.meshes) mesh.visible = ready;
    if (entry.meshes.some(m => m.userData.woodlandSource)) this._treeRevision++;
  }

  update(camX, camZ) {
    // Animated sway only advances while the sim runs, so paused captures are
    // byte-deterministic (see gauntlet/RULES.md §5).
    const app = typeof window !== 'undefined' ? window.__app : null;
    const now = (typeof performance !== 'undefined' ? performance.now() : 0);
    let dt = this._lastNow ? Math.min(0.05, (now - this._lastNow) / 1000) : 0;
    this._lastNow = now;
    if (app && (app.paused || app.forceDrain)) { dt = 0; this.windT = 0; }
    this.windT += dt * TAU * V.windAnimHz;
    for (const k in this.mat) {
      const u = this.mat[k].userData.uniforms;
      if (u) u.uWind.value.x = this.windT;
      if (u?.uFocus) u.uFocus.value.set(camX, camZ);
    }
    this._drainRetireQueue();

    // Most frames do not cross even the smallest vegetation tile. Reuse the
    // previous residency plan in that case; rebuilding it was pure GC/sort work.
    let signature = '';
    for (const layer of LAYERS) {
      const L = V.layers[layer];
      signature += `${Math.floor(camX / L.tile)},${Math.floor(camZ / L.tile)};`;
    }
    const moved = signature !== this._streamSignature;
    const coverageRevision = this.terrain?.coverageRevision ?? 0;
    const groundChanged = coverageRevision !== this._coverageRevision;
    if (moved) {
      const want = new Set();
      const jobs = [];
      for (const layer of LAYERS) {
        const L = V.layers[layer];
        const ci = Math.floor(camX / L.tile), cj = Math.floor(camZ / L.tile);
        for (let j = cj - L.radius; j <= cj + L.radius; j++) {
          for (let i = ci - L.radius; i <= ci + L.radius; i++) {
            const cx = (i + 0.5) * L.tile, cz = (j + 0.5) * L.tile;
            const d = Math.hypot(cx - camX, cz - camZ);
            // Keep the tree/impostor clip rings adjacent instead of submitting
            // both full populations through a broad hard-overlap band.  The
            // half-tile guard still avoids a visible hole at cell boundaries.
            const pad = (layer === 'tree' || layer === 'far') ? L.tile * 0.5 : L.tile;
            if (d > L.maxDist + pad) continue;
            if (!this.study && layer === 'grassFar' && d < V.layers.grassNear.maxDist - V.layers.grassNear.tile * 0.25) continue;
            if (layer === 'far' && d < V.layers.tree.maxDist + V.layers.tree.tile * 0.5) continue;
            const key = `veg:${this.version}:${layer}:${i}:${j}`;
            want.add(key);
            jobs.push({ key, layer, i, j, d });
          }
        }
      }
      for (const [k, t] of this.tiles) if (!want.has(k)) {
        this.tiles.delete(k);
        this._retire(k, t);
      }
      this._cancelBuilds((key) => !want.has(key));
      this.scheduler.drop((k) => k.startsWith('veg:') && !want.has(k));
      this.required = want.size;
      jobs.sort((a, b) => a.d - b.d);
      this._streamSignature = signature;
      this._streamJobs = jobs;
      this._streamWant = want;
    }

    if (moved || groundChanged) {
      for (const entry of this.tiles.values()) this._setGroundReady(entry, this._groundReady(entry.job));
      for (const job of this._streamJobs) {
        if (this.tiles.has(job.key) || this.scheduler.has(job.key)) continue;
        const retired = this._retired.get(job.key);
        const groundReady = this._groundReady(job);
        if (retired) {
          this._retired.delete(job.key);
          this._setGroundReady(retired, groundReady);
          this.tiles.set(job.key, retired);
        } else if (groundReady) {
          // Missing support waits for a coverage revision, never a polling job
          // that could monopolize the same queue needed to build its ground.
          this.scheduler.push(job.key, 200000 + job.d, this._buildTask(job));
        }
      }
      this._coverageRevision = coverageRevision;
    }
    this._cancelBuilds((key) => !this.scheduler.has(key));
    this.woodland?.setCamera(app?.cameras?.camera);
    this.woodland?.sync(this.tiles, camX, camZ, this._treeRevision, V.season);
  }

  get resident() { return this.tiles.size; }

  // ------------------------------------------------------------------- colour

  /** Foliage tint: palette entry -> per-instance hue/sat/value jitter. */
  _foliageTint(col, base, v, w, extraVal) {
    col.setRGB(base[0], base[1], base[2]);
    col.getHSL(this._hsl || (this._hsl = {}));
    const h = this._hsl;
    col.setHSL(
      (h.h + (v - 0.5) * V.hueJitter + 1) % 1,
      clamp(h.s * (1 + (w - 0.5) * V.satJitter * 2), 0.02, 1),
      clamp(h.l * (1 + (v * 0.62 + w * 0.38 - 0.5) * V.valJitter * 2) * (extraVal || 1), 0.008, 0.98),
    );
  }

  // -------------------------------------------------------------------- build

  _cancelBuilds(predicate) {
    if (!this._builds) return;
    for (const [key, build] of this._builds) if (predicate(key)) build.cancel();
  }

  _buildTask(job) {
    const builds = this._builds || (this._builds = new Map());
    builds.get(job.key)?.cancel();
    const version = this.version, seed = this.seed, world = this.world;
    let iterator = null, cancelled = false;
    const build = { cancel: () => {
      cancelled = true;
      iterator?.return();
      if (builds.get(job.key) === build) builds.delete(job.key);
    } };
    builds.set(job.key, build);
    const advance = () => {
      if (cancelled || version !== this.version || seed !== this.seed || world !== this.world ||
          !this._streamWant.has(job.key)) { build.cancel(); return; }
      try {
        // The optional iterator preserves synchronous custom tile builders too.
        if (!iterator) iterator = this._buildTile(job, true);
        if (iterator && !iterator.next().done) return advance;
        if (builds.get(job.key) === build) builds.delete(job.key);
      } catch (error) {
        build.cancel();
        throw error;
      }
    };
    return advance;
  }

  _buildTile(job, incremental = false) {
    const iterator = this._buildTileSteps(job);
    if (incremental) return iterator;
    while (!iterator.next().done) { /* Synchronous callers keep the original API. */ }
  }

  *_buildTileSteps(job) {
    const meshes = [];
    const version = this.version, seed = this.seed, world = this.world;
    let published = false;
    try {
      yield* this._buildTileData(job, meshes);
      if (version !== this.version || seed !== this.seed || world !== this.world) return;
      const entry = { meshes, job };
      this._setGroundReady(entry, this._groundReady(job));
      if (meshes.length) this.group.add(...meshes);
      this.tiles.set(job.key, entry);
      published = true;
    } finally {
      if (!published) this._dispose({ meshes });
    }
  }

  *_buildTileData(job, meshes) {
    const { key, layer, i, j } = job;
    const L = V.layers[layer];
    const world = this.world, hf = world.hf;
    const ox = i * L.tile, oz = j * L.tile;
    const rng = makeRng(hash2i(i, j, this.seed ^ (layer.length * 7919 + 13)));
    const flowerRng = makeRng(hash2i(i, j, this.seed ^ 0x42f10));
    const pal = this.atmo.palette;
    const S = V.season;

    const bins = {
      grass: [], bush: [], bushDry: [], fern: [], tussock: [], plume: [],
      spruce: [], fir: [], pine: [], oak: [], birch: [], maple: [], imp: [], flower: [],
    };
    const isFar = layer === 'far';
    const near = layer === 'grassNear' || layer === 'grassFar' || layer === 'shrub';
    const sm = {};
    const fs = {};
    const groundGradient = { dx: 0, dz: 0 };

    for (let k = 0; k < L.perTile; k++) {
      if (k > 0 && (k & 15) === 0) yield;
      const x = ox + rng() * L.tile;
      const z = oz + rng() * L.tile;
      const rv1 = rng(), rv2 = rng(), rv3 = rng(), rv4 = rng();

      // cheapest strong rejector first
      const cover = this.cover(x, z);
      if (layer === 'tree' || isFar) { if (rv1 > cover) continue; }

      let y, slope, moist, roadDist, waterY;
      if (isFar) {
        // 2 km out, road clearance is invisible: skip the expensive route query
        const f = hf.full(x, z, fs);
        y = f.ground; waterY = f.waterY; moist = f.moisture; roadDist = 999;
        if (y < waterY + V.waterClear && f.dist < f.channelHalf * 2.4) continue;
        const e = 8;
        const hR = hf.ground(x + e, z), hU = hf.ground(x, z + e);
        const nx = (y - hR) / e, nz = (y - hU) / e;
        // Match World.slopeAt's sign convention so the instance normal tilts
        // uphill, using only the two probes already required for far slope.
        groundGradient.dx = -nx;
        groundGradient.dz = -nz;
        slope = clamp(1 - 1 / Math.sqrt(1 + nx * nx + nz * nz), 0, 1);
      } else {
        world.sample(x, z, sm);
        y = sm.y; waterY = sm.waterY; moist = sm.moisture; roadDist = sm.roadDist;
        if (y < waterY + V.waterClear && sm.riverDist < sm.channelHalf * 2.4) continue;
        slope = world.slopeAt(x, z, y, near ? 2.6 : 6, groundGradient);
      }

      const g = this.gust(x, z);

      if (layer === 'grassNear' || layer === 'grassFar') {
        const d = this.grassDensity(x, z, y, slope, moist, roadDist, waterY, cover);
        if (rv1 > d) continue;
        const hr = layer === 'grassNear' ? V.grassHeightNear : V.grassHeightFar;
        // One terrain sample seeds a small card clump. This keeps the visual
        // population close to the old high-density pass without paying for a
        // world.sample/slope query per blade during streaming.
        const copies = this.study
          ? (layer === 'grassNear' ? 16 : 12)
          : (layer === 'grassNear' ? V.grassCopiesNear : V.grassCopiesFar);
        for (let copy = 0; copy < copies; copy++) {
          const spread = copy === 0 ? 0 : (rng() - 0.5) * (layer === 'grassNear' ? V.grassSpreadNear : V.grassSpreadFar);
          const spreadZ = copy === 0 ? 0 : (rng() - 0.5) * (layer === 'grassNear' ? V.grassSpreadNear : V.grassSpreadFar);
          const scaleJitter = copy === 0 ? 1 : lerp(0.84, 1.08, rng());
          // Sink only the copied roots on sloped ground. The amount is derived
          // from the already-computed slope scalar, so this adds no terrain
          // probes or streaming work while hiding tiny gaps between cards.
          const rootSink = V.grassRootSink * clamp(slope * 3.0, 0, 1) *
            (copy === 0 ? 0.55 : lerp(0.78, 1.18, rng()));
          const record = {
            x: x + spread,
            y: y + groundGradient.dx * spread + groundGradient.dz * spreadZ - rootSink,
            z: z + spreadZ,
            groundDx: groundGradient.dx, groundDz: groundGradient.dz,
            s: lerp(hr[0], hr[1], rng() * 0.45 + rv2 * 0.45 + 0.10) *
              lerp(0.8, 1.12, S.lushness) * scaleJitter,
            r: (copy === 0 ? rv2 : rng()) * Math.PI,
            m: moist, v: copy === 0 ? rv3 : rng(), w: rv4, c: cover, g,
            shape: rng(),
          };
          // Preserve the PRNG stream even when a copied root is rejected. Only
          // copies close enough to cross the road need an extra route query.
          if (this.study && world.route && roadDist - Math.hypot(spread, spreadZ) < V.grassClear + 1) {
            const road = world.route.nearest(record.x, record.z, V.grassClear + 1);
            if (road && road.dist < V.grassClear) continue;
          }
          bins.grass.push(record);
        }
        // Only the close ring needs geometric flowers. An independent RNG
        // leaves the existing grass/shrub layout unchanged when flowers vary.
        const flowerChance = S.flowerAmount * (0.02 + 0.06 * moist) * (1 - 0.70 * cover);
        if (layer === 'grassNear' && S.flowerAmount > 0 && flowerRng() < flowerChance) {
          bins.flower.push({ x, y, z, groundDx: groundGradient.dx, groundDz: groundGradient.dz,
            s: lerp(V.flowerHeight[0], V.flowerHeight[1], rv2 * 0.7 + rv3 * 0.3),
            r: rv4 * TAU, m: moist, v: rv3, w: rv4, c: cover, g, shape: flowerRng() });
        }
      } else if (layer === 'shrub') {
        const d = this.shrubDensity(x, z, y, slope, moist, roadDist, waterY, cover);
        if (rv1 > d) continue;
        // archetype from the biome, not from a coin flip
        const wet = moist * (0.55 + 0.75 * cover);
        let kind;
        if (wet > 0.62 && rv2 < 0.80) kind = 'fern';
        else if (moist < 0.34 && rv2 < 0.72) kind = rv3 < 0.42 ? 'plume' : 'bushDry';
        else if (rv2 < 0.44) kind = rv3 < 0.55 ? 'tussock' : 'plume';
        else kind = 'bush';
        const hs = kind === 'bush' || kind === 'bushDry' ? V.bushRadius
          : kind === 'fern' ? V.fernHeight : V.tussockHeight;
        bins[kind].push({
          x, y, z, groundDx: groundGradient.dx, groundDz: groundGradient.dz,
          s: lerp(hs[0], hs[1], rv3 * 0.6 + rv4 * 0.4) * 1.4,
          r: rv4 * TAU, m: moist, v: rv2, w: rv4, c: cover, g, kind, shape: rng(),
        });
      } else {
        const d = this.treeDensity(x, z, y, slope, moist, roadDist, waterY, cover);
        if (rv2 > d / Math.max(cover, 1e-3)) continue;
        const kind = this.speciesKind(x, z, y, moist);
        const hr = kind === 'spruce' ? V.spruceHeight : kind === 'fir' ? V.spruceHeight
          : kind === 'pine' ? V.pineHeight : V.broadleafHeight;
        // taller in sheltered wet ground, stunted on exposed dry slopes
        const vig = clamp(0.35 + moist * 0.75 - slope * 0.55, 0.12, 1.2);
        const h = lerp(hr[0], hr[1], clamp(rv3 * 0.55 + rv4 * 0.45, 0, 1) * vig);
        const variant = hash2i(Math.floor(x / 12), Math.floor(z / 12), this.seed ^ 0x6a21) & 1;
        const rec = { x, y, z, groundDx: groundGradient.dx, groundDz: groundGradient.dz,
          s: h, r: rv4 * TAU, m: moist, v: rv3, w: rv4, c: cover, g, kind,
          shape: rng(), variant };
        if (isFar) bins.imp.push(rec); else bins[kind].push(rec);
      }
    }

    const M = new THREE.Matrix4();
    const Q = new THREE.Quaternion();
    const E = new THREE.Euler();
    const P = new THREE.Vector3();
    const SC = new THREE.Vector3();
    const CO = new THREE.Color();
    const LEAN = new THREE.Quaternion();
    const AX = new THREE.Vector3();
    const groundUp = new THREE.Vector3(0, 1, 0);
    const groundNormal = new THREE.Vector3();
    const groundTilt = new THREE.Quaternion();
    const wdx = Math.cos(V.windDir), wdz = Math.sin(V.windDir);

    const bounds = function* (mesh) {
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
      mesh.boundingSphere = new THREE.Sphere().makeEmpty();
      const sphere = new THREE.Sphere();
      for (let k = 0; k < mesh.count; k++) {
        mesh.getMatrixAt(k, M);
        sphere.copy(mesh.geometry.boundingSphere).applyMatrix4(M);
        mesh.boundingSphere.union(sphere);
        if ((k & 127) === 127) yield;
      }
    };

    const mk = function* (geo, mat, list, tintFn, scaleFn, lean, cast, recv, uvFn, instanceColor = false) {
      if (!list.length) return;
      const n = list.length;
      const tint = new Float32Array(n * 3);
      const iuv = uvFn ? new Float32Array(n * 4) : null;
      const ishape = new Float32Array(n);
      const ivariant = new Float32Array(n);
      // Share the template's vertex buffers; only the INSTANCED attributes are new,
      // so a tile costs one small upload, not a whole tree mesh.
      const gg = new THREE.BufferGeometry();
      for (const a of ['position', 'normal', 'uv', 'cardUv', 'color', 'tintable']) {
        const attr = geo.getAttribute(a);
        if (attr) gg.setAttribute(a, attr);
      }
      gg.setIndex(geo.getIndex());
      gg.boundingSphere = geo.boundingSphere;
      const im = new THREE.InstancedMesh(gg, mat, n);
      meshes.push(im);
      for (let k = 0; k < n; k++) {
        const it = list[k];
        P.set(it.x, it.y, it.z);
        E.set(0, it.r, 0);
        Q.setFromEuler(E);
        // Grass cards are small enough to follow the local tangent. Trees and
        // shrubs intentionally keep their stable vertical frames; rotating an
        // entire broadleaf crown around each sparse sample exaggerates the
        // low-resolution terrain facets and caused a visible broken-slope read.
        if (it.groundDx !== undefined && it.kind === undefined) {
          groundNormal.set(-it.groundDx, 1, -it.groundDz).normalize();
          groundTilt.setFromUnitVectors(groundUp, groundNormal);
          Q.premultiply(groundTilt);
        }
        if (lean > 0) {
          // static gust: lean about the horizontal axis perpendicular to the wind
          AX.set(-wdz, 0, wdx);
          LEAN.setFromAxisAngle(AX, lean * it.g);
          Q.premultiply(LEAN);
        }
        scaleFn(it, SC);
        M.compose(P, Q, SC);
        im.setMatrixAt(k, M);
        tintFn(it, CO);
        tint[k * 3] = CO.r; tint[k * 3 + 1] = CO.g; tint[k * 3 + 2] = CO.b;
        if (instanceColor) im.setColorAt(k, CO);
        ishape[k] = it.shape || 0;
        // Variant is intentionally useful even when no alternate atlas cell
        // is selected: the shader uses it to choose a different organic edge
        // exponent, while far impostors additionally use it for their atlas UV.
        ivariant[k] = it.variant !== undefined ? it.variant : (((it.shape || 0) * 3) | 0);
        if (iuv) {
          const u = uvFn(it);
          iuv[k * 4] = u[0]; iuv[k * 4 + 1] = u[1]; iuv[k * 4 + 2] = u[2]; iuv[k * 4 + 3] = u[3];
        }
        if ((k & 127) === 127) yield;
      }
      gg.setAttribute('iTint', new THREE.InstancedBufferAttribute(tint, 3));
      gg.setAttribute('iShape', new THREE.InstancedBufferAttribute(ishape, 1));
      gg.setAttribute('iVariant', new THREE.InstancedBufferAttribute(ivariant, 1));
      if (iuv) gg.setAttribute('iUv', new THREE.InstancedBufferAttribute(iuv, 4));
      im.instanceMatrix.needsUpdate = true;
      if (instanceColor && im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = !!cast;
      im.receiveShadow = !!recv;
      im.frustumCulled = true;
      yield* bounds(im);
      if (this.study && layer === 'tree') {
        im.userData.woodlandSource = { id: `${key}:${list[0].kind}`, records: list, matrices: im.instanceMatrix.array.slice() };
      }
    }.bind(this);

    const mkCurveGrass = function* (list, layer) {
      if (!list.length) return;
      const template = this.geo[layer];
      const gg = new THREE.BufferGeometry();
      for (const a of ['position', 'normal', 'bladePlane']) {
        const attr = template.getAttribute(a);
        if (attr) gg.setAttribute(a, attr);
      }
      gg.setIndex(template.getIndex());
      const im = new THREE.InstancedMesh(gg, this.mat.curveGrass, list.length);
      meshes.push(im);
      const height = new Float32Array(list.length);
      const width = new Float32Array(list.length);
      const phase = new Float32Array(list.length);
      const curl = new Float32Array(list.length);
      const color = new Float32Array(list.length);
      const layerScale = layer === 'grassNear' ? 1 : 1.15;
      for (let k = 0; k < list.length; k++) {
        const it = list[k];
        P.set(it.x, it.y, it.z);
        E.set(0, it.r, 0);
        Q.setFromEuler(E);
        if (it.groundDx !== undefined) {
          groundNormal.set(-it.groundDx, 1, -it.groundDz).normalize();
          groundTilt.setFromUnitVectors(groundUp, groundNormal);
          Q.premultiply(groundTilt);
        }
        M.compose(P, Q, SC.set(1, 1, 1));
        im.setMatrixAt(k, M);
        height[k] = it.s * (0.68 + 0.12 * it.w) * (layer === 'grassFar' ? 1.04 : 1);
        width[k] = it.s * (0.08 + 0.065 * it.v) * layerScale;
        phase[k] = it.shape * TAU + it.g * 1.7;
        curl[k] = lerp(0.78, 1.38, clamp(it.w * 0.86 + it.v * 0.14, 0, 1));
        color[k] = clamp(it.m * 0.66 + it.v * 0.34, 0, 1);
        if ((k & 127) === 127) yield;
      }
      gg.setAttribute('iGrassHeight', new THREE.InstancedBufferAttribute(height, 1));
      gg.setAttribute('iGrassWidth', new THREE.InstancedBufferAttribute(width, 1));
      gg.setAttribute('iGrassPhase', new THREE.InstancedBufferAttribute(phase, 1));
      gg.setAttribute('iGrassCurl', new THREE.InstancedBufferAttribute(curl, 1));
      gg.setAttribute('iGrassColor', new THREE.InstancedBufferAttribute(color, 1));
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = false;
      im.receiveShadow = false;
      im.frustumCulled = true;
      yield* bounds(im);
    }.bind(this);

    // ---- ground cover colour: inherits from the terrain beneath and darkens
    //      towards litter under a closed canopy.
    const groundTint = (it, col) => {
      const a = pal.grassDry, b = pal.grassLush;
      const t = clamp(it.m * 2.05 - 0.38 + (it.v - 0.5) * 0.30, 0, 1);
      const base = [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
      const shade = 1 - V.forestFloorDarken * it.c;
      this._foliageTint(col, base, it.v, it.w, shade);
      // browning under canopy: pull towards litter
      if (it.c > 0.01) {
        const k = V.forestFloorBrown * it.c;
        col.setRGB(lerp(col.r, col.r * 1.15 + 0.035, k), lerp(col.g, col.g * 0.80, k), lerp(col.b, col.b * 0.62, k));
      }
      col.multiplyScalar(1);
      col.r *= S.groundTint[0]; col.g *= S.groundTint[1]; col.b *= S.groundTint[2];
      // Snow is a ground cover, not a sparse tint: keep a high white baseline
      // so winter fields stay continuous between the remaining grass cards.
      if (S.snow > 0) { col.lerp(SNOW, S.snow * 0.94); }
    };

    const flowerStemTint = (it, col) => {
      // Per-instance colour keeps the shared Flower.glb materials cheap while
      // retaining a spring/summer/autumn palette shift.
      col.setRGB(0.18 + it.v * 0.12, 0.42 + it.m * 0.20, 0.12 + it.w * 0.08);
      col.r *= S.groundTint[0]; col.g *= S.groundTint[1]; col.b *= S.groundTint[2];
      if (S.snow > 0) col.lerp(SNOW, S.snow * 0.9);
    };

    const flowerBlossomTint = (it, col) => {
      const palette = [[0.88, 0.86, 0.68], [0.83, 0.64, 0.23], [0.78, 0.73, 0.63], [0.49, 0.43, 0.62]];
      const base = palette[Math.min(palette.length - 1, Math.floor(it.v * palette.length))];
      col.setRGB(base[0], base[1], base[2]);
      // Autumn flowers are sparse but warm; winter bypasses placement entirely.
      col.multiplyScalar(0.86 + it.w * 0.20);
      if (S.snow > 0) col.lerp(SNOW, S.snow);
    };

    const leafTint = (it, col) => {
      const f = pal.foliage;
      const base = f[(it.v * f.length) | 0] || f[0];
      this._foliageTint(col, base, it.v, it.w, 1 - 0.14 * it.c);
      col.r *= S.leafTint[0]; col.g *= S.leafTint[1]; col.b *= S.leafTint[2];
      if (S.snow > 0) col.lerp(SNOW, S.snow * 0.55);
    };

    const needleTint = (it, col) => {
      const c = pal.conifer;
      // conifers vary less in hue but a lot in value — see sr_22
      this._foliageTint(col, c, it.v, it.w, (1 - 0.10 * it.c) * (0.82 + 0.42 * it.w));
      col.r *= S.needleTint[0]; col.g *= S.needleTint[1]; col.b *= S.needleTint[2];
      if (S.snow > 0) col.lerp(SNOW, S.snow * 0.62);
    };

    const scrubTint = (it, col) => {
      // scrub is greyer / sager / drier than tree foliage
      const a = pal.grassDry, f = pal.foliage[2] || pal.foliage[0];
      const t = clamp(it.m * 1.5 - 0.15, 0, 1);
      const base = [lerp(a[0] * 0.94, f[0], t), lerp(a[1] * 0.92, f[1], t), lerp(a[2] * 1.30, f[2], t)];
      this._foliageTint(col, base, it.v, it.w, 1);
      col.r *= S.leafTint[0]; col.g *= S.leafTint[1]; col.b *= S.leafTint[2];
      if (S.snow > 0) col.lerp(SNOW, S.snow * 0.7);
    };

    const treeScale = (spread) => (it, s) => {
      const k = it.s;
      s.set(k * spread(it), k * (0.94 + 0.14 * it.w), k * spread(it));
    };

    if (layer === 'grassNear' || layer === 'grassFar') {
      if (this.study) {
        const material = layer === 'grassNear' ? this.mat.meadowNear : this.mat.meadowFar;
        yield* mk(this.geo[layer], material, bins.grass, groundTint,
          (it, scale) => scale.set(it.s * 1.10, it.s * 1.14, it.s * 1.10), 0, false, false);
      } else yield* mkCurveGrass(bins.grass, layer);
      if (layer === 'grassNear' && this.flower) {
        yield* mk(this.flower.stem, this.mat.flowerStem, bins.flower, flowerStemTint,
          (it, s) => s.set(it.s, it.s, it.s), V.windLeanGrass * 0.35, false, false, null, true);
        yield* mk(this.flower.blossom, this.mat.flowerBlossom, bins.flower, flowerBlossomTint,
          (it, s) => s.set(it.s, it.s, it.s), V.windLeanGrass * 0.35, false, false, null, true);
      }
    } else if (layer === 'shrub') {
      if (this.understory) {
        const shrubLeafTint = (it, col) => {
          const dry = 1 - it.m;
          const value = 0.84 + it.v * 0.24;
          col.setRGB((0.88 + dry * 0.18) * value * S.leafTint[0],
            0.96 * value * S.leafTint[1], (0.82 + it.m * 0.18) * value * S.leafTint[2]);
        };
        const shrubBarkTint = (it, col) => col.setRGB(0.9, 0.9, 0.9);
        const shrubScale = (it, s) => s.set(it.s * (0.92 + it.v * 0.18),
          it.s * (0.70 + it.w * 0.20), it.s * (0.92 + it.v * 0.18));
        const groups = [[], []];
        for (const it of [...bins.bush, ...bins.bushDry]) groups[it.shape < 0.55 ? 0 : 1].push(it);
        for (const [index, template] of this.understory.templates.entries()) {
          yield* mk(template.bark, this.understory.materials.bark, groups[index], shrubBarkTint,
            shrubScale, 0, false, false, null, true);
          if (S.bareness < 0.6) yield* mk(template.leaf, this.understory.materials.leaf, groups[index], shrubLeafTint,
            shrubScale, 0, false, false, null, true);
        }
      } else {
        yield* mk(this.geo.bush, this.mat.card, bins.bush, scrubTint,
          (it, s) => s.set(it.s * (0.88 + 0.3 * it.v), it.s * (0.80 + 0.34 * it.w), it.s * (0.88 + 0.3 * it.v)),
          V.windLeanShrub, false, false);
        yield* mk(this.geo.bushDry, this.mat.card, bins.bushDry, scrubTint,
          (it, s) => s.set(it.s * (0.92 + 0.34 * it.v), it.s * (0.72 + 0.30 * it.w), it.s * (0.92 + 0.34 * it.v)),
          V.windLeanShrub, false, false);
      }
      yield* mk(this.geo.fern, this.mat.card, bins.fern, (it, c) => { leafTint(it, c); c.multiplyScalar(0.92); },
        (it, s) => s.set(it.s * (0.9 + 0.3 * it.v), it.s, it.s * (0.9 + 0.3 * it.v)),
        V.windLeanShrub * 1.5, false, false);
      yield* mk(this.geo.tussock, this.mat.card, bins.tussock, groundTint,
        (it, s) => s.set(it.s * (0.68 + 0.34 * it.v), it.s, it.s * (0.68 + 0.34 * it.v)),
        V.windLeanGrass * 0.8, false, false);
      yield* mk(this.geo.plume, this.mat.card, bins.plume, groundTint,
        (it, s) => s.set(it.s * (0.62 + 0.32 * it.v), it.s, it.s * (0.62 + 0.32 * it.v)),
        V.windLeanGrass * 0.8, false, false);
    } else if (layer === 'tree') {
      // Keep alpha-tested shadow work local to the camera. A directional shadow
      // map only covers a small region around the vehicle (ATMO.shadow.extent is
      // 145m); submitting every streamed tree tile multiplies the shadow pass
      // without changing the visible result. Near trees retain both cast and
      // receive; distant trees stay in the colour pass only.
      const treeShadow = false;
      yield* mk(this.geo.spruce, this.mat.card, bins.spruce, needleTint, treeScale((it) => 0.86 + 0.26 * it.v), V.windLeanTree, treeShadow, treeShadow);
      yield* mk(this.geo.fir, this.mat.card, bins.fir, needleTint, treeScale((it) => 0.88 + 0.24 * it.v), V.windLeanTree, treeShadow, treeShadow);
      yield* mk(this.geo.pine, this.mat.card, bins.pine, needleTint, treeScale((it) => 0.90 + 0.30 * it.v), V.windLeanTree, treeShadow, treeShadow);
      yield* mk(this.geo.oak, this.mat.card, bins.oak, leafTint, treeScale((it) => 0.92 + 0.28 * it.v), V.windLeanTree, treeShadow, treeShadow);
      yield* mk(this.geo.birch, this.mat.card, bins.birch, leafTint, treeScale((it) => 0.88 + 0.24 * it.v), V.windLeanTree, treeShadow, treeShadow);
      yield* mk(this.geo.maple, this.mat.card, bins.maple, leafTint, treeScale((it) => 0.90 + 0.26 * it.v), V.windLeanTree, treeShadow, treeShadow);
    } else {
      const con = bins.imp.filter((r) => r.kind === 'spruce' || r.kind === 'fir' || r.kind === 'pine');
      const brd = bins.imp.filter((r) => r.kind === 'oak' || r.kind === 'birch' || r.kind === 'maple');
      const iuv = (it) => this.impostor.uv[this.impCell[it.kind] + (it.variant ? 1 : 0)];
      yield* mk(this.geo.impConifer, this.mat.imp, con, needleTint,
        (it, s) => s.set(it.s * (0.9 + 0.3 * it.v), it.s, it.s * (0.9 + 0.3 * it.v)), 0, false, false, iuv);
      yield* mk(this.geo.impBroad, this.mat.imp, brd, leafTint,
        (it, s) => s.set(it.s * (0.95 + 0.3 * it.v), it.s * 0.95, it.s * (0.95 + 0.3 * it.v)), 0, false, false, iuv);
    }
  }
}

const SNOW = new THREE.Color(0.92, 0.94, 0.99);
