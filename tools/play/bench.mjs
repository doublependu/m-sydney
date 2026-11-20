// npm run bench [-- --profile=desktop] [--headed] [--runs=N] [--query=quality=low] [--browser=firefox]
// Times the production build from navigation to interaction, then frame rate. Fails above the Phase 8 budget.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, openGame, ROOT, serveDist } from './lib.mjs';

const BUDGET_MS = { desktop: 2500, phone: 4000 };
const STAGES = { renderer: 'startup', lighting: 'startup', ui: 'startup', postFX: 'startup', controllers: 'startup', compile: 'shaders', firstFrame: 'firstFrame', gpu: 'firstFrame' };

const option = (name, fallback) => {
  const arg = process.argv.find((value) => value === `--${name}` || value.startsWith(`--${name}=`));
  return arg ? (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : true) : fallback;
};
const profiles = option('profile') ? [option('profile')] : Object.keys(BUDGET_MS);
const runs = Number(option('runs', 1));
const query = option('query', '');

const server = await serveDist();
const results = [];
let failed = false;

for (const profile of profiles) {
  const samples = [];
  for (let run = 0; run < runs; run++) {
    const browser = await launchBrowser({ browser: option('browser', 'chrome'), headed: option('headed', false) });
    const game = await openGame(browser, server.url, { profile, query, timeout: 180000, stayThrottled: true });
    const { stages, interactiveAt } = await game.page.evaluate(() => window.__gameDebug.load());
    const network = await game.page.evaluate(() => {
      const entries = [...performance.getEntriesByType('navigation'), ...performance.getEntriesByType('resource')];
      return { requests: entries.length, kilobytes: Math.round(entries.reduce((sum, entry) => sum + (entry.transferSize || 0), 0) / 1024) };
    });
    // The rest of the city builds behind the game: how long that takes, and the worst freeze a player sees on the way
    await game.page.evaluate(() => {
      window.__stalls = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__stalls.push(Math.round(entry.duration));
      }).observe({ type: 'longtask' });
      window.__gameDebug.frameCost();
    });
    await game.page.waitForFunction(() => window.__gameDebug.worldCompleteAt() !== null, null, { timeout: 180000, polling: 250 });
    const building = await game.page.evaluate(() => ({
      worldMs: Math.round(window.__gameDebug.worldCompleteAt() - window.__gameDebug.load().interactiveAt),
      worstStallMs: Math.max(0, ...window.__stalls),
      stalls: window.__stalls.filter((ms) => ms >= 100).length,
      ...window.__gameDebug.frameCost()
    }));
    await game.page.waitForTimeout(3000);
    await game.page.evaluate(() => window.__gameDebug.frameCost());
    await game.page.waitForTimeout(8000);
    const { fps, p50, p95, p99, ...timing } = await game.page.evaluate(() => window.__gameDebug.frameCost());
    const frames = { fps, p50, p95, p99 };
    // The draws and triangles: the most over a second of frames. Read once, between two frames, they can be a pass that drew
    // nothing, and say 0
    const scene = await game.page.evaluate(() => new Promise((resolve) => {
      let most = window.__gameDebug.renderInfo();
      const until = performance.now() + 1000;
      const sample = () => {
        const info = window.__gameDebug.renderInfo();
        if (info.drawCalls > most.drawCalls) most = info;
        if (performance.now() < until) requestAnimationFrame(sample);
        else resolve(most);
      };
      requestAnimationFrame(sample);
    }));
    const cost = { ...timing, ...scene };
    // What Auto went by, in brief: a load that got a lower level than the others says why
    const { level, auto } = await game.page.evaluate(() => {
      const { choice, level, guess, seen: d } = window.__gameDebug.quality();
      if (choice !== 'auto') return { level, auto: null };
      const gpu = d.backend === 'webgpu' ? `WebGPU ${d.vendor || 'unnamed'}${d.isFallback ? ', a fallback adapter' : ''}` : `WebGL2 (${d.adapter})`;
      return {
        level,
        auto: `${gpu}, ${d.cores} cores, ${d.memory} GB${d.coarse ? ', touch' : ''}${d.saveData ? ', saving data' : ''}`
          + (level !== guess ? `; guessed ${guess}, ${level} from an earlier load` : '')
      };
    });
    samples.push({ interactiveMs: Math.round(interactiveAt), level, auto, stages, network, building, frames, cost, errors: game.errors.slice(0, 5) });
    await browser.close();
    await new Promise((resolve) => setTimeout(resolve, 3000)); // as between the play scenarios: see tools/play/run.mjs
  }
  samples.sort((a, b) => a.interactiveMs - b.interactiveMs);
  const median = samples[samples.length >> 1];
  const totals = {};
  for (const [stage, ms] of Object.entries(median.stages)) {
    const group = STAGES[stage] || 'world';
    totals[group] = (totals[group] || 0) + ms;
  }
  const budget = BUDGET_MS[profile];
  const pass = budget === undefined || median.interactiveMs <= budget;
  if (!pass || median.errors.length) failed = true;
  results.push({ profile, budgetMs: budget, pass, ...median, totals, runs: samples.map(({ interactiveMs, level, auto }) => ({ interactiveMs, level, auto })) });
  console.log(`\n${profile}: interactive at ${(median.interactiveMs / 1000).toFixed(2)} s (budget ${budget ? `${budget / 1000} s` : 'none'}) ${pass ? 'PASS' : 'OVER'}`);
  // Auto picks the level from the GPU's reported vendor, so one machine can land on different ones: a time means little
  // without the level it was measured at
  console.log(`  runs: ${samples.map(({ interactiveMs, level }) => `${(interactiveMs / 1000).toFixed(2)} s at ${level}`).join(', ')}`);
  // What Auto saw, once for each different thing it saw: one line where every run saw the same
  const seen = [...new Set(samples.map(({ auto }) => auto).filter(Boolean))];
  if (seen.length) console.log(`  auto saw: ${seen.length === 1 ? seen[0] : samples.map(({ level, auto }, i) => `run ${i + 1} (${level}): ${auto}`).join('; ')}`);
  console.log(`  stages: ${Object.entries(totals).map(([name, ms]) => `${name} ${(ms / 1000).toFixed(2)}`).join(', ')}`);
  console.log(`  download: ${median.network.kilobytes} KB in ${median.network.requests} requests`);
  console.log(`  city complete ${(median.building.worldMs / 1000).toFixed(1)} s later, ${median.building.fps} FPS meanwhile, worst stall ${median.building.worstStallMs} ms, ${median.building.stalls} over 100 ms`);
  console.log(`  frames: ${median.frames.fps} FPS, p95 ${median.frames.p95} ms, sim ${median.cost.simMs.toFixed(1)} ms, submit ${median.cost.submitMs.toFixed(1)} ms`);
  console.log(`  scene: ${median.cost.backend}, ${median.cost.drawCalls} draws, ${(median.cost.triangles / 1e6).toFixed(1)}M triangles`);
  for (const error of median.errors) console.log(`  error: ${error.slice(0, 200)}`);
}

await server.close();
mkdirSync(join(ROOT, 'recordings'), { recursive: true });
writeFileSync(join(ROOT, 'recordings/bench.json'), `${JSON.stringify(results, null, 2)}\n`);
process.exit(failed ? 1 : 0);
