// tools/tiles/grade-ground.mjs: how far the ground moves to meet the roads, by the game's own road heights over the tiles just written.
// Roads have their own smooth shapes (tools/build-heights.mjs). At each kerb the ground is at the road's height, and it blends back
// to the terrain over BLEND metres beyond it. Each tile gets a 5 m grid of the difference, so the game's groundHeight() stays a quick
// lookup: working this out as the game runs would be far too slow on a phone.
// A beach's sand is graded down to the water too: the survey has it a metre or two over the sea where it meets it, which is 2.2 m under
// the survey's zero (js/city-config.js), so the sand would end in a step. The ground under and round a pond the ponds' rule draws is graded
// to its level (tools/tiles/pond-grade.mjs), so its water lies flat and meets its bank, but not within POND_KEEP of a road, which keeps
// its own. And the ground over a tunnel under a cover drawn by hand with a `top` (a land bridge, tools/local/*.json) is raised over the
// tube's ceiling, so the tube can't be seen into from above.
import fs from 'node:fs';

globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { GEO, heldTiles } = await import('../../js/geodata.js');
const { KIND, LINKS, TUNNEL_HEIGHT, roadHeight } = await import('../../js/surfaces.js');
const { localCovers } = await import('../local-edits.mjs');
const { rawTerrainHeight } = await import('../../js/terrain.js');
const { CITY_BOUNDS, landAt } = await import('../../js/city-config.js');
const { generatedPondGrading } = await import('./pond-grade.mjs');

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

