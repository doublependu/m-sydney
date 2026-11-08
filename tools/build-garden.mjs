// tools/build-garden.mjs: the footpaths of a few areas, and what their gardens are drawn with: beds, hedges, ponds, the gates on the paths,
// and every plant, from OpenStreetMap (paths.json and land.json, tools/extract-osm.mjs) and the Royal Botanic Garden's own map. Writes
// tools/data/generated/garden.json. tools/build-trees.mjs adds its plants to the trees; tools/build-tiles.mjs cuts the rest into the tiles.
// Paths elsewhere wait: they'd change where everyone walks.
//   node tools/build-garden.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BitRaster, bbox, elementRings, flat, load, pointInRing, q1, rdp, ringArea, rdpRing, toWorld } from './geo-common.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GENERATED = path.join(ROOT, 'tools/data/generated');
const OUT = path.join(GENERATED, 'garden.json');
const log = (...args) => console.log('[garden]', ...args);
const started = Date.now();

// --- The areas: parks by their name in OSM, and boxes (x0, z0, x1, z1) with any boxes left out -----------------------------------
const AREAS = [
  { name: 'Royal Botanic Garden', osm: 'Royal Botanic Garden' },
  { name: 'The Domain', osm: 'The Domain' },
  { name: 'Domain Crescent Precinct', osm: 'Domain Crescent Precinct' },
  { name: 'Mrs Macquaries Point', osm: 'Domain Yurong Precinct' },
  { name: 'Tarpeian Precinct', osm: 'Domain Tarpeian Precinct' },
  // Round the Opera House: not on its podium, which its own model draws (js/model-sites.js)
  { name: 'Bennelong Point', box: [330, -2060, 730, -1640], except: [[448, -1955, 574, -1752]] },
  { name: 'Circular Quay', box: [-40, -1720, 470, -1330] }
];
const REACH = 4; // m past an area's edge a path still counts, so those through its gates meet the footpaths outside

const land = load('land.json').elements;
const areas = AREAS.map((a) => {
  if (a.box) {
    const [x0, z0, x1, z1] = a.box;
    return { ...a, rings: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1]]], except: (a.except || []).map(([ex0, ez0, ex1, ez1]) => ({ x0: ex0, z0: ez0, x1: ex1, z1: ez1 })) };
  }
  const e = land.find((el) => el.tags?.name === a.osm && /^(park|garden)$/.test(el.tags.leisure || ''));
  if (!e) throw new Error(`No park named ${a.osm} in OSM: has it been renamed?`);
  return { ...a, rings: elementRings(e).outer.filter((r) => r.length > 3), except: [] };
});
for (const a of areas) a.box = bbox(a.rings.flat());
const distToRing = (ring, x, z) => {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) best = Math.min(best, segDist(x, z, ring[j], ring[i]));
  return best;
};
function segDist(x, z, [ax, az], [bx, bz]) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
  return Math.hypot(ax + dx * t - x, az + dz * t - z);
}
const excluded = (a, x, z) => a.except.some((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1);
/** Which area (x, z) is in, `reach` metres past their edges counting too, or null */
function areaAt(x, z, reach = 0) {
  for (const a of areas) {
    if (x < a.box.x0 - reach || x > a.box.x1 + reach || z < a.box.z0 - reach || z > a.box.z1 + reach || excluded(a, x, z)) continue;
    if (a.rings.some((r) => pointInRing(r, x, z) || (reach && distToRing(r, x, z) <= reach))) return a;
  }
  return null;
}

// --- What's in the way: roads on the ground, buildings, and the water --------------------------------------------------------------
globalThis.fetch = async (url) => new Response(fs.readFileSync(new URL(url)));
const { GEO } = await import(path.join(GENERATED, 'geodata.js'));
const RG = GEO.roadGraph;
const near = { x0: Math.min(...areas.map((a) => a.box.x0)) - 50, x1: Math.max(...areas.map((a) => a.box.x1)) + 50, z0: Math.min(...areas.map((a) => a.box.z0)) - 50, z1: Math.max(...areas.map((a) => a.box.z1)) + 50 };
const ROAD_CELL = 32;
const roadCells = new Map();
for (const l of RG.links) {
  if (!l) continue;
  const [a, b, , width, , , inner, , , kind = 0] = l;
  if (kind === 1) continue; // a bridge's over
  // A tunnel's under, but open at its mouths, where it's a cutting: paths may cross it, nothing may grow on it (tunnel)
  const pts = [[RG.nodes[a * 2], RG.nodes[a * 2 + 1]]];
  for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k + 1]]);
  pts.push([RG.nodes[b * 2], RG.nodes[b * 2 + 1]]);
  if (!pts.some(([x, z]) => x > near.x0 && x < near.x1 && z > near.z0 && z < near.z1)) continue;
  for (let i = 1; i < pts.length; i++) {
    const seg = { a: pts[i - 1], b: pts[i], r: width / 2, tunnel: kind === 2 };
    const box = bbox([seg.a, seg.b]);
    for (let cx = Math.floor((box.x0 - 12) / ROAD_CELL); cx <= Math.floor((box.x1 + 12) / ROAD_CELL); cx++) {
      for (let cz = Math.floor((box.z0 - 12) / ROAD_CELL); cz <= Math.floor((box.z1 + 12) / ROAD_CELL); cz++) {
        const key = cx * 100000 + cz;
        (roadCells.get(key) || roadCells.set(key, []).get(key)).push(seg);
      }
    }
  }
}
/** How far (x, z) is from the edge of the nearest road on the ground, or with `tunnels` over a tunnel too: below 0 on it */
function roadClear(x, z, tunnels = false) {
  let best = Infinity;
  for (const s of roadCells.get(Math.floor(x / ROAD_CELL) * 100000 + Math.floor(z / ROAD_CELL)) || []) {
    if (!s.tunnel || tunnels) best = Math.min(best, segDist(x, z, s.a, s.b) - s.r);
  }
  return best;
}
const walls = BitRaster.load(path.join(GENERATED, 'walls.bin'));
const landBits = BitRaster.load(path.join(GENERATED, 'land.bin'));
const inBuilding = (x, z) => walls.at(x, z) === 1;

