// Landform / composition audit along the route (numbers only, no renderer).
//
// Per station (every --step metres of the route ahead of km 0):
//   * cross profile: road-relative height of World.ground() at 20..300 m either
//     side, and a lateral sight line from the eye (road + --eye m) continued to
//     1.5 km.  A side
//       falls  when its 100-300 m band is more than --side m below the road AND
//              the drop is in view: at least half of that band is visible, or
//              (convex "dead ground" below a shoulder) at least a quarter of
//              the 400-1500 m terrain across the valley is visible;
//       rim    when it drops that far but a near bank hides both;
//       rises  when the 20-300 m mean is more than --side/2 above the road;
//       level  otherwise.
//     Station type:
//       hillside = exactly one side falls  (road on the contour, one side opens)
//       crest    = both sides fall
//       corridor = no side falls and both rise or are rimmed (the failure mode:
//                  valley floor / cutting with a bank either side)
//       level    = everything else
//     `rawHill` keeps the pure height test (a far band below the road on exactly
//     one side, visible or not).
//   * forward sight: rays over a 30 deg sector (+-15 deg about the road tangent)
//     from a chase-camera eye.  `deep` = the share of rays that see terrain more
//     than 1 km away; `farVis` = the share of 1-3 km samples that are visible.
//     A station "has a vista" when farVis >= --vista.  Terrain includes the
//     shader-only far-ridge lift so this matches what is drawn (trees excluded).
//
//   node gauntlet/landform-audit.mjs [--seeds 7,12,21] [--root /path/to/repo]
//        [--shots] [--json out.json] [--set ROAD.openWeight=2 --set TERRAIN.midAmp=12]
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: {
  seeds: { type: 'string', default: '7,12,21' },
  root: { type: 'string', default: new URL('..', import.meta.url).pathname },
  step: { type: 'string', default: '100' },
  side: { type: 'string', default: '6' },
  vista: { type: 'string', default: '0.2' },
  eye: { type: 'string', default: '2.6' },
  shots: { type: 'boolean', default: false },
  json: { type: 'string' },
  quiet: { type: 'boolean', default: false },
  set: { type: 'string', multiple: true, default: [] },
} });

const root = pathToFileURL(args.root.endsWith('/') ? args.root : args.root + '/').href;
const src = new URL('src/', root).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(new URL(url), 'utf8'), shortCircuit: true } : next(url, context);
} });
const { World } = await import(new URL('world/world.js', src).href);
// the vertex-shader far-ridge lift (exact JS mirror, locked by foliage-field.test)
const { foliageRidgeOffset: lift } = await import(new URL('vegetation/forestField.js', src).href);
// experiment overrides: tunables are read at build time, so patching the live objects is enough
const tables = { ROAD: (await import(new URL('road/params.js', src).href)).ROAD,
  TERRAIN: (await import(new URL('terrain/params.js', src).href)).TERRAIN };
for (const kv of args.set) {
  const [, table, key, value] = /^(\w+)\.(\w+)=(.*)$/.exec(kv);
  if (!(key in tables[table])) throw new Error(`unknown ${table}.${key}`);
  tables[table][key] = Number(value);
}

const SIDE = Number(args.side), VISTA = Number(args.vista), EYE = Number(args.eye), STEP = Number(args.step);
const LATS = Array.from({ length: 15 }, (_, i) => 20 + i * 20);
const RAYS = [-15, -10, -5, 0, 5, 10, 15].map(d => d * Math.PI / 180);

