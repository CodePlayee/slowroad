// Structural and material contract for river crossings, following refs/bridges/CHECKS.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  return url.startsWith(src) && url.endsWith('.js')
    ? { format: 'module', source: readFileSync(new URL(url), 'utf8'), shortCircuit: true } : next(url, context);
} });
const THREE = await import('three');
const { World, crossSection } = await import('../src/world/world.js');
const { ROAD } = await import('../src/road/params.js');
const { BRIDGE } = await import('../src/bridge/params.js');
const {
  BridgeSystem, buildBridgeGeometry, deckDepthFor, CLEAR_HALF, RAIL_LAT,
  CONCRETE_VERT_BODY, CONCRETE_FRAG_BODY,
} = await import('../src/bridge/bridge.js');

const L = ROAD.laneWidth;
const worlds = new Map([7, 12, 31].map(seed => [seed, new World(seed).build()]));
const all = [...worlds].flatMap(([seed, world]) => world.route.bridges.map(b => ({ seed, world, b, g: buildBridgeGeometry(world, b) })));
// Select by the structural property under test, not a route-design kilometre.
const showcase = all.find(({ b }) => b.nSpans === 3);

test('fixtures contain bridges, including the 3-span showcase crossing', () => {
  assert.ok([...worlds.values()].every(world => world.route.bridges.length > 0));
  assert.ok(showcase, 'generated routes must exercise a three-span bridge');
  assert.equal(showcase.b.nSpans, 3);
  assert.equal(showcase.g.info.piers.length, 2);
});

test('deck follows the road axis and grade exactly, never forced level (CHECKS 1-2)', () => {
  for (const { world, b, g } of all) {
    const rt = world.route, X = g.info.sections;
    assert.equal(X[0].s, b.s0);
    assert.ok(Math.abs(X[X.length - 1].s - b.s1) < 1e-6);
    for (const c of X) {
      const p = rt.at(c.s, {});
      assert.ok(Math.abs(c.deckTop - (p.y + crossSection(CLEAR_HALF) + ROAD.surfaceLift)) < 1e-9, 'no step between deck and road');
      assert.ok(Math.abs(c.nx + p.tz) < 1e-9 && Math.abs(c.nz - p.tx) < 1e-9, 'deck normal is the road normal');
    }
    // the deck carries the road's own grade into both approaches: same slope on the
    // first/last section interval as the road ribbon on that interval
    const grade = (s0, s1) => (rt.at(s1, {}).y - rt.at(s0, {}).y) / (s1 - s0);
    for (const [i, j] of [[0, 1], [X.length - 2, X.length - 1]]) {
      assert.ok(Math.abs((X[j].deckTop - X[i].deckTop) / (X[j].s - X[i].s) - grade(X[i].s, X[j].s)) < 1e-9);
    }
  }
});

test('every pier goes into the ground under its whole battered footprint and carries the soffit (CHECKS 4)', () => {
  let piers = 0;
  for (const { world, b, g } of all) {
    const [OX, OY, OZ] = g.info.origin;
    const P = g.concrete.p, Rf = g.concrete.r;
    for (const pier of g.info.piers) {
      piers++;
      const soffit = world.route.at(pier.s, {}).y + crossSection(CLEAR_HALF) + ROAD.surfaceLift - BRIDGE.deckTopInset - g.info.depth;
      assert.ok(Math.abs(pier.top - soffit) < 1e-9, 'cap meets the soffit');
      assert.ok(pier.bot <= pier.groundMin - BRIDGE.pierEmbed + 1e-9);
      const hx = BRIDGE.pierThk * BRIDGE.pierLenRatio / 2, hz = BRIDGE.pierThk / 2;
      const reach = Math.hypot(hx + hz * BRIDGE.pierNose + pier.grow, hz + pier.grow) + 0.1;
      let base = 0;
      for (let v = 0; v < P.length / 3; v++) {
        const y = P[v * 3 + 1] + OY;
        if (Math.abs(y - pier.bot) > 1e-4) continue;
        const x = P[v * 3] + OX, z = P[v * 3 + 2] + OZ;
        if (Math.hypot(x - pier.x, z - pier.z) > reach) continue;
        base++;
        assert.ok(world.ground(x, z) - y > 1.0, 'pier base corner buried');
        assert.ok(Math.abs(Rf[v * 3] + OY - pier.top) < 1e-6, 'pier shades from its own soffit');
        assert.ok(Math.abs(Rf[v * 3 + 1] + OY - pier.groundMax) < 1e-6, 'pier knows where the ground is');
      }
      assert.equal(base, 12, 'six battered faces reach the base');
      const batter = pier.grow / (pier.shaftTop - pier.bot);
      assert.ok(batter >= 1 / 20 && batter <= 1 / 12, 'batter 1:20-1:12');
    }
  }
  assert.ok(piers >= 8);
});