// --- Paths ---------------------------------------------------------------------------------------------------------------------------
// Kinds: 0 a footpath, 1 steps, 2 a cycleway. Surfaces: 0 paving, 1 asphalt, 2 gravel, 3 timber, 4 trodden grass (walked, not drawn)
const KINDS = { footway: 0, path: 0, track: 0, bridleway: 0, steps: 1, cycleway: 2 };
const SURFACE = [
  [/^(paving_stones|sett|brick|bricks|stone|cobblestone|unhewn_cobblestone|concrete:plates|concrete:lanes|tiles|granite|sandstone)/, 0],
  [/^(asphalt|paved|concrete|metal|rubber|tartan)/, 1],
  [/^(gravel|fine_gravel|compacted|woodchips|dirt|ground|earth|sand|rock|pebblestone|mud|unpaved)/, 2],
  [/^(wood|boardwalk)/, 3],
  [/^(grass|grass_paver)/, 4]
];
const surfaceOf = (t) => {
  if (t.bridge === 'boardwalk') return 3;
  const s = t.surface || '';
  for (const [re, k] of SURFACE) if (re.test(s)) return k;
  return t.highway === 'path' || t.highway === 'track' ? 2 : 1;
};
// A path's width where OSM gives none: the garden's main walks are asphalt about 3 m across, its gravel ones narrower
const DEFAULT_WIDTH = [[2.4, 3, 1.8, 2, 1.2], [2.4, 2.4, 2.4, 2.4, 2.4], [2.5, 2.5, 2.5, 2.5, 2.5]];
const widthOf = (t, kind, surface) => {
  const w = parseFloat(t.width);
  return Number.isFinite(w) && w > 0.6 ? Math.min(6, w) : t.highway === 'track' ? 3 : DEFAULT_WIDTH[kind][surface];
};
// Left out: footpaths along a street (its own footpath's drawn already) and over it, those in or under something, and ones not on the
// ground's level
const skipPath = (t) => /^(sidewalk|crossing|traffic_island|access_aisle)$/.test(t.footway || '') || t.area === 'yes'
  || (t.bridge && t.bridge !== 'no' && t.bridge !== 'boardwalk') || (t.tunnel && t.tunnel !== 'no') || t.indoor === 'yes' || t.covered === 'yes'
  || (t.layer && t.layer !== '0') || (t.level && t.level !== '0');

