// npm run play                 the key scenarios, no video: run this before saying something works
// npm run play -- --changed    what `git diff` says a change can affect
// npm run play -- --full       everything but the soak, long drives on the fast clock: at the end of a phase
// npm run play -- --soak[=10]  the soak as well, or with --only=soak alone: before a stopping point or a deploy
// Also: --only=first-minute,touch --video --fast --realtime --repeat=3 --no-rerun --headed --seed=6 --gap=3 --jobs=3
//       --browser=firefox --tiles=0_-2,1_-2
// Plays on a copy of the production build made at the start, so the next rebuild can't disturb it: a run can go on in the
// background while work carries on. Writes recordings/<date>/, with what it tested in code.txt, and exits non-zero on a failed
// check. A failure runs again with the same seed and with video, so a failure that repeats always has a recording.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser, openGame, ROOT, serveDist, startRecording } from './lib.mjs';
import { Human, Watchdog } from './human.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { affectedScenarios, scenariosForTiles } from './affected.mjs';

const option = (name, fallback) => {
  const arg = process.argv.find((value) => value === `--${name}` || value.startsWith(`--${name}=`));
  return arg ? (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : true) : fallback;
};

export const LITE = ['first-minute', 'walk-cycle', 'helicopter', 'mode-map', 'mode-switch', 'tile-streaming', 'touch', 'webgl2-fallback', 'low-graphics'].filter((name) => SCENARIOS[name]);

function changedFiles() {
  const run = (command) => execSync(command, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  return [...run('git diff --name-only HEAD'), ...run('git ls-files --others --exclude-standard')];
}

// Time or frames are what these measure, or they need a GPU to themselves: they run one at a time, after the rest. Four
// scenarios side by side take about two thirds of the time of one after another, and drive-route's time went from 49 to 67 s.
export const ALONE = new Set([
  'hill-start', 'loading-bar', 'first-minute', 'drive-route', 'crash-recovery', 'helicopter', 'auto-steps-down', 'webgl2-fallback',
  'device-lost', 'offline-file', 'tile-streaming', 'soak', 'long-flight'
]);

function chooseScenarios() {
  if (option('only')) return option('only').split(',');
  if (option('full')) return Object.keys(SCENARIOS).filter((name) => name !== 'soak' || option('soak'));
  if (option('changed')) return affectedScenarios(changedFiles()).filter((name) => SCENARIOS[name]);
  if (option('tiles')) return scenariosForTiles(option('tiles').split(',')).filter((name) => SCENARIOS[name]);
  return LITE;
}

// Runs named by their time, oldest first. A folder holding a file called KEEP is never removed, nor a run still going, which
// says so with a file called RUNNING: unless that's hours old, from a run that died.
const stillRunning = (dir) => existsSync(join(dir, 'RUNNING')) && Date.now() - statSync(join(dir, 'RUNNING')).mtimeMs < 3 * 3600000;
function pruneRecordings(keep = 3) {
  const root = join(ROOT, 'recordings');
  const runs = readdirSync(root).filter((name) => /^\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d(-\d+)?$/.test(name)).sort();
  for (const name of runs.slice(0, Math.max(0, runs.length - keep))) {
    if (!existsSync(join(root, name, 'KEEP')) && !stillRunning(join(root, name))) rmSync(join(root, name), { recursive: true, force: true });
  }
}

const names = chooseScenarios();
const fastWanted = !option('realtime') && Boolean(option('fast') || option('full'));
const repeat = Number(option('repeat', 1));
const soak = option('soak', 5);
const options = { soakMinutes: soak === true ? 5 : Number(soak) };
// Full runs take a few browsers at a time
const jobs = Number(option('jobs', option('full') ? 3 : 1));
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
let outDir = join(ROOT, 'recordings', stamp);
// Two runs started in the same second
for (let n = 2; existsSync(outDir); n++) outDir = join(ROOT, 'recordings', `${stamp}-${n}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'RUNNING'), '');

// The build as it is now, and a name for it
const dist = join(outDir, 'dist');
cpSync(join(ROOT, 'dist'), dist, { recursive: true });
const code = createHash('sha1');
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isDirectory()) walk(join(dir, entry.name));
    else code.update(entry.name).update(readFileSync(join(dir, entry.name)));
  }
};
walk(dist);
writeFileSync(join(outDir, 'code.txt'), `${code.digest('hex').slice(0, 12)} ${new Date().toISOString()} ${option('full') ? 'full' : names.join(',')}\n`);

const server = await serveDist(0, dist);

async function play(name, index, { video, suffix = '' }) {
  const scenario = SCENARIOS[name];
  const fast = fastWanted && !!scenario.fast;
  const browser = await launchBrowser({ browser: option('browser', 'chrome'), headed: option('headed', false) });
  const url = scenario.file ? pathToFileURL(join(dist, scenario.file)).href : server.url;
  const game = await openGame(browser, url, {
    profile: scenario.profile || 'laptop',
    query: scenario.query,
    storage: scenario.storage,
    initScript: scenario.initScript,
    offline: Boolean(scenario.file)
  });
  // On the fast clock the world has to be there first: nothing builds it between advances
  if (fast) {
    await game.page.waitForFunction(() => window.__gameDebug.worldCompleteAt() !== null, null, { timeout: 180000, polling: 200 });
    await game.page.evaluate(() => window.__gameDebug.setFast(true));
  }
  const stopRecording = video ? await startRecording(game, join(outDir, `${name}${suffix}.mp4`)) : null;
  const human = new Human(game, Number(option('seed', index + 1)), { fast }); // --seed replays one scenario of a full run
  const watchdog = new Watchdog(game, { memory: scenario.memory, expectedErrors: scenario.expectedErrors, fast });
  const metrics = {};
  const failures = [];
  const started = Date.now();
  // A script that hangs must fail its scenario, not stall the whole run while the video grows.
  const limitMs = (scenario.minutes ?? (name === 'soak' ? options.soakMinutes + 4 : 4)) * 60000;
  let timer;
  try {
    await Promise.race([
      scenario.run({
        human,
        game,
        page: game.page,
        options,
        watchdog,
        metric: (key, value) => { metrics[key] = value; },
        expect: (condition, message) => { if (!condition) failures.push(message); }
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${limitMs / 60000} min`)), limitMs); })
    ]);
  } catch (error) {
    failures.push(`script: ${error.message.split('\n')[0]}`);
  }
  clearTimeout(timer);
  await human.releaseAll().catch(() => {});
  failures.push(...await watchdog.stop());
  await game.page.screenshot({ path: join(outDir, `${name}${suffix}.png`) }).catch(() => {});
  await stopRecording?.();
  await browser.close();
  return { name, pass: failures.length === 0, seconds: Math.round((Date.now() - started) / 1000), fast, failures, metrics };
}