test('open steel rail is 0.29-0.40 L tall, thin and see-through (CHECKS 6-7)', () => {
  assert.ok(BRIDGE.kerbThk <= 0.2 * L);
  const approach = ROAD.laneWidth * ROAD.lanes + 2 * ROAD.shoulderWidth;
  assert.ok(2 * CLEAR_HALF / approach >= 0.85 && 2 * CLEAR_HALF / approach <= 1, 'bridge is the pinch point of the road');
  for (const member of [BRIDGE.railPost, BRIDGE.railTopH, BRIDGE.railTopW, BRIDGE.railMidH]) assert.ok(member >= 0.05 && member <= 0.12);
  const open = 1 - (BRIDGE.railTopH + BRIDGE.railMidH) / (BRIDGE.railH - BRIDGE.kerbH);
  assert.ok(open > 0.75, `rail band ${Math.round(open * 100)}% open`);
  for (const { b, g } of all) {
    const posts = g.info.posts.filter(p => p.side === 1).map(p => p.s);
    assert.ok(posts.length >= 1 || b.L < 2 * BRIDGE.endBlockLen + 2 * BRIDGE.railPostGap);
    for (let i = 1; i < posts.length; i++) assert.ok(posts[i] - posts[i - 1] >= 1.8 && posts[i] - posts[i - 1] <= 2.5);
    for (const p of g.info.posts) assert.ok(p.top >= 0.29 * L && p.top <= 0.40 * L);
  }
});

test('fascia depth reads as span/14-span/20, 0.55-1.6x the railing (CHECKS 8)', () => {
  for (const { b, g } of all) {
    const d = BRIDGE.deckTopInset + g.info.depth;
    assert.equal(g.info.depth, deckDepthFor(b));
    assert.ok(d / BRIDGE.railH >= 0.55 - 1e-9 && d / BRIDGE.railH <= 1.6 + 1e-9, `d ${d.toFixed(2)} / rail`);
    if (b.span / 20 <= 1.6 * BRIDGE.railH && b.span / 14 >= 0.55 * BRIDGE.railH) {
      assert.ok(b.span / d >= 14 - 1e-9 && b.span / d <= 20 + 1e-9, `span ${b.span.toFixed(1)} / d ${d.toFixed(2)}`);
    }
    assert.ok(g.info.depth <= b.deckDepth + 0.1, 'water clearance kept within 0.1 m of the route plan');
  }
  assert.ok(Math.abs(showcase.g.info.depth - showcase.b.deckDepth) < 1e-9, 'showcase crossing keeps its span/16 deck');
});

test('approach guardrail bolts into concrete end blocks at both ends (CHECKS 10)', () => {
  for (const { b, g } of all) {
    for (const rail of g.info.guardrails) {
      assert.ok(rail.s === b.s0 || rail.s === b.s1);
      const block = g.info.endBlocks.find(e => e.s === rail.s && e.side === rail.side);
      assert.ok(block, 'end block at the guardrail joint');
      assert.ok(rail.lat - 0.045 >= block.lat0 && rail.lat + 0.045 <= block.lat1, 'beam lands on the block face');
      assert.ok(rail.y + 0.16 < block.top, 'beam below the block top');
    }
    assert.equal(g.info.endBlocks.length, 4);
  }
});