const pathsSource = load('paths.json').elements;
const paths = [];
const wayGeom = new Map(); // way id: { pts, nodes, width } of each kept path, for the gates on it
const skipped = { sidewalk: 0, offGround: 0, area: 0 };
let metres = 0;
const STEP = 1; // m between the points a path is tested at
for (const e of pathsSource) {
  if (e.type !== 'way' || !e.geometry) continue;
  const t = e.tags || {};
  const kind = KINDS[t.highway];
  if (kind === undefined) continue;
  const pts = e.geometry.map((g) => toWorld(g.lon, g.lat));
  if (!pts.some(([x, z]) => areaAt(x, z, REACH))) continue;
  if (skipPath(t)) {
    if (/sidewalk|crossing/.test(t.footway || '')) skipped.sidewalk++;
    else skipped.offGround++;
    continue;
  }
  const surface = surfaceOf(t);
  const width = widthOf(t, kind, surface);
  wayGeom.set(e.id, { pts, nodes: e.nodes, width });
  // Kept where it's in an area, off the roads and out of buildings: in runs
  const keep = (x, z) => areaAt(x, z, REACH) && roadClear(x, z) > 0.6 && !inBuilding(x, z) && landBits.at(x, z) === 1;
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      const line = rdp(run, 0.25);
      let L = 0;
      for (let i = 1; i < line.length; i++) L += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
      if (L >= 2) {
        paths.push([kind, surface, q1(width), ...flat(line)]);
        metres += L;
      }
    }
    run = [];
  };
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / STEP));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n;
      if (keep(x, z)) {
        // A path's own corners stay; the points between them only where a run starts or ends
        if (k === n || k === 0 || !run.length) run.push([x, z]);
        else if (run.length && !keep(ax + ((bx - ax) * (k + 1)) / n, az + ((bz - az) * (k + 1)) / n)) run.push([x, z]);
      } else flush();
    }
  }
  flush();
}
log(`${paths.length} paths, ${(metres / 1000).toFixed(1)} km; left out ${skipped.sidewalk} along or across streets, ${skipped.offGround} off the ground`);

// Gates on them: where they stand, which way their path runs, and how wide
const gates = [];
for (const e of pathsSource) {
  if (e.type !== 'node' || !/gate/.test(e.tags?.barrier || '')) continue;
  const [x, z] = toWorld(e.lon, e.lat);
  if (!areaAt(x, z, REACH) || roadClear(x, z) < 1) continue;
  let found = null;
  for (const way of wayGeom.values()) {
    const k = way.nodes.indexOf(e.id);
    if (k < 0) continue;
    const a = way.pts[Math.max(0, k - 1)], b = way.pts[Math.min(way.pts.length - 1, k + 1)];
    found = { heading: Math.atan2(b[0] - a[0], b[1] - a[1]), width: way.width };
    break;
  }
  if (found) gates.push([q1(x), q1(z), Math.round(found.heading * 1000) / 1000, q1(Math.max(1.2, found.width + 0.4))]);
}
log(`${gates.length} gates on them`);

// The paths as segments, to keep plants and ponds off them
const PATH_CELL = 16;
const pathCells = new Map();
for (const [, , width, ...line] of paths) {
  for (let i = 2; i + 1 < line.length; i += 2) {
    const seg = { a: [line[i - 2], line[i - 1]], b: [line[i], line[i + 1]], r: width / 2 };
    const box = bbox([seg.a, seg.b]);
    for (let cx = Math.floor((box.x0 - 4) / PATH_CELL); cx <= Math.floor((box.x1 + 4) / PATH_CELL); cx++) {
      for (let cz = Math.floor((box.z0 - 4) / PATH_CELL); cz <= Math.floor((box.z1 + 4) / PATH_CELL); cz++) {
        const key = cx * 100000 + cz;
        (pathCells.get(key) || pathCells.set(key, []).get(key)).push(seg);
      }
    }
  }
}
/** How far (x, z) is from the edge of the nearest path, up to 4 m: below 0 on it */
function pathClear(x, z) {
  let best = 4;
  for (const s of pathCells.get(Math.floor(x / PATH_CELL) * 100000 + Math.floor(z / PATH_CELL)) || []) best = Math.min(best, segDist(x, z, s.a, s.b) - s.r);
  return best;
}

