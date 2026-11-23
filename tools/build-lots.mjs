// Houses' lots on NSW's cadastre: each tile's houses fitted to their real lots (tools/lots/fit.mjs), into a file for each tile with
// houses, in the tiles' 8 km folders (js/tiles/paths.js lotFile()), and an index of them. It reads the tiles (js/geodata.js, so the houses
// are the game's own, matched by their middles) and the cadastre's lots (tools/fetch-data.mjs nsw_cadastre), after build-tiles.
// usage: node tools/build-lots.mjs <out folder> [--tiles=ix_iz,...] [--report=file.json]
//   --tiles: the tiles to write (by default every tile held whose neighbours are held too). SYDNEY_TILES must hold each tile's
//   neighbours, whose houses and lots bound its own. The index (<out>/index.json) keeps the other tiles it names.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DATA, fromWorld, toWorld } from './geo-common.mjs';
import { CELL, fitLots, insideLines } from './lots/fit.mjs';
import { packLots } from './lots/pack.mjs';
import { lotFile } from '../js/tiles/paths.js';

const args = process.argv.slice(2);
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const OUT = args.find((a) => !a.startsWith('--'));
if (!OUT) throw new Error('usage: node tools/build-lots.mjs <out folder> [--tiles=ix_iz,...] [--report=file.json]');
const SOURCE = path.join(DATA, 'nsw_cadastre.json');
if (!fs.existsSync(SOURCE)) {
  console.log(`[lots] no ${SOURCE} (node tools/fetch-data.mjs nsw_cadastre): no lot files written`);
  process.exit(0);
}
const started = performance.now();
const { heldTiles, isHeld, tileExists } = await import('../js/geodata.js');
const { linkById } = await import('../js/surfaces.js');
const { wholesOf } = await import('../js/house-lots.js');

const SHED = 4, PARTNER_AREA = 80; // as js/house-lots.js: a building of no house's this big bounds a lot
const FIT_REACH = 600; // m round the tiles written: houses whose lots and lines decide those tiles' squares' shifts
const MOVE_REACH = 150; // m round them: houses whose moved lines can reach a written house's lot
const tiles = heldTiles();
const held = new Map(tiles.map((t) => [t.key, t]));
const neighboursHeld = (t) => [-1, 0, 1].every((i) => [-1, 0, 1].every((j) => !tileExists(t.ix + i, t.iz + j) || isHeld(t.ix + i, t.iz + j)));
const targets = (opt('tiles')?.split(',') ?? tiles.filter(neighboursHeld).map((t) => t.key)).map((key) => {
  const t = held.get(key);
  if (!t) throw new Error(`tile ${key} isn't held (SYDNEY_TILES)`);
  if (!neighboursHeld(t)) throw new Error(`tile ${key}'s neighbours aren't all held (SYDNEY_TILES)`);
  return t;
});
const targetKeys = new Set(targets.map((t) => t.key));
const tileOf = (x, z) => `${Math.floor(x / 1000)}_${Math.floor(z / 1000)}`;
const nearTargets = (x, z, r) => targets.some((t) => x >= t.ix * 1000 - r && x < t.ix * 1000 + 1000 + r && z >= t.iz * 1000 - r && z < t.iz * 1000 + 1000 + r);

// The houses, the buildings that bound a lot, and the roads on the ground
const wholes = wholesOf(tiles.flatMap((tile) => tile.buildings.map((b) => ({ b, tile }))));
const houses = wholes.filter((w) => w.house && nearTargets(w.cx, w.cz, FIT_REACH));
const others = wholes.filter((w) => !w.house && w.kind !== SHED && w.area >= PARTNER_AREA && nearTargets(w.cx, w.cz, FIT_REACH));
const roads = [];
const linkSeen = new Set();
for (const t of tiles) {
  for (const r of t.links) {
    const l = linkById.get(r[0]);
    if (!l || l.kind || l.deck || linkSeen.has(l)) continue;
    linkSeen.add(l);
    if (l.pts.some((p) => nearTargets(p.x, p.z, MOVE_REACH))) roads.push({ pts: l.pts, width: l.width });
  }
}

