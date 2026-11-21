// Cloudflare's free plan: 20,000 files per version and 25 MiB per file (developers.cloudflare.com/workers/platform/limits).
// Fails well before the file limit, so a change can't quietly move the site off the free plan. Also fails if a Worker
// script appears: its requests would count against 100,000 a day, where static files are free and unlimited.
// And fails if any folder in the deploy or the repository has over 1,000 entries: GitHub's website lists only the first 1,000
// of a folder, and its documentation recommends 3,000 at most. The map's files go in folders by 8 km square (js/tiles/paths.js).
// It lists the first download's code too (what index.html loads, and what that imports), and fails if a season's is in it: the
// seasons are fetched only in their season, once the city is complete (js/seasons.js); or a pool's moving water, fetched only near one
// (js/pool-water.js), and swimming with the first model that has a pool to swim in (js/swimming.js).
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_FILES = 18000;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_IN_FOLDER = 1000;

let files = 0, bytes = 0, largest = ['', 0], fullest = ['', 0];
const walk = (dir) => {
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.length > fullest[1]) fullest = [dir.slice(ROOT.length) || '.', entries.length];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else {
      const { size } = statSync(path);
      files++;
      bytes += size;
      if (size > largest[1]) largest = [path.slice(ROOT.length), size];
    }
  }
};
walk(join(ROOT, 'dist'));
console.log(`deploy: ${files} files, ${(bytes / 1048576).toFixed(1)} MB, largest ${largest[0]} ${(largest[1] / 1048576).toFixed(1)} MB, fullest folder ${fullest[0]} with ${fullest[1]}`);

// The repository's folders as git has them, files that are new included
const inRepo = new Map();
try {
  // Moved or deleted files stay in git's index until they're committed: only what's on disk counts
  const listed = execSync('git ls-files --cached --others --exclude-standard', { cwd: ROOT, maxBuffer: 64 * 1048576 }).toString().split('\n')
    .filter((file) => file && existsSync(join(ROOT, file)));
  for (const file of listed) {
    // Each folder on the way counts the entry below it once
    const parts = file.split('/');
    for (let i = 0; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/') || '.';
      const entry = parts[i];
      if (!inRepo.has(folder)) inRepo.set(folder, new Set());
      inRepo.get(folder).add(entry);
    }
  }
} catch {
  // Not a git checkout: only the deploy is checked
}
const repoFullest = [...inRepo].reduce((best, [folder, set]) => (set.size > best[1] ? [folder, set.size] : best), ['', 0]);
if (inRepo.size) console.log(`repository: fullest folder ${repoFullest[0]} with ${repoFullest[1]}`);

// The first download: index.html's scripts, styles, fonts and preloads in assets/, and every module those import as they load (not
// import(), which waits until it's called)
const first = new Map();
const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
const visit = (path) => {
  if (first.has(path) || !existsSync(path)) return;
  const bytes = readFileSync(path);
  first.set(path, { bytes: bytes.length, gzip: gzipSync(bytes).length });
  if (!path.endsWith('.js')) return;
  const code = bytes.toString('utf8');
  for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*)["'](\.{1,2}\/[^"']+\.js)["']/g)) visit(join(dirname(path), m[1]));
};
for (const m of html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)) visit(join(ROOT, 'dist', m[1]));
const firstNames = [...first.keys()].map((path) => path.slice(join(ROOT, 'dist/assets/').length));
const sum = (key) => [...first.values()].reduce((n, f) => n + f[key], 0);
console.log(`first download's code: ${first.size} files, ${(sum('bytes') / 1024).toFixed(1)} KB (${(sum('gzip') / 1024).toFixed(1)} KB gzipped): ${firstNames.join(', ')}`);

const wrangler = JSON.parse(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const problems = [];
if (files > MAX_FILES) problems.push(`${files} files, over ${MAX_FILES}`);
if (largest[1] > MAX_BYTES) problems.push(`${largest[0]} is over 25 MiB`);
if (fullest[1] > MAX_IN_FOLDER) problems.push(`${fullest[0]} has ${fullest[1]} entries in the deploy, over ${MAX_IN_FOLDER}`);
if (repoFullest[1] > MAX_IN_FOLDER) problems.push(`${repoFullest[0]} has ${repoFullest[1]} entries in the repository, over ${MAX_IN_FOLDER}`);
for (const name of firstNames) if (/^seasons?[-.]/.test(name)) problems.push(`${name} is in the first download: a season's code is fetched only in its season`);
for (const name of firstNames) if (/^pool-water[-.]/.test(name)) problems.push(`${name} is in the first download: a pool's water is fetched only near it`);
// ...nor a gallery's art, fetched with its inside (js/art.js)
for (const name of firstNames) if (/^art(works|-paint)?[-.]/.test(name)) problems.push(`${name} is in the first download: a gallery's art comes with its inside`);
for (const name of firstNames) if (/^swimming[-.]/.test(name)) problems.push(`${name} is in the first download: swimming is fetched with a pool to swim in`);
if (wrangler.main || wrangler.assets?.run_worker_first) problems.push('wrangler.jsonc runs a Worker: the site has to stay static files on the free plan');
for (const problem of problems) console.error(problem);
process.exit(problems.length ? 1 : 0);