// --- Hedges, ponds and beds ----------------------------------------------------------------------------------------------------------
const hedges = [];
for (const e of pathsSource) {
  if (e.type !== 'way' || e.tags?.barrier !== 'hedge' || !e.geometry) continue;
  const pts = e.geometry.map((g) => toWorld(g.lon, g.lat)).filter(([x, z]) => areaAt(x, z) && roadClear(x, z) > 0.5);
  if (pts.length < 2) continue;
  const h = Math.min(3, parseFloat(e.tags.height) || 1.1);
  hedges.push([q1(h), 0.8, ...flat(rdp(pts, 0.2))]);
}

// Ponds and reflecting pools: still water at the ground's own height, not the sea's
const ponds = [];
const pondRings = [];
for (const e of land) {
  const t = e.tags || {};
  if (t.natural !== 'water' || (t.water && !/^(pond|reflecting_pool|fishpond|basin|lake|fountain)$/.test(t.water))) continue;
  for (const ring of elementRings(e).outer) {
    const area = Math.abs(ringArea(ring));
    if (ring.length < 4 || area < 8 || area > 30000) continue;
    const b = bbox(ring), cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    if (!areaAt(cx, cz) || landBits.at(cx, cz) !== 1) continue;
    pondRings.push(ring);
    ponds.push(flat(rdpRing(ring, 0.2)));
  }
}
const inPond = (x, z, margin = 0) => pondRings.some((r) => pointInRing(r, x, z) || (margin && distToRing(r, x, z) < margin));
log(`${hedges.length} hedges, ${ponds.length} ponds and pools`);

// --- Plants ----------------------------------------------------------------------------------------------------------------------------
// The tree system's kinds (js/trees.js): what each garden is planted with. Heights in metres for trees; for the small ones (SMALL) in
// tenths of a metre, as js/tree-placements.js reads them.
const K = { broadleaf: 0, small: 1, gum: 2, fig: 3, palm: 4, jacaranda: 5, bangalow: 6, datePalm: 7, araucaria: 8, wollemi: 9, cycad: 10, treeFern: 11,
  shrub: 12, native: 13, flowers: 14, roses: 15, succulent: 16, grass: 17 };
