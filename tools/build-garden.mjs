// tools/build-garden.mjs: the footpaths of a few areas, and what their gardens are drawn with: beds, hedges, ponds (some edged with rocks)
// and fountains, paved areas, the gates on the paths, the raised lawn, and every plant, from OpenStreetMap (paths.json, land.json and
// all_roads.json, tools/extract-osm.mjs), the Royal Botanic Garden's own map and the City of Sydney's tree register (cos_trees.json). Writes
// tools/data/generated/garden.json. tools/build-trees.mjs adds its plants to the trees; tools/build-tiles.mjs cuts the rest into the tiles.
// It reads the game's tiles as last built too, for the Harbour Bridge's feet and the room under the decks (js/harbour-bridge.js,
// js/deck-room.js): not while tools/build-tiles.mjs writes them. And every other park on the map with paths, by rule (tools/garden-areas.mjs
// ruleParks()): its paths, and in a formal one its raised lawn, a tile at a time (tools/garden/rule-parks.mjs), after the areas'.
//   node tools/build-garden.mjs [--tiles=0_-1,2_2] [--no-parks] [--out=garden.json]
// --tiles lays out only those tiles' parks by rule (a trial: the 240 m squares starting in them), --no-parks none of them; --out writes
// elsewhere.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BitRaster, bbox, dataPath, elementRings, flat, load, pointInRing, q1, rdp, ringArea, rdpRing, toWorld } from './geo-common.mjs';
import { SQUARE, traceRaised } from './garden/raised-lawn.mjs';
import { MODEL_GATES, gardenAreas, gateHeading, pathKind, pockets as bushPockets, ruleParks } from './garden-areas.mjs';
import { MIN_PATHS, ParkIndex, Pockets, kindAt, parkLawns, parkPaths } from './garden/rule-parks.mjs';
import { loadPonds, pondTest } from './pond-pieces.mjs';
import { onRegionEdge } from './geodata/regions.mjs';
import { localAreas } from './local-edits.mjs';
import { beachBehind, beachTest, loadSand } from './sand-pieces.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GENERATED = path.join(ROOT, 'tools/data/generated');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const OUT = arg('out') ? path.resolve(arg('out')) : path.join(GENERATED, 'garden.json');
const ONLY = arg('tiles')?.split(',') ?? null;
const NO_PARKS = process.argv.includes('--no-parks');
const log = (...args) => console.log('[garden]', ...args);
const started = Date.now();

// --- The areas (tools/garden-areas.mjs) -----------------------------------------------------------------------------------------
const REACH = 4; // m past an area's edge a path still counts, so those through its gates meet the footpaths outside

const land = load('land.json').elements;
const areas = gardenAreas(land);
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
// What of the Harbour Bridge stands on the ground (js/harbour-bridge.js): its pylons (in the buildings' walls too) and its approaches'
// piers (not), which nothing of a garden is planted in or stands in
const { bridgeFeet } = await import('../js/harbour-bridge.js');
const feet = bridgeFeet();
/** Whether (x, z) is within `margin` of the bridge's pylons or piers */
const onBridgeFoot = (x, z, margin = 0) => feet.some((f) => {
  const dx = x - f.x, dz = z - f.z;
  return Math.abs(dx * f.ux + dz * f.uz) <= f.along + margin && Math.abs(dz * f.ux - dx * f.uz) <= f.across + margin;
});
// ...and the room under the decks (js/deck-room.js, the game's, as the tiles were last built): no path, nor a gate, where a walker hasn't
// room to stand (ROOM, js/surfaces.js), as Bradfield Park's under the bridge's railway where it comes down at its north end, or the crowd
// walks inside the deck. Trees under a deck without room for them are left out of the tiles (tools/tiles/derive.mjs).
const { roomOver } = await import('../js/deck-room.js');
const { ROOM } = await import('../js/surfaces.js');
const GATE_ROOM = 2.6; // m: a gate's pillars and their caps, 2.24 m
const landBits = BitRaster.load(path.join(GENERATED, 'land.bin'));
const inBuilding = (x, z) => walls.at(x, z) === 1;

