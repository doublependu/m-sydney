// npm run check: what to run on every change. Unit tests, the build, the ground and the size of what would be deployed.
// usage: node tools/check.mjs [--no-build]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const steps = [
  ['unit tests', 'node', ['--test', '--test-reporter=dot', 'tests/**/*.test.*']],
  ...(process.argv.includes('--no-build') ? [] : [['build', 'npm', ['run', '--silent', 'build', '--', '--logLevel', 'warn']]]),
  ['ground', 'node', ['tools/check-ground.mjs', '--strict']],
  ['deploy size', 'node', ['tools/check-dist.mjs']]
];
const started = Date.now();
for (const [name, command, args] of steps) {
  const t = Date.now();
  const run = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  const ok = run.status === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  if (!ok || name === 'ground' || name === 'deploy size') process.stdout.write((run.stdout || '').trimEnd() + (run.stdout ? '\n' : ''));
  if (!ok) {
    process.stdout.write(run.stderr || '');
    process.exit(1);
  }
}
console.log(`check passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
