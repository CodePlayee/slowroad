#!/usr/bin/env node
// Run one visual/performance round with one private, headless browser profile.
// This is deliberately an orchestrator: shoot/perf/rigcheck stay canonical and
// this file owns their lifetime, logs, signal handling, and cleanup.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseTreeLodBands } from './tree-lod-trial-helper.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_SHOTS = [
  'chase_summer_noon', 'chase_golden', 'chase_night',
  'cockpit_overcast', 'season_winter', 'vista_wide', 'cockpit_noon',
];
const SHOT_ALIASES = {
  summer: 'chase_summer_noon', golden: 'chase_golden', night: 'chase_night',
  cockpit_overcast: 'cockpit_overcast', winter: 'season_winter', vista: 'vista_wide', cockpit_noon: 'cockpit_noon',
};
const SHOTS = JSON.parse(fs.readFileSync(path.join(HERE, 'shots.json'), 'utf8')).shots || {};

function usage() {
  return `usage: node gauntlet/run-round.mjs [options]

  --out DIR          output directory (default: gauntlet/rounds/round-<timestamp>)
  --port N            private CDP port (default: an available port)
  --shots A,B,...     shot ids (default: the seven frozen round shots)
  --perf-ms N         run perf.mjs for chase_summer_noon for N milliseconds
  --profile           run the vegetation CPU/GPU profiler after captures
  --profile-ablation  profile with serial grass/tree/terrain/resolution ablations
  --grass-trial       compare legacy, cell and density LOD grass in one page
  --performance-audit  measure exclusive CPU costs and matched render ablations
  --quality-check    compare locked high quality with adaptive raster/CSS LOD
  --frame-pacing     record uninterrupted driving frame times and CPU stages
  --wheel-check      verify rolling/steering and capture wheel close-ups
  --startup           measure normal-budget loading and teleport readiness
  --drive-ms N        verify sustained roadside coverage without force-draining
  --ground-contact    compare plant roots with the actual settled terrain triangles
  --terrain-material-probe  read actual terrain shader blend weights offscreen
  --tree-lod-trial    same-page 110:200 -> 160:260 -> baseline tree LOD trial
  --tree-lod-bands A:B[,C:D]  up to two earlier-impostor candidates
  --tree-lod-drive-ms N       natural driving per candidate (default: 6000)
  --culling-reference FILE  compare culling pixels with a saved reference module
  --skip-rig          do not run rigcheck.mjs
  --dry-run           print the plan without starting a browser or writing files
  --help              show this help`;
}