// WebGL2 straight after a closed WebGPU browser loses its context ("GPU state invalid" within a second of launch, on the
// RTX 3060 here): 3 s between browsers clears it. Nothing a player can reach, as one browser never follows another.
const gapBefore = (name) => Number(option('gap', ['webgl2-fallback', 'device-lost', 'offline-file'].includes(name) || option('browser') === 'firefox' ? 3 : 0.5)) * 1000;

const report = [];
const startedAll = Date.now();

async function playRound(name, index, round) {
  const video = Boolean(option('video'));
  const entry = await play(name, index, { video, suffix: repeat > 1 ? `-${round + 1}` : '' });
  if (repeat > 1) entry.round = round + 1;
  report.push(entry);
  console.log(`${entry.pass ? 'PASS' : 'FAIL'} ${name} (${entry.seconds} s${entry.fast ? ', fast clock' : ''}) ${JSON.stringify(entry.metrics)}`);
  for (const failure of entry.failures) console.log(`  - ${failure}`);
  if (!entry.pass && !video && !option('no-rerun')) {
    await new Promise((resolve) => setTimeout(resolve, gapBefore(name)));
    const again = await play(name, index, { video: true, suffix: '-rerun' });
    entry.rerun = { pass: again.pass, seconds: again.seconds, failures: again.failures };
    console.log(`  rerun with video: ${again.pass ? 'passed, so this failure is flaky' : `failed again (${again.failures.length})`}`);
  }
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

for (const name of names) if (!SCENARIOS[name]) throw new Error(`Unknown scenario: ${name}`);
const rounds = names.flatMap((name, index) => Array.from({ length: repeat }, (_, round) => ({ name, index, round })));

// Those that can share the machine, a few at a time; then those that can't, one by one
const shared = jobs > 1 ? rounds.filter((r) => !ALONE.has(r.name)) : [];
const alone = rounds.filter((r) => !shared.includes(r));
await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => {
  for (let next = shared.shift(); next; next = shared.shift()) await playRound(next.name, next.index, next.round);
}));
for (const [i, { name, index, round }] of alone.entries()) {
  if (i || jobs > 1) await new Promise((resolve) => setTimeout(resolve, gapBefore(name)));
  await playRound(name, index, round);
}
await server.close();
rmSync(dist, { recursive: true, force: true });
rmSync(join(outDir, 'RUNNING'), { force: true });
pruneRecordings();
const failed = report.filter((entry) => !entry.pass);
console.log(`\n${report.length - failed.length} of ${report.length} passed in ${((Date.now() - startedAll) / 60000).toFixed(1)} min. Report: ${outDir}`);
process.exit(failed.length ? 1 : 0);