// --- Paths ---------------------------------------------------------------------------------------------------------------------------
// Kinds: 0 a footpath, 1 steps, 2 a cycleway, 3 a track (by its area's kind and its surface: tools/garden-areas.mjs pathKind()).
// Surfaces: 0 paving, 1 asphalt, 2 gravel, 3 timber, 4 trodden grass, 5 dirt, 6 sand, 7 concrete (only where an area says its concrete is
// drawn as concrete, tools/garden-areas.mjs `surfaces`: elsewhere it's asphalt)
const KINDS = { footway: 0, path: 0, track: 0, bridleway: 0, steps: 1, cycleway: 2 };
const SURFACE = [
  [/^(paving_stones|sett|brick|bricks|stone|cobblestone|unhewn_cobblestone|concrete:plates|concrete:lanes|tiles|granite|sandstone)/, 0],
  [/^(asphalt|paved|concrete|metal|rubber|tartan)/, 1],
  [/^(gravel|fine_gravel|compacted|woodchips|rock|pebblestone|unpaved)/, 2],
  [/^(dirt|ground|earth|mud)/, 5],
  [/^sand/, 6],
  [/^(wood|boardwalk)/, 3],
  [/^(grass|grass_paver)/, 4]
];
const NAMED = { paving: 0, asphalt: 1, gravel: 2, timber: 3, concrete: 7 };
/** A path's surface from its tags, in `area` (some areas draw some of OSM's surfaces as another: `surfaces`) */
const surfaceOf = (t, area = null) => {
  if (t.bridge === 'boardwalk') return 3;
  const s = t.surface || '';
  const named = area?.surfaces?.[s];
  if (named !== undefined) {
    if (NAMED[named] === undefined) throw new Error(`${area.name}: no surface called ${named}`);
    return NAMED[named];
  }
  for (const [re, k] of SURFACE) if (re.test(s)) return k;
  return t.highway === 'path' || t.highway === 'track' ? 2 : 1;
};
// A path's width where OSM gives none: the garden's main walks are asphalt about 3 m across, its gravel ones narrower
const DEFAULT_WIDTH = [[2.4, 3, 1.8, 2, 1.2, 1.8, 1.8, 2.4], [2.4, 2.4, 2.4, 2.4, 2.4], [2.5, 2.5, 2.5, 2.5, 2.5]];
const TRACK_WIDTH = 1.2; // m: a track's, where OSM gives none
// ...and a bridleway's: Centennial Park's bridle track round Grand Drive and its gravel loops by the equestrian centre are 3.5-4.5 m across
// in the aerial imagery, and OSM gives none of them a width
const BRIDLE_WIDTH = 4;
const widthOf = (t, kind, surface) => {
  const w = parseFloat(t.width);
  if (Number.isFinite(w) && w > 0.6) return Math.min(6, w);
  if (t.highway === 'bridleway') return BRIDLE_WIDTH;
  if (kind === 3) return TRACK_WIDTH;
  return t.highway === 'track' ? 3 : DEFAULT_WIDTH[kind][surface] ?? DEFAULT_WIDTH[kind][2];
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
const byKind = [0, 0, 0, 0];
const STEP = 1; // m between the points a path is tested at
for (const e of pathsSource) {
  if (e.type !== 'way' || !e.geometry) continue;
  const t = e.tags || {};
  const kind = KINDS[t.highway];
  if (kind === undefined) continue;
  const pts = e.geometry.map((g) => toWorld(g.lon, g.lat));
  const first = pts.find(([x, z]) => areaAt(x, z, REACH));
  if (!first) continue;
  if (skipPath(t)) {
    if (/sidewalk|crossing/.test(t.footway || '')) skipped.sidewalk++;
    else skipped.offGround++;
    continue;
  }
  const surface = surfaceOf(t, areaAt(first[0], first[1], REACH));
  wayGeom.set(e.id, { pts, nodes: e.nodes, width: widthOf(t, kind, surface) });
  // Kept where it's in an area, off the roads, out of buildings and not under a deck too low to walk under: in runs
  const keep = (x, z) => areaAt(x, z, REACH) && roadClear(x, z) > 0.6 && !inBuilding(x, z) && landBits.at(x, z) === 1 && roomOver(x, z) >= ROOM.foot;
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      const line = rdp(run, 0.25);
      let L = 0;
      for (let i = 1; i < line.length; i++) L += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
      if (L >= 2) {
        // A track or a path laid with a kerb, by the area it runs through
        const [mx, mz] = run[run.length >> 1];
        const area = areaAt(mx, mz, REACH) || areaAt(run[0][0], run[0][1], REACH);
        const k = pathKind(kind, surface, area.kind, area.kerbedGravel);
        paths.push([k, surface, q1(widthOf(t, k, surface)), ...flat(line)]);
        metres += L;
        byKind[k] += L;
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
log(`${paths.length} paths, ${(metres / 1000).toFixed(1)} km (${byKind.map((m, k) => `${['footpaths', 'steps', 'cycleways', 'tracks'][k]} ${(m / 1000).toFixed(1)}`).join(', ')}); left out ${skipped.sidewalk} along or across streets, ${skipped.offGround} off the ground`);

// Gates on them: where they stand, which way their path runs through them, and how wide
const gates = [];
for (const e of pathsSource) {
  if (e.type !== 'node' || !/gate/.test(e.tags?.barrier || '')) continue;
  const [x, z] = toWorld(e.lon, e.lat);
  if (!areaAt(x, z, REACH) || roadClear(x, z) < 1 || MODEL_GATES.some(([gx, gz]) => Math.hypot(gx - x, gz - z) < 3) || onBridgeFoot(x, z, 0.5)
    || roomOver(x, z) < GATE_ROOM) continue;
  // Every way out of the gate along the paths through it, in the order they're found
  const arms = [];
  for (const way of wayGeom.values()) {
    const k = way.nodes.indexOf(e.id);
    if (k < 0) continue;
    if (k > 0) arms.push({ pt: way.pts[k - 1], after: false, width: way.width });
    if (k < way.pts.length - 1) arms.push({ pt: way.pts[k + 1], after: true, width: way.width });
  }
  const through = gateHeading([x, z], arms);
  if (!through) continue;
  // As wide as the path it's on
  const width = arms[through.used[0]].width;
  gates.push([q1(x), q1(z), Math.round(through.heading * 1000) / 1000, q1(Math.max(1.2, width + 0.4))]);
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

// Ponds and reflecting pools: still water at the ground's own height, not the sea's. A fountain's basin (amenity=fountain, or a fountain's
// water) is a pond too, and its middle and how far that is from its edge, [x, z, r], a fountain: js/garden.js gives it a rim and a plinth.
// In an area whose ponds are edged with rocks (tools/garden-areas.mjs `pondEdge`), they're `rockPonds`, not `ponds`: js/garden.js lays rocks
// along their edges in place of a coping. A pond's islands (OSM's inner rings: Centennial Park's lakes have one to five each) are
// `islands`, holes in its water, the park's lawn as round it; a fountain's are its plinth's.
const POND_MAX = 60000; // m²: the biggest still water a garden draws (Centennial Park's Busbys Pond is 57,356)
const MIN_ISLAND = 8; // m²: smaller islands are water
const ponds = [];
const rockPonds = [];
const islands = [];
const pondRings = [];
const islandRings = [];
const fountains = [];
for (const e of land) {
  const t = e.tags || {};
  if (t.natural !== 'water' || (t.water && !/^(pond|reflecting_pool|fishpond|basin|lake|fountain)$/.test(t.water))) continue;
  const { outer, inner } = elementRings(e);
  for (const ring of outer) {
    const area = Math.abs(ringArea(ring));
    if (ring.length < 4 || area < 8 || area > POND_MAX) continue;
    const b = bbox(ring), cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    if (!areaAt(cx, cz) || landBits.at(cx, cz) !== 1) continue;
    pondRings.push(ring);
    // (A fountain's inner ring is its plinth's, which js/garden.js draws itself, in its water)
    const fountain = t.amenity === 'fountain' || t.water === 'fountain';
    for (const hole of fountain ? [] : inner) {
      if (hole.length < 4 || Math.abs(ringArea(hole)) < MIN_ISLAND || !pointInRing(ring, hole[0][0], hole[0][1])) continue;
      islandRings.push(hole);
      islands.push(flat(rdpRing(hole, 0.2)));
    }
    if (areaAt(cx, cz).pondEdge === 'rock') {
      rockPonds.push(flat(rdpRing(ring, 0.2)));
      continue;
    }
    ponds.push(flat(rdpRing(ring, 0.2)));
    if (fountain) {
      // Its middle (the area's), and the nearest of its edges to it
      let ax = 0, az = 0, a2 = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const c = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
        a2 += c; ax += (ring[j][0] + ring[i][0]) * c; az += (ring[j][1] + ring[i][1]) * c;
      }
      const mx = ax / (3 * a2), mz = az / (3 * a2);
      fountains.push([q1(mx), q1(mz), q1(distToRing(ring, mx, mz))]);
    }
  }
}
const pondBoxes = pondRings.map((r) => bbox(r)), islandBoxes = islandRings.map((r) => bbox(r));
/** Whether (x, z) is in a pond's water (not on an island in it), or within `margin` of its edge or an island's */
const inPond = (x, z, margin = 0) => {
  const near = (b) => x >= b.x0 - margin && x <= b.x1 + margin && z >= b.z0 - margin && z <= b.z1 + margin;
  const wet = pondRings.some((r, i) => near(pondBoxes[i]) && pointInRing(r, x, z)) && !islandRings.some((r, i) => near(islandBoxes[i]) && pointInRing(r, x, z));
  return wet || (margin > 0 && (pondRings.some((r, i) => near(pondBoxes[i]) && distToRing(r, x, z) < margin)
    || islandRings.some((r, i) => near(islandBoxes[i]) && distToRing(r, x, z) < margin)));
};

// Paved areas OSM draws in a garden as areas, not lines (highway=pedestrian, a footway as an area): the plaza round the Archibald Fountain,
// the paving along the Pool of Reflection. The map draws a park's as lawn; the garden paves them where it does (the raised lawn, below), on
// the ground's level. Untagged, paving.
const plazaSource = [];
const otherPlazas = [];
for (const els of [load('all_roads.json').elements, pathsSource]) {
  for (const e of els) {
    const t = e.tags || {};
    const isArea = (/^(pedestrian|footway)$/.test(t.highway || '') && t.area === 'yes') || /^(pedestrian|footway)$/.test(t['area:highway'] || '');
    if (!isArea || (t.layer && t.layer !== '0') || (t.level && t.level !== '0') || (t.tunnel && t.tunnel !== 'no') || (t.bridge && t.bridge !== 'no')
      || t.indoor === 'yes' || t.covered === 'yes') continue;
    const { outer, inner } = elementRings(e);
    for (const ring of outer) {
      if (ring.length < 4) continue;
      const b = bbox(ring);
      const area = areaAt((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2);
      // Elsewhere, one the parks by rule may pave (below)
      if (!area) {
        otherPlazas.push({ tags: t, rings: [ring, ...inner.filter((h) => h.length > 3 && pointInRing(ring, h[0][0], h[0][1]))], middle: [(b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2] });
        continue;
      }
      const surface = t.surface ? surfaceOf(t, area) : 0;
      if (surface === 4) continue;
      plazaSource.push({ surface, rings: [ring, ...inner.filter((h) => h.length > 3 && pointInRing(ring, h[0][0], h[0][1]))] });
    }
  }
}
// ...and those drawn by hand (tools/local/, `paving`)
const HAND_SURFACE = { paving: 0, asphalt: 1, gravel: 2, concrete: 7 };
for (const area of localAreas()) {
  for (const p of area.paving || []) {
    const surface = HAND_SURFACE[p.surface];
    if (surface === undefined) throw new Error(`tools/local/${area.file}: no paved surface called ${p.surface}`);
    const ring = p.ring || Array.from({ length: 48 }, (_, i) => [p.circle[0] + p.circle[2] * Math.cos((i / 48) * Math.PI * 2), p.circle[1] + p.circle[2] * Math.sin((i / 48) * Math.PI * 2)]);
    const b = bbox(ring);
    if (!areaAt((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2)) throw new Error(`tools/local/${area.file}: paving outside every garden's area (${p.why})`);
    plazaSource.push({ surface, rings: [ring] });
  }
}
log(`${plazaSource.length} paved areas in them, OSM's and by hand`);
log(`${hedges.length} hedges, ${ponds.length} ponds and pools, ${fountains.length} of them fountains; ${rockPonds.length} edged with rocks; ${islands.length} islands in them`);

// --- Sea walls: the shore round the parks themselves, where a sandstone parapet keeps people out of the water (js/garden.js) ------------
// Not the boxes round the Opera House, whose Broadwalk has no parapet (its edge is the map's sea wall, js/city-grid.js: the model's
// parapets are on the podium), or the Quay's, where the ferries tie up. Each is
// [side, x, z, x, z, ...] along the shore, the land on the side `side` gives, as tools/build-tiles.mjs reckons a shore's (by its ring's
// winding). Open where steps or a jetty reach the water.
const WALL_REACH = 8; // m past a park's outline the shore can lie: its outline is often drawn along the top of the wall
const OPENING = 2.5; // m either side of where steps or a pier meet the shore
// ...nor a park whose shore is rock stepping down to the water (tools/garden-areas.mjs `rockShore`)
const parks = areas.filter((a) => a.osm && !a.rockShore);
const parkBox = bbox(parks.flatMap((a) => a.rings.flat()));
const inPark = (x, z) => parks.some((a) => x >= a.box.x0 - WALL_REACH && x <= a.box.x1 + WALL_REACH && z >= a.box.z0 - WALL_REACH && z <= a.box.z1 + WALL_REACH
  && a.rings.some((r) => pointInRing(r, x, z) || distToRing(r, x, z) <= WALL_REACH));
const openings = [];
for (const [kind, , , ...line] of paths) {
  if (kind !== 1) continue;
  openings.push([[line[0], line[1]], [line[2], line[3]]], [[line[line.length - 4], line[line.length - 3]], [line[line.length - 2], line[line.length - 1]]]);
}
for (const e of land) {
  if (e.tags?.man_made !== 'pier' || !e.geometry) continue;
  const pts = e.geometry.map((g) => toWorld(g.lon, g.lat));
  for (let i = 1; i < pts.length; i++) openings.push([pts[i - 1], pts[i]]);
}
const isOpen = (x, z) => openings.some(([a, b]) => segDist(x, z, a, b) < OPENING);
// ...and none where a beach runs down to the water (tools/build-sand.mjs)
const sandPieces = loadSand(GENERATED);
const onBeach = beachTest(sandPieces);
const seawalls = [];
let wallMetres = 0;
for (const rings of GEO.shores) {
  for (const flatRing of rings) {
    const ring = [];
    for (let k = 0; k < flatRing.length; k += 2) ring.push([flatRing[k], flatRing[k + 1]]);
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    const side = area > 0 ? 1 : -1;
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        const line = rdp(run, 0.1);
        let L = 0;
        for (let i = 1; i < line.length; i++) L += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
        if (L >= 3) {
          seawalls.push([side, ...flat(line)]);
          wallMetres += L;
        }
      }
      run = [];
    };
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
      // Nor where a region's edge cut the land (tools/build-tiles.mjs leaves those out of the shore too): Hyde Park South is on one
      if (Math.max(ax, bx) < parkBox.x0 - WALL_REACH || Math.min(ax, bx) > parkBox.x1 + WALL_REACH
        || Math.max(az, bz) < parkBox.z0 - WALL_REACH || Math.min(az, bz) > parkBox.z1 + WALL_REACH || onRegionEdge(ax, az, bx, bz)) {
        flush();
        continue;
      }
      const L = Math.hypot(bx - ax, bz - az) || 1;
      const n = Math.max(1, Math.ceil(L / 2));
      for (let k = 0; k < n; k++) {
        const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n;
        if (inPark(x, z) && !isOpen(x, z) && !beachBehind(onBeach, x, z, (bx - ax) / L, (bz - az) / L, side)) run.push([x, z]);
        else flush();
      }
    }
    flush();
  }
}
log(`${seawalls.length} sea walls, ${(wallMetres / 1000).toFixed(2)} km, round the parks' shores`);

// --- Raised lawns ----------------------------------------------------------------------------------------------------------------------
// In a formal area (tools/garden/raised-lawn.mjs): the lawn raised over its paved paths, kerbed along every edge. Areas that meet are one
// raster, so no kerb runs along where they meet. `kerb` what its kerbs are, by the area most of its outline is in: 0 concrete, 1 sandstone
// (tools/garden-areas.mjs `kerb`).
const lawns = [];
const plazas = [];
let plazaArea = 0;
{
  const formal = areas.filter((a) => a.kind === 'formal');
  const clusters = [];
  for (const a of formal) {
    const box = { x0: a.box.x0 - 8, z0: a.box.z0 - 8, x1: a.box.x1 + 8, z1: a.box.z1 + 8 };
    const meets = clusters.filter((c) => box.x0 <= c.box.x1 && box.x1 >= c.box.x0 && box.z0 <= c.box.z1 && box.z1 >= c.box.z0);
    const merged = { areas: [a, ...meets.flatMap((c) => c.areas)], box };
    for (const c of meets) {
      merged.box = { x0: Math.min(merged.box.x0, c.box.x0), z0: Math.min(merged.box.z0, c.box.z0), x1: Math.max(merged.box.x1, c.box.x1), z1: Math.max(merged.box.z1, c.box.z1) };
      clusters.splice(clusters.indexOf(c), 1);
    }
    clusters.push(merged);
  }
  const ringOf = (f) => { const out = []; for (let k = 0; k + 1 < f.length; k += 2) out.push([f[k], f[k + 1]]); return out; };
  const wet = [...[...ponds, ...rockPonds].map((f) => ({ ring: ringOf(f), val: 1 })), ...islands.map((f) => ({ ring: ringOf(f), val: 0 }))];
  // Its kerbs' stone, by the area most of its outline is in
  const kerbOf = (outer) => {
    const votes = new Map();
    for (const [x, z] of outer) {
      const a = areaAt(x, z, 1);
      if (a) votes.set(a, (votes.get(a) || 0) + 1);
    }
    const home = [...votes].sort((p, q) => q[1] - p[1])[0]?.[0];
    return home?.kerb === 'sandstone' ? 1 : 0;
  };
  const sum = { pieces: 0, area: 0, moved: 0, kept: 0, corners: 0 };
  for (const cluster of clusters) {
    const box = { x0: Math.floor(cluster.box.x0 / SQUARE) * SQUARE, z0: Math.floor(cluster.box.z0 / SQUARE) * SQUARE,
      x1: Math.ceil(cluster.box.x1 / SQUARE) * SQUARE, z1: Math.ceil(cluster.box.z1 / SQUARE) * SQUARE };
    // The areas, less what's left out of them
    const fill = (raised, ringLines) => {
      for (const a of cluster.areas) {
        for (const ring of a.rings) { raised.fillRing(ring, 1); ringLines(ring); }
        for (const b of a.except) {
          const ring = [[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]];
          raised.fillRing(ring, 0);
          ringLines(ring);
        }
      }
    };
    const traced = traceRaised({ box, fill, lawns: GEO.lawns, plazas: plazaSource, paths, wet, sand: sandPieces, kerbOf });
    lawns.push(...traced.lawns);
    plazas.push(...traced.plazas);
    for (const k of Object.keys(sum)) sum[k] += traced.stats[k];
    plazaArea += traced.stats.plazaArea;
  }
  log(`${plazas.length} paved areas traced, ${(plazaArea / 1e4).toFixed(2)} ha`);
  log(`${sum.pieces} pieces of raised lawn, ${(sum.area / 1e4).toFixed(1)} ha, in ${clusters.length} rasters; ${sum.moved} traced points moved onto their lines, ${sum.kept} not, ${sum.corners} corners put back`);
}

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
  wood: { every: 9, bed: -1, plants: [[K.broadleaf, 0.4, 10, 18], [K.fig, 0.2, 14, 22], [K.gum, 0.25, 12, 22], [K.small, 0.15, 5, 8]] },
  // A big park's woods (Centennial Park's paperbark swamps and eucalypt stands): gums and paperbarks, a few big exotics, every 16 m. At
  // the Royal Botanic Garden's `wood` (every 9 m, figs among them) its 31 ha of woods took 2,900 trees, and the low level drew up to
  // 270,000 more triangles over the park
  parkland: { every: 16, bed: -1, plants: [[K.gum, 0.45, 12, 22], [K.small, 0.35, 6, 10], [K.broadleaf, 0.2, 10, 18]] },
  // A Chinese garden's groves: small ornamental trees (maples, crepe myrtles, magnolias) under a few bigger ones (elms, willows), shrubs and
  // cycads between, in the bed its ground is planted as (`ground`), not one of their own
  chinese: { every: 4, bed: -1, plants: [[K.small, 0.38, 4, 8], [K.broadleaf, 0.14, 8, 14], [K.shrub, 0.3, 0.8, 1.8], [K.cycad, 0.06, 0.8, 1.4], [K.grass, 0.12, 0.5, 1.0]] }
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
    // A park planted with natives only (tools/garden-areas.mjs `natives`) has its woods planted as bush: natives and grasses, a few gums
    // ...and an area that says what its woods are (`woods`), with that
    if (!mix && t.natural === 'wood') {
      const a = areaAt((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2);
      mix = a.woods ?? (a.natives ? 'native' : 'wood');
    }
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
// An area planted all over (`ground`): its outline a zone, the biggest, so its woods and beds inside it keep their own plants
for (const a of areas) {
  if (!a.ground) continue;
  if (!MIX[a.ground]) throw new Error(`${a.name}: no mix called ${a.ground}`);
  for (const ring of a.rings) zones.push({ name: a.name, mix: a.ground, ring, area: Math.abs(ringArea(ring)) });
}
// The smaller of two overlapping zones is planted, as a bed inside a wood
zones.sort((p, q) => p.area - q.area);
log(`${zones.length} planted zones: ${Object.entries(zones.reduce((m, z) => ({ ...m, [z.mix]: (m[z.mix] || 0) + 1 }), {})).map(([k, v]) => `${v} ${k}`).join(', ')}`);

const TRUNK_CLEAR = 1.5; // m a tree's trunk keeps from the bridge's pylons and piers
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
// The City of Sydney register's trees in an area that has them all (tools/garden-areas.mjs `register`): tools/build-trees.mjs plants them
// wherever the garden is, so the garden plants no trees there, and keeps its small plants off them
const registered = (x, z) => areaAt(x, z)?.register === true;
let registerTrees = 0;
for (const [lon, lat, name, , status] of load('cos_trees.json')) {
  if (name === 'Not Applicable' || (status && status !== 'Tree')) continue;
  const [x, z] = toWorld(lon, lat);
  if (!registered(x, z)) continue;
  const key = Math.floor(x / PLANT_CELL) * 100000 + Math.floor(z / PLANT_CELL);
  (plantCells.get(key) || plantCells.set(key, []).get(key)).push([x, z, K.broadleaf]);
  registerTrees++;
}
// Where nothing can grow: paths (and their edges), ponds, roads, buildings and the sea. A plant's kept to the half metre (tools/build-trees.mjs),
// so it may move a third of a metre nearer a path.
const clearFor = (x, z, small) => pathClear(x, z) > (small ? 0.7 : 1.4) && !inPond(x, z, small ? 0.3 : 1) && roadClear(x, z, true) > (small ? 1.5 : 3)
  && !inBuilding(x, z) && landBits.at(x, z) === 1 && !onBridgeFoot(x, z, small ? 0.5 : TRUNK_CLEAR);

// Trees OSM has in the areas: by what it says they are, or what's growing round them. Not within TRUNK_CLEAR of the bridge's pylons or piers,
// which the game places a little off where they stand (OSM's trees beside Bradfield Park's pylons would grow through the granite)
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
// ...and a park of natives' (Barangaroo Reserve's): gums and angophoras, Port Jackson figs, banksias and she-oaks, cabbage-tree palms
const NATIVE_BIG = [[K.gum, 0.5], [K.fig, 0.15], [K.small, 0.25], [K.palm, 0.1]];
const HEIGHT = { [K.broadleaf]: [10, 18], [K.small]: [5, 9], [K.gum]: [12, 24], [K.fig]: [14, 24], [K.palm]: [6, 11], [K.jacaranda]: [8, 12],
  [K.bangalow]: [9, 17], [K.datePalm]: [7, 12], [K.araucaria]: [24, 36], [K.wollemi]: [8, 14], [K.cycad]: [1, 2.5], [K.treeFern]: [3, 5] };
const pick = (list, r) => {
  let acc = 0;
  for (const [kind, share] of list) if (r < (acc += share)) return kind;
  return list[list.length - 1][0];
};
const nodes = load('nodes.json').elements;
let osmTrees = 0;
const OFF_PATH = 0.5; // m off a path's edge a tree on it is moved to: kept to the half metre (tools/build-trees.mjs), it stays off it
let offFeet = 0;
/** (x, z) moved straight out from the nearest path's line to OFF_PATH past its edge, or null if that's on a path too */
const offPath = (x, z) => {
  let best = null;
  for (const sg of pathCells.get(Math.floor(x / PATH_CELL) * 100000 + Math.floor(z / PATH_CELL)) || []) {
    const [ax, az] = sg.a, [bx, bz] = sg.b, dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
    const cx = ax + dx * t, cz = az + dz * t, d = Math.hypot(x - cx, z - cz);
    if (!best || d - sg.r < best.d - best.sg.r) best = { sg, cx, cz, d };
  }
  if (!best) return null;
  // Straight out from its line, or across it where the tree is on the line itself
  const [ux, uz] = best.d > 1e-3 ? [(x - best.cx) / best.d, (z - best.cz) / best.d] : (() => {
    const [ax, az] = best.sg.a, [bx, bz] = best.sg.b, L = Math.hypot(bx - ax, bz - az) || 1;
    return [-(bz - az) / L, (bx - ax) / L];
  })();
  const out = [best.cx + ux * (best.sg.r + OFF_PATH), best.cz + uz * (best.sg.r + OFF_PATH)];
  return pathClear(out[0], out[1]) >= OFF_PATH - 0.01 ? out : null;
};
let movedOff = 0;
for (const e of nodes) {
  if (e.tags?.natural !== 'tree') continue;
  let [x, z] = toWorld(e.lon, e.lat);
  if (!areaAt(x, z) || registered(x, z)) continue;
  // ...not on a path: where OSM has one there, its line or the tree's is a little off (trees along Barangaroo Reserve's paths), so the tree
  // stands just off the path's edge, or isn't planted if that's on another
  if (pathClear(x, z) < 0.1) {
    const moved = offPath(x, z);
    if (!moved) continue;
    [x, z] = moved;
    movedOff++;
  }
  if (roadClear(x, z, true) < 2 || inBuilding(x, z) || landBits.at(x, z) !== 1) continue;
  if (onBridgeFoot(x, z, TRUNK_CLEAR)) { offFeet++; continue; }
  const zone = zoneAt(x, z);
  let kind = byTags(e.tags);
  if (kind === null && zone?.mix === 'palms') kind = seeded(x, z, 1) < 0.7 ? K.bangalow : K.datePalm;
  if (kind === null && zone?.mix === 'rainforest') kind = pick([[K.fig, 0.3], [K.broadleaf, 0.4], [K.bangalow, 0.3]], seeded(x, z, 1));
  if (kind === null) kind = pick(areaAt(x, z).natives ? NATIVE_BIG : BIG, seeded(x, z, 1));
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
      if (!areaAt(x, z) || registered(x, z) || treeNear(x, z, 6) || !clearFor(x, z, false)) continue;
      const kind = pick(BIG, seeded(x, z, 3));
      const [lo, hi] = HEIGHT[kind];
      addPlant(x, z, kind, Math.round(lo + seeded(x, z, 4) * (hi - lo)));
    }
  }
}
// Planted by hand (tools/local/, `plants`): a kind of tree in a row along a line every so many metres, or at points
let byHand = 0;
for (const area of localAreas()) {
  for (const p of area.plants || []) {
    const kind = K[p.kind];
    if (kind === undefined) throw new Error(`tools/local/${area.file}: no kind of plant called ${p.kind}`);
    const spots = [...(p.at || [])];
    if (p.line) {
      // Every `every` metres along the line, from its start, carried round its corners
      let next = 0, walked = 0;
      for (let i = 1; i < p.line.length; i++) {
        const [ax, az] = p.line[i - 1], [bx, bz] = p.line[i], L = Math.hypot(bx - ax, bz - az);
        for (; next <= walked + L; next += p.every) spots.push([ax + ((bx - ax) * (next - walked)) / L, az + ((bz - az) * (next - walked)) / L]);
        walked += L;
      }
    }
    for (const [x, z] of spots) {
      if (!areaAt(x, z) || !clearFor(x, z, SMALL.has(kind)) || treeNear(x, z, p.apart ?? 4)) continue;
      const [lo, hi] = p.height;
      addPlant(x, z, kind, Math.round(lo + seeded(x, z, 9) * (hi - lo)));
      byHand++;
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
      if ((!small && registered(x, z)) || !clearFor(x, z, small) || treeNear(x, z, small ? 1.2 : 5)) continue;
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
log(`${plants.length} plants: ${osmTrees} trees from OSM (${movedOff} moved off a path, ${offFeet} left out by the bridge's feet), ${byHand} by hand; by zone ${JSON.stringify(planted)}; ${registerTrees} of the register's trees kept clear of`);
log(`by kind: ${Object.entries(counts).map(([k, v]) => `${names[k]} ${v}`).join(', ')}; ${beds.length} beds`);

// --- The parks by rule ---------------------------------------------------------------------------------------------------------------
// Every other park on the map with paths (tools/garden-areas.mjs ruleParks()), laid out after the areas, which are as they were: their
// paths (kept where they're in a park and off what's in the way, as an area's, and off the lakes, the sand and rock and the model sites'
// cuts), and where
// a park is formal its raised lawn and paved areas, a 240 m square at a time (tools/garden/rule-parks.mjs): bush where it's wood or scrub in OSM or
// bush land in NSW's zoning, or all over where its tags or an override say. OSM's concrete is drawn as concrete there:
// no one has looked at their paths, and the older areas' asphalt for concrete was a choice made before there was a concrete to draw.
// Added after the areas' in garden.json's paths, lawns and plazas (`byRule`: how many are the areas'), and listed in `parks`: [id, kind,
// x0, z0, x1, z1].
const RULE = { name: 'the parks by rule', surfaces: { concrete: 'concrete' } };
const parkList = [], parkOut = { paths: [], lawns: [], plazas: [] };
if (!NO_PARKS) {
  const t0 = Date.now();
  const { SITE_CUTS } = await import('../js/model-sites.js');
  const { TILE, tileExists } = await import('../js/geodata.js');
  const cuts = SITE_CUTS.map((c) => c.poly.map((p) => [p.x, p.z]));
  // Where a park is bush: OSM's wood and scrub, and the bush land in NSW's zoning
  const zoningFile = dataPath('nsw_zoning.json');
  if (!fs.existsSync(zoningFile)) console.warn('[garden] no nsw_zoning.json: the parks by rule are bush only where OSM has wood (npm run data:fetch)');
  const pocketList = bushPockets(land, fs.existsSync(zoningFile) ? JSON.parse(fs.readFileSync(zoningFile, 'utf8')) : []);
  const pockets = new Pockets(pocketList);
  const { parks: ruled, left } = ruleParks(land, areas, { cuts, woods: pocketList });
  const why = new Map();
  for (const l of left) why.set(l.why, (why.get(l.why) || 0) + 1);
  log(`parks by rule: ${ruled.length} (most of it formal ${ruled.filter((p) => p.kind === 'formal').length}, bush ${ruled.filter((p) => p.kind === 'bush').length}; bush all over ${ruled.filter((p) => p.forced === 'bush').length}; ${pocketList.length} pockets of bush); left out ${left.length}: ${[...why].sort((p, q) => q[1] - p[1]).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  const index = new ParkIndex(ruled);
  // The 240 m squares laid out: those a park reaches, starting in one of the tiles asked for (a trial), or in any; and only what's in the
  // map's own tiles (world.json), so no garden makes a tile of its own
  const SQ = 240;
  const squareSet = new Set();
  for (const p of ruled) {
    const b = p.outline.box;
    for (let i = Math.floor(b.x0 / SQ); i <= Math.floor(b.x1 / SQ); i++) {
      for (let j = Math.floor(b.z0 / SQ); j <= Math.floor(b.z1 / SQ); j++) {
        if (!ONLY || ONLY.includes(`${Math.floor((i * SQ) / TILE)}_${Math.floor((j * SQ) / TILE)}`)) squareSet.add(i * 100000 + j);
      }
    }
  }
  const mapTile = (x, z) => tileExists(`${Math.floor(x / TILE)}_${Math.floor(z / TILE)}`);
  const within = (x, z) => mapTile(x, z) && squareSet.has(Math.floor(x / SQ) * 100000 + Math.floor(z / SQ));
  const squares = [...squareSet].map((k) => { const i = Math.round(k / 100000); return [i, k - i * 100000]; }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  log(`parks by rule: ${squares.length} squares to lay out${ONLY ? ` in the ${ONLY.length} tiles asked for` : ''}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // What's in the way, over the whole map: the roads on the ground, as roadClear() has them round the areas
  const cells = new Map();
  for (const l of RG.links) {
    if (!l) continue;
    const [a, b, , width, , , inner, , , kind = 0] = l;
    if (kind === 1 || kind === 2) continue;
    const pts = [[RG.nodes[a * 2], RG.nodes[a * 2 + 1]]];
    for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k + 1]]);
    pts.push([RG.nodes[b * 2], RG.nodes[b * 2 + 1]]);
    for (let i = 1; i < pts.length; i++) {
      const seg = [pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], width / 2];
      for (let cx = Math.floor((Math.min(seg[0], seg[2]) - 12) / ROAD_CELL); cx <= Math.floor((Math.max(seg[0], seg[2]) + 12) / ROAD_CELL); cx++) {
        for (let cz = Math.floor((Math.min(seg[1], seg[3]) - 12) / ROAD_CELL); cz <= Math.floor((Math.max(seg[1], seg[3]) + 12) / ROAD_CELL); cz++) {
          const key = cx * 100000 + cz;
          (cells.get(key) || cells.set(key, []).get(key)).push(seg);
        }
      }
    }
  }
  const offRoads = (x, z) => {
    for (const s of cells.get(Math.floor(x / ROAD_CELL) * 100000 + Math.floor(z / ROAD_CELL)) || []) if (segDist(x, z, [s[0], s[1]], [s[2], s[3]]) - s[4] <= 0.6) return false;
    return true;
  };
  const pondPieces = loadPonds(GENERATED).pieces;
  const inLake = pondTest(pondPieces);
  const inCut = (x, z) => cuts.some((c) => pointInRing(c, x, z));
  // ...and a beach's sand and the coast's rock, drawn over the lawn a path is laid on (tools/build-sand.mjs): a path there would be under them
  const onSand = pondTest(sandPieces.filter(([kind]) => kind <= 1));
  const clear = (x, z) => offRoads(x, z) && !inBuilding(x, z) && landBits.at(x, z) === 1 && !inLake(x, z) && !onSand(x, z) && !inCut(x, z)
    && roomOver(x, z) >= ROOM.foot;
  // OSM's paths near a park, as they're read for the areas
  const ways = [];
  for (const e of pathsSource) {
    if (e.type !== 'way' || !e.geometry) continue;
    const t = e.tags || {};
    const kind = KINDS[t.highway];
    if (kind === undefined || skipPath(t)) continue;
    const pts = e.geometry.map((g) => toWorld(g.lon, g.lat));
    const b = bbox(pts);
    if (!index.touches(b)) continue;
    const surface = surfaceOf(t, RULE);
    ways.push({ tags: t, pts, kind, surface, width: (k) => widthOf(t, k, surface) });
  }
  const found = parkPaths(ways, index, { inArea: (x, z) => areaAt(x, z, REACH), clear, within, pockets });
  parkOut.paths.push(...found.paths);
  log(`parks by rule: ${found.paths.length} paths, ${(found.metres / 1000).toFixed(1)} km (${found.byKind.map((m, k) => `${['footpaths', 'steps', 'cycleways', 'tracks'][k]} ${(m / 1000).toFixed(1)}`).join(', ')}), from ${ways.length} of OSM's near them, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const withPaths = ruled.filter((p) => (p.metres || 0) >= MIN_PATHS);
  log(`parks by rule with paths (${MIN_PATHS} m or more): ${withPaths.length}, most of it formal ${withPaths.filter((p) => p.kind === 'formal').length}, bush ${withPaths.filter((p) => p.kind === 'bush').length}`);
  // Paved areas in a formal park's raised lawn, as in an area's
  const plazasIn = [];
  for (const p of otherPlazas) {
    const park = index.at(p.middle[0], p.middle[1]);
    if (!park || kindAt(park, ...p.middle, pockets) !== 'formal' || (park.metres || 0) < MIN_PATHS || !within(...p.middle)) continue;
    const surface = p.tags.surface ? surfaceOf(p.tags, RULE) : 0;
    if (surface !== 4) plazasIn.push({ surface, rings: p.rings });
  }
  const raised = parkLawns(squares, { parks: ruled, pockets: pocketList, areas: areas.map((a) => a.rings), cuts, lawns: GEO.lawns, plazas: plazasIn,
    paths: [...paths, ...parkOut.paths], lakes: pondPieces, sand: sandPieces, mapTile: (ix, iz) => tileExists(`${ix}_${iz}`), tile: TILE });
  parkOut.lawns.push(...raised.lawns);
  parkOut.plazas.push(...raised.plazas);
  const st = raised.stats;
  log(`parks by rule: ${st.pieces} pieces of raised lawn, ${(st.area / 1e4).toFixed(1)} ha, in ${st.squares} squares; ${raised.plazas.length} paved areas, ${(st.plazaArea / 1e4).toFixed(2)} ha; ${st.moved} traced points moved onto their lines, ${st.kept} not, ${st.corners} corners put back; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // Nothing in a tile the map hasn't (tools/build-tiles.mjs would make one for it): a piece by the point its tile is found by, a path by
  // each segment's middle
  let dropped = 0;
  const middleIn = (f) => { const m = (f.length >> 2) << 1; return mapTile(f[m], f[m + 1]); };
  for (const list of [parkOut.lawns, parkOut.plazas]) {
    const kept = list.filter(([, outer]) => middleIn(outer));
    dropped += list.length - kept.length;
    list.splice(0, list.length, ...kept);
  }
  const cutPaths = [];
  for (const [kind, surface, width, ...line] of parkOut.paths) {
    let run = [];
    const flush = () => { if (run.length >= 4) cutPaths.push([kind, surface, width, ...run]); run = []; };
    for (let i = 0; i + 3 < line.length; i += 2) {
      if (!mapTile((line[i] + line[i + 2]) / 2, (line[i + 1] + line[i + 3]) / 2)) { dropped++; flush(); continue; }
      if (!run.length) run.push(line[i], line[i + 1]);
      run.push(line[i + 2], line[i + 3]);
    }
    flush();
  }
  parkOut.paths.splice(0, parkOut.paths.length, ...cutPaths);
  if (dropped) log(`parks by rule: ${dropped} pieces and path segments left out, in tiles the map hasn't`);
  // ...every park with any of its paths laid out (its raised lawn only with MIN_PATHS of them), for tools/tile-diff.mjs
  for (const p of ruled.filter((q) => q.metres > 0)) {
    const b = bbox(p.rings.flat());
    parkList.push([p.id, p.kind, Math.floor(b.x0), Math.floor(b.z0), Math.ceil(b.x1), Math.ceil(b.z1)]);
  }
}
fs.writeFileSync(OUT, JSON.stringify({
  areas: areas.map((a) => ({ name: a.name, rings: a.rings.map((r) => flat(rdpRing(r, 0.5))), except: a.except })),
  paths: [...paths, ...parkOut.paths], gates, hedges, ponds, rockPonds, islands, fountains, beds, seawalls, lawns: [...lawns, ...parkOut.lawns],
  plazas: [...plazas, ...parkOut.plazas], plants, small: [...SMALL],
  ...(parkList.length && { parks: parkList, byRule: { paths: paths.length, lawns: lawns.length, plazas: plazas.length } })
}));
log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
