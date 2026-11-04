// Moves tiles, far files and map images made before they went into folders (js/tiles/paths.js) to where they go now, without
// rebuilding the map. The generators write to the folders themselves, so this is only for files from before that.
// usage: node tools/tiles/move-to-folders.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { farFile, mapImageFile, tileFile } from '../../js/tiles/paths.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const move = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
};
let moved = 0;
const tiles = path.join(ROOT, 'public/tiles');
for (const name of fs.readdirSync(tiles)) {
  const tile = name.match(/^(-?\d+_-?\d+)\.([0-9a-f]+)\.bin\.gz$/);
  const far = name.match(/^far_(-?\d+_-?\d+)\.([0-9a-f]+)\.bin\.gz$/);
  if (tile) move(path.join(tiles, name), path.join(tiles, tileFile(tile[1], tile[2])));
  else if (far) move(path.join(tiles, name), path.join(tiles, farFile(far[1], far[2])));
  else continue;
  moved++;
}
const map = path.join(ROOT, 'public/map');
for (const m of [2, 8, 32]) {
  const dir = path.join(map, String(m));
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    const image = name.match(/^(-?\d+)_(-?\d+)\.webp$/);
    if (!image) continue;
    const to = path.join(map, mapImageFile(m, +image[1], +image[2]));
    if (to === path.join(dir, name)) continue;
    move(path.join(dir, name), to);
    moved++;
  }
}
console.log(`moved ${moved} files`);
