// tools/tiles/grade-ground.mjs: how far the ground moves to meet the roads, by the game's own road heights over the tiles just written.
// Roads have their own smooth shapes (tools/build-heights.mjs). At each kerb the ground is at the road's height, and it blends back
// to the terrain over BLEND metres beyond it. Each tile gets a 5 m grid of the difference, so the game's groundHeight() stays a quick
// lookup: working this out as the game runs would be far too slow on a phone.
import fs from 'node:fs';

globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { GEO, heldTiles } = await import('../../js/geodata.js');
const { LINKS, roadHeight } = await import('../../js/surfaces.js');
const { rawTerrainHeight } = await import('../../js/terrain.js');

const { size, cell, unit } = GEO.ground;
const BLEND = 8; // m beyond the kerb
const FAR_BLEND = 16; // ...and where the road is a long way from the terrain, so the bank isn't too steep
const STEEP = 1.5; // m
const CELL = 32;

// Every stretch of shaped road, by cell, as far as its blend can reach
const cells = new Map();
for (const l of LINKS) {
  if (!l.profile) continue;
  const reach = l.half + FAR_BLEND;
  for (let i = 1; i < l.pts.length; i++) {
    const a = l.pts[i - 1], b = l.pts[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) continue;
    const seg = { l, ax: a.x, az: a.z, ux: (b.x - a.x) / len, uz: (b.z - a.z) / len, len };
    for (let ix = Math.floor((Math.min(a.x, b.x) - reach) / CELL); ix <= Math.floor((Math.max(a.x, b.x) + reach) / CELL); ix++) {
      for (let iz = Math.floor((Math.min(a.z, b.z) - reach) / CELL); iz <= Math.floor((Math.max(a.z, b.z) + reach) / CELL); iz++) {
        const k = ix * 100000 + iz;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(seg);
      }
    }
  }
}

const smooth = (t) => t * t * (3 - 2 * t);
function moved(x, z) {
  const terrain = rawTerrainHeight(x, z);
  let sum = 0, weight = 0;
  // Each road once, at its nearest point
  const best = new Map();
  for (const seg of cells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
    const along = Math.max(0, Math.min(seg.len, (x - seg.ax) * seg.ux + (z - seg.az) * seg.uz));
    const px = seg.ax + seg.ux * along, pz = seg.az + seg.uz * along;
    const d = Math.hypot(x - px, z - pz);
    const known = best.get(seg.l);
    if (!known || d < known.d) best.set(seg.l, { d, px, pz });
  }
  for (const [l, { d, px, pz }] of best) {
    const edge = l.half;
    // The road's height at its kerb on this side, or here if this is on the road
    const out = d > edge ? edge / d : 1;
    const y = roadHeight(l, px + (x - px) * out, pz + (z - pz) * out);
    const gap = y - terrain;
    const blend = Math.abs(gap) > STEEP ? FAR_BLEND : BLEND;
    if (d > edge + blend) continue;
    const near = d <= edge ? 1 : 1 - (d - edge) / blend;
    const w = d <= edge ? 1e6 / (d + 0.1) : near ** 3 / (d - edge + 0.05);
    sum += gap * smooth(near) * w;
    weight += w;
  }
  return weight ? sum / weight : 0;
}

const out = {};
let total = 0, movedCells = 0;
for (const tile of heldTiles()) {
  const grid = new Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const q = Math.round(moved(tile.ix * GEO.tileSize + i * cell, tile.iz * GEO.tileSize + j * cell) / unit);
      grid[j * size + i] = q;
      total++;
      if (q) movedCells++;
    }
  }
  out[tile.key] = grid;
}
fs.writeFileSync(process.argv[2], JSON.stringify(out));
console.log(`[ground] ${((movedCells / total) * 100).toFixed(0)}% of the ground moved for the roads`);
