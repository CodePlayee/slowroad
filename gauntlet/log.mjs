#!/usr/bin/env node
// gauntlet/log.mjs — append one gauntlet round to gauntlet/state.json, atomically.
// Many agents call this concurrently, so writes go through a lock dir + temp/rename.
//
//   node gauntlet/log.mjs --piece terrain --round 3 --agent critic \
//     --winner ours|bar|tie --gap "..." --our shots/x.png \
//     --bar refs/slowroads/official/sr_03.jpg --summary "..." [--status building|judging|won|blocked]
//
//   node gauntlet/log.mjs --init             # (re)seed state.json with the 10 pieces
//   node gauntlet/log.mjs --show             # print current state
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, 'state.json');
const LOCK = path.join(HERE, '.state.lock');

const PIECES = [
  ['terrain', 'Rolling landform, gentle but varied, believable silhouettes'],
  ['road', 'Route placement + how the ribbon meets the ground'],
  ['bridge', 'River crossings: deck, piers, abutments, railings'],
  ['water', 'Rivers, lakes, shoreline'],
  ['vegetation', 'Grass / shrub / tree density and near-far falloff'],
  ['atmosphere', 'Fog layering, sky, distant ridgelines, aerial perspective'],
  ['daycycle', 'Dawn / noon / golden / dusk / night lighting'],
  ['season', 'Spring / summer / autumn / winter palette + foliage'],
  ['journey', 'Camera + motion feel: a journey, not a driving sim'],
  ['streaming', 'Endless world, no pops, stable framerate'],
];

function args() {
  const a = process.argv.slice(2);
  const o = { _: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const k = a[i].slice(2);
      const v = a[i + 1];
      if (v === undefined || v.startsWith('--')) o[k] = true;
      else { o[k] = v; i++; }
    } else o._.push(a[i]);
  }
  return o;
}

function freshState() {
  return {
    started: new Date().toISOString(),
    updated: new Date().toISOString(),
    pieces: PIECES.map(([id, title]) => ({
      id, title, round: 0, status: 'pending', verdict: '', gap: '',
      our_shot: '', bar_shot: '', updated: new Date().toISOString(),
    })),
    rounds: [],
  };
}

function withLock(fn) {
  const deadline = Date.now() + 15000;
  for (;;) {
    try { fs.mkdirSync(LOCK); break; }
    catch (e) {
      if (Date.now() > deadline) {
        // stale lock (crashed agent): break it
        try { fs.rmSync(LOCK, { recursive: true, force: true }); fs.mkdirSync(LOCK); break; }
        catch { throw new Error('cannot acquire state lock'); }
      }
      const t = Date.now() + 40 + Math.random() * 60;
      while (Date.now() < t) { /* spin briefly */ }
    }
  }
  try { return fn(); }
  finally { try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch {} }
}

function read() {
  if (!fs.existsSync(STATE)) return freshState();
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { return freshState(); }
}

function write(state) {
  state.updated = new Date().toISOString();
  const tmp = STATE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, STATE);
}

const o = args();

if (o.show) {
  console.log(fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : '{}');
  process.exit(0);
}

if (o.init || !fs.existsSync(STATE)) {
  withLock(() => {
    const prev = fs.existsSync(STATE) && !o.init ? read() : freshState();
    write(prev);
  });
  if (o.init) { console.log('state.json seeded with ' + PIECES.length + ' pieces'); process.exit(0); }
}

if (!o.piece) {
  console.error('usage: log.mjs --piece <id> --round <n> --agent <name> [--winner ours|bar|tie]\n' +
    '                 [--gap "..."] [--our path] [--bar path] [--summary "..."] [--status s]\n' +
    '       log.mjs --init | --show');
  process.exit(1);
}

const ok = withLock(() => {
  const st = read();
  let p = st.pieces.find((x) => x.id === o.piece);
  if (!p) {
    p = { id: o.piece, title: o.piece, round: 0, status: 'pending', verdict: '', gap: '', our_shot: '', bar_shot: '', updated: '' };
    st.pieces.push(p);
  }
  const round = o.round !== undefined ? Number(o.round) : p.round + 1;
  const ts = new Date().toISOString();
  const winner = o.winner || '';

  p.round = Math.max(p.round, round);
  if (o.status) p.status = String(o.status);
  else if (o.agent === 'critic') p.status = winner === 'ours' || winner === 'tie' ? 'won' : 'judging';
  else p.status = 'building';
  if (winner) p.verdict = winner;
  if (o.gap) p.gap = String(o.gap);
  if (o.our) p.our_shot = String(o.our);
  if (o.bar) p.bar_shot = String(o.bar);
  p.updated = ts;

  st.rounds.unshift({
    ts, piece: o.piece, round, agent: String(o.agent || 'unknown'),
    summary: String(o.summary || ''), winner,
    gap: String(o.gap || ''), our_shot: String(o.our || ''), bar_shot: String(o.bar || ''),
  });
  if (st.rounds.length > 400) st.rounds.length = 400;
  write(st);
  return { piece: o.piece, round, winner };
});

console.log(JSON.stringify(ok));
process.exit(0);
