// Cloudflare's free plan: 20,000 files per version and 25 MiB per file (developers.cloudflare.com/workers/platform/limits).
// Fails well before the file limit, so a change can't quietly move the site off the free plan. Also fails if a Worker
// script appears: its requests would count against 100,000 a day, where static files are free and unlimited.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_FILES = 18000;
const MAX_BYTES = 25 * 1024 * 1024;

let files = 0, bytes = 0, largest = ['', 0];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
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
console.log(`deploy: ${files} files, ${(bytes / 1048576).toFixed(1)} MB, largest ${largest[0]} ${(largest[1] / 1048576).toFixed(1)} MB`);

const wrangler = JSON.parse(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const problems = [];
if (files > MAX_FILES) problems.push(`${files} files, over ${MAX_FILES}`);
if (largest[1] > MAX_BYTES) problems.push(`${largest[0]} is over 25 MiB`);
if (wrangler.main || wrangler.assets?.run_worker_first) problems.push('wrangler.jsonc runs a Worker: the site has to stay static files on the free plan');
for (const problem of problems) console.error(problem);
process.exit(problems.length ? 1 : 0);
