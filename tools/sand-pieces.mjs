// The pieces of sand and rock tools/build-sand.mjs writes (tools/data/generated/sand.json): [kind, outer, ...holes], flat rings, kind 0
// sand, 1 rock on land, 2 a rock shelf in the sea. What tells the tiles' shores and the gardens' sea walls where a beach is.
import fs from 'node:fs';
import path from 'node:path';

/** The pieces, or none if the file isn't there */
export function loadSand(dir) {
  const file = path.join(dir, 'sand.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).pieces : [];
}

const inFlatRing = (f, x, z) => {
  let c = false;
  for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) {
    if ((f[i + 1] > z) !== (f[j + 1] > z) && x < ((f[j] - f[i]) * (z - f[i + 1])) / (f[j + 1] - f[i + 1]) + f[i]) c = !c;
  }
  return c;
};

/** (x, z) => whether it's on a beach's sand */
export function beachTest(pieces) {
  const cells = new Map();
  for (const [kind, outer, ...holes] of pieces) {
    if (kind !== 0) continue;
    const piece = { outer, holes };
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < outer.length; k += 2) { x0 = Math.min(x0, outer[k]); x1 = Math.max(x1, outer[k]); z0 = Math.min(z0, outer[k + 1]); z1 = Math.max(z1, outer[k + 1]); }
    for (let ix = Math.floor(x0 / 240); ix <= Math.floor(x1 / 240); ix++) {
      for (let iz = Math.floor(z0 / 240); iz <= Math.floor(z1 / 240); iz++) {
        const key = ix * 100000 + iz;
        (cells.get(key) || cells.set(key, []).get(key)).push(piece);
      }
    }
  }
  return (x, z) => (cells.get(Math.floor(x / 240) * 100000 + Math.floor(z / 240)) || [])
    .some((p) => inFlatRing(p.outer, x, z) && !p.holes.some((h) => inFlatRing(h, x, z)));
}

/** Whether a beach lies `inland` m behind the shore at (x, z), the land on `side` of the shore's direction (ux, uz) */
export const beachBehind = (onBeach, x, z, ux, uz, side, inland = 2.5) => onBeach(x - uz * side * inland, z + ux * side * inland);
