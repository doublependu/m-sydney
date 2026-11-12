// tools/build-sand.mjs: beaches and the rock along the shore, from OpenStreetMap (sand.json, tools/extract-osm.mjs), as pieces drawn over
// the lawn and paving (js/city-grid.js). Writes tools/data/generated/sand.json; tools/build-tiles.mjs cuts it into the tiles and grades a
// beach's ground down to the water (tools/tiles/grade-ground.mjs).
//   node --max-old-space-size=8000 tools/build-sand.mjs
// Kinds: 0 sand (natural=beach, sand or shingle), 1 rock on land (natural=bare_rock, and a strip along each cliff's line), 2 a rock shelf
// in the sea (bare rock where the map has water), drawn flat a little over it. Every beach; the rest only along the coast (COAST), as
// the sandstone of its headlands and the harbour's foreshore: inland cliffs, rock and golf courses' bunkers would change a few hundred
// more tiles for little anyone sees.
// Only where the ground is the curb islands' (the lawns and paving tools/build-geodata.mjs made): never on a road or in the water. Each
// piece is cut to the 240 m squares the lawns are, so it's cheap to triangulate and built only near the player.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BitRaster, Raster, elementRings, flat, inDetail, load, tiledPolygons, toWorld } from './geo-common.mjs';
import { localAreas } from './local-edits.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GENERATED = path.join(ROOT, 'tools/data/generated');
const OUT = path.join(GENERATED, 'sand.json');
const log = (...args) => console.log('[sand]', ...args);
const started = Date.now();

const WINDOW = 960; // m: four of the lawns' 240 m squares, so a window's squares are theirs
const CLIFF = 4; // m either side of a cliff's line that's bare rock: its face on the 20 m height grid
const MIN_CELLS = 16; // m²: smaller scraps are left as they are
const KIND = { beach: 0, sand: 0, shingle: 0, bare_rock: 1 };
const COAST = 150; // m from the shore that rock, cliffs and sand other than a beach are kept

globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { GEO } = await import(path.join(GENERATED, 'geodata.js'));
const landBits = BitRaster.load(path.join(GENERATED, 'land.bin'));

// The shore, by 50 m cell, to tell what's on the coast
const SHORE_CELL = 50;
const shoreCells = new Set();
for (const rings of GEO.shores) for (const r of rings) for (let k = 0; k + 1 < r.length; k += 2) shoreCells.add(`${Math.floor(r[k] / SHORE_CELL)}_${Math.floor(r[k + 1] / SHORE_CELL)}`);
const onCoast = (pts) => {
  const R = Math.ceil(COAST / SHORE_CELL);
  return pts.some(([x, z]) => {
    const ix = Math.floor(x / SHORE_CELL), iz = Math.floor(z / SHORE_CELL);
    for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) if (shoreCells.has(`${ix + a}_${iz + b}`)) return true;
    return false;
  });
};

// --- OSM's areas and cliffs, by the windows they reach ----------------------------------------------------------------------------
const windows = new Map();
const windowOf = (ix, iz) => {
  const key = `${ix}_${iz}`;
  if (!windows.has(key)) windows.set(key, { ix, iz, areas: [], cliffs: [], ground: [] });
  return windows.get(key);
};
const eachWindow = (pts, pad, visit) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  for (let ix = Math.floor((x0 - pad) / WINDOW); ix <= Math.floor((x1 + pad) / WINDOW); ix++) {
    for (let iz = Math.floor((z0 - pad) / WINDOW); iz <= Math.floor((z1 + pad) / WINDOW); iz++) visit(ix, iz);
  }
};
let areas = 0, cliffs = 0;
for (const e of load('sand.json').elements) {
  const t = e.tags || {};
  if (t.natural === 'cliff') {
    if (e.type !== 'way' || !e.geometry) continue;
    const line = e.geometry.map((g) => toWorld(g.lon, g.lat));
    if (!line.some(([x, z]) => inDetail(x, z)) || !onCoast(line)) continue;
    eachWindow(line, CLIFF, (ix, iz) => windowOf(ix, iz).cliffs.push(line));
    cliffs++;
    continue;
  }
  const kind = KIND[t.natural];
  if (kind === undefined) continue;
  // A beach of rock is rock
  const rock = kind === 1 || /^(rock|stone)$/.test(t.surface || '');
  const { outer, inner } = elementRings(e);
  const rings = [...outer, ...inner].filter((r) => r.length > 3);
  if (!rings.length || !rings.some((r) => r.some(([x, z]) => inDetail(x, z)))) continue;
  if (t.natural !== 'beach' && !onCoast(rings.flat())) continue;
  eachWindow(rings.flat(), 0, (ix, iz) => windowOf(ix, iz).areas.push({ rock, rings }));
  areas++;
}
// Rock drawn by hand where OSM has none (tools/local/, `rock`)
for (const area of localAreas()) {
  for (const { ring } of area.rock || []) {
    eachWindow(ring, 0, (ix, iz) => windowOf(ix, iz).areas.push({ rock: true, rings: [ring] }));
    areas++;
  }
}
log(`${areas} areas of sand and rock, ${cliffs} cliffs, in ${windows.size} windows of ${WINDOW} m`);

