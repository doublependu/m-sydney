// The pieces of still water tools/build-ponds.mjs writes (tools/data/generated/ponds.json): [level, outer, ...holes], flat rings, `level`
// the water's over the survey's zero where it lies flat; and what each pond is ({ keys, name, box, area, level, pieces }, and for a pond
// whose ground is graded to its level, `graded` and `first`, its first piece's index). What keeps the trees out of them
// (tools/build-trees.mjs), tells tools/tile-diff.mjs where they are, and grades the ground to them (tools/tiles/pond-grade.mjs); and how a
// pond is cut (cutPond()).
import fs from 'node:fs';
import path from 'node:path';
import { Raster, tiledPolygons } from './geo-common.mjs';

export const SQUARE = 240; // m: the lawns' squares (tools/geo-common.mjs tiledPolygons())
const MIN_CELLS = 16; // m²: smaller scraps are left as they are
const ON_LAND = 0.5; // share of a pond's cells the last build's land must have, or it's still the sea's there
const EDGE_STEP = 2; // m between the points of its edge a pond's level is found from
// A pond whose level is the survey's (cutPond()'s surveyAt): its water's height where most of it lies, within WINDOW; and the ground over it
// by more than ABOVE, in a patch of HIGH m² or more, isn't its water (a dune or a bank its outline takes in)
const WINDOW = 0.5;
const ABOVE = 1;
const HIGH = 100;
const STEP = { area: 2000, flat: 0.7, within: 0.25 };
// ...and the survey's level is taken only where TRUST of the water left lies within WINDOW of it: a pond on a slope, under trees or reeds,
// or too small for the survey's 5 m cells, has its water anywhere in it, and is left at the lowest ground round its edge, never over its bank
const TRUST = 0.5;

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

/** The middle of the WINDOW m that holds most of `values` (sorted in place): where most of a pond's water lies in the survey */
export function densest(values, window = WINDOW) {
  values.sort((a, b) => a - b);
  let best = 0, at = values[0];
  for (let i = 0, j = 0; i < values.length; i++) {
    while (values[i] - values[j] > window) j++;
    if (i - j + 1 > best) { best = i - j + 1; at = (values[i] + values[j]) / 2; }
  }
  return at;
}

/**
 * A pond's level from the survey, and its water cut back off the ground over it: `water` its cells (a Raster a cell a metre), `terrainAt`
 * the height grid, `surveyAt(x, z)` NSW's 5 m elevation model (null where it has none), which has a lake's water flat at its height and
 * the 20 m height grid hasn't: across a narrow lake the grid has its banks, and round a dam its valley. The level is where most of the
 * water lies in the survey (the grid's, without it), kept between the lowest and highest of the grid along the water's edge. Clears the
 * cells the survey has more than ABOVE over it, in patches of HIGH m² or more; a patch of STEP.area or more that lies flat in the survey
 * is water a step up (one of a golf course's ponds that OSM draws as one), at a level of its own found the same way, and cut back off the
 * ground over that. Returns { level, survey, clipped (m²), steps: [{ cells, level }] }; or { untrusted: true, survey }, with `water` as
 * it was, where less than TRUST of what would be left lies within WINDOW of the level in the survey (or the survey hasn't the pond).
 */
