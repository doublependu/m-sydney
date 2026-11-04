// Each tile's 100 m grid of who lives and works there, and what the land is for (js/places.js reads it). From the Mesh Blocks
// and zoning of tools/build-population.mjs, and for workers, the floor area of the buildings that aren't homes.
import { CELL, USE, ZONE } from '../population/places.mjs';

const SIZE = 1000;
const N = SIZE / CELL;
// Floor area for each worker: offices and shops, then factories and depots, which hold far fewer for their size
const AREA_PER_WORKER = 30;
const AREA_PER_INDUSTRIAL_WORKER = 100;
const STOREY = 3.5;
const WORK_USES = new Set([USE.Commercial, USE.Industrial, USE.Education, USE['Hospital/Medical'], USE.Transport, USE.Other]);
const WORK_ZONES = new Set([ZONE.centre, ZONE.office, ZONE.industry, ZONE.special]);

const ringArea = (ring) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  return Math.abs(a) / 2;
};
const footprint = (b) => b.polygons.reduce((sum, p) => sum + ringArea(p.outer) - p.holes.reduce((h, r) => h + ringArea(r), 0), 0);

/** How many work in a building, by its use, or the land's where it has none. Homes and sheds have none. */
function workersIn(b, places) {
  if (b.kind === 1 || b.kind === 2 || b.kind === 4) return 0;
  const area = footprint(b);
  const floors = Math.max(1, Math.round(((b.height || 0) - (b.bottom || 0)) / STOREY));
  const use = places.blockAt(b.cx, b.cz)?.use || 0, zone = places.zoneAt(b.cx, b.cz);
  const industrial = use === USE.Industrial || zone === ZONE.industry;
  if (b.kind === 3 || b.kind === 5 || WORK_USES.has(use) || WORK_ZONES.has(zone)) return (area * floors) / (industrial ? AREA_PER_INDUSTRIAL_WORKER : AREA_PER_WORKER);
  // A building of no use given among homes: a shop at most, on its ground floor
  return 0;
}

/** Workers in each 100 m cell of the map, from every building: Map of `${i}_${j}` (cell indexes) -> workers */
export function workersByCell(buildings, places) {
  const out = new Map();
  for (const b of buildings) {
    const w = workersIn(b, places);
    if (!w) continue;
    const key = `${Math.floor(b.cx / CELL)}_${Math.floor(b.cz / CELL)}`;
    out.set(key, (out.get(key) || 0) + w);
  }
  return out;
}

const majority = (counts) => {
  let best = 0, most = 0;
  counts.forEach((n, k) => { if (n > most) { most = n; best = k; } });
  return { best, most };
};

/**
 * The grid of tile (ix, iz): { res, dw, jobs } as 100 numbers each, row by row from the tile's north-west corner, and `use` and
 * `zone` as 100 characters each, one base-36 digit a cell (tools/population/places.mjs has what they mean).
 */
export function placeGrid(places, workers, ix, iz) {
  const { frame, mb, zone, blocks } = places;
  const per = frame.cell, fine = CELL / per;
  const res = [], dw = [], jobs = [], uses = [], zones = [];
  const useCounts = new Array(16), zoneCounts = new Array(16);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x0 = ix * SIZE + i * CELL, z0 = iz * SIZE + j * CELL;
      const fi = Math.round((x0 - frame.x0) / per), fj = Math.round((z0 - frame.z0) / per);
      let r = 0, d = 0, zoned = 0;
      useCounts.fill(0);
      zoneCounts.fill(0);
      for (let b = 0; b < fine; b++) {
        for (let a = 0; a < fine; a++) {
          const gi = fi + a, gj = fj + b;
          if (gi < 0 || gj < 0 || gi >= frame.w || gj >= frame.h) continue;
          const k = gj * frame.w + gi;
          const id = mb[k];
          if (id >= 0) {
            const block = blocks[id];
            r += block.persons / block.cells;
            d += block.dwellings / block.cells;
            useCounts[block.use]++;
          }
          if (zone[k]) { zoneCounts[zone[k]]++; zoned++; }
        }
      }
      res.push(Math.round(r));
      dw.push(Math.round(d));
      jobs.push(Math.round(workers.get(`${ix * N + i}_${iz * N + j}`) || 0));
      uses.push(majority(useCounts).best.toString(36));
      // Roads and rail are zoned too, or not at all: a cell takes the zone most of its zoned land has
      zones.push((zoned >= fine * fine * 0.2 ? majority(zoneCounts).best : 0).toString(36));
    }
  }
  return { res, dw, jobs, use: uses.join(''), zone: zones.join('') };
}