export function station(world, s) {
  const rt = world.route, p = rt.at(s, {});
  const nx = -p.tz, nz = p.tx;
  const sides = [-1, 1].map((sg) => {
    const ox = nx * sg, oz = nz * sg;
    const prof = LATS.map(d => world.ground(p.x + ox * d, p.z + oz * d) - p.y);
    const far = prof.slice(4).reduce((a, b) => a + b, 0) / (prof.length - 4);
    const mean = prof.reduce((a, b) => a + b, 0) / prof.length;
    let maxTan = -Infinity, seen = 0, across = 0, acrossN = 0;
    prof.forEach((h, k) => {
      const tan = (h - EYE) / LATS[k];
      if (tan >= maxTan) { maxTan = tan; if (k >= 4) seen++; }
    });
    for (let d = 350; d <= 1500; d += 50) {
      const x = p.x + ox * d, z = p.z + oz * d;
      const g = world.ground(x, z), tan = (g + lift(x, z, p.x, p.z, g, p.y + EYE) - p.y - EYE) / d;
      if (tan >= maxTan) { maxTan = tan; if (d >= 400) across++; }
      if (d >= 400) acrossN++;
    }
    const open = seen / (prof.length - 4);
    const inView = open >= 0.5 || across / acrossN >= 0.25;
    const cls = far < -SIDE ? (inView ? 'fall' : 'rim') : mean > SIDE / 2 ? 'rise' : 'level';
    return { far, open, across: across / acrossN, cls };
  });
  const falls = sides.filter(q => q.cls === 'fall').length;
  const shut = sides.filter(q => q.cls === 'rise' || q.cls === 'rim').length;
  const type = falls === 1 ? 'hillside' : falls === 2 ? 'crest' : shut === 2 ? 'corridor' : 'level';
  const rawHill = sides.filter(q => q.far < -SIDE).length === 1;

  const eyeY = p.y + EYE, h0 = Math.atan2(p.tz, p.tx);
  let deep = 0, farSeen = 0, farAll = 0, maxReach = 0;
  for (const off of RAYS) {
    const cx = Math.cos(h0 + off), cz = Math.sin(h0 + off);
    let maxTan = -Infinity, reach = 0;
    for (let d = 25; d <= 3000; d += Math.max(12, d * 0.025)) {
      const x = p.x + cx * d, z = p.z + cz * d;
      const g = world.ground(x, z), tan = (g + lift(x, z, p.x, p.z, g, eyeY) - eyeY) / d;
      const vis = tan >= maxTan;
      if (vis) { maxTan = tan; reach = d; }
      if (d >= 1000) { farAll++; if (vis) farSeen++; }
    }
    if (reach > 1000) deep++;
    maxReach = Math.max(maxReach, reach);
  }
  const farVis = farSeen / farAll;
  return { km: rt.sToKm(s), type, rawHill, sides: sides.map(q => +q.far.toFixed(1)), open: sides.map(q => +q.open.toFixed(2)),
    cls: sides.map(q => q.cls), bridge: p.bridge > 0.01, deep: deep / RAYS.length, farVis, vista: farVis >= VISTA, reach: maxReach };
}

export function auditSeed(seed) {
  const t0 = performance.now();
  const world = new World(seed).build();
  const buildMs = performance.now() - t0;
  const rt = world.route, stations = [];
  for (let s = rt.kmZero; s < rt.length - 1; s += STEP) stations.push(station(world, s));
  const n = stations.length, frac = f => stations.filter(f).length / n;
  return { seed, world, buildMs, stations, summary: {
    n, routeKm: +rt.maxKm.toFixed(2), bridges: rt.bridges.length,
    corridor: frac(q => q.type === 'corridor'), hillside: frac(q => q.type === 'hillside'),
    crest: frac(q => q.type === 'crest'), level: frac(q => q.type === 'level'),
    vista: frac(q => q.vista), hillOrVista: frac(q => q.type === 'hillside' || q.type === 'crest' || q.vista),
    rawHill: frac(q => q.rawHill),
    deep: stations.reduce((a, q) => a + q.deep, 0) / n, farVis: stations.reduce((a, q) => a + q.farVis, 0) / n,
    ...gradeStats(rt),
    minRadius: 1 / Math.max(...rt.CURV.map(Math.abs)),
    ...earthworks(world),
    selfApproach: selfApproach(rt),
  } };
}

function gradeStats(rt) {
  let mi = 0;
  const abs = Array.from(rt.GRADE, Math.abs);
  for (let i = 0; i < abs.length; i++) if (abs[i] > abs[mi]) mi = i;
  const sorted = [...abs].sort((a, b) => a - b);
  return { maxGrade: abs[mi], maxGradeKm: +rt.sToKm(mi * rt.ds).toFixed(2), p99Grade: sorted[Math.floor(sorted.length * 0.99)] };
}

/** Road height minus natural (river-carved) ground along the centreline, off bridges. */
function earthworks(world) {
  const rt = world.route, d = [];
  for (let i = 0; i < rt.n; i += 2) if (rt.BR[i] <= 0.01) d.push(rt.Y[i] - world.hf.ground(rt.X[i], rt.Z[i]));
  const sorted = [...d].sort((a, b) => a - b), q = p => +sorted[Math.floor(p * (sorted.length - 1))].toFixed(1);
  return { cutFill: [+sorted[0].toFixed(1), +sorted.at(-1).toFixed(1)], cutP1: q(0.01), fillP99: q(0.99),
    bigEarthworks: d.filter(v => v < -10 || v > 15).length / d.length };
}

/** Share of the route passing within 170 m of another part of itself (>400 m away along it). */
function selfApproach(rt) {
  const cs = 170, grid = new Map(), key = (x, z) => `${Math.floor(x / cs)},${Math.floor(z / cs)}`;
  for (let j = 0; j < rt.n; j += 2) { const k = key(rt.X[j], rt.Z[j]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(j); }
  let close = 0, n = 0;
  for (let i = 0; i < rt.n; i += 10) {
    n++;
    const cx = Math.floor(rt.X[i] / cs), cz = Math.floor(rt.Z[i] / cs);
    search: for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      for (const j of grid.get(`${cx + dx},${cz + dz}`) || []) {
        if (Math.abs(i - j) * rt.ds > 400 && Math.hypot(rt.X[i] - rt.X[j], rt.Z[i] - rt.Z[j]) < cs) { close++; break search; }
      }
    }
  }
  return close / n;
}

