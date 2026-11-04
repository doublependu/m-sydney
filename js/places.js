// Who lives and works where, and what the land is for: each tile's 100 m grid (tools/tiles/place-grid.mjs), from the ABS 2021
// Census's Mesh Blocks and NSW's land zoning. Traffic and people follow it: a street of houses gets the odd car and a few people
// walking, a shopping strip or the CBD a crowd. Where a tile has no grid (one made before it), nothing here knows: callers keep
// to what they did before.
// Sources: ABS Mesh Block Counts 2021 and ASGS Edition 3 (CC BY 4.0); NSW Department of Planning, Housing and Infrastructure, land zoning (CC BY 4.0).
import { TILE, onMap } from './geodata.js';

const CELL = 100;
const N = TILE / CELL;
// tools/population/places.mjs
const USES = ['', 'residential', 'commercial', 'industrial', 'parkland', 'education', 'hospital', 'transport', 'farm', 'water', 'other'];
const ZONES = ['', 'houses', 'medium', 'flats', 'centre', 'office', 'industry', 'park', 'special', 'water', 'rural'];

const grids = new Map(); // tile key -> { res, dw, jobs, use, zone } as arrays of N * N
onMap({
  addTile(tile) {
    const p = tile.place;
    if (!p) return;
    const digits = (text) => Uint8Array.from(text, (c) => parseInt(c, 36));
    grids.set(`${tile.ix}_${tile.iz}`, { res: Uint16Array.from(p.res), dw: Uint16Array.from(p.dw), jobs: Uint32Array.from(p.jobs), use: digits(p.use), zone: digits(p.zone) });
  },
  removeTile(tile) {
    grids.delete(`${tile.ix}_${tile.iz}`);
  }
});

/** The grid's cell at (x, z): { res, dw, jobs, use, zone } with use and zone as names, or null where no grid is held */
function placeAt(x, z) {
  const ix = Math.floor(x / TILE), iz = Math.floor(z / TILE);
  const g = grids.get(`${ix}_${iz}`);
  if (!g) return null;
  const k = Math.floor(z / CELL - iz * N) * N + Math.floor(x / CELL - ix * N);
  return { res: g.res[k], dw: g.dw[k], jobs: g.jobs[k], use: USES[g.use[k]] || '', zone: ZONES[g.zone[k]] || '' };
}

/**
 * Everyone within `radius` of (x, z), by the cells whose middles are: { res, dw, jobs, cells, known, zones: { name: cells } }.
 * `known` is how many of the cells had a grid; with none, the rest mean nothing.
 */
function placesNear(x, z, radius) {
  const out = { res: 0, dw: 0, jobs: 0, cells: 0, known: 0, zones: {} };
  const r2 = radius * radius;
  for (let cz = Math.floor((z - radius) / CELL); cz <= Math.floor((z + radius) / CELL); cz++) {
    for (let cx = Math.floor((x - radius) / CELL); cx <= Math.floor((x + radius) / CELL); cx++) {
      const mx = (cx + 0.5) * CELL - x, mz = (cz + 0.5) * CELL - z;
      if (mx * mx + mz * mz > r2) continue;
      out.cells++;
      const ix = Math.floor(cx / N), iz = Math.floor(cz / N);
      const g = grids.get(`${ix}_${iz}`);
      if (!g) continue;
      out.known++;
      const k = (cz - iz * N) * N + (cx - ix * N);
      out.res += g.res[k];
      out.dw += g.dw[k];
      out.jobs += g.jobs[k];
      const zone = ZONES[g.zone[k]] || '';
      out.zones[zone] = (out.zones[zone] || 0) + 1;
    }
  }
  return out;
}

// How busy a place is: residents and workers within a street's reach. The CBD has tens of thousands, a street of houses one or two thousand.
const BUSY_REACH = 250;
const BUSY_FULL = 20000; // as busy as it gets, for a street that isn't a main road: the CBD's
/** 0-1, how busy the streets around (x, z) are, or null where no grid is held */
function busyAt(x, z) {
  const near = placesNear(x, z, BUSY_REACH);
  if (!near.known) return null;
  // Cells off the map's grid count as the average of those on it
  const people = ((near.res + near.jobs) * near.cells) / near.known;
  return Math.min(1, people / BUSY_FULL);
}

/** Each held cell: fn(x0, z0, size, { res, dw, jobs, use, zone }), for the map screen's layer (js/city-map.js, ?places=1) */
function eachPlaceCell(fn) {
  for (const [key, g] of grids) {
    const [ix, iz] = key.split('_').map(Number);
    for (let k = 0; k < N * N; k++) {
      fn(ix * TILE + (k % N) * CELL, iz * TILE + Math.floor(k / N) * CELL, CELL, { res: g.res[k], dw: g.dw[k], jobs: g.jobs[k], use: USES[g.use[k]] || '', zone: ZONES[g.zone[k]] || '' });
    }
  }
}
// How many tiles' grids are held: the map screen redraws its layer when it changes
const placeVersion = () => grids.size;

export { BUSY_REACH, USES, ZONES, busyAt, eachPlaceCell, placeAt, placesNear, placeVersion };
