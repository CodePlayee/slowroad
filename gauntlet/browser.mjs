#!/usr/bin/env node
// Isolated, always-headless browser manager for the Gauntlet Loop.
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = '/tmp/gauntlet-browsers';
const EXE = chromium.executablePath();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PORTS = { refs: 9222, ours: 9223 };
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function paths(name) {
  if (!NAME_RE.test(name || '')) throw new Error(`invalid browser name: ${name}`);
  const dir = path.join(ROOT, name);
  return { dir, profile: path.join(dir, 'profile'), pid: path.join(dir, 'pids'), meta: path.join(dir, 'meta.json') };
}

async function alive(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; }
  catch { return false; }
}

function psProcesses() {
  // Keep PID, PPID, and argv together. This avoids grep/awk substring matches.
  const text = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' });
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/); if (!m) continue;
    const marker = m[3].search(/\s+--/); if (marker < 0) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), executable: m[3].slice(0, marker), argv: m[3].slice(marker + 1).trim().split(/\s+/).filter(Boolean) });
  }
  return rows;
}

function optionValues(argv, name) { return argv.filter((arg) => arg.startsWith(`${name}=`)).map((arg) => arg.slice(name.length + 1)); }
function isBundledExecutable(executable) {
  // Helpers are beside the bundled binary; system/user Chrome never matches.
  return executable === EXE || executable.startsWith(`${path.dirname(EXE)}/`) || executable.startsWith(`${path.dirname(path.dirname(EXE))}/Frameworks/`);
}
function profileProcesses(profile, port = null) {
  return psProcesses().filter((proc) => {
    if (!isBundledExecutable(proc.executable)) return false;
    const profiles = optionValues(proc.argv, '--user-data-dir');
    if (profiles.length !== 1 || profiles[0] !== profile) return false;
    if (!proc.argv.includes('--headless=new')) return false;
    const ports = optionValues(proc.argv, '--remote-debugging-port');
    return port === null || (ports.length === 1 && ports[0] === String(port));
  });
}
function listeningPids(port) {
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' });
    return out.split('\n').filter((line) => line.startsWith('p')).map((line) => Number(line.slice(1))).filter(Number.isInteger);
  } catch { return []; }
}
function ensureSafeDirs(p) {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  for (const dir of [p.dir, p.profile]) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error(`refusing symlink profile path: ${dir}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

async function up(name, opts) {
  const p = paths(name); const port = opts.port || PORTS[name] || 9300 + (name.length % 50);
  ensureSafeDirs(p);
  const owners = listeningPids(port);
  if (owners.length) {
    const ours = profileProcesses(p.profile, port).filter((proc) => owners.includes(proc.pid));
    if (ours.length && ours.every((proc) => proc.argv.includes('--headless=new'))) { console.log(JSON.stringify({ name, port, status: 'already-up', headed: false })); return port; }
    throw new Error(`port ${port} is already owned by an unverified process; refusing reuse`);
  }
  const args = ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${p.profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000', '--mute-audio', '--hide-scrollbars', '--disable-component-update', '--disable-background-networking', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--disable-blink-features=AutomationControlled', 'about:blank'];
  const outFd = fs.openSync(path.join(p.dir, 'out.log'), 'a'); const errFd = fs.openSync(path.join(p.dir, 'err.log'), 'a');
  const child = spawn(EXE, args, { detached: true, stdio: ['ignore', outFd, errFd] }); child.unref(); fs.closeSync(outFd); fs.closeSync(errFd);
  fs.writeFileSync(p.meta, JSON.stringify({ name, port, headed: false, exe: EXE, started: new Date().toISOString() }, null, 1));
  for (let i = 0; i < 40 && !(await alive(port)); i++) await sleep(250);
  if (!(await alive(port))) throw new Error(`browser "${name}" failed to come up on ${port}; see ${p.dir}/err.log`);
  const records = profileProcesses(p.profile, port);
  if (!records.some((proc) => proc.pid === child.pid || proc.executable === EXE)) throw new Error('browser came up but ownership could not be verified');
  fs.writeFileSync(p.pid, records.map((proc) => String(proc.pid)).join('\n') + '\n');
  console.log(JSON.stringify({ name, port, status: 'up', headed: false })); return port;
}

async function down(name) {
  const p = paths(name); let killed = 0;
  for (const proc of profileProcesses(p.profile)) { try { process.kill(proc.pid, 'SIGTERM'); killed++; } catch {} }
  for (let i = 0; i < 20 && profileProcesses(p.profile).length; i++) await sleep(100);
  for (const proc of profileProcesses(p.profile)) { try { process.kill(proc.pid, 'SIGKILL'); killed++; } catch {} }
  console.log(JSON.stringify({ name, killed, remaining: profileProcesses(p.profile).length }));
}
function list() {
  if (!fs.existsSync(ROOT)) return console.log('[]');
  console.log(JSON.stringify(fs.readdirSync(ROOT).filter((name) => NAME_RE.test(name)).map((name) => { try { return JSON.parse(fs.readFileSync(paths(name).meta, 'utf8')); } catch { return {}; } }), null, 1));
}
async function main() {
  const [cmd, name, ...rest] = process.argv.slice(2);
  if (process.argv.slice(2).includes('--headed')) throw new Error('headed mode is prohibited; browser.mjs is always headless');
  const opts = { port: null }; const pi = rest.indexOf('--port');
  if (pi >= 0) opts.port = Number(rest[pi + 1]);
  if (opts.port !== null && (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)) throw new Error('invalid port');
  if (cmd === 'up') await up(name, opts); else if (cmd === 'down') await down(name); else if (cmd === 'list') list(); else if (cmd === 'port') console.log(await up(name, opts)); else throw new Error('usage: browser.mjs up|down|list|port <name> [--port N]');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { console.error(`browser.mjs: ${e.message}`); process.exitCode = 1; });
export { psProcesses, profileProcesses, listeningPids };
