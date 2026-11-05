// tools/build-tiles.mjs: cuts the generated map (tools/data/generated/, from npm run data:build) into 1 km tiles in
// public/tiles/, and world.json for what the whole map shares, so the game can fetch only what's near the player. A road
// crossing tiles is in each of them, by the same id. Every file's name has a hash of its contents, so a tile that hasn't
// changed stays in players' caches.
//
// It runs in two passes. What needs the ground and the roads together (tunnels' open ends, each building's floor) is worked
// out by the game's own code, run over the first pass's files (tools/tiles/derive.mjs), and written into the second's.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { BitRaster, flat, rdp } from './geo-common.mjs';
import { onRegionEdge } from './geodata/regions.mjs';
import { farFile, tileFile } from '../js/tiles/paths.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC = path.join(ROOT, 'tools/data/generated');
const OUT = path.join(ROOT, 'public/tiles');
const DERIVED = path.join(SRC, 'derived.json');
const SIZE = 1000;
const MARGIN = 3; // cells of the height grid past each edge, for what stands on the edge
const GROUND = { size: SIZE / 5 + 1, cell: 5, unit: 0.05 }; // the ground beside the roads: a grid per tile
const KEY = (ix, iz) => `${ix}_${iz}`;
const tileOf = (x, z) => [Math.floor(x / SIZE), Math.floor(z / SIZE)];

const started = Date.now();
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { GEO } = await import(path.join(SRC, 'geodata.js'));
const { AWNINGS } = await import(path.join(SRC, 'awning-geodata.js'));
const { ROAD_TAGS } = await import(path.join(SRC, 'road-tags.js'));
const { REAL_BUILDINGS } = await import(path.join(SRC, 'building-geodata.js'));
const { REAL_TREES, TREE_KINDS, TREE_HEIGHTS } = await import(path.join(SRC, 'tree-geodata.js'));

const RG = GEO.roadGraph;
const KIND_CUTTING = 3;
// Who lives and works where (tools/build-population.mjs), for each tile's 100 m grid
const PLACES_FILE = path.join(SRC, 'places.bin.gz');
const PLACES = fs.existsSync(PLACES_FILE) ? (await import('./population/places.mjs')).loadPlaces(PLACES_FILE) : null;
if (!PLACES) console.warn('[tiles] no places.bin.gz: tiles have no grid of residents and land use (node tools/build-population.mjs)');
const { placeGrid, workersByCell } = await import('./tiles/place-grid.mjs');
// Tunnels side by side, moved apart to make room for a wall between them (tools/tiles/separate-tubes.mjs)
{
  const { separateTubes } = await import('./tiles/separate-tubes.mjs');
  const s = separateTubes(RG);
  console.log(`[tiles] tunnels: ${s.before} m inside another tube, ${s.after} m once ${s.links} links were moved apart`);
}
// Every road, node and structure keeps the id the last build gave it, so a change in one place rewrites only the tiles around it
// (tools/tiles/stable-ids.mjs). From the tiles in public/tiles, before they're replaced. --fresh-ids numbers them all afresh.
const STABLE = await (async () => {
  const { previousIds, stableBlockIds, stableIds } = await import('./tiles/stable-ids.mjs');
  const prev = process.argv.includes('--fresh-ids') ? null : previousIds(OUT);
  if (!prev) {
    console.warn('[tiles] ids numbered afresh: no whole build in public/tiles to keep them from');
    return null;
  }
  const stable = stableIds(RG, prev);
  stable.blocks = stableBlockIds(GEO.blocks, prev);
  console.log(`[tiles] ids: ${stable.report()}; ${stable.blocks.report}`);
  return stable;
})();

// Structures: links off the ground, joined where they share a node (js/surfaces.js reads this table)
function findStructures() {
  const parent = new Map();
  const find = (n) => {
    let r = n;
    while (parent.get(r) !== r) r = parent.get(r);
    return r;
  };
  const off = (l) => (l && l[9] && l[9] !== KIND_CUTTING && l[12] ? l[9] : 0);
  // Bridges join bridges and tunnels tunnels: one of each meeting at a node are two structures. Before plan 5 they were one, and a
  // tunnel anywhere in it made all of it a tunnel: the Cahill's viaduct over Circular Quay, for its short tunnel at The Rocks.
  const at = (l, n) => `${off(l)}:${n}`;
  for (const l of RG.links) if (off(l)) for (const n of [at(l, l[0]), at(l, l[1])]) if (!parent.has(n)) parent.set(n, n);
  for (const l of RG.links) if (off(l)) parent.set(find(at(l, l[0])), find(at(l, l[1])));
  // Each structure's roads, in the order they're met; its id the one it had (STABLE), or the next
  const members = new Map();
  RG.links.forEach((l, id) => {
    if (!off(l)) return;
    const root = find(at(l, l[0]));
    (members.get(root) || members.set(root, []).get(root)).push(id);
  });
  const table = [null], sid = new Map();
  for (const ids of members.values()) {
    const s = STABLE ? STABLE.sidFor(ids) : table.length;
    while (table.length <= s) table.push(null);
    const entry = (table[s] = [off(RG.links[ids[0]]), 0, 0]);
    for (const id of ids) {
      const l = RG.links[id];
      sid.set(id, s);
      if (l[8]) entry[1] = 1;
      if ((l[11] || 0) & 1) entry[2] = 1;
      if (off(l) === 2) entry[0] = 2;
    }
  }
  return { table, sid };
}

