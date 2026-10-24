#!/usr/bin/env node
// gauntlet/serve-progress.mjs — static server for the live progress page on :5199.
// Serves gauntlet/progress.html at /, plus gauntlet/, shots/ and refs/ statically so
// the A/B image pairs resolve. Read-only; no caching of state.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PROGRESS_PORT || 5199);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.md': 'text/plain; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.mjs': 'text/javascript',
};
const ALLOW = ['gauntlet', 'shots', 'refs'];

http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { p = '/'; }
  if (p === '/' || p === '/index.html') p = '/gauntlet/progress.html';
  const rel = p.replace(/^\/+/, '');
  const top = rel.split('/')[0];
  if (!ALLOW.includes(top)) { res.writeHead(403).end('forbidden'); return; }
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + rel); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': ext === '.json' || ext === '.html' ? 'no-store' : 'max-age=5',
      'content-length': st.size,
    });
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`progress page: http://localhost:${PORT}/`);
});
