// tools/tile-diff.mjs: which of the map's files a build changed, against git, and whether a change reached past the areas edited by
// hand (tools/local/), the gardens tools/build-garden.mjs planted and the buildings drawn from models. Tiles are named for a hash of
// their contents, so a changed tile is one whose name changed.
// usage: node tools/tile-diff.mjs [--against=HEAD] [--accept] [--list]
//   --accept  a change meant to reach the whole map (a new field in every tile): list it, don't fail on it
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localAreas } from './local-edits.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TILES = path.join(ROOT, 'public/tiles');
const against = process.argv.find((a) => a.startsWith('--against='))?.slice(10) || 'HEAD';
const accept = process.argv.includes('--accept');
const list = process.argv.includes('--list');

const git = (file) => {
  try {
    return execFileSync('git', ['show', `${against}:public/tiles/${file}`], { cwd: ROOT, maxBuffer: 1 << 30 });
  } catch {
    return null;
  }
};
const now = JSON.parse(fs.readFileSync(path.join(TILES, 'world.json'), 'utf8'));
const before = JSON.parse(git('world.json'));
const size = now.tileSize;

const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
const tiles = changed(before.tiles, now.tiles);
const far = changed(before.farFiles, now.farFiles);
const whole = ['world.json', 'far.json.gz', 'map.json.gz', 'far-heights.bin.gz', 'horizon.bin.gz'].filter((f) => {
  const old = git(f), file = path.join(TILES, f);
  return !old || !fs.existsSync(file) || !old.equals(fs.readFileSync(file));
});

// A tile is in an area if it touches the area's box: those edited by hand, and the gardens (their paths, beds and plants)
const gardenFile = path.join(ROOT, 'tools/data/generated/garden.json');
const gardens = fs.existsSync(gardenFile) ? JSON.parse(fs.readFileSync(gardenFile, 'utf8')).areas.map((a) => {
  const xs = a.rings.flatMap((r) => r.filter((_, i) => i % 2 === 0)), zs = a.rings.flatMap((r) => r.filter((_, i) => i % 2 === 1));
  return { name: `${a.name}: its garden (tools/build-garden.mjs)`, box: [Math.min(...xs) - 10, Math.min(...zs) - 10, Math.max(...xs) + 10, Math.max(...zs) + 10] };
}) : [];
// ...and the buildings drawn from models of their own, which leave the map's buildings there out (js/model-sites.js)
const { MODEL_SITES } = await import('../js/model-sites.js');
const sites = MODEL_SITES.filter((s) => !s.debug).map((s) => ({ name: `${s.id}: a model (js/model-sites.js)`, box: [s.x - 80, s.z - 80, s.x + 80, s.z + 80] }));
const areas = [...localAreas(), ...gardens, ...sites];
const inArea = (key) => {
  const [ix, iz] = key.split('_').map(Number);
  const x0 = ix * size, z0 = iz * size, x1 = x0 + size, z1 = z0 + size;
  return areas.find((a) => a.box && x0 < a.box[2] && x1 > a.box[0] && z0 < a.box[3] && z1 > a.box[1]);
};
const outside = tiles.filter((k) => !inArea(k));

console.log(`tiles: ${tiles.length} of ${Object.keys(now.tiles).length} changed against ${against}, ${outside.length} outside the areas edited by hand`);
for (const a of areas) console.log(`  ${a.name}: ${tiles.filter((k) => inArea(k) === a).length} tiles`);
console.log(`far squares: ${far.length} changed${far.length ? ` (${far.join(', ')})` : ''}`);
console.log(`whole-map files changed: ${whole.join(', ') || 'none'}`);
if (list || outside.length <= 20) for (const k of outside) console.log(`  outside: ${k}`);
if (outside.length && !accept) {
  console.error(`${outside.length} tiles changed outside every area in tools/local/: a change reached further than its edits. Run with --accept if that's meant.`);
  process.exit(1);
}