function cutMap(derived) {
  const tiles = new Map();
  const tile = (ix, iz) => {
    const key = KEY(ix, iz);
    if (!tiles.has(key)) {
      tiles.set(key, { ix, iz, blocks: [], lawns: [], pavements: [], fills: [], signals: [], postBoxes: [], busShelters: [], nodes: new Map(), links: [], home: [],
        scenery: [], awnings: [], tags: { buses: [], cycles: [], cycleways: [], speeds: [], oneways: [], zebras: [], directions: [] }, buildings: [], trees: [] });
    }
    return tiles.get(key);
  };
  const at = (x, z) => tile(...tileOf(x, z));

  // --- Things that are in one place ----------------------------------------------------------------------------------
  GEO.blocks.forEach((b, i) => {
    const flat = b[0], m = (flat.length >> 2) << 1; // the middle point of its outline
    at(flat[m], flat[m + 1]).blocks.push([...b.slice(0, 4), STABLE ? STABLE.blocks.ids[i] : i]);
  });
  const ringsHome = (rings) => {
    const flat = rings[0], m = (flat.length >> 2) << 1;
    return at(flat[m], flat[m + 1]);
  };
  for (const rings of GEO.lawns) ringsHome(rings).lawns.push(rings);
  for (const rings of GEO.pavements) ringsHome(rings).pavements.push(rings);
  for (const flat of GEO.fills) at(flat[0], flat[1]).fills.push(flat);
  const pairs = (list, field) => { for (let i = 0; i + 1 < list.length; i += 2) at(list[i], list[i + 1])[field].push(list[i], list[i + 1]); };
  pairs(GEO.signals, 'signals');
  pairs(GEO.postBoxes, 'postBoxes');
  pairs(GEO.busShelters, 'busShelters');

  // --- Lines: each segment goes with the tile its middle is in, in runs -------------------------------------------------
  function cut(flat, add) {
    let run = null, current = null;
    for (let i = 0; i + 3 < flat.length; i += 2) {
      const t = at((flat[i] + flat[i + 2]) / 2, (flat[i + 1] + flat[i + 3]) / 2);
      if (t !== current) {
        if (run) add(current, run);
        current = t;
        run = [flat[i], flat[i + 1]];
      }
      run.push(flat[i + 2], flat[i + 3]);
    }
    if (run) add(current, run);
  }
  for (const [name, kind, flat] of GEO.scenery) cut(flat, (t, run) => t.scenery.push([name, kind, run]));
  for (const [kind, ...flat] of AWNINGS) cut(flat, (t, run) => t.awnings.push([kind, ...run]));
  for (const flat of ROAD_TAGS.buses) cut(flat, (t, run) => t.tags.buses.push(run));
  for (const [side, ...flat] of ROAD_TAGS.cycles) cut(flat, (t, run) => t.tags.cycles.push([side, ...run]));
  for (const flat of ROAD_TAGS.cycleways) cut(flat, (t, run) => t.tags.cycleways.push(run));
  for (const s of ROAD_TAGS.speeds) at(s[1], s[2]).tags.speeds.push(s);
  for (let i = 0; i + 3 < ROAD_TAGS.oneways.length; i += 4) at(ROAD_TAGS.oneways[i], ROAD_TAGS.oneways[i + 1]).tags.oneways.push(...ROAD_TAGS.oneways.slice(i, i + 4));
  for (let i = 0; i + 1 < ROAD_TAGS.zebras.length; i += 2) at(ROAD_TAGS.zebras[i], ROAD_TAGS.zebras[i + 1]).tags.zebras.push(ROAD_TAGS.zebras[i], ROAD_TAGS.zebras[i + 1]);
  for (const d of ROAD_TAGS.directions) at(d[1], d[2]).tags.directions.push(d);

  // --- Roads: a link is in every tile within reach of it, with its id --------------------------------------------------
  const REACH = 40; // m: wide enough for a cutting's slope and a junction's disc beside the road
  const { table, sid } = findStructures();
  RG.links.forEach((l, id) => {
    const [a, b, ni, width, lanes, dir, inner, major, deck, kind = 0, layer = 0, flags = 0, ys = null, profile = null, lean = null] = l;
    const pts = [[RG.nodes[a * 2], RG.nodes[a * 2 + 1]]];
    for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k + 1]]);
    pts.push([RG.nodes[b * 2], RG.nodes[b * 2 + 1]]);
    const homes = new Set();
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    let walked = 0, middle = null;
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      const s = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.ceil(s / 25));
      for (let k = 0; k <= steps; k++) {
        const x = ax + ((bx - ax) * k) / steps, z = az + ((bz - az) * k) / steps;
        for (const [dx, dz] of [[0, 0], [REACH, 0], [-REACH, 0], [0, REACH], [0, -REACH]]) homes.add(KEY(...tileOf(x + dx, z + dz)));
      }
      if (middle === null && walked + s >= L / 2) {
        const t = s ? (L / 2 - walked) / s : 0;
        middle = [ax + (bx - ax) * t, az + (bz - az) * t];
      }
      walked += s;
    }
    const open = derived?.tunnels?.[id] || [0, 0, 0];
    // The name itself: each tile's file stands alone
    const record = [id, a, b, RG.names[ni], width, lanes, dir, inner, major ? 1 : 0, deck ? 1 : 0, kind, layer, flags, ys, sid.get(id) || 0, ...open, profile, lean];
    for (const key of homes) {
      const [ix, iz] = key.split('_').map(Number);
      const t = tile(ix, iz);
      t.links.push(record);
      t.nodes.set(a, [RG.nodes[a * 2], RG.nodes[a * 2 + 1]]);
      t.nodes.set(b, [RG.nodes[b * 2], RG.nodes[b * 2 + 1]]);
    }
    at(...(middle || pts[0])).home.push(id);
  });

  // --- Buildings and trees ---------------------------------------------------------------------------------------------
  // The pieces of one building stay together, in the tile of its lowest piece: they share a look and a floor
  const pieceHome = new Map();
  for (const b of REAL_BUILDINGS) if (b.group && !b.bottom) pieceHome.set(b.group, [b.cx, b.cz]);
  // Left out: under a landmark's own model, or under a deck with no room (tools/tiles/derive.mjs)
  const skip = new Set([...(derived?.underLandmarks || []), ...(derived?.dropped || [])]);
  REAL_BUILDINGS.forEach((b, i) => {
    if (skip.has(i)) return;
    const [hx, hz] = (b.group && pieceHome.get(b.group)) || [b.cx, b.cz];
    at(hx, hz).buildings.push({ b, i });
  });
  const noTree = new Set(derived?.treesUnder || []);
  for (let i = 0; i < TREE_KINDS.length; i++) if (!noTree.has(i)) at(REAL_TREES[i * 2], REAL_TREES[i * 2 + 1]).trees.push(i);
  return { tiles, table };
}

