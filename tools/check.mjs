// npm run check: what to run on every change. Unit tests, the build, the ground, how the roads drive, how traffic moves and the
// size of what would be deployed. They run side by side, so more checks cost little.
// usage: node tools/check.mjs [--no-build]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const started = Date.now();
const SHOW_OUTPUT = new Set(['ground', 'roads', 'traffic', 'deploy size']);
const FULL = process.argv.includes('--full');

function run([name, command, args]) {
  return new Promise((done) => {
    const t = Date.now();
    // The CBD and around it, or it'd take minutes. npm run check -- --full does the whole map, by tile.
    const env = { ...process.env, ...(FULL ? {} : { SYDNEY_TILES: '-4,-6,3,3' }) };
    const child = spawn(command, args, { cwd: ROOT, env });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (status) => done({ name, ok: status === 0, out, err, seconds: (Date.now() - t) / 1000 }));
  });
}

function report(results) {
  let failed = false;
  for (const { name, ok, out, err, seconds } of results) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${seconds.toFixed(1)} s)`);
    if (!ok || SHOW_OUTPUT.has(name)) process.stdout.write(out.trimEnd() + (out ? '\n' : ''));
    if (!ok) {
      process.stdout.write(err);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}

report(await Promise.all([
  ['unit tests', 'node', ['--test', '--test-reporter=dot', 'tests/**/*.test.*']],
  ...(process.argv.includes('--no-build') ? [] : [['build', 'npm', ['run', '--silent', 'build', '--', '--logLevel', 'warn']]]),
  ['ground', 'node', ['--max-old-space-size=12000', 'tools/check-ground.mjs', ...(FULL ? [] : ['--strict'])]],
  ['roads', 'node', ['--max-old-space-size=12000', 'tools/check-roads.mjs', ...(FULL ? ['--by-tile'] : ['--strict'])]],
  ['traffic', 'node', ['--max-old-space-size=4096', 'tools/check-traffic.mjs', '--strict', '--seconds=120', '--warm=60']]
].map(run)));
report(await Promise.all([['deploy size', 'node', ['tools/check-dist.mjs']]].map(run)));
console.log(`check passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
