// Boots the build and saves what the game shows from a list of places, for checking the city by eye.
// usage: node tools/play/look.mjs out-dir [--query=...] [name:x,z,heading[,mode[,climbSeconds]] ...]
import { mkdirSync, writeFileSync } from 'node:fs';
import { serveDist, launchChrome, openGame } from './lib.mjs';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--') && !a.includes(':')) || 'recordings/look';
const query = args.find((a) => a.startsWith('--query='))?.slice(8) || '';
const places = args.filter((a) => a.includes(':')).map((a) => {
  const [name, rest] = a.split(':');
  const [x, z, heading = 0, mode = 'car', climb = 0] = rest.split(',');
  return { name, x: +x, z: +z, heading: +heading, mode, climb: +climb };
});
mkdirSync(out, { recursive: true });
const server = await serveDist();
const browser = await launchChrome();
const game = await openGame(browser, server.url, { profile: 'laptop', query });
const { page } = game;
const t = await page.evaluate(() => window.__gameDebug.load());
console.log('interactive', Math.round(t.interactiveAt), 'ms', JSON.stringify(t.stages));
await page.waitForFunction(() => window.__gameDebug.worldCompleteAt() !== null, null, { timeout: 240000, polling: 500 });
console.log('world complete', Math.round(await page.evaluate(() => window.__gameDebug.worldCompleteAt())), 'ms');
const grab = async (name) => {
  await page.waitForTimeout(1500);
  const url = await page.evaluate(() => window.__gameDebug.grab());
  writeFileSync(`${out}/${name}.jpg`, Buffer.from(url.split(',')[1], 'base64'));
};
await grab('start');
for (const p of places) {
  await page.evaluate(({ x, z, heading, mode }) => window.__gameDebug.goto?.(x, z, heading, mode), p);
  if (p.climb) {
    await page.keyboard.down('Space');
    await page.waitForTimeout(p.climb * 1000);
    await page.keyboard.up('Space');
  }
  await grab(p.name);
}
console.log(JSON.stringify(await page.evaluate(() => ({ ...window.__gameDebug.frameCost(), ...window.__gameDebug.renderInfo() }))));
console.log('errors', game.errors.length, game.errors.slice(0, 8).join('\n').slice(0, 1600));
await browser.close();
await server.close();