const uint = (out, v) => { while (v > 127) { out.push((v & 127) | 128); v = Math.floor(v / 128); } out.push(v); };
const sint = (out, v) => uint(out, v >= 0 ? v * 2 : -v * 2 - 1);
function packBuildings(list, floors) {
  const meta = [], xs = [], zs = [];
  let px = 0, pz = 0;
  uint(meta, list.length);
  for (const { b, i } of list) {
    uint(meta, b.height);
    uint(meta, b.kind | (b.pitched ? 8 : 0) | (b.group ? 16 : 0) | (b.realAwning ? 32 : 0) | ((b.houseStyle || 0) << 7));
    if (b.group) { uint(meta, b.group); uint(meta, b.bottom || 0); }
    const [floor, low] = floors?.[i] || [0, 0];
    sint(meta, floor);
    sint(meta, low);
    uint(meta, b.polygons.length);
    for (const polygon of b.polygons) {
      const rings = [polygon.outer, ...polygon.holes];
      uint(meta, rings.length);
      for (const ring of rings) {
        uint(meta, ring.length);
        for (const p of ring) {
          const x = Math.round(p.x * 2), z = Math.round(p.z * 2);
          sint(xs, x - px);
          sint(zs, z - pz);
          px = x;
          pz = z;
        }
      }
    }
  }
  const head = [];
  uint(head, meta.length);
  uint(head, xs.length);
  uint(head, zs.length);
  return Buffer.from([...head, ...meta, ...xs, ...zs]);
}
function packTrees(list) {
  const out = [];
  let px = 0, pz = 0;
  uint(out, list.length);
  for (const i of list) {
    const x = Math.round(REAL_TREES[i * 2] * 2), z = Math.round(REAL_TREES[i * 2 + 1] * 2);
    sint(out, x - px);
    sint(out, z - pz);
    px = x;
    pz = z;
    out.push(TREE_KINDS[i], TREE_HEIGHTS[i]);
  }
  return Buffer.from(out);
}

