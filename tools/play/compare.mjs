// Each reference photo beside what the game shows from the same place, in ref/compare/<name>.jpg.
// usage: node tools/play/compare.mjs [names...] [--out=ref/compare] [--browser=firefox]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, launchBrowser, openGame, serveDist } from './lib.mjs';

// Where each photo was taken from, as near as can be told: x, z, heading, mode, height above the ground or null, time of day
export const REF_VIEWS = {
  caleb: [650, -1745, -2.3, 'helicopter', 80, 'golden'],
  'christopher-burns': [-178, -1990, 2.5, 'helicopter', 10, 'midnight'],
  'dan-freeman': [70, -2230, 0.78, 'helicopter', 62, 'midday'],
  'jamie-davies': [3100, -2500, -1.62, 'helicopter', 380, 'midday'],
  'jasper-wilde': [330, -1875, 1.57, 'helicopter', 6, 'golden'],
  'jeremy-huang': [798, -2364, -0.41, 'helicopter', 8, 'midday'],
  leigh: [-400, -1500, 2.62, 'helicopter', 28, 'twilight'],
  'quentin-grignet': [500, -1790, 3.4, 'helicopter', 12, 'golden']
};

const args = process.argv.slice(2);
const wanted = args.filter((a) => !a.startsWith('--'));
const out = join(ROOT, args.find((a) => a.startsWith('--out='))?.slice(6) || 'ref/compare');
const browserName = args.find((a) => a.startsWith('--browser='))?.slice(10) || 'chrome';
mkdirSync(out, { recursive: true });

const photos = readdirSync(join(ROOT, 'ref')).filter((f) => f.endsWith('.jpg'));
const server = await serveDist();
const browser = await launchBrowser({ browser: browserName });
const game = await openGame(browser, server.url, { profile: 'desktop' });
const { page } = game;
await page.waitForFunction(() => window.__gameDebug.worldCompleteAt() !== null, null, { timeout: 240000, polling: 500 });
for (const [name, [x, z, heading, mode, height, time]] of Object.entries(REF_VIEWS)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const photo = photos.find((f) => f.startsWith(name));
  await page.locator(`[data-time="${time}"]`).click();
  await page.evaluate(([a, b, c, d, e]) => window.__gameDebug.goto(a, b, c, d, false, e), [x, z, heading, mode, height]);
  await page.evaluate(() => window.__gameDebug.showPlayer(false));
  await page.waitForTimeout(2500);
  const url = await page.evaluate(() => { window.__gameDebug.showPlayer(false); return window.__gameDebug.grab(); });
  const shot = join(out, `${name}-game.jpg`);
  writeFileSync(shot, Buffer.from(url.split(',')[1], 'base64'));
  if (photo && existsSync(join(ROOT, 'ref', photo))) {
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', join(ROOT, 'ref', photo), '-i', shot, '-filter_complex', '[0]scale=-2:800[a];[1]scale=-2:800[b];[a][b]hstack', '-q:v', '4', join(out, `${name}.jpg`)], { stdio: 'inherit' });
  }
  console.log(name);
}
await browser.close();
await server.close();
