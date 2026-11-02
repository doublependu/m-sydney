// How frames hold up while the map streams: fly the length of the map and back with tiles coming and going, and measure every
// frame. The load benchmark (bench.mjs) only measures frames once the city has settled.
// usage: node tools/play/stream-bench.mjs [--profile=phone] [--query=quality=low] [--legs=4]
import { serveDist, launchBrowser, openGame } from './lib.mjs';

const option = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const profile = option('profile', 'phone');
const legs = Number(option('legs', 4));
const server = await serveDist();
const browser = await launchBrowser({});
const game = await openGame(browser, server.url, { profile, query: option('query', ''), timeout: 180000, stayThrottled: true });
const { page } = game;
await page.waitForFunction(() => window.__gameDebug.worldCompleteAt() !== null, null, { timeout: 240000 });

// Across the map's length, at a helicopter's cruise: 52 m/s is the fastest anything crosses tiles
await page.evaluate(() => window.__gameDebug.goto(150, 1500, Math.PI, 'helicopter', false, 120));
await page.evaluate(() => {
  window.__frames = [];
  let last = performance.now();
  const tick = (now) => { window.__frames.push(now - last); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
const started = Date.now();
const samples = [];
for (let leg = 0; leg < legs; leg++) {
  // South to north, then back, by turning the helicopter around rather than jumping
  await page.evaluate((north) => window.__gameDebug.goto(150, north ? 1500 : -4000, north ? Math.PI : 0, 'helicopter', false, 120), leg % 2 === 0);
  await page.keyboard.down('KeyW');
  for (let t = 0; t < 110; t += 10) {
    await page.waitForTimeout(10000);
    samples.push(await page.evaluate(() => {
      const s = window.__gameDebug.tileState();
      const me = window.__gameDebug.player();
      // Is the tile under the player drawn, or has it been outrun?
      const here = `${Math.floor(me.x / 1000)}_${Math.floor(me.z / 1000)}`;
      return { done: s.done.length, heap: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576), z: Math.round(me.z), behind: !s.done.includes(here) && s.known.includes(here) };
    }));
  }
  await page.keyboard.up('KeyW');
}
const frames = await page.evaluate(() => window.__frames);
frames.sort((a, b) => a - b);
const at = (q) => frames[Math.floor(frames.length * q)];
const sum = frames.reduce((a, b) => a + b, 0);
console.log(`${profile}: ${frames.length} frames over ${((Date.now() - started) / 1000).toFixed(0)} s of streaming`);
console.log(`  ${(1000 * frames.length / sum).toFixed(1)} FPS, median ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms, p99 ${at(0.99).toFixed(1)} ms, worst ${frames.at(-1).toFixed(0)} ms, over 100 ms: ${frames.filter((f) => f > 100).length}`);
console.log(`  tiles built ${Math.min(...samples.map((s) => s.done))}-${Math.max(...samples.map((s) => s.done))}, heap ${Math.min(...samples.map((s) => s.heap))}-${Math.max(...samples.map((s) => s.heap))} MB, z from ${Math.min(...samples.map((s) => s.z))} to ${Math.max(...samples.map((s) => s.z))}`);
console.log(`  samples with the tile underneath not drawn yet: ${samples.filter((s) => s.behind).length} of ${samples.length}`);
console.log(`  waits for the ground after a jump across the map: ${JSON.stringify(await page.evaluate(() => window.__gameDebug.groundWaits()))} ms`);
console.log(`  level ${JSON.stringify(await page.evaluate(() => window.__gameDebug.quality()))}`);
await browser.close();
await server.close();