// The height grid, on 20 m cells, in 0.25 m steps
const H = GEO.frame.heights;
const grid = new Int32Array(H.w * H.h);
{
  const data = zlib.gunzipSync(fs.readFileSync(path.join(SRC, 'height-grid.bin.gz')));
  let cursor = 0;
  for (let j = 0; j < H.h; j++) {
    let v = 0;
    for (let i = 0; i < H.w; i++) {
      let z = 0, shift = 0, byte;
      do { byte = data[cursor++]; z |= (byte & 127) << shift; shift += 7; } while (byte & 128);
      v += (z >>> 1) ^ -(z & 1);
      grid[j * H.w + i] = v;
    }
  }
}
const gridAt = (x, z) => {
  const i = Math.max(0, Math.min(H.w - 1, Math.round((x - H.x0) / H.cell))), j = Math.max(0, Math.min(H.h - 1, Math.round((z - H.z0) / H.cell)));
  return grid[j * H.w + i];
};
const SAMPLES = SIZE / H.cell + 1 + MARGIN * 2;
function packHeights(ix, iz) {
  const gx = H.x0 + Math.ceil((ix * SIZE - MARGIN * H.cell - H.x0) / H.cell) * H.cell;
  const gz = H.z0 + Math.ceil((iz * SIZE - MARGIN * H.cell - H.z0) / H.cell) * H.cell;
  const out = [];
  for (let j = 0; j < SAMPLES; j++) {
    let v = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const q = gridAt(gx + i * H.cell, gz + j * H.cell);
      sint(out, q - v);
      v = q;
    }
  }
  return Buffer.from(out);
}
// The whole grid again, coarser, for what's beyond the tiles held: 80 m cells
// A very coarse grid for the whole map, fetched at the start, for where nothing better is held. Each far file has a finer one for its square.
const FAR = { x0: H.x0, z0: H.z0, cell: 400, w: Math.floor(((H.w - 1) * H.cell) / 400) + 1, h: Math.floor(((H.h - 1) * H.cell) / 400) + 1 };
function packFarHeights() {
  const out = [];
  for (let j = 0; j < FAR.h; j++) {
    let v = 0;
    for (let i = 0; i < FAR.w; i++) {
      const q = gridAt(FAR.x0 + i * FAR.cell, FAR.z0 + j * FAR.cell);
      sint(out, q - v);
      v = q;
    }
  }
  return zlib.gzipSync(Buffer.from(out), { level: 9 });
}

// The far level: for each 4 km square, every building as a few points and a height (js/building-outlines.js), how green each
// 100 m of the ground is, and the main roads. Beyond the tiles held, this is the city.
const FAR_FILE = 4000;
const farKeyOfTile = (ix, iz) => KEY(Math.floor((ix * SIZE) / FAR_FILE), Math.floor((iz * SIZE) / FAR_FILE));
// Where the land is, in runs along rows: [from, to, from, to...] in metres from the left of the square, or 1 if all of it is and 0 if none
const landBits = BitRaster.load(path.join(SRC, 'land.bin'));
function landRuns(x0, z0, size, rowStep, cellStep) {
  const rows = [];
  let cells = 0, land = 0;
  for (let k = 0; k * rowStep < size; k++) {
    const z = z0 + (k + 0.5) * rowStep;
    const row = [];
    let on = false;
    for (let c = 0; c * cellStep < size; c++) {
      const here = landBits.at(x0 + (c + 0.5) * cellStep, z) === 1;
      cells++;
      if (here) land++;
      if (here !== on) { row.push(c * cellStep); on = here; }
    }
    if (on) row.push(size);
    rows.push(row);
  }
  return land === cells ? 1 : land === 0 ? 0 : rows;
}
const tileLand = new Map();
const landOfTile = (ix, iz) => {
  const key = KEY(ix, iz);
  if (!tileLand.has(key)) tileLand.set(key, landRuns(ix * SIZE, iz * SIZE, SIZE, 2, 1));
  return tileLand.get(key);
};
// The shore a segment at a time, each in the tile it starts in, with which side the land's on. Not where a region's edge cut the land.
function shoreByTile() {
  const out = new Map();
  for (const rings of GEO.shores) {
    for (const flatRing of rings) {
      const ring = [];
      for (let k = 0; k < flatRing.length; k += 2) ring.push([flatRing[k], flatRing[k + 1]]);
      let area = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      const side = area > 0 ? 1 : -1;
      for (let i = 0; i < ring.length; i++) {
        const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
        if (onRegionEdge(ax, az, bx, bz)) continue;
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 30));
        for (let k = 0; k < n; k++) {
          const px = ax + ((bx - ax) * k) / n, pz = az + ((bz - az) * k) / n, qx = ax + ((bx - ax) * (k + 1)) / n, qz = az + ((bz - az) * (k + 1)) / n;
          const key = KEY(...tileOf(px, pz));
          if (!out.has(key)) out.set(key, []);
          out.get(key).push([side, Math.round(px * 10) / 10, Math.round(pz * 10) / 10, Math.round(qx * 10) / 10, Math.round(qz * 10) / 10]);
        }
      }
    }
  }
  return out;
}
const shores = shoreByTile();

