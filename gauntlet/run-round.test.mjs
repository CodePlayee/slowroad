#!/usr/bin/env node
// Read-only CLI/lifecycle smoke test. It never starts Chromium.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCommand } from './run-round.mjs';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-round.mjs');
const dry = spawnSync(process.execPath, [file, '--dry-run', '--shots', 'cockpit_noon,vista_wide', '--perf-ms', '250', '--skip-rig', '--port', '9431'], { encoding: 'utf8' });
assert.equal(dry.status, 0, dry.stderr);
const plan = JSON.parse(dry.stdout);
assert.equal(plan.dryRun, true);
assert.deepEqual(plan.shots, ['cockpit_noon', 'vista_wide']);
assert.equal(plan.perfMs, 250);
assert.equal(plan.skipRig, true);
assert.equal(plan.port, 9431);
const profiling = spawnSync(process.execPath, [file, '--dry-run', '--profile', '--startup', '--ground-contact', '--terrain-material-probe', '--drive-ms', '120000', '--culling-reference', 'reference.js'], {
  encoding: 'utf8', env: { ...process.env, GAUNTLET_URL: 'http://localhost:5189' },
});
assert.equal(profiling.status, 0, profiling.stderr);
assert.equal(JSON.parse(profiling.stdout).profileFrames, true);
assert.equal(JSON.parse(profiling.stdout).startup, true);
assert.equal(JSON.parse(profiling.stdout).driveMs, 120000);
assert.equal(JSON.parse(profiling.stdout).groundContact, true);
assert.equal(JSON.parse(profiling.stdout).terrainMaterialProbe, true);
assert.equal(JSON.parse(profiling.stdout).cullingReference, 'reference.js');
assert.equal(JSON.parse(profiling.stdout).url, 'http://localhost:5189');
const ablation = spawnSync(process.execPath, [file, '--dry-run', '--profile-ablation'], { encoding: 'utf8' });
assert.equal(ablation.status, 0, ablation.stderr);
assert.equal(JSON.parse(ablation.stdout).profileFrames, true);
assert.equal(JSON.parse(ablation.stdout).profileAblation, true);
assert.equal(JSON.parse(profiling.stdout).profileAblation, false);
const lod = spawnSync(process.execPath, [file, '--dry-run', '--shots', 'route_26km', '--tree-lod-bands', '140:230,160:260',
  '--tree-lod-drive-ms', '12000', '--skip-rig'], { encoding: 'utf8' });
assert.equal(lod.status, 0, lod.stderr);
assert.equal(JSON.parse(lod.stdout).treeLodTrial, true);
assert.equal(JSON.parse(lod.stdout).treeLodBands, '140:230,160:260');
assert.equal(JSON.parse(lod.stdout).treeLodDriveMs, 12000);
assert.match(JSON.parse(lod.stdout).treeLodQuery, /km=26/);
const badLod = spawnSync(process.execPath, [file, '--dry-run', '--tree-lod-bands', '90:160'], { encoding: 'utf8' });
assert.equal(badLod.status, 2);

const bad = spawnSync(process.execPath, [file, '--dry-run', '--shots', 'not-a-shot'], { encoding: 'utf8' });
assert.equal(bad.status, 2);
console.log('run-round CLI smoke test passed (no browser started)');

test('grass A/B uses the existing isolated browser lifecycle', () => {
  const run = spawnSync(process.execPath, [file, '--dry-run', '--grass-trial', '--skip-rig'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).grassTrial, true);
});

test('performance audit uses the same isolated lifecycle without altering runtime defaults', () => {
  const run = spawnSync(process.execPath, [file, '--dry-run', '--performance-audit', '--skip-rig'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).performanceAudit, true);
});

test('quality validation retains isolated browser ownership', () => {
  const run = spawnSync(process.execPath, [file, '--dry-run', '--quality-check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).qualityCheck, true);
});

test('tree LOD reruns reject an existing report before writing the round or starting a browser', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'slowroad-round-immutable-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, 'tree-lod-trial.json'), '{"status":"failed"}\n');
  writeFileSync(path.join(directory, 'round.json'), '{"status":"failed","historical":true}\n');
  const result = spawnSync(process.execPath, [file, '--out', directory, '--tree-lod-trial', '--skip-rig', '--port', '9431'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /fresh --out/);
  assert.equal(readFileSync(path.join(directory, 'round.json'), 'utf8'), '{"status":"failed","historical":true}\n');
  assert.equal(existsSync(path.join(directory, 'logs')), false);
});

test('failed subprocess is reported', async () => {
  const result = await runCommand(['-e', 'process.exit(7)']);
  assert.equal(result.code, 7);
  assert.equal(result.timedOut, false);
});

test('a subprocess ignoring SIGTERM is killed after its timeout', async () => {
  const result = await runCommand(['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeoutMs: 250 });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.notEqual(result.code, 0);
});
