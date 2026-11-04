// The map screen's images: all of the map, drawn by the game's own map code in Chrome from everything the generators made, at three levels
// of detail, into public/map/. Needs a build of the game in dist/, and npm run build again afterwards to take them in. npm run data:map does all that.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { launchBrowser, openGame, serveDist } from './play/lib.mjs';
import { mapImageFile } from '../js/tiles/paths.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public/map');
const LEVELS = [{ m: 2, size: 1024, px: 512 }, { m: 8, size: 4096, px: 512 }, { m: 32, size: 16384, px: 512 }];
const FAR = 4000;

const world = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/tiles/world.json'), 'utf8'));
const tiles = Object.keys(world.tiles).map((k) => k.split('_').map(Number));
const started = Date.now();
fs.rmSync(OUT, { recursive: true, force: true });
const fullMap = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'tools/data/generated/map-full.json.gz')));

const server = await serveDist(0, process.env.MAP_DIST || path.join(ROOT, 'dist'));
const browser = await launchBrowser({});
const game = await openGame(browser, server.url, {
  profile: 'laptop',
  query: 'quality=low&cars=1',
  setup: (page) => page.route('**/tiles/map.json.gz', (route) => route.fulfill({ body: fullMap, contentType: 'application/json' }))
});
const { page } = game;
await page.waitForFunction(() => window.__gameDebug?.load().interactiveAt !== null, null, { timeout: 120000, polling: 200 });
await page.evaluate(() => window.__gameDebug.prepareMapImages());
await page.waitForTimeout(15000); // the whole map's data, parsed

const index = { levels: [] };
let written = 0, bytes = 0;
const farCache = new Map();
const farIn = (x0, z0, size) => {
  const keys = [];
  for (let fx = Math.floor(x0 / FAR); fx * FAR < x0 + size; fx++) {
    for (let fz = Math.floor(z0 / FAR); fz * FAR < z0 + size; fz++) if (Object.hasOwn(world.farFiles, `${fx}_${fz}`)) keys.push(`${fx}_${fz}`);
  }
  return keys;
};
for (const level of LEVELS) {
  fs.mkdirSync(path.join(OUT, String(level.m)), { recursive: true });
  const keys = new Set();
  for (const [ix, iz] of tiles) {
    for (let a = Math.floor((ix * 1000) / level.size); a * level.size < (ix + 1) * 1000; a++) {
      for (let b = Math.floor((iz * 1000) / level.size); b * level.size < (iz + 1) * 1000; b++) keys.add(`${a}_${b}`);
    }
  }
  for (const key of keys) {
    const [a, b] = key.split('_').map(Number);
    const url = await page.evaluate(async ({ x0, z0, size, px, far }) => {
      const debug = window.__gameDebug;
      const cache = (window.__farCache ??= new Map());
      const buildings = [];
      for (const k of far) {
        if (!cache.has(k)) {
          // A few at a time: a whole level walks across the map
          if (cache.size > 12) cache.delete(cache.keys().next().value);
          cache.set(k, await debug.farBuildings(k));
        }
        for (const building of cache.get(k)) {
          const p = building.rings[0]?.[0];
          if (p && p.x > x0 - 100 && p.x < x0 + size + 100 && p.z > z0 - 100 && p.z < z0 + size + 100) buildings.push(building);
        }
      }
      return debug.mapImage(x0, z0, size, px, buildings);
    }, { x0: a * level.size, z0: b * level.size, size: level.size, px: level.px, far: level.m <= 2 ? farIn(a * level.size, b * level.size, level.size) : [] });
    const body = Buffer.from(url.split(',')[1], 'base64');
    const file = path.join(OUT, mapImageFile(level.m, a, b));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    written++;
    bytes += body.length;
    if (written % 200 === 0) console.log(`[map] ${written} images, ${Math.round(bytes / 1048576)} MB, ${Math.round((Date.now() - started) / 1000)} s`);
  }
  index.levels.push({ ...level, keys: [...keys] });
}
void farCache;
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
console.log(`[map] ${written} images, ${Math.round(bytes / 1048576)} MB, in ${Math.round((Date.now() - started) / 1000)} s; errors ${game.errors.length} ${game.errors.slice(0, 2).join(' | ').slice(0, 200)}`);
await browser.close();
await server.close();
