// The pieces of still water tools/build-ponds.mjs writes (tools/data/generated/ponds.json): [level, outer, ...holes], flat rings, `level`
// the water's over the survey's zero where it lies flat; and what each pond is ({ keys, name, box, area, level, pieces }). What keeps the
// trees out of them (tools/build-trees.mjs), and tells tools/tile-diff.mjs where they are; and how a pond is cut (cutPond()).
import fs from 'node:fs';
import path from 'node:path';
import { Raster, tiledPolygons } from './geo-common.mjs';

export const SQUARE = 240; // m: the lawns' squares (tools/geo-common.mjs tiledPolygons())
const MIN_CELLS = 16; // m²: smaller scraps are left as they are
const ON_LAND = 0.5; // share of a pond's cells the last build's land must have, or it's still the sea's there
const EDGE_STEP = 2; // m between the points of its edge a pond's level is found from

/** { pieces, ponds }, or none of either if the file isn't there */
export function loadPonds(dir) {
  const file = path.join(dir, 'ponds.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { pieces: [], ponds: [] };
}

const inFlatRing = (f, x, z) => {
  let c = false;
  for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) {
    if ((f[i + 1] > z) !== (f[j + 1] > z) && x < ((f[j] - f[i]) * (z - f[i + 1])) / (f[j + 1] - f[i + 1]) + f[i]) c = !c;
  }
  return c;
};

/** (x, z) => whether it's in a pond's water */
export function pondTest(pieces) {
  const cells = new Map();
  for (const [, outer, ...holes] of pieces) {
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

/** Flips the cells of a raster of their own box inside each of `rings` (an outer ring and its holes, [[x, z], ...]), then ORs them into `into` */
function fillInto(into, rings) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of rings) for (const [x, z] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  x0 = Math.max(x0, into.x0); z0 = Math.max(z0, into.z0);
  x1 = Math.min(x1, into.x0 + into.w * into.res); z1 = Math.min(z1, into.z0 + into.h * into.res);
  if (x1 <= x0 || z1 <= z0) return;
  const own = new Raster(x0, z0, x1, z1, into.res);
  const flip = new Raster(own.x0, own.z0, own.x0 + (own.w - 1) * own.res, own.z0 + (own.h - 1) * own.res, own.res);
  for (const r of rings) {
    flip.d.fill(0);
    flip.fillRing(r, 1);
    for (let i = 0; i < own.d.length; i++) own.d[i] ^= flip.d[i];
  }
  const oi = Math.round((own.x0 - into.x0) / into.res), oj = Math.round((own.z0 - into.z0) / into.res);
  for (let j = 0; j < own.h; j++) {
    const jj = j + oj;
    if (jj < 0 || jj >= into.h) continue;
    for (let i = 0; i < own.w; i++) {
      const ii = i + oi;
      if (ii >= 0 && ii < into.w && own.d[j * own.w + i]) into.d[jj * into.w + ii] = 1;
    }
  }
}

const onSeam = (a, b) => (a[0] === b[0] && a[0] % SQUARE === 0) || (a[1] === b[1] && a[1] % SQUARE === 0);

/**
 * A pond (`waters`: [{ outer, inner }], rings of [x, z], waters that meet), cut to the ground: `groundIn(box)` the curb islands' lawns and
 * paving over a box of whole SQUAREs, [[outer, ...holes]]; `landIn(box)` the land there ({ w, h, d } a cell a metre, as BitRaster.window()
 * gives); `terrainAt(x, z)` the surveyed ground. Returns { sea: true } where the land doesn't have it (less than ON_LAND of its cells), or
 * { pieces: [[outer, ...holes]], level }: its water on the ground, in SQUAREs, and the lowest ground along its edges, every EDGE_STEP m,
 * leaving out the squares' seams.
 */
export function cutPond(waters, { groundIn, landIn, terrainAt }) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const w of waters) for (const r of w.outer) for (const [x, z] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const box = { x0: Math.floor((x0 - 2) / SQUARE) * SQUARE, z0: Math.floor((z0 - 2) / SQUARE) * SQUARE, x1: Math.ceil((x1 + 2) / SQUARE) * SQUARE, z1: Math.ceil((z1 + 2) / SQUARE) * SQUARE };
  const blank = () => new Raster(box.x0, box.z0, box.x1 - 1, box.z1 - 1, 1);
  const water = blank(), ground = blank();
  for (const w of waters) fillInto(water, [...w.outer, ...w.inner]);
  // The same cells as the rest: a window's x1 is its last cell's, not past it
  const land = landIn(box);
  if (land.w !== water.w || land.h !== water.h) throw new Error('the land window and the ponds\' rasters differ');
  let cells = 0, onLand = 0;
  for (let i = 0; i < water.d.length; i++) if (water.d[i]) { cells++; if (land.d[i]) onLand++; }
  if (!cells || onLand / cells < ON_LAND) return { sea: true };
  for (const rings of groundIn(box)) fillInto(ground, rings);
  for (let i = 0; i < water.d.length; i++) water.d[i] = water.d[i] && ground.d[i] && land.d[i] ? 1 : 0;
  water.open(1);
  const pieces = tiledPolygons(water, SQUARE, 0.5, MIN_CELLS, 9, box);
  let level = Infinity;
  for (const rings of pieces) {
    for (const r of rings) {
      for (let i = 0; i < r.length; i++) {
        const a = r[i], c = r[(i + 1) % r.length];
        if (onSeam(a, c)) continue;
        const L = Math.hypot(c[0] - a[0], c[1] - a[1]), n = Math.max(1, Math.ceil(L / EDGE_STEP));
        for (let k = 0; k < n; k++) level = Math.min(level, terrainAt(a[0] + ((c[0] - a[0]) * k) / n, a[1] + ((c[1] - a[1]) * k) / n));
      }
    }
  }
  return { pieces, level };
}