function packFarFile(entries, parks, roads, derived, key) {
  const meta = [], xs = [], zs = [];
  let px = 0, pz = 0, count = 0;
  for (const { b, i, ix, iz } of entries) {
    const look = derived?.looks?.[i];
    if (!look) continue;
    count++;
    const [floor, low] = derived.floors[i];
    uint(meta, b.height + (look[3] || 0)); // a pitched roof's middle (tools/tiles/derive.mjs)
    uint(meta, b.bottom || 0);
    sint(meta, floor);
    sint(meta, low);
    uint(meta, look[0]);
    uint(meta, look[1]);
    sint(meta, ix);
    sint(meta, iz);
    const rings = look[2];
    uint(meta, rings.length);
    for (const ring of rings) {
      uint(meta, ring.length / 2);
      for (let k = 0; k < ring.length; k += 2) {
        sint(xs, ring[k] - px);
        sint(zs, ring[k + 1] - pz);
        px = ring[k];
        pz = ring[k + 1];
      }
    }
  }
  const head = [];
  uint(head, count);
  uint(head, meta.length);
  uint(head, xs.length);
  uint(head, zs.length);
  // Its own ground: 80 m heights in 0.25 m steps, and where the land is
  const [fx, fz] = key.split('_').map(Number);
  const grid = [];
  for (let j = 0; j <= FAR_FILE / 80; j++) for (let i = 0; i <= FAR_FILE / 80; i++) grid.push(gridAt(fx * FAR_FILE + i * 80, fz * FAR_FILE + j * 80));
  const land = landRuns(fx * FAR_FILE, fz * FAR_FILE, FAR_FILE, 20, 5);
  const json = Buffer.from(JSON.stringify({ parks, roads, grid, land }));
  const lead = Buffer.alloc(8);
  lead.writeUInt32LE(json.length, 0);
  lead.writeUInt32LE(head.length, 4);
  return zlib.gzipSync(Buffer.concat([lead, json, Buffer.from(head), Buffer.from(meta), Buffer.from(xs), Buffer.from(zs)]), { level: 9 });
}