const SMALL = new Set([K.cycad, K.shrub, K.native, K.flowers, K.roses, K.succulent, K.grass]);
// Each mix: plants a metre apart on a jittered grid (`every`), what share of each kind, and their heights [from, to]
const MIX = {
  rose: { every: 1.5, bed: 2, plants: [[K.roses, 0.85, 0.8, 1.4], [K.shrub, 0.15, 0.6, 1.0]] },
  herb: { every: 1.3, bed: 2, plants: [[K.grass, 0.35, 0.4, 0.8], [K.shrub, 0.3, 0.5, 0.9], [K.flowers, 0.35, 0.3, 0.7]] },
  succulent: { every: 1.7, bed: 1, plants: [[K.succulent, 0.6, 0.5, 1.4], [K.cycad, 0.1, 1.0, 2.0], [K.grass, 0.15, 0.5, 0.9], [K.native, 0.15, 0.8, 1.6]] },
  oriental: { every: 2.2, bed: 0, plants: [[K.shrub, 0.5, 0.8, 1.8], [K.grass, 0.35, 0.5, 1.0], [K.small, 0.05, 4, 6], [K.cycad, 0.1, 0.8, 1.4]] },
  native: { every: 2, bed: 3, plants: [[K.native, 0.55, 0.8, 2.2], [K.grass, 0.38, 0.5, 1.1], [K.gum, 0.02, 8, 14], [K.small, 0.05, 4, 7]] },
  flowers: { every: 1.3, bed: 2, plants: [[K.flowers, 0.65, 0.3, 0.8], [K.shrub, 0.15, 0.6, 1.1], [K.grass, 0.2, 0.4, 0.8]] },
  beds: { every: 1.6, bed: 0, plants: [[K.shrub, 0.5, 0.7, 1.6], [K.flowers, 0.3, 0.3, 0.7], [K.grass, 0.2, 0.5, 0.9]] },
  camellia: { every: 2.4, bed: 0, plants: [[K.shrub, 0.8, 1.2, 2.4], [K.flowers, 0.2, 0.3, 0.6]] },
  palms: { every: 6, bed: -1, plants: [[K.bangalow, 0.5, 9, 16], [K.datePalm, 0.12, 7, 11], [K.palm, 0.13, 6, 10], [K.cycad, 0.15, 1, 2], [K.treeFern, 0.1, 3, 5]] },
  rainforest: { every: 4, bed: -1, plants: [[K.treeFern, 0.35, 2.5, 5], [K.bangalow, 0.15, 8, 14], [K.broadleaf, 0.08, 10, 16], [K.fig, 0.04, 14, 20], [K.shrub, 0.28, 1, 2.2], [K.cycad, 0.1, 0.8, 1.6]] },
  wollemi: { every: 6, bed: -1, plants: [[K.wollemi, 1, 6, 12]] },
  scrub: { every: 2.2, bed: 3, plants: [[K.native, 0.7, 0.8, 2.4], [K.grass, 0.3, 0.5, 1.1]] },
  wood: { every: 9, bed: -1, plants: [[K.broadleaf, 0.4, 10, 18], [K.fig, 0.2, 14, 22], [K.gum, 0.25, 12, 22], [K.small, 0.15, 5, 8]] }
};
const zoneOf = (name) => {
  if (/rose/i.test(name)) return 'rose';
  if (/herb/i.test(name)) return 'herb';
  if (/succulent|southern africa/i.test(name)) return 'succulent';
  if (/oriental/i.test(name)) return 'oriental';
  if (/native|rockery|cadi jam ora|solander|yellowwood|bushland/i.test(name)) return 'native';
  if (/bicentenary|pioneer|trial|begonia|art garden|speaker/i.test(name)) return 'flowers';
  if (/palm grove/i.test(name)) return 'palms';
  if (/rainforest|tropical|fern gully|wishing tree/i.test(name)) return 'rainforest';
  if (/camellia/i.test(name)) return 'camellia';
  if (/wollemi/i.test(name)) return 'wollemi';
  return null;
};
// The garden's map (ref/royal_botanic_garden), placed on the world by the gardens OSM has outlines for (to about 20 m): those it hasn't
const circle = (x, z, r) => Array.from({ length: 16 }, (_, i) => [x + r * Math.cos((i / 16) * Math.PI * 2), z + r * Math.sin((i / 16) * Math.PI * 2)]);
const MAP_GARDENS = [
  ['Wollemi Pine', 878, -962, 12], ['Begonia Garden', 835, -976, 12], ['Camellia Garden', 795, -830, 16],
  ['Australian Native Plant Border', 1110, -1206, 18], ["Mrs Macquarie's Bushland Walk", 1123, -1041, 26]
];