// The cadastre's lots near: their boxes in lon/lat first, then in the map's frame
const reach = FIT_REACH + 100;
const corners = targets.flatMap((t) => [[t.ix * 1000 - reach, t.iz * 1000 - reach], [t.ix * 1000 + 1000 + reach, t.iz * 1000 + 1000 + reach],
  [t.ix * 1000 - reach, t.iz * 1000 + 1000 + reach], [t.ix * 1000 + 1000 + reach, t.iz * 1000 - reach]].map(([x, z]) => fromWorld(x, z)));
const lon0 = Math.min(...corners.map((c) => c[0])), lon1 = Math.max(...corners.map((c) => c[0]));
const lat0 = Math.min(...corners.map((c) => c[1])), lat1 = Math.max(...corners.map((c) => c[1]));
const lots = [];
for (const line of fs.readFileSync(SOURCE, 'utf8').split('\n')) {
  if (!line) continue;
  const f = JSON.parse(line);
  const [lon, lat] = f.rings[0][0];
  if (lon < lon0 || lon > lon1 || lat < lat0 || lat > lat1) continue;
  const rings = f.rings.map((r) => r.slice(0, r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? -1 : undefined)
    .map(([lo, la]) => { const [x, z] = toWorld(lo, la); return { x, z }; }));
  if (!rings.some((r) => r.some((p) => nearTargets(p.x, p.z, reach - 100)))) continue;
  lots.push({ id: f.id, plan: f.plan, cls: f.cls, stratum: f.stratum, rings });
}
// The day the cadastre was asked for (its licence asks for the date of the extraction on what's made from it)
const doneFile = path.join(DATA, 'nsw_cadastre.done');
const days = fs.existsSync(doneFile) ? fs.readFileSync(doneFile, 'utf8').split('\n').map((l) => l.split(' ')[1]).filter(Boolean).sort() : [];
const loaded = performance.now();
console.log(`[lots] ${targets.length} tiles; ${houses.length} houses, ${others.length} other buildings, ${roads.length} roads, ${lots.length} lots near (${((loaded - started) / 1000).toFixed(1)} s)`);

const result = fitLots({ lots, houses, others, roads, fitted: (h) => targetKeys.has(tileOf(h.cx, h.cz)), active: (h) => nearTargets(h.cx, h.cz, MOVE_REACH) });
const fitDone = performance.now();