// The curb islands' ground, by window: each lawn and pavement piece is a 240 m square's or less
for (const list of [GEO.lawns, GEO.pavements]) {
  for (const rings of list) {
    const outer = rings[0];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < outer.length; k += 2) {
      x0 = Math.min(x0, outer[k]); x1 = Math.max(x1, outer[k]); z0 = Math.min(z0, outer[k + 1]); z1 = Math.max(z1, outer[k + 1]);
    }
    for (let ix = Math.floor(x0 / WINDOW); ix <= Math.floor(x1 / WINDOW); ix++) {
      for (let iz = Math.floor(z0 / WINDOW); iz <= Math.floor(z1 / WINDOW); iz++) windows.get(`${ix}_${iz}`)?.ground.push(rings);
    }
  }
}

const pairsOf = (f) => {
  const out = [];
  for (let k = 0; k < f.length; k += 2) out.push([f[k], f[k + 1]]);
  return out;
};
/** ORs `rings` (an outer ring and its holes, even-odd) into `into`, through a raster of their own box so holes clear only their own */
function fillInto(into, rings) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of rings) for (const [x, z] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  x0 = Math.max(x0, into.x0); z0 = Math.max(z0, into.z0);
  x1 = Math.min(x1, into.x0 + into.w * into.res); z1 = Math.min(z1, into.z0 + into.h * into.res);
  if (x1 <= x0 || z1 <= z0) return;
  const own = new Raster(x0, z0, x1, z1, into.res);
  evenOdd(own, rings);
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
function evenOdd(raster, rings) {
  // Each ring flips the cells inside it, so a hole inside its outer ring comes out empty
  const flip = new Raster(raster.x0, raster.z0, raster.x0 + (raster.w - 1) * raster.res, raster.z0 + (raster.h - 1) * raster.res, raster.res);
  for (const r of rings) {
    flip.d.fill(0);
    flip.fillRing(r, 1);
    for (let i = 0; i < raster.d.length; i++) raster.d[i] ^= flip.d[i];
  }
}

// --- Each window: sand and rock where the ground is, shelves where the sea is ----------------------------------------------------
const pieces = [];
const counts = [0, 0, 0], area = [0, 0, 0];
for (const w of windows.values()) {
  if (!w.areas.length && !w.cliffs.length) continue;
  const box = { x0: w.ix * WINDOW, z0: w.iz * WINDOW, x1: (w.ix + 1) * WINDOW, z1: (w.iz + 1) * WINDOW };
  const blank = () => new Raster(box.x0, box.z0, box.x1 - 1, box.z1 - 1, 1);
  const ground = blank(), sand = blank(), rock = blank();
  for (const rings of w.ground) fillInto(ground, rings.map(pairsOf));
  for (const a of w.areas) fillInto(a.rock ? rock : sand, a.rings);
  const cliff = blank();
  for (const line of w.cliffs) for (let i = 1; i < line.length; i++) cliff.stampSegment(...line[i - 1], ...line[i], CLIFF, 1);
  // The same cells as the rest: a window's x1 is its last cell's, not past it
  const land = landBits.window({ x0: box.x0, z0: box.z0, x1: box.x1 - 1, z1: box.z1 - 1 });
  if (land.w !== ground.w || land.h !== ground.h) throw new Error('the land window and the pieces\' rasters differ');
  const out = [blank(), blank(), blank()];
  for (let i = 0; i < ground.d.length; i++) {
    const onGround = ground.d[i] && land.d[i];
    if (onGround && (rock.d[i] || cliff.d[i])) out[1].d[i] = 1;
    else if (onGround && sand.d[i]) out[0].d[i] = 1;
    else if (!land.d[i] && rock.d[i]) out[2].d[i] = 1;
  }
  for (let kind = 0; kind < 3; kind++) {
    const r = out[kind];
    r.open(1);
    for (const rings of tiledPolygons(r, 240, 0.5, MIN_CELLS, 9, box)) {
      pieces.push([kind, ...rings.map(flat)]);
      counts[kind]++;
      for (const [k, ring] of rings.entries()) {
        let a = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
        area[kind] += (k ? -1 : 1) * Math.abs(a / 2);
      }
    }
  }
}
log(`${counts[0]} pieces of sand (${(area[0] / 1e4).toFixed(1)} ha), ${counts[1]} of rock (${(area[1] / 1e4).toFixed(1)} ha), ${counts[2]} shelves in the sea (${(area[2] / 1e4).toFixed(1)} ha)`);
fs.writeFileSync(OUT, JSON.stringify({ pieces }));
log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