// What the map screen draws, all of it: fetched when the map is first opened
// All of the map, for drawing the map screen's images (tools/build-map-images.mjs). Not deployed.
function packFullMap() {
  const roads = RG.links.filter(Boolean).map((l) => {
    const [a, b, ni, w, lanes, dir, inner, major, , kind = 0] = l;
    return [RG.names[ni], w, lanes, dir, major ? 1 : 0, kind, [RG.nodes[a * 2], RG.nodes[a * 2 + 1], ...inner, RG.nodes[b * 2], RG.nodes[b * 2 + 1]]];
  });
  return zlib.gzipSync(JSON.stringify({ roads, scenery: GEO.scenery, shores: GEO.shores, blocks: GEO.blocks.map(([flat, holes, park, parkName]) => [flat, holes, park, parkName]) }), { level: 9 });
}
// What the map screen fetches when it's first opened: where every named street is, for its names and for searching. Links of a street are
// strung together and simplified.
function packStreetIndex() {
  const groups = new Map();
  for (const l of RG.links) {
    if (!l) continue; // a road that's gone keeps its id unused (tools/tiles/stable-ids.mjs)
    const [a, b, ni, , , , inner, major, , kind = 0] = l;
    if (!RG.names[ni]) continue;
    const key = `${ni}|${major ? 1 : 0}|${kind}`;
    if (!groups.has(key)) groups.set(key, { name: RG.names[ni], major: major ? 1 : 0, kind, links: [] });
    const pts = [[RG.nodes[a * 2], RG.nodes[a * 2 + 1]]];
    for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k + 1]]);
    pts.push([RG.nodes[b * 2], RG.nodes[b * 2 + 1]]);
    groups.get(key).links.push({ a, b, pts, used: false });
  }
  const roads = [];
  for (const { name, major, kind, links } of groups.values()) {
    const at = new Map();
    for (const l of links) for (const n of [l.a, l.b]) (at.get(n) || at.set(n, []).get(n)).push(l);
    const walk = (l, from) => {
      let pts = [], node = from, link = l;
      while (link && !link.used) {
        link.used = true;
        const forward = link.a === node;
        const part = forward ? link.pts : [...link.pts].reverse();
        pts = pts.concat(pts.length ? part.slice(1) : part);
        node = forward ? link.b : link.a;
        link = (at.get(node) || []).find((o) => !o.used);
      }
      return pts;
    };
    // From the loose ends first, so a street comes out as one line
    for (const l of links) for (const n of [l.a, l.b]) if (!l.used && at.get(n).length === 1) roads.push([name, 0, 0, 0, major, kind, flat(rdp(walk(l, n), 8))]);
    for (const l of links) if (!l.used) roads.push([name, 0, 0, 0, major, kind, flat(rdp(walk(l, l.a), 8))]);
  }
  const whole = (list) => list.map((v) => Math.round(v));
  return zlib.gzipSync(JSON.stringify({ roads: roads.map((r) => [...r.slice(0, 6), whole(r[6])]), scenery: GEO.scenery }), { level: 9 });
}

// The links the Harbour Bridge's model stands among
function bridgeLinks(derived) {
  const { sid } = findStructures();
  const deckSid = [...sid.keys()].find((id) => RG.links[id][8]);
  const line = [];
  for (let i = 0; i + 1 < GEO.bridge.length; i += 2) line.push([GEO.bridge[i], GEO.bridge[i + 1]]);
  const near = (x, z) => line.some(([lx, lz]) => Math.hypot(lx - x, lz - z) < 400);
  const out = [];
  RG.links.forEach((l, id) => {
    const [a, b, , width, , , inner, , deck] = l;
    const pts = [[RG.nodes[a * 2], RG.nodes[a * 2 + 1]]];
    for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k + 1]]);
    pts.push([RG.nodes[b * 2], RG.nodes[b * 2 + 1]]);
    if (!pts.some(([x, z]) => near(x, z))) return;
    out.push([id, pts.flat(), width, deck ? 1 : 0, sid.get(id) === sid.get(deckSid) ? 1 : 0, l[12] || null, l[9] || 0, l[4] || 0, l[5] || 0]);
  });
  return out;
}

// How far the bridge's deck reaches across, every DECK_SPAN_STEP m along the corridor: west (negative) and east (positive) of its line,
// as far as any of the deck's roads' lanes do (js/bridge.js). Needed from the start, by everything that asks whether it's on the deck.
// `gap`: where the lane furthest east runs apart from the rest, the Cahill's through the east pylons, [from, to], or 0.
const DECK_SPAN_STEP = 10;
function deckSpan() {
  const path = [];
  for (let i = 0; i < GEO.bridge.length; i += 2) path.push({ x: GEO.bridge[i], z: GEO.bridge[i + 1], s: 0 });
  for (let i = 1; i < path.length; i++) path[i].s = path[i - 1].s + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
  const length = path[path.length - 1].s;
  const bins = Math.ceil(length / DECK_SPAN_STEP) + 1;
  const west = new Array(bins).fill(Infinity), east = new Array(bins).fill(-Infinity);
  const lanes = Array.from({ length: bins }, () => []);
  const place = (x, z) => {
    let best = null;
    for (let i = 1; i < path.length; i++) {
      const p = path[i - 1], q = path[i], dx = q.x - p.x, dz = q.z - p.z, L = Math.hypot(dx, dz) || 1;
      const t = Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.z) * dz) / (L * L)));
      const px = p.x + dx * t, pz = p.z + dz * t, d = Math.hypot(px - x, pz - z);
      if (!best || d < best.d) best = { d, s: p.s + t * L, off: (-(x - px) * dz + (z - pz) * dx) / L };
    }
    return best;
  };
  for (const l of RG.links) {
    if (!l || !l[8]) continue;
    const [a, b, , width, , , inner] = l;
    const pts = [[RG.nodes[a * 2], RG.nodes[a * 2 + 1]]];
    for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k + 1]]);
    pts.push([RG.nodes[b * 2], RG.nodes[b * 2 + 1]]);
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i], L = Math.hypot(bx - ax, bz - az);
      for (let d = 0; d <= L; d += 2) {
        const p = place(ax + ((bx - ax) * d) / (L || 1), az + ((bz - az) * d) / (L || 1));
        const k = Math.round(p.s / DECK_SPAN_STEP);
        west[k] = Math.min(west[k], p.off - width / 2);
        east[k] = Math.max(east[k], p.off + width / 2);
        lanes[k].push([p.off - width / 2, p.off + width / 2]);
      }
    }
  }
  // Bins no road's point fell in take their neighbours'
  for (const side of [west, east]) {
    for (let k = 0; k < bins; k++) {
      if (Number.isFinite(side[k])) continue;
      let j = 1;
      while (j < bins && !Number.isFinite(side[k - j]) && !Number.isFinite(side[k + j])) j++;
      side[k] = Number.isFinite(side[k - j]) ? side[k - j] : side[k + j];
    }
  }
  const q = (v) => Math.round(v * 10) / 10;
  // The last gap from west to east between the roads' lanes, 0.3 m or more
  const gap = lanes.map((list) => {
    list.sort((p, r) => p[0] - r[0]);
    let reach = -Infinity, found = 0;
    for (const [from, to] of list) {
      if (from - reach >= 0.3 && Number.isFinite(reach)) found = [q(reach), q(from)];
      reach = Math.max(reach, to);
    }
    return found;
  });
  return { step: DECK_SPAN_STEP, west: west.map(q), east: east.map(q), gap };
}