const zones = [];
for (const e of land) {
  const t = e.tags || {};
  if (t.leisure !== 'garden' && t.natural !== 'wood') continue;
  if (/roof_garden|green_wall/.test(t['garden:type'] || '')) continue;
  for (const ring of elementRings(e).outer) {
    const area = Math.abs(ringArea(ring));
    const b = bbox(ring);
    if (ring.length < 4 || !areaAt((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2)) continue;
    let mix = zoneOf(t.name || '');
    if (!mix && t.natural === 'wood') mix = 'wood';
    if (!mix && t.leisure === 'garden' && area <= 4000) mix = 'beds';
    if (mix) zones.push({ name: t.name || '', mix, ring, area });
  }
}
for (const e of pathsSource) {
  const t = e.tags || {};
  if (e.type !== 'way' || !e.geometry || (t.landuse !== 'flowerbed' && t.natural !== 'scrub')) continue;
  const ring = e.geometry.map((g) => toWorld(g.lon, g.lat));
  const b = bbox(ring);
  if (ring.length < 4 || !areaAt((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2)) continue;
  zones.push({ name: t.name || '', mix: t.landuse === 'flowerbed' ? 'flowers' : 'scrub', ring, area: Math.abs(ringArea(ring)) });
}
for (const [name, x, z, r] of MAP_GARDENS) zones.push({ name, mix: zoneOf(name), ring: circle(x, z, r), area: Math.PI * r * r, map: true });
// The smaller of two overlapping zones is planted, as a bed inside a wood
zones.sort((p, q) => p.area - q.area);
log(`${zones.length} planted zones: ${Object.entries(zones.reduce((m, z) => ({ ...m, [z.mix]: (m[z.mix] || 0) + 1 }), {})).map(([k, v]) => `${v} ${k}`).join(', ')}`);

const seeded = (x, z, salt = 0) => {
  const s = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
  return s - Math.floor(s);
};
const plants = [];
const beds = [];
const PLANT_CELL = 4;
const plantCells = new Map();
const addPlant = (x, z, kind, height) => {
  plants.push([q1(x), q1(z), kind, height]);
  const key = Math.floor(x / PLANT_CELL) * 100000 + Math.floor(z / PLANT_CELL);
  (plantCells.get(key) || plantCells.set(key, []).get(key)).push([x, z, kind]);
};
// Is a tree (not a small plant) within `r` of (x, z)?
const treeNear = (x, z, r) => {
  for (let cx = Math.floor((x - r) / PLANT_CELL); cx <= Math.floor((x + r) / PLANT_CELL); cx++) {
    for (let cz = Math.floor((z - r) / PLANT_CELL); cz <= Math.floor((z + r) / PLANT_CELL); cz++) {
      for (const [px, pz, k] of plantCells.get(cx * 100000 + cz) || []) if (!SMALL.has(k) && Math.hypot(px - x, pz - z) < r) return true;
    }
  }
  return false;
};
// Where nothing can grow: paths (and their edges), ponds, roads, buildings and the sea. A plant's kept to the half metre (tools/build-trees.mjs),
// so it may move a third of a metre nearer a path.
const clearFor = (x, z, small) => pathClear(x, z) > (small ? 0.7 : 1.4) && !inPond(x, z, small ? 0.3 : 1) && roadClear(x, z, true) > (small ? 1.5 : 3)
  && !inBuilding(x, z) && landBits.at(x, z) === 1;

// Trees OSM has in the areas: by what it says they are, or what's growing round them
const zoneAt = (x, z) => zones.find((zn) => pointInRing(zn.ring, x, z));
const byTags = (t) => {
  const what = `${t.species || ''} ${t.genus || ''} ${t.taxon || ''} ${t['species:en'] || ''}`;
  if (/phoenix|jubaea|butia|date/i.test(what)) return K.datePalm;
  if (/archontophoenix|livistona|howea|washingtonia|syagrus|arecaceae|palm/i.test(what) || t.leaf_type === 'palm') return K.bangalow;
  if (/wollemi/i.test(what)) return K.wollemi;
  if (/araucaria|agathis|norfolk|bunya|hoop pine|kauri/i.test(what) || t.leaf_type === 'needleleaved') return K.araucaria;
  if (/ficus|fig/i.test(what)) return K.fig;
  if (/eucalyptus|corymbia|angophora|gum/i.test(what)) return K.gum;
  if (/jacaranda/i.test(what)) return K.jacaranda;
  if (/dracaena|cycas|macrozamia|encephalartos/i.test(what)) return K.cycad;
  if (/dicksonia|cyathea|fern/i.test(what)) return K.treeFern;
  return null;
};
// The garden's big trees are mostly Moreton Bay and Port Jackson figs and old exotics
const BIG = [[K.fig, 0.32], [K.broadleaf, 0.38], [K.gum, 0.16], [K.small, 0.1], [K.jacaranda, 0.04]];
const HEIGHT = { [K.broadleaf]: [10, 18], [K.small]: [5, 9], [K.gum]: [12, 24], [K.fig]: [14, 24], [K.palm]: [6, 11], [K.jacaranda]: [8, 12],
  [K.bangalow]: [9, 17], [K.datePalm]: [7, 12], [K.araucaria]: [24, 36], [K.wollemi]: [8, 14], [K.cycad]: [1, 2.5], [K.treeFern]: [3, 5] };
const pick = (list, r) => {
  let acc = 0;
  for (const [kind, share] of list) if (r < (acc += share)) return kind;
  return list[list.length - 1][0];
};
const nodes = load('nodes.json').elements;
let osmTrees = 0;
for (const e of nodes) {
  if (e.tags?.natural !== 'tree') continue;
  const [x, z] = toWorld(e.lon, e.lat);
  if (!areaAt(x, z) || roadClear(x, z, true) < 2 || inBuilding(x, z) || landBits.at(x, z) !== 1) continue;
  const zone = zoneAt(x, z);
  let kind = byTags(e.tags);
  if (kind === null && zone?.mix === 'palms') kind = seeded(x, z, 1) < 0.7 ? K.bangalow : K.datePalm;
  if (kind === null && zone?.mix === 'rainforest') kind = pick([[K.fig, 0.3], [K.broadleaf, 0.4], [K.bangalow, 0.3]], seeded(x, z, 1));
  if (kind === null) kind = pick(BIG, seeded(x, z, 1));
  const [lo, hi] = HEIGHT[kind];
  const tagged = parseFloat(e.tags.height);
  const height = Number.isFinite(tagged) && tagged > 1 ? Math.min(40, tagged) : lo + seeded(x, z, 2) * (hi - lo);
  addPlant(x, z, kind, Math.round(SMALL.has(kind) ? height * 10 : height));
  osmTrees++;
}
// Tree rows OSM draws as lines, where it hasn't the trees themselves
for (const e of pathsSource) {
  if (e.type !== 'way' || e.tags?.natural !== 'tree_row' || !e.geometry) continue;
  const pts = e.geometry.map((g) => toWorld(g.lon, g.lat));
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i], L = Math.hypot(bx - ax, bz - az);
    for (let s = 4; s < L; s += 9) {
      const x = ax + ((bx - ax) * s) / L, z = az + ((bz - az) * s) / L;
      if (!areaAt(x, z) || treeNear(x, z, 6) || !clearFor(x, z, false)) continue;
      const kind = pick(BIG, seeded(x, z, 3));
      const [lo, hi] = HEIGHT[kind];
      addPlant(x, z, kind, Math.round(lo + seeded(x, z, 4) * (hi - lo)));
    }
  }
}
// Each zone filled by its mix, round the trees already there; beds under the small plants
const planted = {};
for (const zone of zones) {
  const mix = MIX[zone.mix];
  const b = bbox(zone.ring);
  const every = mix.every;
  let n = 0;
  for (let gx = Math.floor(b.x0 / every) * every; gx < b.x1; gx += every) {
    for (let gz = Math.floor(b.z0 / every) * every; gz < b.z1; gz += every) {
      const x = gx + (seeded(gx, gz, 5) - 0.5) * every * 0.8, z = gz + (seeded(gx, gz, 6) - 0.5) * every * 0.8;
      if (!pointInRing(zone.ring, x, z) || !areaAt(x, z)) continue;
      // A smaller zone inside this one has its own plants
      if (zones.some((o) => o !== zone && o.area < zone.area && pointInRing(o.ring, x, z))) continue;
      const kind = pick(mix.plants, seeded(x, z, 7));
      const small = SMALL.has(kind);
      if (!clearFor(x, z, small) || treeNear(x, z, small ? 1.2 : 5)) continue;
      const [, , lo, hi] = mix.plants.find((p) => p[0] === kind);
      const height = lo + seeded(x, z, 8) * (hi - lo);
      addPlant(x, z, kind, Math.round(small ? height * 10 : height));
      n++;
    }
  }
  planted[zone.mix] = (planted[zone.mix] || 0) + n;
  // The bed it grows in, by what's planted (js/garden.js): shrubs (0), succulents on gravel (1), flowers (2), natives (3)
  if (mix.bed >= 0 && n) beds.push([mix.bed, ...flat(rdpRing(zone.ring, 0.2))]);
}
const counts = {};
for (const [, , kind] of plants) counts[kind] = (counts[kind] || 0) + 1;
const names = Object.fromEntries(Object.entries(K).map(([k, v]) => [v, k]));
log(`${plants.length} plants: ${osmTrees} trees from OSM; by zone ${JSON.stringify(planted)}`);
log(`by kind: ${Object.entries(counts).map(([k, v]) => `${names[k]} ${v}`).join(', ')}; ${beds.length} beds`);

fs.writeFileSync(OUT, JSON.stringify({
  areas: areas.map((a) => ({ name: a.name, rings: a.rings.map((r) => flat(rdpRing(r, 0.5))), except: a.except })),
  paths, gates, hedges, ponds, beds, plants, small: [...SMALL]
}));
log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