function parseArgs(argv) {
  const out = { shots: [], perfMs: null, skipRig: false, dryRun: false, port: null, outDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name) => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${name} requires a value`);
      return v;
    };
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--skip-rig') { out.skipRig = true; continue; }
    if (a === '--profile') { out.profile = true; continue; }
    if (a === '--profile-ablation') { out.profile = true; out.ablation = true; continue; }
    if (a === '--grass-trial') { out.grassTrial = true; continue; }
    if (a === '--performance-audit') { out.performanceAudit = true; continue; }
    if (a === '--quality-check') { out.qualityCheck = true; continue; }
    if (a === '--frame-pacing') { out.framePacing = true; continue; }
    if (a === '--wheel-check') { out.wheelCheck = true; continue; }
    if (a === '--startup') { out.startup = true; continue; }
    if (a === '--ground-contact') { out.groundContact = true; continue; }
    if (a === '--terrain-material-probe') { out.terrainMaterialProbe = true; continue; }
    if (a === '--tree-lod-trial') { out.treeLodTrial = true; continue; }
    if (a === '--tree-lod-bands') { out.treeLodTrial = true; out.treeLodBands = value(a); continue; }
    if (a === '--tree-lod-drive-ms') { out.treeLodTrial = true; out.treeLodDriveMs = Number(value(a)); continue; }
    if (a === '--drive-ms') { out.driveMs = Number(value('--drive-ms')); continue; }
    if (a === '--culling-reference') { out.cullingReference = value('--culling-reference'); continue; }
    if (a === '--out') { out.outDir = value('--out'); continue; }
    if (a === '--port') { out.port = Number(value('--port')); continue; }
    if (a === '--perf-ms') { out.perfMs = Number(value('--perf-ms')); continue; }
    if (a === '--shots') {
      const values = [value('--shots')];
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) values.push(argv[++i]);
      out.shots.push(...values.flatMap((v) => v.split(',').map((s) => s.trim()).filter(Boolean)));
      continue;
    }
    throw new Error(`unknown option: ${a}`);
  }
  if (out.help) return out;
  if (!out.shots.length) out.shots = DEFAULT_SHOTS.slice();
  if (!out.shots.length) throw new Error('at least one shot is required');
  out.shots = out.shots.map((id) => SHOT_ALIASES[id] || id);
  for (const id of out.shots) if (!SHOTS[id]) throw new Error(`unknown shot id "${id}"`);
  if (out.port !== null && (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535)) throw new Error('invalid --port');
  if (out.perfMs !== null && (!Number.isFinite(out.perfMs) || out.perfMs <= 0)) throw new Error('--perf-ms must be a positive number');
  if (out.driveMs !== undefined && (!Number.isFinite(out.driveMs) || out.driveMs < 15000)) throw new Error('--drive-ms must be at least 15000');
  if (out.treeLodTrial) {
    out.treeLodBands ||= '160:260';
    const bands = parseTreeLodBands(out.treeLodBands);
    if (bands.some(band => band.low <= 110 || band.high <= 200)) throw new Error('Tree LOD candidates must switch earlier than 110:200');
    out.treeLodDriveMs ??= 6000;
    if (!Number.isInteger(out.treeLodDriveMs) || out.treeLodDriveMs < 1000 || out.treeLodDriveMs > 30000) {
      throw new Error('--tree-lod-drive-ms must be between 1000 and 30000');
    }
  }
  return out;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const p = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return p;
}

function commandLabel(args) { return [process.execPath, ...args].join(' '); }

function runCommand(args, { stdoutFile, stderrFile, env = process.env, signalState, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    let stdout = '', stderr = '';
    let timedOut = false;
    let hardTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      hardTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2000);
      hardTimer.unref();
    }, timeoutMs);
    timeout.unref();
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('close', (code, sig) => {
      clearTimeout(timeout);
      if (hardTimer) clearTimeout(hardTimer);
      if (stdoutFile) fs.writeFileSync(stdoutFile, stdout);
      if (stderrFile) fs.writeFileSync(stderrFile, stderr);
      if (activeChild === child) activeChild = null;
      resolve({ code: code === null ? 1 : code, signal: sig, stdout, stderr, timedOut, interrupted: Boolean(signalState?.value) });
    });
    child.on('error', (error) => {
      stderr += `${error.name}: ${error.message}\n`;
    });
  });
}

let activeChild = null;
let signalState = { value: null };

function installSignalHandlers() {
  let killTimer = null;
  const onSignal = (sig) => {
    if (!signalState.value) signalState.value = sig;
    const child = activeChild;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2000);
      killTimer.unref();
    }
  };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  return () => { clearTimeout(killTimer); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); };
}

async function main(options) {
  const outDir = path.resolve(ROOT, options.outDir || path.join('gauntlet', 'rounds', `round-${timestamp()}`));
  const profile = `round-${process.pid}-${Date.now().toString(36)}`;
  const port = options.port ?? await freePort();
  const plan = { profile, port, outDir, shots: options.shots, perfMs: options.perfMs, skipRig: options.skipRig,
    profileFrames: Boolean(options.profile), profileAblation: Boolean(options.ablation), grassTrial: Boolean(options.grassTrial), performanceAudit: Boolean(options.performanceAudit), qualityCheck: Boolean(options.qualityCheck), startup: Boolean(options.startup), driveMs: options.driveMs ?? null,
    groundContact: Boolean(options.groundContact), terrainMaterialProbe: Boolean(options.terrainMaterialProbe), cullingReference: options.cullingReference || null,
    treeLodTrial: Boolean(options.treeLodTrial), treeLodBands: options.treeLodBands || null,
    treeLodDriveMs: options.treeLodDriveMs ?? null, treeLodQuery: options.treeLodTrial ? SHOTS[options.shots[0]].params : null,
    url: process.env.GAUNTLET_URL || 'http://localhost:5188', plantVariant: process.env.GAUNTLET_PLANTS || 'default' };
  if (options.dryRun) { console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2)); return 0; }
  if (options.treeLodTrial && fs.existsSync(path.join(outDir, 'tree-lod-trial.json'))) {
    throw new Error('Tree LOD reports are immutable; choose a fresh --out directory');
  }

  fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'logs'), { recursive: true });
  const report = { schema: 'gauntlet.run-round.v1', startedAt: new Date().toISOString(), ...plan, stages: [], pageErrors: [], status: 'running' };
  const reportPath = path.join(outDir, 'round.json');
  const writeReport = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  writeReport();

  let browserUpAttempted = false;
  let browser = null;
  let detachSignals = () => {};
  const errors = [];
  try {
    detachSignals = installSignalHandlers();
    browserUpAttempted = true;
    const up = await runCommand([path.join(HERE, 'browser.mjs'), 'up', profile, '--port', String(port)], {
      stdoutFile: path.join(outDir, 'logs', 'browser-up.stdout.log'),
      stderrFile: path.join(outDir, 'logs', 'browser-up.stderr.log'), signalState,
    });
    report.stages.push({ name: 'browser-up', command: commandLabel([path.join(HERE, 'browser.mjs'), 'up', profile, '--port', String(port)]), code: up.code, timedOut: up.timedOut });
    writeReport();
    if (up.code !== 0 || signalState.value) throw new Error(`browser up failed${up.signal ? ` (${up.signal})` : ''}`);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
    const context = browser.contexts()[0] || await browser.newContext();
    const observe = (page) => {
      page.on('pageerror', (e) => errors.push({ type: 'pageerror', message: String(e?.message || e) }));
      page.on('console', (m) => { if (m.type() === 'error') errors.push({ type: 'console-error', message: m.text() }); });
    };
    for (const page of context.pages()) observe(page);
    context.on('page', observe);
    // The app has no favicon asset; avoid turning that expected request into a
    // console error while still treating every real page error as fatal.
    await context.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));

    if (options.groundContact) {
      const args = [path.join(HERE, 'ground-contact-audit.mjs'), '--port', String(port), '--out', outDir];
      const result = await runCommand(args, { stdoutFile: path.join(outDir, 'logs', 'ground-contact.stdout.log'),
        stderrFile: path.join(outDir, 'logs', 'ground-contact.stderr.log'), signalState, timeoutMs: 210000 });
      report.stages.push({ name: 'ground-contact', code: result.code, timedOut: result.timedOut }); writeReport();
      if (result.code !== 0 || signalState.value) throw new Error('ground contact audit failed');
    }

    if (options.terrainMaterialProbe) {
      const args = [path.join(HERE, 'terrain-material-probe.mjs'), '--port', String(port), '--out', outDir, '--url', plan.url];
      const result = await runCommand(args, { stdoutFile: path.join(outDir, 'logs', 'terrain-material-probe.stdout.log'),
        stderrFile: path.join(outDir, 'logs', 'terrain-material-probe.stderr.log'), signalState, timeoutMs: 210000 });
      report.stages.push({ name: 'terrain-material-probe', code: result.code, timedOut: result.timedOut }); writeReport();
      if (result.code !== 0 || signalState.value) throw new Error('terrain material probe failed');
    }

    if (options.startup) {
      const args = [path.join(HERE, 'profile-startup.mjs'), '--port', String(port), '--out', outDir];
      const result = await runCommand(args, { stdoutFile: path.join(outDir, 'logs', 'startup.stdout.log'),
        stderrFile: path.join(outDir, 'logs', 'startup.stderr.log'), signalState, timeoutMs: 210000 });
      const stage = { name: 'startup', code: result.code, timedOut: result.timedOut, pageErrors: errors.slice() };
      report.stages.push(stage); writeReport();
      if (result.code !== 0 || stage.pageErrors.length || signalState.value) throw new Error('startup profile failed');
    }

    if (options.driveMs) {
      const args = [path.join(HERE, 'route-drive-check.mjs'), '--port', String(port), '--out', outDir, '--ms', String(options.driveMs)];
      const result = await runCommand(args, { stdoutFile: path.join(outDir, 'logs', 'route-drive.stdout.log'),
        stderrFile: path.join(outDir, 'logs', 'route-drive.stderr.log'), signalState, timeoutMs: options.driveMs + 60000 });
      report.stages.push({ name: 'route-drive', code: result.code, timedOut: result.timedOut }); writeReport();
      if (result.code !== 0 || signalState.value) throw new Error('route drive check failed');
    }

    for (const id of options.shots) {
      if (signalState.value) throw new Error(`interrupted by ${signalState.value}`);
      const startErrors = errors.length;
      const png = path.join(outDir, 'shots', `${id}.png`);
      const args = [path.join(HERE, 'shoot.mjs'), '--shot', id, png, '--browser', profile, '--port', String(port)];
      const logBase = path.join(outDir, 'logs', `shoot-${id}`);
      const result = await runCommand(args, { stdoutFile: `${logBase}.stdout.log`, stderrFile: `${logBase}.stderr.log`, signalState });
      const pageErrors = errors.slice(startErrors);
      report.pageErrors.push(...pageErrors.map((e) => ({ stage: `shoot:${id}`, ...e })));
      const stage = { name: `shoot:${id}`, id, command: commandLabel(args), code: result.code, signal: result.signal, timedOut: result.timedOut, screenshot: png, stdout: `${logBase}.stdout.log`, stderr: `${logBase}.stderr.log`, pageErrors };
      report.stages.push(stage); writeReport();
      if (result.code !== 0 || pageErrors.length || signalState.value) throw new Error(`shot ${id} failed${pageErrors.length ? ' with page errors' : ''}`);
    }

    if (options.wheelCheck) {
      const result = await runCommand([path.join(HERE, 'wheel-check.mjs'), '--port', String(port), '--out', outDir], {
        stdoutFile: path.join(outDir, 'logs', 'wheel-check.stdout.log'),
        stderrFile: path.join(outDir, 'logs', 'wheel-check.stderr.log'), signalState, timeoutMs: 180000 });
      report.stages.push({ name: 'wheel-check', code: result.code, timedOut: result.timedOut }); writeReport();
      if (result.code !== 0 || errors.length || signalState.value) throw new Error('wheel check failed');
    }

    if (options.qualityCheck) {
      const result = await runCommand([path.join(HERE, 'quality-check.mjs'), '--port', String(port), '--out', outDir], {
        stdoutFile: path.join(outDir, 'logs', 'quality-check.stdout.log'),
        stderrFile: path.join(outDir, 'logs', 'quality-check.stderr.log'), signalState, timeoutMs: 300000 });
      report.stages.push({ name: 'quality-check', code: result.code, timedOut: result.timedOut }); writeReport();
      if (result.code !== 0 || errors.length || signalState.value) throw new Error('quality check failed');
    }

    if (options.framePacing) {
      const result = await runCommand([path.join(HERE, 'frame-pacing.mjs'), '--port', String(port), '--out', outDir], {
        stdoutFile: path.join(outDir, 'logs', 'frame-pacing.stdout.log'),
        stderrFile: path.join(outDir, 'logs', 'frame-pacing.stderr.log'), signalState, timeoutMs: 300000 });
      report.stages.push({ name: 'frame-pacing', code: result.code, timedOut: result.timedOut }); writeReport();
      if (result.code !== 0 || errors.length || signalState.value) throw new Error('frame pacing check failed');
    }

    if (options.performanceAudit) {
      const result = await runCommand([path.join(HERE, 'performance-audit.mjs'), '--port', String(port), '--out', outDir], {
        stdoutFile: path.join(outDir, 'logs', 'performance-audit.stdout.log'),
        stderrFile: path.join(outDir, 'logs', 'performance-audit.stderr.log'), signalState, timeoutMs: 480000 });
      report.stages.push({ name: 'performance-audit', code: result.code, timedOut: result.timedOut }); writeReport();
      if (result.code !== 0 || errors.length || signalState.value) throw new Error('performance audit failed');
    }

    if (options.grassTrial) {
      const result = await runCommand([path.join(HERE, 'grass-trial.mjs'), '--port', String(port), '--out', outDir], {
        stdoutFile: path.join(outDir, 'logs', 'grass-trial.stdout.log'),
        stderrFile: path.join(outDir, 'logs', 'grass-trial.stderr.log'), signalState, timeoutMs: 300000 });
      report.stages.push({ name: 'grass-trial', code: result.code, timedOut: result.timedOut }); writeReport();
      if (result.code !== 0 || errors.length || signalState.value) throw new Error('grass trial failed');
    }

    if (options.perfMs !== null) {
      const args = [path.join(HERE, 'perf.mjs'), '--shot', 'chase_summer_noon', '--ms', String(options.perfMs), '--browser', profile, '--port', String(port)];
      const result = await runCommand(args, { stdoutFile: path.join(outDir, 'logs', 'perf.stdout.log'), stderrFile: path.join(outDir, 'logs', 'perf.stderr.log'), signalState });
      const stage = { name: 'perf', command: commandLabel(args), code: result.code, signal: result.signal, timedOut: result.timedOut, stdout: path.join(outDir, 'logs', 'perf.stdout.log'), stderr: path.join(outDir, 'logs', 'perf.stderr.log'), pageErrors: errors.slice() };
      report.stages.push(stage); writeReport();
      if (result.code !== 0 || stage.pageErrors.length || signalState.value) throw new Error('perf failed');
    }

    if (!options.skipRig) {
      const args = [path.join(HERE, 'rigcheck.mjs'), '--browser', profile, '--port', String(port), '--screenshots-dir', path.join(outDir, 'checks')];
      const result = await runCommand(args, { stdoutFile: path.join(outDir, 'logs', 'rigcheck.stdout.log'), stderrFile: path.join(outDir, 'logs', 'rigcheck.stderr.log'), signalState, timeoutMs: 480000 });
      const stage = { name: 'rigcheck', command: commandLabel(args), code: result.code, signal: result.signal, timedOut: result.timedOut, stdout: path.join(outDir, 'logs', 'rigcheck.stdout.log'), stderr: path.join(outDir, 'logs', 'rigcheck.stderr.log'), pageErrors: errors.slice() };
      report.stages.push(stage); writeReport();
      if (result.code !== 0 || stage.pageErrors.length || signalState.value) throw new Error('rigcheck failed');
    }
    if (options.profile) {
      const args = [path.join(HERE, 'profile-frame.mjs'), '--port', String(port), '--label', 'profile', '--out', outDir];
      if (options.ablation) args.push('--ablation');
      const startErrors = errors.length;
      const result = await runCommand(args, { stdoutFile: path.join(outDir, 'logs', 'profile.stdout.log'),
        stderrFile: path.join(outDir, 'logs', 'profile.stderr.log'), signalState, timeoutMs: 360000 });
      const stage = { name: 'profile', code: result.code, timedOut: result.timedOut, pageErrors: errors.slice(startErrors) };
      report.stages.push(stage); writeReport();
      if (result.code !== 0 || stage.pageErrors.length || signalState.value) throw new Error('profile failed');
    }
    if (options.cullingReference) {
      const args = [path.join(HERE, 'culling-parity.mjs'), '--port', String(port), '--out', outDir,
        '--reference', path.resolve(options.cullingReference)];
      const result = await runCommand(args, { stdoutFile: path.join(outDir, 'logs', 'culling-parity.stdout.log'),
        stderrFile: path.join(outDir, 'logs', 'culling-parity.stderr.log'), signalState });
      report.stages.push({ name: 'culling-parity', code: result.code, timedOut: result.timedOut }); writeReport();
      if (result.code !== 0 || signalState.value) throw new Error('culling parity failed');
    }
    if (options.treeLodTrial) {
      const args = [path.join(HERE, 'tree-lod-trial.mjs'), '--port', String(port), '--out', outDir,
        '--query', SHOTS[options.shots[0]].params, '--bands', options.treeLodBands, '--drive-ms', String(options.treeLodDriveMs)];
      const startErrors = errors.length;
      const timeoutMs = Math.max(360000, (parseTreeLodBands(options.treeLodBands).length + 2) * (options.treeLodDriveMs + 30000) + 180000);
      const result = await runCommand(args, { stdoutFile: path.join(outDir, 'logs', 'tree-lod-trial.stdout.log'),
        stderrFile: path.join(outDir, 'logs', 'tree-lod-trial.stderr.log'), signalState, timeoutMs });
      report.stages.push({ name: 'tree-lod-trial', code: result.code, timedOut: result.timedOut,
        report: path.join(outDir, 'tree-lod-trial.json'), pageErrors: errors.slice(startErrors) });
      writeReport();
      if (result.code !== 0 || errors.length > startErrors || signalState.value) throw new Error('tree LOD trial failed');
    }
    report.status = 'passed';
    return 0;
  } catch (error) {
    report.status = signalState.value ? 'interrupted' : 'failed';
    report.error = error.message;
    return 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (browserUpAttempted) {
      const down = await runCommand([path.join(HERE, 'browser.mjs'), 'down', profile], {
        stdoutFile: path.join(outDir, 'logs', 'browser-down.stdout.log'),
        stderrFile: path.join(outDir, 'logs', 'browser-down.stderr.log'), signalState,
      });
      let remaining = -1;
      try { remaining = JSON.parse(down.stdout.trim().split('\n').at(-1)).remaining; } catch {}
      report.cleanup = { code: down.code, profile, remaining };
      if (down.code !== 0 || remaining !== 0) report.status = 'cleanup-failed';
    }
    report.pageErrors = errors.slice();
    report.endedAt = new Date().toISOString();
    if (report.status === 'running') report.status = 'failed';
    writeReport();
    detachSignals();
    console.log(JSON.stringify({ status: report.status, report: reportPath, cleanup: report.cleanup }));
    if (report.status === 'cleanup-failed') throw new Error('isolated browser cleanup failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(usage());
    else process.exitCode = await main(options);
  } catch (error) {
    console.error(`run-round: ${error.message}`);
    console.error(usage());
    process.exitCode = 2;
  }
}

export { DEFAULT_SHOTS, parseArgs, runCommand, main };