// --- Beaches: down to the water at BEACH_SHORE where the sand meets the sea (a shore segment with a beach behind it, tools/build-tiles.mjs),
// rising BEACH_SLOPE a metre inland until it meets the ground as surveyed; never raised. It fades over BEACH_FADE either side of the sand's
// other edges (its ends against rock, its back against the park), and keeps clear of the roads, which keep their own heights.
const BEACH_SHORE = CITY_BOUNDS.waterLevel + 0.1;
const BEACH_SLOPE = 0.08;
const BEACH_REACH = 60; // m from a beach's shore that its grading can reach
const BEACH_FADE = 4;
const ROAD_KEEP = [6, 12]; // m past a road's edge: no grading nearer, all of it past
const SAND_CELL = 32;
const segDist = (x, z, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
  return Math.hypot(ax + dx * t - x, az + dz * t - z);
};
const addToCells = (map, x0, z0, x1, z1, pad, item) => {
  for (let ix = Math.floor((x0 - pad) / SAND_CELL); ix <= Math.floor((x1 + pad) / SAND_CELL); ix++) {
    for (let iz = Math.floor((z0 - pad) / SAND_CELL); iz <= Math.floor((z1 + pad) / SAND_CELL); iz++) {
      const k = ix * 100000 + iz;
      (map.get(k) || map.set(k, []).get(k)).push(item);
    }
  }
};
const beachShores = new Map(), sandPieces = new Map(), sandEdges = new Map();
{
  const shoreSegs = [];
  for (const tile of heldTiles()) {
    for (const s of tile.shore || []) {
      if (s[5] !== 1) continue;
      const seg = s.slice(1, 5);
      shoreSegs.push(seg);
      addToCells(beachShores, Math.min(seg[0], seg[2]), Math.min(seg[1], seg[3]), Math.max(seg[0], seg[2]), Math.max(seg[1], seg[3]), BEACH_REACH, seg);
    }
  }
  const nearShore = (x, z) => (beachShores.get(Math.floor(x / SAND_CELL) * 100000 + Math.floor(z / SAND_CELL)) || [])
    .some(([ax, az, bx, bz]) => segDist(x, z, ax, az, bx, bz) < 3);
  // A piece's edge along a 240 m square's side has more sand past it (tools/build-sand.mjs), and one along the shore is the beach's own
  const onSquareLine = (a, b) => (a % 240 === 0 && a === b);
  for (const tile of heldTiles()) {
    for (const [kind, outer, ...holes] of tile.sand || []) {
      if (kind !== 0) continue;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < outer.length; k += 2) { x0 = Math.min(x0, outer[k]); x1 = Math.max(x1, outer[k]); z0 = Math.min(z0, outer[k + 1]); z1 = Math.max(z1, outer[k + 1]); }
      addToCells(sandPieces, x0, z0, x1, z1, 0, { outer, holes });
      for (const ring of [outer, ...holes]) {
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
          const ax = ring[j], az = ring[j + 1], bx = ring[i], bz = ring[i + 1];
          if (onSquareLine(ax, bx) || onSquareLine(az, bz) || nearShore((ax + bx) / 2, (az + bz) / 2)) continue;
          addToCells(sandEdges, Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), BEACH_FADE, [ax, az, bx, bz]);
        }
      }
    }
  }
  console.log(`[ground] ${shoreSegs.length} stretches of shore at a beach`);
}
const inFlatRing = (f, x, z) => {
  let c = false;
  for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) {
    if ((f[i + 1] > z) !== (f[j + 1] > z) && x < ((f[j] - f[i]) * (z - f[i + 1])) / (f[j + 1] - f[i + 1]) + f[i]) c = !c;
  }
  return c;
};
/** How far the ground at (x, z), now at `ground`, comes down for a beach: 0 or less */
function beachDrop(x, z, ground, roadEdge) {
  const key = Math.floor(x / SAND_CELL) * 100000 + Math.floor(z / SAND_CELL);
  const shores = beachShores.get(key);
  if (!shores) return 0;
  let d = Infinity;
  for (const [ax, az, bx, bz] of shores) d = Math.min(d, segDist(x, z, ax, az, bx, bz));
  if (d > BEACH_REACH) return 0;
  const land = landAt(x, z);
  let w = 1;
  if (land) {
    // Into the sand by how far from its edges, the shore's aside
    const inSand = (sandPieces.get(key) || []).some((p) => inFlatRing(p.outer, x, z) && !p.holes.some((h) => inFlatRing(h, x, z)));
    let edge = Infinity;
    for (const [ax, az, bx, bz] of sandEdges.get(key) || []) edge = Math.min(edge, segDist(x, z, ax, az, bx, bz));
    const into = inSand ? Math.min(edge, BEACH_FADE) : -Math.min(edge, BEACH_FADE);
    w = smooth((into + BEACH_FADE) / (2 * BEACH_FADE));
  }
  w *= smooth(Math.max(0, Math.min(1, (roadEdge - ROAD_KEEP[0]) / (ROAD_KEEP[1] - ROAD_KEEP[0]))));
  if (w <= 0) return 0;
  const target = BEACH_SHORE + BEACH_SLOPE * (land ? d : -d);
  return w * Math.min(0, target - ground);
}