const pct = v => (v * 100).toFixed(1).padStart(5) + '%';
const results = args.seeds.split(',').map(Number).map(auditSeed);
const out = { root: args.root, params: { side: SIDE, vista: VISTA, eye: EYE, step: STEP }, seeds: [] };
const KEYS = ['corridor', 'hillside', 'crest', 'level', 'vista', 'hillOrVista', 'rawHill', 'deep', 'farVis'];
const row = (label, m) => `${label} ${pct(m.corridor)} ${pct(m.hillside)} ${pct(m.crest)} ${pct(m.level)} ${pct(m.vista)} ${pct(m.hillOrVista)}   ${pct(m.rawHill)}  ${m.deep.toFixed(2)}  ${m.farVis.toFixed(3)}`;
if (!args.quiet) console.log('seed  n    corridor hillside crest  level  vista hill|crest|vista rawHill deep  farVis | bridges maxGrade p99   minR  cut p1/fill p99 big   self<170m buildMs');
const agg = {};
for (const r of results) {
  const m = r.summary;
  for (const k of [...KEYS, 'selfApproach', 'bigEarthworks']) agg[k] = (agg[k] || 0) + m[k] / results.length;
  if (!args.quiet) console.log(`${row(`${String(r.seed).padEnd(5)} ${String(m.n).padEnd(4)}`, m)} | ${String(m.bridges).padEnd(7)} ${(m.maxGrade * 100).toFixed(1)}%    ${(m.p99Grade * 100).toFixed(1)}%  ${m.minRadius.toFixed(0).padEnd(5)} ${`${m.cutP1}/${m.fillP99}`.padEnd(14)} ${pct(m.bigEarthworks)} ${pct(m.selfApproach)}    ${r.buildMs.toFixed(0)}`);
  out.seeds.push({ seed: r.seed, buildMs: r.buildMs, summary: m, stations: r.stations });
}
if (!args.quiet) console.log(`${row('mean      ', agg)} |${' '.repeat(42)}${pct(agg.bigEarthworks)} ${pct(agg.selfApproach)}`);
out.mean = agg;

if (args.shots) {
  const shots = JSON.parse(readFileSync(new URL('gauntlet/shots.json', root), 'utf8')).shots;
  const worlds = new Map(results.map(r => [r.seed, r.world]));
  out.shots = [];
  console.log('\nshot                 seed  km      type      L/R far(m)  L/R class    farVis  bridge±0.2km  water±0.25km  findWater  findBridge  findVista');
  for (const [id, shot] of Object.entries(shots)) {
    const q = new URLSearchParams(shot.params), seed = Number(q.get('seed')), km = Number(q.get('km'));
    if (!worlds.has(seed)) worlds.set(seed, new World(seed).build());
    const world = worlds.get(seed), rt = world.route;
    const st = station(world, rt.kmToS(km));
    const bridge = rt.bridges.find(b => Math.abs(b.km - km) < 0.2);
    const wKm = world.findWaterKm(Math.max(0, km - 0.3));
    const water = wKm !== null && Math.abs(wKm - km) < 0.25;
    const row = { id, seed, km, type: st.type, sides: st.sides, cls: st.cls, farVis: +st.farVis.toFixed(3),
      bridge: bridge ? { km: +bridge.km.toFixed(3), nSpans: bridge.nSpans, W: +bridge.W.toFixed(1) } : null, water,
      findWaterKm: world.findWaterKm(0), findBridgeKm: world.findBridgeKm(0), findVistaKm: world.findVistaKm(0) };
    out.shots.push(row);
    const f = v => v === null ? 'null' : v.toFixed(2);
    console.log(`${id.padEnd(20)} ${String(seed).padEnd(5)} ${String(km).padEnd(7)} ${st.type.padEnd(9)} ${st.sides.map(v => v.toFixed(0).padStart(5)).join(' ')}  ${st.cls.join('/').padEnd(12)} ${st.farVis.toFixed(2)}    ${bridge ? `${bridge.km.toFixed(2)} (${bridge.nSpans}sp)` : '-'.padEnd(10)}    ${water ? 'yes' : 'no '}           ${f(row.findWaterKm)}      ${f(row.findBridgeKm)}       ${f(row.findVistaKm)}`);
  }
}
if (args.json) writeFileSync(args.json, JSON.stringify(out, (k, v) => k === 'world' ? undefined : v));
