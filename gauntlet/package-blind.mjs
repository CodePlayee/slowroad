#!/usr/bin/env node
// Lossless, offline review packaging: equal HUD masks, no rendering or retouching.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PNG, jpegjs } = require(path.join(path.dirname(require.resolve('playwright-core')), 'lib/utilsBundle.js'));
const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function maskPixels(source, masks = []) {
  const { width, height } = source, data = Buffer.from(source.data);
  for (const [x, y, w, h] of masks) {
    if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height) {
      throw new Error('HUD mask outside image');
    }
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const at = (row * width + col) * 4;
      data[at] = data[at + 1] = data[at + 2] = 20; data[at + 3] = 255;
    }
  }
  return { width, height, data };
}

export function packageBlind({ capture, cases, out, seed = crypto.randomBytes(4).readUInt32LE(0) }) {
  const round = JSON.parse(fs.readFileSync(path.join(capture, 'round.json')));
  if (round.status !== 'passed' || round.cleanup?.remaining !== 0) throw new Error('Capture must pass and clean up before review');
  if (fs.existsSync(out)) throw new Error('Do not overwrite an existing blind package');
  let state = seed >>> 0;
  const random = () => { state = (state + 0x6D2B79F5) >>> 0; let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const key = [];
  fs.mkdirSync(out, { recursive: true });
  for (const [index, fixture] of cases.entries()) {
    const id = `Q${String(index + 1).padStart(2, '0')}`;
    const inputs = [path.join(capture, 'shots', `${fixture.shot}.png`), path.resolve(root, fixture.reference)];
    const sources = inputs.map(file => {
      const bytes = fs.readFileSync(file);
      const decoded = bytes[0] === 0x89 ? PNG.sync.read(bytes) : jpegjs.decode(bytes, { useTArray: true });
      if (decoded.width !== 1920 || decoded.height !== 1080) throw new Error(`Invalid comparison dimensions: ${file}`);
      return { file, sha256: sha(bytes), png: PNG.sync.write(maskPixels(decoded, fixture.masks)) };
    });
    const order = random() < 0.5 ? [0, 1] : [1, 0];
    fs.mkdirSync(path.join(out, id));
    order.forEach((source, i) => fs.writeFileSync(path.join(out, id, `${i ? 'B' : 'A'}.png`), sources[source].png));
    key.push({ id, shot: fixture.shot, masks: fixture.masks || [],
      A: { role: order[0] === 0 ? 'build' : 'reference', file: sources[order[0]].file, sha256: sources[order[0]].sha256 },
      B: { role: order[1] === 0 ? 'build' : 'reference', file: sources[order[1]].file, sha256: sources[order[1]].sha256 } });
  }
  fs.copyFileSync(path.join(root, 'gauntlet/BLIND_RUBRIC.md'), path.join(out, 'RUBRIC.md'));
  fs.writeFileSync(`${out}.private-key.json`, JSON.stringify({ seed, capture, createdAt: new Date().toISOString(), key }, null, 2));
  return { out, pairs: key.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), flag = name => args[args.indexOf(name) + 1];
  if (!args.includes('--capture') || !args.includes('--cases') || !args.includes('--out')) {
    throw new Error('Usage: --capture DIR --cases JSON --out DIR [--seed N]');
  }
  console.log(JSON.stringify(packageBlind({ capture: flag('--capture'), cases: JSON.parse(fs.readFileSync(flag('--cases'))),
    out: flag('--out'), ...(args.includes('--seed') ? { seed: Number(flag('--seed')) } : {}) })));
}