// Each tile's file: the houses whose middle is in it, and the lots whose first house is
const homeOrder = new Map(result.homes.map((h, i) => [h, i]));
const byTile = new Map(targets.map((t) => [t.key, { homes: new Set(), lots: [] }]));
for (const home of result.homes) byTile.get(tileOf(home.house.cx, home.house.cz))?.homes.add(home);
let acrossTiles = 0;
for (const lot of result.lots) {
  const first = lot.homes.reduce((p, q) => (homeOrder.get(q) < homeOrder.get(p) ? q : p));
  const entry = byTile.get(tileOf(first.house.cx, first.house.cz));
  if (!entry) continue;
  entry.lots.push(lot);
  for (const h of lot.homes) {
    if (!entry.homes.has(h)) acrossTiles++;
    entry.homes.add(h);
  }
}
// The lots each tile's measure reads, as fetched and as shifted: those reaching within 100 m of it, which any line inside its houses is
// (over the whole map, every lot read for every tile would take hours)
const MEASURE_REACH = 100;
const allNear = new Map(targets.map((t) => [t.key, []]));
for (const lot of result.all) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const ring of lot.rings) {
    for (const v of ring) {
      x0 = Math.min(x0, v.x0, v.xs); x1 = Math.max(x1, v.x0, v.xs);
      z0 = Math.min(z0, v.z0, v.zs); z1 = Math.max(z1, v.z0, v.zs);
    }
  }
  for (let ix = Math.floor((x0 - MEASURE_REACH) / 1000); ix <= Math.floor((x1 + MEASURE_REACH) / 1000); ix++) {
    for (let iz = Math.floor((z0 - MEASURE_REACH) / 1000); iz <= Math.floor((z1 + MEASURE_REACH) / 1000); iz++) allNear.get(`${ix}_${iz}`)?.push(lot);
  }
}
fs.mkdirSync(OUT, { recursive: true });
const indexFile = path.join(OUT, 'index.json');
const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : { tiles: {} };
const report = { tiles: {}, measure: result.measure, acrossTiles };
for (const t of targets) {
  const { homes: set, lots: tileLots } = byTile.get(t.key);
  const homes = [...set].sort((a, b) => a.house.cz - b.house.cz || a.house.cx - b.house.cx);
  const at = new Map(homes.map((h, i) => [h, i]));
  const file = {
    homes: homes.map((h) => ({ x: h.house.cx, z: h.house.cz, rule: h.rule })),
    lots: tileLots.map((l) => ({ kind: l.kind, homes: l.homes.map((h) => at.get(h)), rings: l.rings, edges: l.edges }))
  };
  const packed = zlib.gzipSync(packLots(file, t.ix, t.iz), { level: 9 });
  const old = index.tiles[t.key];
  if (!homes.length) {
    delete index.tiles[t.key];
  } else {
    const hash = crypto.createHash('sha256').update(packed).digest('hex').slice(0, 10);
    const name = path.join(OUT, lotFile(t.key, hash));
    fs.mkdirSync(path.dirname(name), { recursive: true });
    fs.writeFileSync(name, packed);
    index.tiles[t.key] = hash;
  }
  if (old && old !== index.tiles[t.key]) fs.rmSync(path.join(OUT, lotFile(t.key, old)), { force: true });
  // Its numbers: houses by rule, lots by kind, edges by kind
  const own = homes.filter((h) => tileOf(h.house.cx, h.house.cz) === t.key);
  const count = (list, f) => list.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  const edges = {};
  for (const l of tileLots) for (const ring of l.edges) for (const e of ring) edges[e] = (edges[e] || 0) + 1;
  report.tiles[t.key] = { houses: own.length, rules: count(own, (h) => h.rule), lots: tileLots.length, kinds: count(tileLots, (l) => l.kind), edges,
    bytes: homes.length ? packed.length : 0, inside: insideLines({ all: allNear.get(t.key), lots: tileLots }, own.map((h) => h.house)) };
}
index.cadastre = days.length ? (days[0] === days[days.length - 1] ? days[0] : `${days[0]} to ${days[days.length - 1]}`) : null;
index.tiles = Object.fromEntries(Object.entries(index.tiles).sort());
fs.writeFileSync(indexFile, JSON.stringify(index));
const shifts = [...result.shifts.entries()].filter(([k, s]) => s.own > 0 && targetKeys.has(tileOf(...k.split(',').map((v) => (Number(v) + 0.5) * CELL))))
  .map(([, s]) => Math.hypot(s.dx, s.dz)).sort((a, b) => a - b);
report.shifts = { squares: shifts.length, median: shifts[shifts.length >> 1] ?? null, most: shifts[shifts.length - 1] ?? null };
report.seconds = { load: +((loaded - started) / 1000).toFixed(1), fit: +((fitDone - loaded) / 1000).toFixed(1), all: +((performance.now() - started) / 1000).toFixed(1) };
if (opt('report')) fs.writeFileSync(opt('report'), JSON.stringify({ ...report, result: undefined }, null, 1));
for (const [key, r] of Object.entries(report.tiles)) {
  console.log(`[lots] ${key}: ${r.houses} houses ${JSON.stringify(r.rules)}, ${r.lots} lots ${JSON.stringify(r.kinds)}, ${(r.bytes / 1024).toFixed(1)} KB; line inside its houses ${JSON.stringify(r.inside)} m`);
}
console.log(`[lots] ${JSON.stringify(result.measure)}; shifts: median ${report.shifts.median} m, most ${report.shifts.most} m; ${acrossTiles} houses on a lot in another tile's file; ${report.seconds.all} s`);
export { result };