// How far the ground moves to meet the roads (tools/tiles/grade-ground.mjs): 5 cm steps as differences along each row
function packGround(cells) {
  if (!cells) return Buffer.alloc(0);
  const out = [];
  for (let j = 0; j < GROUND.size; j++) {
    let v = 0;
    for (let i = 0; i < GROUND.size; i++) {
      const q = cells[j * GROUND.size + i];
      sint(out, q - v);
      v = q;
    }
  }
  return Buffer.from(out);
}

function write(derived, graded_ = null) {
  // Guessed heights cut down to fit under a deck (tools/tiles/derive.mjs)
  for (const [i, height] of Object.entries(derived?.caps || {})) REAL_BUILDINGS[i].height = height;
  const { tiles, table } = cutMap(derived);
  const workers = PLACES && workersByCell(REAL_BUILDINGS, PLACES);
  let placeBytes = 0;
  // What another tool writes here stays: the horizon (tools/build-horizon.mjs)
  const horizon = path.join(OUT, 'horizon.bin.gz');
  const kept = fs.existsSync(horizon) ? fs.readFileSync(horizon) : null;
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  if (kept) fs.writeFileSync(horizon, kept);
  let total = 0, largest = 0;
  const sizes = [], names = {};
  for (const t of tiles.values()) {
    const place = PLACES && placeGrid(PLACES, workers, t.ix, t.iz);
    if (place) placeBytes += zlib.gzipSync(JSON.stringify(place)).length;
    const json = Buffer.from(JSON.stringify({
      blocks: t.blocks, lawns: t.lawns, pavements: t.pavements, fills: t.fills, signals: t.signals, postBoxes: t.postBoxes, busShelters: t.busShelters,
      nodes: [...t.nodes].flatMap(([id, [x, z]]) => [id, x, z]), links: t.links, home: t.home, scenery: t.scenery, awnings: t.awnings, tags: t.tags,
      land: landOfTile(t.ix, t.iz), shore: shores.get(KEY(t.ix, t.iz)) || [],
      portals: (derived?.portals || []).filter((p) => KEY(...tileOf(p.x, p.z)) === KEY(t.ix, t.iz)),
      ...(place && { place })
    }));
    const buildings = packBuildings(t.buildings, derived?.floors), trees = packTrees(t.trees), heights = packHeights(t.ix, t.iz);
    const graded = packGround(graded_?.[KEY(t.ix, t.iz)]);
    const head = Buffer.alloc(20);
    head.writeUInt32LE(json.length, 0);
    head.writeUInt32LE(buildings.length, 4);
    head.writeUInt32LE(trees.length, 8);
    head.writeUInt32LE(heights.length, 12);
    head.writeUInt32LE(graded.length, 16);
    const packed = zlib.gzipSync(Buffer.concat([head, json, buildings, trees, heights, graded]), { level: 9 });
    const hash = crypto.createHash('sha256').update(packed).digest('hex').slice(0, 10);
    names[KEY(t.ix, t.iz)] = hash;
    const file = path.join(OUT, tileFile(KEY(t.ix, t.iz), hash));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, packed);
    total += packed.length;
    largest = Math.max(largest, packed.length);
    sizes.push(packed.length);
  }
  // The far files, by 4 km square
  const farFiles = {};
  const farGroups = new Map();
  for (const t of tiles.values()) {
    const key = farKeyOfTile(t.ix, t.iz);
    if (!farGroups.has(key)) farGroups.set(key, { entries: [], roads: [] });
    const group = farGroups.get(key);
    for (const { b, i } of t.buildings) group.entries.push({ b, i, ix: t.ix, iz: t.iz });
  }
  const seenRoads = new Set();
  for (const t of tiles.values()) {
    for (const record of t.links) {
      const [id, a, b, , width, , , inner, major, deck, kind] = record;
      if (seenRoads.has(id) || !major || deck || kind === 2 || !t.home.includes(id)) continue;
      seenRoads.add(id);
      farGroups.get(farKeyOfTile(t.ix, t.iz)).roads.push([width, [RG.nodes[a * 2], RG.nodes[a * 2 + 1], ...inner, RG.nodes[b * 2], RG.nodes[b * 2 + 1]]]);
    }
  }
  let farTotal = 0;
  for (const [key, group] of farGroups) {
    const packed = packFarFile(group.entries, derived?.farParks?.[key] || '', group.roads, derived, key);
    const hash = crypto.createHash('sha256').update(packed).digest('hex').slice(0, 10);
    farFiles[key] = hash;
    farTotal += packed.length;
    const file = path.join(OUT, farFile(key, hash));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, packed);
  }
  const mapFile = packStreetIndex();
  fs.writeFileSync(path.join(OUT, 'map.json.gz'), mapFile);
  fs.writeFileSync(path.join(SRC, 'map-full.json.gz'), packFullMap());
  fs.writeFileSync(path.join(OUT, 'far-heights.bin.gz'), packFarHeights());
  fs.writeFileSync(path.join(OUT, 'far.json.gz'), zlib.gzipSync(JSON.stringify({
    surroundings: GEO.surroundings, bridgeLinks: bridgeLinks(derived), suburbs: GEO.suburbs ?? []
  }), { level: 9 }));
  const world = {
    version: 2, tileSize: SIZE, frame: GEO.frame, heights: { margin: MARGIN, size: SAMPLES }, ground: GROUND, far: FAR, tiles: names, farFile: FAR_FILE, farFiles,
    bridge: GEO.bridge, deckSpan: deckSpan(), ferries: GEO.ferries, lightRail: GEO.lightRail, stations: GEO.stations || [],
    nodeCount: RG.nodes.length / 2, structures: table, landmarkBoxes: derived?.landmarkBoxes || [],
    ...(derived?.deckProfile && { deckProfile: derived.deckProfile, bridgeSpan: derived.bridgeSpan })
  };
  fs.writeFileSync(path.join(OUT, 'world.json'), JSON.stringify(world));
  sizes.sort((a, b) => a - b);
  const worldBytes = fs.statSync(path.join(OUT, 'world.json')).size;
  return `places ${(placeBytes / tiles.size).toFixed(0)} bytes a tile zipped; far files ${(farTotal / 1024).toFixed(0)} KB, map ${(mapFile.length / 1024).toFixed(0)} KB; ${tiles.size} tiles, ${(total / 1024).toFixed(0)} KB, median ${(sizes[sizes.length >> 1] / 1024).toFixed(1)} KB, largest ${(largest / 1024).toFixed(1)} KB; world.json ${(worldBytes / 1024).toFixed(0)} KB, ${(zlib.gzipSync(fs.readFileSync(path.join(OUT, 'world.json'))).length / 1024).toFixed(0)} KB zipped`;
}

// Three passes. The ground's grid wants the roads; each building's floor and the rest want the ground.
write(null);
const GRADED = path.join(SRC, 'graded.json');
execFileSync(process.execPath, [fileURLToPath(new URL('./tiles/grade-ground.mjs', import.meta.url)), GRADED], { stdio: ['ignore', 'inherit', 'inherit'] });
const graded = JSON.parse(fs.readFileSync(GRADED, 'utf8'));
write(null, graded);
execFileSync(process.execPath, [fileURLToPath(new URL('./tiles/derive.mjs', import.meta.url)), DERIVED], { stdio: ['ignore', 'inherit', 'inherit'] });
const summary = write(JSON.parse(fs.readFileSync(DERIVED, 'utf8')), graded);
console.log(`[tiles] ${summary}, in ${((Date.now() - started) / 1000).toFixed(1)} s`);