function surveyLevel(water, terrainAt, surveyAt) {
  const { w, h, d, x0, z0, res } = water;
  const at = (k) => [x0 + ((k % w) + 0.5) * res, z0 + (Math.floor(k / w) + 0.5) * res];
  const cells = [], survey = new Float32Array(d.length).fill(NaN);
  for (let k = 0; k < d.length; k++) {
    if (!d[k]) continue;
    cells.push(k);
    const v = surveyAt(...at(k));
    if (v !== null && Number.isFinite(v)) survey[k] = v;
  }
  if (!cells.length) return null;
  const mark = new Uint8Array(d.length);
  const round = (v) => Math.round(v * 100) / 100;
  // The level of the cells `list` (each marked `mark[k] === m`), and the patches over it
  const levelOf = (list, m) => {
    let low = Infinity, high = -Infinity;
    const seen = [];
    const out = (n) => n < 0 || n >= d.length || mark[n] !== m;
    for (const k of list) {
      if (!Number.isNaN(survey[k])) seen.push(survey[k]);
      const i = k % w, j = Math.floor(k / w);
      if (i === 0 || j === 0 || i === w - 1 || j === h - 1 || out(k - 1) || out(k + 1) || out(k - w) || out(k + w)) {
        const g = terrainAt(...at(k));
        low = Math.min(low, g);
        high = Math.max(high, g);
      }
    }
    const surveyed = seen.length >= list.length / 2;
    const middle = surveyed ? densest(seen) : densest(list.map((k) => terrainAt(...at(k))));
    const level = round(Math.max(low, Math.min(high, middle)));
    const patches = [];
    if (!surveyed) return { level, middle: round(middle), patches };
    // The ground over it: each patch of cells joined side by side, kept if it's big enough
    const over = m + 1;
    for (const k of list) if (survey[k] > level + ABOVE) mark[k] = over;
    const stack = [];
    for (const k0 of list) {
      if (mark[k0] !== over) continue;
      const patch = [];
      mark[k0] = over + 1;
      stack.push(k0);
      while (stack.length) {
        const k = stack.pop();
        patch.push(k);
        const i = k % w;
        for (const n of [i > 0 ? k - 1 : -1, i < w - 1 ? k + 1 : -1, k - w, k + w]) {
          if (n >= 0 && n < d.length && mark[n] === over) { mark[n] = over + 1; stack.push(n); }
        }
      }
      if (patch.length * res * res >= HIGH) patches.push(patch);
      else for (const k of patch) mark[k] = m;
    }
    return { level, middle: round(middle), patches };
  };
  for (const k of cells) mark[k] = 1;
  const main = levelOf(cells, 1);
  const off = new Set(main.patches.flat());
  let seen = 0, near = 0;
  for (const k of cells) {
    if (off.has(k) || Number.isNaN(survey[k])) continue;
    seen++;
    if (Math.abs(survey[k] - main.level) <= WINDOW) near++;
  }
  if (near < TRUST * seen || !seen) return { untrusted: true, survey: main.middle };
  let clipped = 0;
  const steps = [];
  for (const patch of main.patches) {
    for (const k of patch) d[k] = 0;
    const values = patch.map((k) => survey[k]);
    const own = densest(values.slice());
    if (patch.length * res * res >= STEP.area && values.filter((v) => Math.abs(v - own) <= STEP.within).length >= STEP.flat * values.length) {
      for (const k of patch) mark[k] = 4;
      const step = levelOf(patch, 4);
      const off = new Set(step.patches.flat());
      clipped += off.size * res * res;
      steps.push({ cells: patch.filter((k) => !off.has(k)), level: step.level });
    } else {
      clipped += patch.length * res * res;
    }
  }
  return { level: main.level, survey: main.middle, clipped, steps };
}

/**
 * A pond (`waters`: [{ outer, inner }], rings of [x, z], waters that meet), cut to the ground: `groundIn(box)` the curb islands' lawns and
 * paving over a box of whole SQUAREs, [[outer, ...holes]]; `landIn(box)` the land there ({ w, h, d } a cell a metre, as BitRaster.window()
 * gives); `terrainAt(x, z)` the surveyed ground. Returns { sea: true } where the land doesn't have it (less than ON_LAND of its cells), or
 * { pieces: [[outer, ...holes]], level }: its water on the ground, in SQUAREs, and the lowest ground along its edges, every EDGE_STEP m,
 * leaving out the squares' seams. With `surveyAt` (NSW's 5 m elevation model, for a pond whose ground is graded to its level), the level
 * is the survey's water instead, and the water is cut back off the ground over it (surveyLevel()): { pieces, level, survey, clipped,
 * steps: [{ pieces, level }] }, steps its water a step up, at levels of their own; where the survey can't be trusted, the lowest ground
 * round its edge, as without it, and `untrusted`.
 */
export function cutPond(waters, { groundIn, landIn, terrainAt, surveyAt = null }) {
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
  const surveyed = surveyAt && surveyLevel(water, terrainAt, surveyAt);
  water.open(1);
  const pieces = tiledPolygons(water, SQUARE, 0.5, MIN_CELLS, 9, box);
  if (surveyed && !surveyed.untrusted) {
    const steps = surveyed.steps.map(({ cells, level }) => {
      const step = blank();
      for (const k of cells) step.d[k] = 1;
      step.open(1);
      return { level, pieces: tiledPolygons(step, SQUARE, 0.5, MIN_CELLS, 9, box) };
    }).filter((step) => step.pieces.length);
    return { pieces, level: surveyed.level, survey: surveyed.survey, clipped: surveyed.clipped, steps };
  }
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
  return surveyed ? { pieces, level, survey: surveyed.survey, clipped: 0, steps: [], untrusted: true } : { pieces, level };
}
