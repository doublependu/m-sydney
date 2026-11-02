import { GEO, TILE, farHeightBytes, onMap } from './geodata.js';

// The ground's height. Sydney has about 50 m of relief, which the simulation never hears about: colliders, traffic and
// people all live on a flat plane, and this lifts what is drawn. Static geometry is lifted once as it is built, moving
// things where their transforms are written. Grades are gentle (86% of road under 6%), so distances stay honest.
//
// Each tile held has its own 20 m grid, reaching a little past its edges so a building or a road on the edge can ask about
// the ground beside it. Elsewhere the coarse grid for the whole map answers.

const { x0, z0, cell, w, h } = GEO.frame.heights;
const { margin, size } = GEO.heights;
const FAR = GEO.far;

// 0.25 m steps as zigzag varint differences along each row
const far = new Float32Array(FAR.w * FAR.h);
{
  let cursor = 0;
  for (let j = 0; j < FAR.h; j++) {
    let v = 0;
    for (let i = 0; i < FAR.w; i++) {
      let z = 0, shift = 0, byte;
      do {
        byte = farHeightBytes[cursor++];
        z |= (byte & 127) << shift;
        shift += 7;
      } while (byte & 128);
      v += (z >>> 1) ^ -(z & 1);
      far[j * FAR.w + i] = v * 0.25;
    }
  }
}

const SLOTS = 4096;
const slotOf = (ix, iz) => ((ix + SLOTS / 2) * SLOTS + iz + SLOTS / 2);
const grids = new Map();
const moved = new Map(); // how far the ground moves to meet the roads, by tile
onMap({
  addTile(tile) {
    // The grid's lines, not the tile's edge, set where its samples lie
    const gx = x0 + Math.ceil((tile.ix * TILE - margin * cell - x0) / cell) * cell;
    const gz = z0 + Math.ceil((tile.iz * TILE - margin * cell - z0) / cell) * cell;
    grids.set(slotOf(tile.ix, tile.iz), { gx, gz, heights: tile.heights });
    if (tile.ground) moved.set(slotOf(tile.ix, tile.iz), { ox: tile.ix * TILE, oz: tile.iz * TILE, cells: tile.ground });
  },
  removeTile(tile) {
    grids.delete(slotOf(tile.ix, tile.iz));
    moved.delete(slotOf(tile.ix, tile.iz));
  }
});

// How far the ground at (x, z) has been moved to meet the roads (tools/tiles/grade-ground.mjs), over a 5 m grid
const G = GEO.ground ?? { size: 0, cell: 5, unit: 0.05 };
let lastMoved = null;
function groundMoved(x, z) {
  let g = lastMoved;
  if (!g || x < g.ox || z < g.oz || x >= g.ox + TILE || z >= g.oz + TILE) {
    g = moved.get(slotOf(Math.floor(x / TILE), Math.floor(z / TILE)));
    if (!g) return 0;
    lastMoved = g;
  }
  const fx = (x - g.ox) / G.cell, fz = (z - g.oz) / G.cell;
  const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
  const k = j * G.size + i, C = g.cells;
  const a = C[k] + (C[k + 1] - C[k]) * tx;
  const b = C[k + G.size] + (C[k + G.size + 1] - C[k + G.size]) * tx;
  return (a + (b - a) * tz) * G.unit;
}

// The last grid asked: most queries in a row fall in one tile
let last = null;
function inGrid(g, x, z) {
  const fx = (x - g.gx) / cell, fz = (z - g.gz) / cell;
  return fx >= 0 && fz >= 0 && fx < size - 1 && fz < size - 1;
}
function sample(g, x, z) {
  const fx = (x - g.gx) / cell, fz = (z - g.gz) / cell;
  const i = fx | 0, j = fz | 0;
  const tx = fx - i, tz = fz - j;
  const k = j * size + i, H = g.heights;
  const a = H[k] + (H[k + 1] - H[k]) * tx;
  const b = H[k + size] + (H[k + size + 1] - H[k + size]) * tx;
  return a + (b - a) * tz;
}

/** The land as surveyed, before it's moved for the roads */
function rawTerrainHeight(x, z) {
  const hx = (x - x0) / cell, hz = (z - z0) / cell;
  if (hx < 0 || hz < 0 || hx >= w - 1 || hz >= h - 1) return 0;
  if (last && inGrid(last, x, z)) return sample(last, x, z);
  const ix = Math.floor(x / TILE), iz = Math.floor(z / TILE);
  let g = grids.get(slotOf(ix, iz));
  if (!g) {
    // A neighbour's margin may reach here
    for (let dx = -1; dx <= 1 && !g; dx++) {
      for (let dz = -1; dz <= 1 && !g; dz++) {
        const n = (dx || dz) && grids.get(slotOf(ix + dx, iz + dz));
        if (n && inGrid(n, x, z)) g = n;
      }
    }
  }
  if (g) {
    last = g;
    return sample(g, x, z);
  }
  const fx = (x - FAR.x0) / FAR.cell, fz = (z - FAR.z0) / FAR.cell;
  if (fx < 0 || fz < 0 || fx >= FAR.w - 1 || fz >= FAR.h - 1) return 0;
  const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * FAR.w + i;
  const a = far[k] + (far[k + 1] - far[k]) * tx;
  const b = far[k + FAR.w] + (far[k + FAR.w + 1] - far[k + FAR.w]) * tx;
  return a + (b - a) * tz;
}

/** The ground's height at (x, z), where everything on it stands */
function terrainHeight(x, z) {
  return rawTerrainHeight(x, z) + groundMoved(x, z);
}

/** Rise per metre at (x, z) heading along (sin, cos) */
function terrainSlope(x, z, sin, cos) {
  return (terrainHeight(x + sin * 2.5, z + cos * 2.5) - terrainHeight(x - sin * 2.5, z - cos * 2.5)) / 5;
}

/** Forgets the grid in use: a tile's going away */
function forgetLastGrid() { last = null; lastMoved = null; }
onMap({ removeTile: forgetLastGrid });

export { groundMoved, rawTerrainHeight, terrainHeight, terrainSlope };
