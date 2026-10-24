#!/usr/bin/env node
// Root-only diagnostic. Connect to the private browser owned by run-round;
// never launch a browser, change production defaults, or reuse a user profile.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { profileScene } from './profile-frame.mjs';
import { parseTreeLodBands, comparePopulationFingerprints, compareTreeSelections, treeSubmissionTotals } from './tree-lod-trial-helper.mjs';

export function parseTreeLodTrialArgs(argv) {
  const { values } = parseArgs({ args: argv, options: {
    port: { type: 'string' }, out: { type: 'string', default: '/tmp/slowroad-tree-lod-trial' },
    query: { type: 'string', default: 'seed=7&t=12&season=summer&weather=clear&cam=chase&km=6' },
    url: { type: 'string', default: process.env.GAUNTLET_URL || 'http://localhost:5188' },
    bands: { type: 'string', default: '160:260' }, 'drive-ms': { type: 'string', default: '6000' },
    'sample-frames': { type: 'string', default: '90' }, 'dry-run': { type: 'boolean', default: false },
  } });
  const port = Number(values.port), driveMs = Number(values['drive-ms']), sampleFrames = Number(values['sample-frames']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('An explicit private --port is required');
  if (!Number.isInteger(driveMs) || driveMs < 1000 || driveMs > 30000) throw new RangeError('--drive-ms must be between 1000 and 30000');
  if (!Number.isInteger(sampleFrames) || sampleFrames < 15 || sampleFrames > 600) throw new RangeError('--sample-frames must be between 15 and 600');
  const bands = parseTreeLodBands(values.bands);
  if (bands.some(band => band.low <= 110 || band.high <= 200)) throw new RangeError('Candidates must switch earlier than the original 110:200 band');
  const query = new URLSearchParams(values.query);
  query.set('paused', '1'); query.set('dpr', '1');
  return { port, out: path.resolve(values.out), query: query.toString(), url: values.url, bands, driveMs, sampleFrames,
    dryRun: values['dry-run'], viewport: { width: 1920, height: 1080 } };
}

async function resetAndSnapshot({ band, restore = false }) {
  const state = globalThis.__treeLodTrialDiagnostic, app = globalThis.__app, rig = globalThis.__rig;
  rig.pause();
  if (restore) state.controller.restore(); else state.controller.apply(band);
  rig.snap(); await rig.ready({ timeoutMs: 150000 }); rig.hideUI();
  // New streamed meshes must receive the same CPU padding and selection invalidation.
  if (restore) state.controller.restore(); else state.controller.apply(band);
  await app.nextFrame(); await app.nextFrame();
  const camera = app.cameras.camera;
  const wanted = [...app.veg._streamWant].sort(), resident = [...app.veg.tiles.keys()].sort();
  const wantedSet = new Set(wanted), residentSet = new Set(resident);
  const cpuProbe = state.controller.probe(state.probeBands), treeSelection = state.captureTreeSelection(app);
  return { population: state.populationFingerprint(app.veg.tiles), cpuProbe, treeSelection,
    identity: { ...state.identity, directRangeMatchesLive: state.controller.isLiveRange(state.directRange),
      directRange: { ...state.directRange }, bindingSource: 'material.userData' },
    pose: { seed: app.world.seedInput, s: app.vehicle.s, speed: app.vehicle.speed, position: app.vehicle.pos.toArray(),
      camera: camera.matrixWorld.elements.slice(), projection: camera.projectionMatrix.elements.slice(),
      cam: app.cameras.mode, t: app.atmo.time, season: app.atmo.seasonName, weather: app.atmo.weatherName,
      viewport: [innerWidth, innerHeight], canvas: [app.renderer.domElement.width, app.renderer.domElement.height] },
    streaming: { frame: app.frameNo, vegetationVersion: app.veg.version, vegetationSignature: app.veg._signature,
      vegetationFocus: [app.veg.focusX, app.veg.focusZ], required: app.veg.required, resident: app.veg.resident,
      cached: app.veg.cache.size, workerPending: app.veg.pool.pending, wanted,
      missingResidents: wanted.filter(key => !residentSet.has(key)), extraResidents: resident.filter(key => !wantedSet.has(key)),
      unsupportedTiles: [...app.veg.tiles].filter(([, entry]) => !entry.groundReady).map(([key]) => key).sort(),
      terrainAnchor: app.terrain._anchor, terrainPrefetchSeconds: app.terrain.prefetchSeconds,
      terrainRequired: app.terrain.required, terrainResident: app.terrain.resident, terrainSettled: app.terrain.settled },
    lod: state.controller.describe() };
}

export function recordTreeLodSnapshot(report, stage, snapshot, reference, directory) {
  const population = comparePopulationFingerprints(reference.population, snapshot.population);
  const treeSelection = compareTreeSelections(reference.treeSelection, snapshot.treeSelection);
  const changedPoseFields = Object.keys(snapshot.pose).filter(key => JSON.stringify(snapshot.pose[key]) !== JSON.stringify(reference.pose[key]));
  const changedStreamingFields = Object.keys(snapshot.streaming || {}).filter(key =>
    JSON.stringify(snapshot.streaming[key]) !== JSON.stringify(reference.streaming?.[key]));
  const invariants = { population: population.equal, pose: changedPoseFields.length === 0,
    cpuPredicate: snapshot.cpuProbe?.ok === true,
    treeSelection: snapshot.treeSelection?.ok === true && (stage.name.startsWith('trial-') ? treeSelection.changed : !treeSelection.changed),
    cpuGpuLod: snapshot.lod.range.low === stage.band.low && snapshot.lod.range.high === stage.band.high &&
      snapshot.lod.uniforms.length > 0 && snapshot.lod.uniforms.every(values => values[0] === stage.band.low && values[1] === stage.band.high &&
      values[2] === snapshot.lod.range.fadeStart && values[3] === snapshot.lod.range.fadeEnd) };
  const comparable = Object.values(invariants).every(Boolean);
  const snapshotPath = path.join(directory, `tree-lod-${stage.name}.snapshot.json`);
  const row = { name: stage.name, band: stage.band, snapshotPath, status: comparable ? 'ready' : 'incomparable',
    invariants, comparison: { population, treeSelection, changedPoseFields, changedStreamingFields }, snapshot };
  report.stages.push(row);
  if (!comparable) {
    report.status = 'failed';
    report.error = `${stage.name} is not comparable: ${JSON.stringify(invariants)}; population=${population.classification}`;
  }
  // Persist rejected candidates before throwing, including the evidence for the mismatch.
  fs.writeFileSync(snapshotPath, JSON.stringify({ schema: 'gauntlet.tree-lod-snapshot.v3', ...row }, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'tree-lod-trial.json'), JSON.stringify(report, null, 2) + '\n');
  if (!comparable) throw new Error(report.error);
  return row;
}

export async function runTreeLodTrial(options) {
  if (options.dryRun) { console.log(JSON.stringify({ rootOnly: true, dryRun: true, ...options }, null, 2)); return; }
  fs.mkdirSync(options.out, { recursive: true });
  const reportPath = path.join(options.out, 'tree-lod-trial.json');
  if (fs.existsSync(reportPath)) throw new Error('Tree LOD reports are immutable; choose a fresh --out directory');
  const report = { schema: 'gauntlet.tree-lod-trial.v3', rootOnly: true, startedAt: new Date().toISOString(),
    experimentContract: 'live-bindings/predicate/selection/submission-v3',
    query: options.query, viewport: options.viewport, driveMs: options.driveMs, sampleFrames: options.sampleFrames,
    candidates: options.bands, stages: [], errors: [], status: 'running' };
  const write = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  write();
  let browser, context, page, failure;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${options.port}`, { timeout: 20000 });
    context = await browser.newContext({ viewport: options.viewport });
    context.setDefaultTimeout(20000);
    await context.route('**/favicon.ico', route => route.fulfill({ status: 204, body: '' }));
    page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
    await page.goto(`${options.url.replace(/\/$/, '')}/?${options.query}`, { timeout: 20000, waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!globalThis.__rig, null, { timeout: 20000 });
    report.identity = await page.evaluate(async ({ bands }) => {
      __rig.pause(); __rig.snap(); await __rig.ready({ timeoutMs: 150000 }); __rig.hideUI();
      const { createTreeLodTrial, populationFingerprint, captureTreeSelection } = await import('/gauntlet/tree-lod-trial-helper.mjs');
      const { FOREST_LOD } = await import('/src/vegetation/forestField.js');
      const { TERRAIN } = await import('/src/terrain/params.js');
      if (globalThis.__treeLodTrialDiagnostic) throw new Error('A tree LOD trial is already active');
      if (__app.veg.generation !== 2) throw new Error('Tree LOD trial requires generation-2 vegetation');
      const controller = createTreeLodTrial({ forest: __app.veg.forest, renderer: __app.renderer, terrain: TERRAIN });
      if (controller.original.low !== 110 || controller.original.high !== 200) throw new Error('Live tree LOD is not the unchanged 110:200 baseline');
      const identity = { directSpecifier: '/src/vegetation/forestField.js', directRangeMatchesLive: controller.isLiveRange(FOREST_LOD.tree),
        observedModuleUrls: [...new Set(performance.getEntriesByType('resource').map(entry => entry.name)
          .filter(name => name.includes('/src/vegetation/forestField.js')))] };
      globalThis.__treeLodTrialDiagnostic = {
        controller, populationFingerprint, captureTreeSelection, directRange: FOREST_LOD.tree, identity,
        probeBands: [controller.original, ...bands],
      };
      return identity;
    }, { bands: options.bands });
    write();
    const sequence = [{ name: 'baseline', band: { low: 110, high: 200 } },
      ...options.bands.map(band => ({ name: `trial-${band.low}-${band.high}`, band })),
      { name: 'baseline-repeat', band: { low: 110, high: 200 }, restore: true }];
    let reference;
    for (const stage of sequence) {
      const snapshot = await page.evaluate(resetAndSnapshot, stage);
      reference ||= snapshot;
      const row = recordTreeLodSnapshot(report, stage, snapshot, reference, options.out);
      const screenshot = path.join(options.out, `tree-lod-${stage.name}.png`);
      await page.screenshot({ path: screenshot, timeout: 20000 });
      row.screenshot = screenshot; write();
      row.profile = await page.evaluate(profileScene, { ablation: false, warmupFrames: 20,
        sampleFrames: options.sampleFrames, drivingMs: options.driveMs, queryDrainFrames: 20 });
      row.treeSubmissions = treeSubmissionTotals(row.profile);
      const baselineSubmissions = report.stages[0].treeSubmissions;
      row.treeSubmissionDelta = { triangles: row.treeSubmissions.triangles - baselineSubmissions.triangles,
        calls: row.treeSubmissions.calls - baselineSubmissions.calls,
        byPart: Object.fromEntries(['bark', 'leaf', 'impostor'].map(part => [part, {
          triangles: row.treeSubmissions.byPart[part].triangles - baselineSubmissions.byPart[part].triangles,
          calls: row.treeSubmissions.byPart[part].calls - baselineSubmissions.byPart[part].calls,
        }])) };
      const submittedChange = Object.values(row.treeSubmissionDelta.byPart).some(part => part.triangles !== 0 || part.calls !== 0);
      row.invariants.actualTreeSubmission = row.treeSubmissions.triangles > 0 &&
        (stage.name.startsWith('trial-') ? submittedChange : !submittedChange);
      if (!row.invariants.actualTreeSubmission) {
        row.status = 'ineffective'; write();
        throw new Error(`${stage.name} did not satisfy the actual tree submission comparison`);
      }
      row.status = 'profiled';
      write();
      console.log(stage.name, JSON.stringify({ band: stage.band, invariants: row.invariants,
        populationComparison: row.comparison.population.classification, stages: row.profile.stages }));
    }
    if (report.errors.length) throw new Error('Browser errors during tree LOD trial');
    report.status = 'passed';
  } catch (error) {
    failure = error; report.status = 'failed'; report.error = String(error.message || error);
  } finally {
    try {
      if (page && !page.isClosed()) report.restoration = await page.evaluate(() => {
        const state = globalThis.__treeLodTrialDiagnostic;
        if (!state) return { skipped: true };
        try {
          __rig.pause();
          const restored = state.controller.restore();
          const cpuProbe = state.controller.probe(state.probeBands);
          const expected = ['low', 'high', 'fadeStart', 'fadeEnd'].map(key => state.controller.original[key]);
          if (!['low', 'high', 'fadeStart', 'fadeEnd'].every((key, i) => restored.range[key] === expected[i]) ||
            !restored.uniforms.every(values => values.every((value, i) => value === expected[i])) || !cpuProbe.ok) throw new Error('Tree LOD restoration failed');
          return { restored: true, ...restored, cpuProbe, directRangeMatchesLive: state.controller.isLiveRange(state.directRange) };
        } finally { delete globalThis.__treeLodTrialDiagnostic; }
      });
    } catch (error) {
      failure ||= error; report.status = 'failed'; report.restorationError = String(error.message || error);
    } finally {
      try { await context?.close(); report.contextClosed = true; }
      catch (error) { failure ||= error; report.status = 'failed'; report.contextCloseError = String(error.message || error); }
      try { await browser?.close(); report.connectionClosed = true; }
      catch (error) { failure ||= error; report.status = 'failed'; report.connectionCloseError = String(error.message || error); }
      report.endedAt = new Date().toISOString(); write();
    }
  }
  if (failure) throw failure;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runTreeLodTrial(parseTreeLodTrialArgs(process.argv.slice(2))); }
  catch (error) { console.error(`tree-lod-trial: ${error.message}`); process.exitCode = 1; }
}