// --- Covers with a `top`: inside the ring, the ground at least `top` m over the ceiling of each tunnel under it (TUNNEL_HEIGHT over its
// road) to LID_FLAT past the tube's edge, then less by LID_SLOPE a metre out to LID_REACH: the 5 m grid's corners round any point over the
// tube hold it up to within 0.16 m, and the bank beside it is no steeper than the grid makes it. Never lowered. Not within LID_MOUTH of
// a tunnel's ends, where its mouth and the cutting before it are (js/tunnel-mouths.js).
const LID_FLAT = 2.5;
const LID_SLOPE = 0.5;
const LID_REACH = 7.5;
const LID_MOUTH = 12;
const lids = localCovers().filter((c) => c.top).map(({ ring, top }) => {
  const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
  const box = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
  const segs = [];
  for (const l of LINKS) {
    if (l.kind !== KIND.TUNNEL) continue;
    const at = [0];
    for (let i = 1; i < l.pts.length; i++) at.push(at[i - 1] + Math.hypot(l.pts[i].x - l.pts[i - 1].x, l.pts[i].z - l.pts[i - 1].z));
    const length = at[at.length - 1], reach = l.half + LID_REACH;
    for (let i = 1; i < l.pts.length; i++) {
      const a = l.pts[i - 1], b = l.pts[i], len = at[i] - at[i - 1];
      if (len < 1e-6 || Math.max(a.x, b.x) < box[0] - reach || Math.min(a.x, b.x) > box[2] + reach || Math.max(a.z, b.z) < box[1] - reach || Math.min(a.z, b.z) > box[3] + reach) continue;
      segs.push({ l, a, b, len, s0: at[i - 1], length, reach });
    }
  }
  return { ring: ring.flat(), top, box, segs };
});
/** How far the ground at (x, z), now at `ground`, comes up over a tube under a cover with a `top`: 0 or more */
function lidRaise(x, z, ground) {
  let raise = 0;
  for (const lid of lids) {
    if (x < lid.box[0] || x > lid.box[2] || z < lid.box[1] || z > lid.box[3] || !inFlatRing(lid.ring, x, z)) continue;
    for (const { l, a, b, len, s0, length, reach } of lid.segs) {
      const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
      const along = Math.max(0, Math.min(len, (x - a.x) * ux + (z - a.z) * uz));
      const d = Math.hypot(a.x + ux * along - x, a.z + uz * along - z);
      if (d > reach) continue;
      const s = s0 + along;
      if (s < LID_MOUTH || s > length - LID_MOUTH) continue;
      const lower = LID_SLOPE * Math.max(0, d - l.half - LID_FLAT);
      raise = Math.max(raise, a.y + ((b.y - a.y) * along) / len + TUNNEL_HEIGHT + lid.top - lower - ground);
    }
  }
  return raise;
}
if (lids.length) console.log(`[ground] ${lids.length} covers over tunnels with a top (tools/local/)`);

// --- Ponds: the ground under and round each graded pond at its level, faded out near a road, which keeps its own ---------------------
const POND_KEEP = [3, 8]; // m past a road's edge: no grading nearer, all of it past
const pondAt = generatedPondGrading();
let pondCells = 0, pondDown = 0, pondUp = 0;
if (pondAt) console.log('[ground] ponds graded to their levels (tools/data/generated/ponds.json)');

const smooth = (t) => t * t * (3 - 2 * t);
function moved(x, z) {
  const terrain = rawTerrainHeight(x, z);
  let sum = 0, weight = 0, roadEdge = Infinity;
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
    roadEdge = Math.min(roadEdge, d - edge);
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
  const roads = weight ? sum / weight : 0;
  let graded = roads + beachDrop(x, z, terrain + roads, roadEdge);
  // On the land only: the ground under the sea beside a pond stays as the beaches leave it
  const pond = pondAt && landAt(x, z) ? pondAt(x, z, terrain + graded) : null;
  if (pond !== null) {
    const keep = roadEdge === Infinity ? 1 : smooth(Math.max(0, Math.min(1, (roadEdge - POND_KEEP[0]) / (POND_KEEP[1] - POND_KEEP[0]))));
    const by = (pond - terrain - graded) * keep;
    graded += by;
    if (Math.abs(by) >= 0.05) { pondCells++; pondDown = Math.min(pondDown, by); pondUp = Math.max(pondUp, by); }
  }
  return lids.length ? graded + lidRaise(x, z, terrain + graded) : graded;
}

const out = {};
let total = 0, movedCells = 0;
for (const tile of heldTiles()) {
  const grid = new Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = tile.ix * GEO.tileSize + i * cell, z = tile.iz * GEO.tileSize + j * cell;
      const q = Math.round(moved(x, z) / unit);
      grid[j * size + i] = q;
      total++;
      if (q) movedCells++;
    }
  }
  out[tile.key] = grid;
}
fs.writeFileSync(process.argv[2], JSON.stringify(out));
console.log(`[ground] ${((movedCells / total) * 100).toFixed(0)}% of the ground moved for the roads`);
if (pondAt) console.log(`[ground] ${pondCells} points of the 5 m grid moved 5 cm or more for the ponds, by ${pondDown.toFixed(2)} to +${pondUp.toFixed(2)} m`);
