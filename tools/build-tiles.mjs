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

// Structures: links off the ground, joined where they share a node (js/surfaces.js reads this table)
function findStructures() {
  const parent = new Map();
  const find = (n) => {
    let r = n;
    while (parent.get(r) !== r) r = parent.get(r);
    return r;
  };
  const off = (l) => (l[9] && l[9] !== KIND_CUTTING && l[12] ? l[9] : 0);
  for (const l of RG.links) if (off(l)) { if (!parent.has(l[0])) parent.set(l[0], l[0]); if (!parent.has(l[1])) parent.set(l[1], l[1]); }
  for (const l of RG.links) if (off(l)) parent.set(find(l[0]), find(l[1]));
  const ids = new Map(), table = [null], sid = new Map();
  RG.links.forEach((l, id) => {
    if (!off(l)) return;
    const root = find(l[0]);
    if (!ids.has(root)) {
      ids.set(root, table.length);
      table.push([off(l), 0, 0]);
    }
    const s = table[ids.get(root)];
    sid.set(id, ids.get(root));
    if (l[8]) s[1] = 1;
    if ((l[11] || 0) & 1) s[2] = 1;
    if (off(l) === 2) s[0] = 2;
  });
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
  GEO.blocks.forEach((b, id) => {
    const flat = b[0], m = (flat.length >> 2) << 1; // the middle point of its outline
    at(flat[m], flat[m + 1]).blocks.push([...b.slice(0, 4), id]);
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
  const skip = new Set(derived?.underLandmarks || []);
  REAL_BUILDINGS.forEach((b, i) => {
    if (skip.has(i)) return;
    const [hx, hz] = (b.group && pieceHome.get(b.group)) || [b.cx, b.cz];
    at(hx, hz).buildings.push({ b, i });
  });
  for (let i = 0; i < TREE_KINDS.length; i++) at(REAL_TREES[i * 2], REAL_TREES[i * 2 + 1]).trees.push(i);
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
    uint(meta, b.kind | (b.pitched ? 8 : 0) | (b.group ? 16 : 0) | (b.realAwning ? 32 : 0));
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
const FAR = { x0: H.x0, z0: H.z0, cell: 80, w: Math.floor(((H.w - 1) * H.cell) / 80) + 1, h: Math.floor(((H.h - 1) * H.cell) / 80) + 1 };
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
function packFarFile(entries, parks, roads, derived) {
  const meta = [], xs = [], zs = [];
  let px = 0, pz = 0, count = 0;
  for (const { b, i, ix, iz } of entries) {
    const look = derived?.looks?.[i];
    if (!look) continue;
    count++;
    const [floor, low] = derived.floors[i];
    uint(meta, b.height);
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
  const json = Buffer.from(JSON.stringify({ parks, roads }));
  const lead = Buffer.alloc(8);
  lead.writeUInt32LE(json.length, 0);
  lead.writeUInt32LE(head.length, 4);
  return zlib.gzipSync(Buffer.concat([lead, json, Buffer.from(head), Buffer.from(meta), Buffer.from(xs), Buffer.from(zs)]), { level: 9 });
}

// What the map screen draws, all of it: fetched when the map is first opened
function packMap(derived) {
  const roads = RG.links.map((l) => {
    const [a, b, ni, w, lanes, dir, inner, major, , kind = 0] = l;
    return [RG.names[ni], w, lanes, dir, major ? 1 : 0, kind, [RG.nodes[a * 2], RG.nodes[a * 2 + 1], ...inner, RG.nodes[b * 2], RG.nodes[b * 2 + 1]]];
  });
  return zlib.gzipSync(JSON.stringify({ roads, scenery: GEO.scenery, blocks: GEO.blocks.map(([flat, holes, park, parkName]) => [flat, holes, park, parkName]) }), { level: 9 });
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
    out.push([id, pts.flat(), width, deck ? 1 : 0, sid.get(id) === sid.get(deckSid) ? 1 : 0, l[12] || null, l[9] || 0]);
  });
  return out;
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
  const { tiles, table } = cutMap(derived);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  let total = 0, largest = 0;
  const sizes = [], names = {};
  for (const t of tiles.values()) {
    const json = Buffer.from(JSON.stringify({
      blocks: t.blocks, lawns: t.lawns, pavements: t.pavements, fills: t.fills, signals: t.signals, postBoxes: t.postBoxes, busShelters: t.busShelters,
      nodes: [...t.nodes].flatMap(([id, [x, z]]) => [id, x, z]), links: t.links, home: t.home, scenery: t.scenery, awnings: t.awnings, tags: t.tags
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
    fs.writeFileSync(path.join(OUT, `${KEY(t.ix, t.iz)}.${hash}.bin.gz`), packed);
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
    const packed = packFarFile(group.entries, derived?.farParks?.[key] || '', group.roads, derived);
    const hash = crypto.createHash('sha256').update(packed).digest('hex').slice(0, 10);
    farFiles[key] = hash;
    farTotal += packed.length;
    fs.writeFileSync(path.join(OUT, `far_${key}.${hash}.bin.gz`), packed);
  }
  const mapFile = packMap(derived);
  fs.writeFileSync(path.join(OUT, 'map.json.gz'), mapFile);
  fs.writeFileSync(path.join(OUT, 'far-heights.bin.gz'), packFarHeights());
  fs.writeFileSync(path.join(OUT, 'far.json.gz'), zlib.gzipSync(JSON.stringify({
    surroundings: GEO.surroundings, bridgeLinks: bridgeLinks(derived)
  }), { level: 9 }));
  const world = {
    version: 2, tileSize: SIZE, frame: GEO.frame, heights: { margin: MARGIN, size: SAMPLES }, ground: GROUND, far: FAR, tiles: names, farFile: FAR_FILE, farFiles,
    shores: GEO.shores, bridge: GEO.bridge, ferries: GEO.ferries, lightRail: GEO.lightRail, suburbs: GEO.suburbs ?? [],
    nodeCount: RG.nodes.length / 2, structures: table, portals: derived?.portals || [], landmarkBoxes: derived?.landmarkBoxes || [],
    ...(derived?.deckProfile && { deckProfile: derived.deckProfile, bridgeSpan: derived.bridgeSpan })
  };
  fs.writeFileSync(path.join(OUT, 'world.json'), JSON.stringify(world));
  sizes.sort((a, b) => a - b);
  const worldBytes = fs.statSync(path.join(OUT, 'world.json')).size;
  return `far files ${(farTotal / 1024).toFixed(0)} KB, map ${(mapFile.length / 1024).toFixed(0)} KB; ${tiles.size} tiles, ${(total / 1024).toFixed(0)} KB, median ${(sizes[sizes.length >> 1] / 1024).toFixed(1)} KB, largest ${(largest / 1024).toFixed(1)} KB; world.json ${(worldBytes / 1024).toFixed(0)} KB, ${(zlib.gzipSync(fs.readFileSync(path.join(OUT, 'world.json'))).length / 1024).toFixed(0)} KB zipped`;
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
