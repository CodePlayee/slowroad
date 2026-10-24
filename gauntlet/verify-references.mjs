import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const endpoint = 'https://store.steampowered.com/api/appdetails?appids=3431300';
const app = JSON.parse(execFileSync('curl', ['-fLsS', '--max-time', '30', endpoint], { encoding: 'utf8' }))['3431300'];
if (!app.success || app.data.name !== 'Slow Roads') throw new Error('Unexpected reference listing');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const images = [];
for (const shot of app.data.screenshots) {
  const file = `official/sr_${String(shot.id + 1).padStart(2, '0')}.jpg`;
  const local = fs.readFileSync(path.join(root, 'refs/slowroads', file));
  const remote = execFileSync('curl', ['-fLsS', '--max-time', '30', shot.path_full], { maxBuffer: 10 * 1024 * 1024 });
  const row = { file, source_url: shot.path_full, local_sha256: sha(local), source_sha256: sha(remote), exact_match: sha(local) === sha(remote) };
  images.push(row);
  console.log(`${row.exact_match ? 'MATCH' : 'DIFF'} ${file}`);
}
const manifestPath = path.join(root, 'refs/slowroads/manifest.json');
const previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const manifest = {
  ...previous,
  status: images.every((row) => row.exact_match) ? 'source-verified' : 'source-differences',
  verified_at: new Date().toISOString(),
  source_page: 'https://store.steampowered.com/app/3431300/Slow_Roads/',
  source_api: endpoint,
  scope_note: 'Official store promotional screenshots. They are not claimed to be captures of the current web build.',
  images,
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