test('bridge materials are lit and fogged by the scene, with deck-relative weathering', () => {
  const registered = [];
  const { world, b } = showcase;
  const system = new BridgeSystem(world, { register: m => { registered.push(m); return m; } }, {});
  system._build('bridge:test', b);
  const group = system.group.children[0];
  assert.equal(group.children.length, 2, 'one concrete + one steel draw call');
  assert.deepEqual(registered, group.children.map(m => m.material), 'both materials join the atmosphere');
  for (const mesh of group.children) {
    assert.ok(mesh.material.isMeshStandardMaterial && mesh.material.fog);
    assert.equal(mesh.material.emissive.getHex(), 0);
  }
  const concrete = group.children[0];
  assert.ok(concrete.geometry.getAttribute('aRef'), 'per-vertex soffit/ground reference');
  const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} };
  concrete.material.onBeforeCompile(shader);
  assert.ok(shader.vertexShader.includes(CONCRETE_VERT_BODY));
  assert.ok(shader.fragmentShader.includes(CONCRETE_FRAG_BODY));
  assert.ok(shader.fragmentShader.indexOf(CONCRETE_FRAG_BODY) > shader.fragmentShader.indexOf('#include <color_fragment>'));
  assert.match(shader.fragmentShader, /surfaceHash\(/, 'precision-safe integer hash');
  assert.doesNotMatch(CONCRETE_FRAG_BODY, /gl_FragColor|outgoingLight|emissive/, 'only albedo is modulated');
  assert.match(CONCRETE_FRAG_BODY, /float below = vRefB\.x - bp\.y;/, 'soffit shadow gradient');
  // under-deck shade removes the blocked sun share via the scene's own light uniforms,
  // so sun-facing and shaded faces under the deck settle to one ambient level
  assert.match(CONCRETE_FRAG_BODY, /#if NUM_DIR_LIGHTS > 0[\s\S]*directionalLights\[ 0 \][\s\S]*#if NUM_HEMI_LIGHTS > 0[\s\S]*hemisphereLights\[ 0 \]/);
  assert.ok(Math.abs(shader.uniforms.uWaterY.value - (b.waterY - showcase.g.info.origin[1])) < 1e-9, 'waterline in mesh-local metres');
  // the deck never shades itself: every deck-edge vertex sits above its soffit reference
  const P = showcase.g.concrete.p, Rf = showcase.g.concrete.r, [, OY] = showcase.g.info.origin;
  const lowestDeck = Math.min(...showcase.g.info.sections.map(c => c.soffitY)) - BRIDGE.fasciaLip;
  let deckVerts = 0, along = 0;
  for (let v = 0; v < P.length / 3; v++) {
    if (P[v * 3 + 1] + OY < lowestDeck - 1e-6 || Rf[v * 3] < -1e3 || Rf[v * 3 + 1] > -1e3) continue;
    assert.ok(P[v * 3 + 1] > Rf[v * 3], 'deck vertex above its soffit reference');
    deckVerts++;
    if (Rf[v * 3 + 2] > -1e3) {
      along++;
      assert.ok(Math.abs(Rf[v * 3 + 2]) <= b.L / 2 + 1e-6, 'deck arclength texture coordinate');
    }
  }
  assert.ok(deckVerts > 500 && along >= deckVerts - 64, 'deck faces (bar the end caps) carry arclength');
});

test('underside reads as slab on girders, lit by bounce rather than baked black', () => {
  const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const concrete = lum(BRIDGE.concrete);
  for (const { world, b, g } of all) {
    const [OX, OY, OZ] = g.info.origin, P = g.concrete.p, Rf = g.concrete.r, Col = g.concrete.c;
    const rib = g.info.ribDepth;
    if (deckDepthFor(b) >= 0.6) assert.ok(rib >= BRIDGE.ribMin, 'girders under every deck deeper than 0.6 m');
    let under = 0;
    for (let v = 0; v < P.length / 3; v++) {
      const s = Rf[v * 3], gr = Rf[v * 3 + 1], y = P[v * 3 + 1];
      // under-structure: carries the deck-relative "along" coordinate and a soffit
      // reference above itself, plus its real ground
      if (Rf[v * 3 + 2] < -1e3 || s < -1e3 || y >= s) continue;
      under++;
      assert.ok(s - y <= rib + 0.02 + 1e-9, 'under-structure stays within the girder depth');
      assert.ok(Math.abs(gr - (world.ground(P[v * 3] + OX, P[v * 3 + 2] + OZ) - OY)) < 1e-9, 'under-structure knows the ground below it');
      assert.ok(lum(Col.slice(v * 3, v * 3 + 3)) >= 0.75 * concrete, 'no baked-black soffit albedo');
    }
    assert.ok(under > 0);
  }
  // showcase: 4 girder bottoms + 3 bays + 6 webs per deck interval
  const n = showcase.g.info.sections.length;
  const P = showcase.g.concrete.p, Rf = showcase.g.concrete.r;
  let underVerts = 0;
  for (let v = 0; v < P.length / 3; v++) if (Rf[v * 3 + 2] > -1e3 && Rf[v * 3] > P[v * 3 + 1]) underVerts++;
  assert.equal(underVerts, (n - 1) * 13 * 4);
});

test('abutments and wingwalls carry a per-vertex ground line for the soil transition', () => {
  for (const { world, g } of all) {
    const [OX, OY, OZ] = g.info.origin, P = g.concrete.p, Rf = g.concrete.r;
    const pierGround = new Set(g.info.piers.map(p => p.groundMax - OY));
    let contact = 0;
    for (let v = 0; v < P.length / 3; v++) {
      const gr = Rf[v * 3 + 1];
      if (gr < -1e3 || pierGround.has(gr)) continue;
      contact++;
      assert.ok(Math.abs(gr - (world.ground(P[v * 3] + OX, P[v * 3 + 2] + OZ) - OY)) < 1e-9);
    }
    assert.ok(contact >= 2 * 3 * 24, 'abutment + two wingwalls at each end');
  }
});

test('bridges stay inside the triangle budget', () => {
  for (const { g } of all) assert.ok((g.concrete.i.length + g.steel.i.length) / 3 < 9000);
});
