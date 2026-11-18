// tools/build-garden.mjs: the footpaths of a few areas, and what their gardens are drawn with: beds, hedges, ponds (some edged with rocks)
// and fountains, paved areas, the gates on the paths, the raised lawn, and every plant, from OpenStreetMap (paths.json, land.json and
// all_roads.json, tools/extract-osm.mjs), the Royal Botanic Garden's own map and the City of Sydney's tree register (cos_trees.json). Writes
// tools/data/generated/garden.json. tools/build-trees.mjs adds its plants to the trees; tools/build-tiles.mjs cuts the rest into the tiles.
// It reads the game's tiles as last built too, for the Harbour Bridge's feet and the room under the decks (js/harbour-bridge.js,
// js/deck-room.js): not while tools/build-tiles.mjs writes them. Paths elsewhere wait: they'd change where everyone walks.
//   node tools/build-garden.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BitRaster, Raster, bbox, elementRings, flat, load, pointInRing, q1, rdp, ringArea, rdpRing, tiledPolygons, toWorld } from './geo-common.mjs';
import { MODEL_GATES, gardenAreas, gateHeading, pathKind } from './garden-areas.mjs';
import { onRegionEdge } from './geodata/regions.mjs';
import { localAreas } from './local-edits.mjs';
import { beachBehind, beachTest, loadSand } from './sand-pieces.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GENERATED = path.join(ROOT, 'tools/data/generated');
const OUT = path.join(GENERATED, 'garden.json');
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
      if (!area) continue;
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
// Not the boxes round the Opera House, whose model has its own sea wall, or the Quay's, where the ferries tie up. Each is
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
// In a formal area the lawn stands RAISE over the map's (js/garden.js), with a kerb along every edge of it and its paved paths down
// between: the map's lawn in the area (its pieces, tools/geodata/region-worker.mjs) less a corridor along each kerbed path, steps too
// (half its width and the kerb's: the kerb stands in the corridor, at the path's edge), and less the ponds (the kerb round one stands in
// its water, under its coping). Tracks are worn into it, not cut out of it; beds and hedges stand on it. A gate stands on its path, its
// pillars on the lawn either side, so its opening is the path's corridor. Areas that meet are one raster, so no kerb runs along where
// they meet. Traced in the map's 240 m squares, as its lawns are, so each piece is cheap to lay on the lawn's triangles; each traced point
// is then moved onto what its cells stand for (a corridor's edge, a pond's edge, the lawn's or the area's outline), so a kerb stands at
// its path's edge, not wherever the cells put it, and kept to the centimetre. [[kerb, outer, ...holes]], each ring [x, z, ...]; `kerb` what
// its kerbs are, by the area most of its outline is in: 0 concrete, 1 sandstone (tools/garden-areas.mjs `kerb`). Nor is it raised where
// the map draws a beach's sand or the coast's rock over the lawn (tools/build-sand.mjs): it stops at their edge.
const RAISED_RES = 0.5; // m: the raster's cells
const KERB = 0.1; // m: the kerb's width (js/garden.js)
const SNAP = 0.6; // m a traced point may move onto what its cells stand for
const MIN_LAWN = 1; // m²: smaller pieces of raised lawn, and holes in it, are left out
const SLIVER = 0.3; // m: raised lawn narrower than twice this is left out
const SPIKE = 0.06; // m²: a traced point that turns the ring back on itself, the triangle with its two neighbours smaller than this, is left out
const SQUARE = 240; // m: the map's lawns' squares (tools/geodata/region-worker.mjs)
const kerbed = (kind, surface) => kind !== 3 && surface !== 4; // tracks aren't, and trodden grass that isn't one isn't drawn
/** Each point's way across a polyline ([[x, z], ...]), with its mitre's stretch, as js/garden.js across() draws a path's */
const mitres = (pts) => pts.map((p, i) => {
  const unit = (x, z) => { const L = Math.hypot(x, z) || 1; return [x / L, z / L]; };
  const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
  const prev = i > 0 ? unit(p[0] - a[0], p[1] - a[1]) : null, next = i < pts.length - 1 ? unit(b[0] - p[0], b[1] - p[1]) : null;
  const d = prev && next ? unit(prev[0] + next[0], prev[1] + next[1]) : prev || next;
  const stretch = prev && next ? Math.min(2, 1 / Math.max(0.5, d[0] * next[0] + d[1] * next[1])) : 1;
  return [-d[1] * stretch, d[0] * stretch];
});
const q2 = (v) => Math.round(v * 100) / 100;
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
  let pieces = 0, area = 0, moved = 0, kept = 0, corners = 0;
  for (const cluster of clusters) {
    const box = { x0: Math.floor(cluster.box.x0 / SQUARE) * SQUARE, z0: Math.floor(cluster.box.z0 / SQUARE) * SQUARE,
      x1: Math.ceil(cluster.box.x1 / SQUARE) * SQUARE, z1: Math.ceil(cluster.box.z1 / SQUARE) * SQUARE };
    const blank = () => new Raster(box.x0, box.z0, box.x1 - RAISED_RES, box.z1 - RAISED_RES, RAISED_RES);
    // What its cells stand for, as lines: each { a, b, r }, the edge r out from the segment a-b
    const LINE_CELL = 8;
    const lines = new Map();
    const addLine = (a, b, r = 0) => {
      const s = { a, b, r };
      for (let cx = Math.floor((Math.min(a[0], b[0]) - r - SNAP) / LINE_CELL); cx <= Math.floor((Math.max(a[0], b[0]) + r + SNAP) / LINE_CELL); cx++) {
        for (let cz = Math.floor((Math.min(a[1], b[1]) - r - SNAP) / LINE_CELL); cz <= Math.floor((Math.max(a[1], b[1]) + r + SNAP) / LINE_CELL); cz++) {
          const key = cx * 100000 + cz;
          (lines.get(key) || lines.set(key, []).get(key)).push(s);
        }
      }
    };
    // A lawn piece's edge along its square's (a seam, where the next piece goes on) is nothing to stand at
    const onSeam = (a, b) => (a[0] === b[0] && Math.abs(a[0] / SQUARE - Math.round(a[0] / SQUARE)) < 1e-9)
      || (a[1] === b[1] && Math.abs(a[1] / SQUARE - Math.round(a[1] / SQUARE)) < 1e-9);
    const ringLines = (ring, r = 0) => { for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if (!onSeam(ring[j], ring[i])) addLine(ring[j], ring[i], r); };
    const inBox = (pts) => pts.some(([x, z]) => x >= box.x0 - 10 && x <= box.x1 + 10 && z >= box.z0 - 10 && z <= box.z1 + 10);

    // The areas, less what's left out of them
    const raised = blank();
    for (const a of cluster.areas) {
      for (const ring of a.rings) { raised.fillRing(ring, 1); ringLines(ring); }
      for (const b of a.except) {
        const ring = [[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]];
        raised.fillRing(ring, 0);
        ringLines(ring);
      }
    }
    // ...where the map has lawn: each piece's outline less its holes
    const lawn = blank();
    for (const rings of GEO.lawns) {
      const pts = rings.map((f) => { const out = []; for (let k = 0; k + 1 < f.length; k += 2) out.push([f[k], f[k + 1]]); return out; });
      if (!inBox(pts[0])) continue;
      lawn.fillRing(pts[0], 1);
      for (const hole of pts.slice(1)) lawn.fillRing(hole, 0);
      for (const ring of pts) ringLines(ring);
    }
    for (let i = 0; i < raised.d.length; i++) raised.d[i] &= lawn.d[i];
    // ...less the paved areas, each surface's traced on its own (below) where it's on the map's lawn in an area
    const plazaBy = new Map();
    for (const p of plazaSource) {
      if (!inBox(p.rings[0])) continue;
      const r = plazaBy.get(p.surface) || plazaBy.set(p.surface, blank()).get(p.surface);
      r.fillRing(p.rings[0], 1);
      for (const hole of p.rings.slice(1)) r.fillRing(hole, 0);
      for (const ring of p.rings) ringLines(ring);
    }
    for (const r of plazaBy.values()) {
      for (let i = 0; i < r.d.length; i++) {
        r.d[i] &= raised.d[i];
        if (r.d[i]) raised.d[i] = 0;
      }
    }
    // ...less the corridors of its kerbed paths and steps, and its ponds
    // A corridor is its path as js/garden.js draws it (mitred where it bends: pathPieces()), KERB wider either side, and KERB past each end:
    // its kerb across a path that ends on the lawn
    for (const [kind, surface, width, ...line] of paths) {
      if (!kerbed(kind, surface)) continue;
      const pts = [];
      for (let k = 0; k + 1 < line.length; k += 2) pts.push([line[k], line[k + 1]]);
      if (!inBox(pts)) continue;
      const r = width / 2 + KERB;
      const side = mitres(pts);
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 1e-3) continue;
        const ux = (bx - ax) / L, uz = (bz - az) / L;
        const back = i === 1 ? KERB : 0, on = i === pts.length - 1 ? KERB : 0;
        const a = [ax - ux * back, az - uz * back], b = [bx + ux * on, bz + uz * on];
        const [sa, sb] = [side[i - 1], side[i]];
        const quad = [[a[0] + sa[0] * r, a[1] + sa[1] * r], [b[0] + sb[0] * r, b[1] + sb[1] * r], [b[0] - sb[0] * r, b[1] - sb[1] * r], [a[0] - sa[0] * r, a[1] - sa[1] * r]];
        raised.fillRing(quad, 0);
        addLine(quad[0], quad[1]);
        addLine(quad[3], quad[2]);
        if (back) addLine(quad[0], quad[3]);
        if (on) addLine(quad[1], quad[2]);
      }
    }
    // ...its water, that is: not its islands, which are lawn as the park's round it is
    const wet = blank();
    let anyWet = false;
    for (const [list, val] of [[[...ponds, ...rockPonds], 1], [islands, 0]]) {
      for (const f of list) {
        const ring = [];
        for (let k = 0; k + 1 < f.length; k += 2) ring.push([f[k], f[k + 1]]);
        if (!inBox(ring)) continue;
        wet.fillRing(ring, val);
        ringLines(ring);
        anyWet = true;
      }
    }
    if (anyWet) {
      for (let i = 0; i < wet.d.length; i++) {
        if (!wet.d[i]) continue;
        raised.d[i] = 0;
        for (const r of plazaBy.values()) r.d[i] = 0;
      }
    }
    // ...and the sand and rock on land, each piece's outline less its holes: a piece over no raised lawn adds no lines to move points onto
    for (const [kind, ...flats] of sandPieces) {
      if (kind > 1) continue;
      const rings = flats.map((f) => { const out = []; for (let k = 0; k + 1 < f.length; k += 2) out.push([f[k], f[k + 1]]); return out; });
      if (!inBox(rings[0])) continue;
      const b = bbox(rings[0]);
      // Its own cells, on the same grid as the area's
      const piece = new Raster(Math.max(b.x0, box.x0), Math.max(b.z0, box.z0), Math.min(b.x1, box.x1 - RAISED_RES), Math.min(b.z1, box.z1 - RAISED_RES), RAISED_RES);
      if (piece.w < 1 || piece.h < 1) continue;
      piece.fillRing(rings[0], 1);
      for (const hole of rings.slice(1)) piece.fillRing(hole, 0);
      const di = Math.round((piece.x0 - raised.x0) / RAISED_RES), dj = Math.round((piece.z0 - raised.z0) / RAISED_RES);
      let cut = 0;
      for (let j = 0; j < piece.h; j++) {
        for (let i = 0; i < piece.w; i++) {
          const k = (j + dj) * raised.w + i + di;
          if (piece.d[j * piece.w + i] && i + di < raised.w && j + dj < raised.h && raised.d[k]) { raised.d[k] = 0; cut++; }
        }
      }
      if (cut) for (const ring of rings) ringLines(ring);
    }

    // ...less what's too narrow for its cells to draw: a strip between two corridors that close is lawn at the paths' level
    raised.open(SLIVER);
    // A traced point moved onto the nearest line within SNAP, or where two meet onto both, with the lines it's on; a point on its square's
    // edge stays put
    const project = (p, s) => {
      const [ax, az] = s.a, [bx, bz] = s.b;
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-12;
      const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / L2));
      const cx = ax + dx * t, cz = az + dz * t, d = Math.hypot(p[0] - cx, p[1] - cz);
      if (!s.r) return { at: [cx, cz], off: d };
      if (d < 1e-6) return null;
      return { at: [cx + ((p[0] - cx) / d) * s.r, cz + ((p[1] - cz) / d) * s.r], off: Math.abs(d - s.r) };
    };
    const moveOnto = (p, onEdge) => {
      if (onEdge(p[0], p[1])) return { at: alongSeam(p), on: [] };
      const near = [];
      for (const s of lines.get(Math.floor(p[0] / LINE_CELL) * 100000 + Math.floor(p[1] / LINE_CELL)) || []) {
        const hit = project(p, s);
        if (hit && hit.off < SNAP) near.push({ s, ...hit });
      }
      if (!near.length) { kept++; return { at: p, on: [] }; }
      near.sort((u, v) => u.off - v.off);
      moved++;
      // Where two lines meet: onto both, turn about
      if (near.length > 1 && near[1].off < SNAP / 2 && near[1].s !== near[0].s) {
        let q = p;
        for (let k = 0; k < 12; k++) q = project(project(q, near[0].s)?.at ?? q, near[1].s)?.at ?? q;
        const a = project(q, near[0].s), b = project(q, near[1].s);
        if (a && b && a.off < 0.02 && b.off < 0.02 && Math.hypot(q[0] - p[0], q[1] - p[1]) < SNAP) return { at: q, on: [near[0].s, near[1].s] };
      }
      return { at: near[0].at, on: [near[0].s] };
    };
    // A point on a square's edge, slid along it onto the nearest line that crosses it there: the same for the squares either side, whose
    // pieces meet on it. One at a square's corner stays put.
    const alongSeam = (p) => {
      const onX = Math.abs(p[0] / SQUARE - Math.round(p[0] / SQUARE)) < 1e-9, onZ = Math.abs(p[1] / SQUARE - Math.round(p[1] / SQUARE)) < 1e-9;
      if (onX === onZ) return p;
      let best = null, far = SNAP;
      for (const s of lines.get(Math.floor(p[0] / LINE_CELL) * 100000 + Math.floor(p[1] / LINE_CELL)) || []) {
        if (s.r) continue;
        const [ax, az] = s.a, [bx, bz] = s.b;
        // Where the line crosses the seam, if it does within its length
        const [u, ua, ub] = onX ? [p[0], ax, bx] : [p[1], az, bz];
        if ((ua - u) * (ub - u) > 0 || ua === ub) continue;
        const t = (u - ua) / (ub - ua);
        const at = onX ? [p[0], az + (bz - az) * t] : [ax + (bx - ax) * t, p[1]];
        const d = Math.hypot(at[0] - p[0], at[1] - p[1]);
        if (d < far) { far = d; best = at; }
      }
      return best || p;
    };
    // Where two straight lines cross, carried on past their ends
    const meet = (s, t) => {
      const [ax, az] = s.a, [bx, bz] = s.b, [cx, cz] = t.a, [dx, dz] = t.b;
      const ux = bx - ax, uz = bz - az, vx = dx - cx, vz = dz - cz, den = ux * vz - uz * vx;
      if (Math.abs(den) < 1e-6 * Math.hypot(ux, uz) * Math.hypot(vx, vz)) return null;
      const k = ((cx - ax) * vz - (cz - az) * vx) / den;
      return [ax + ux * k, az + uz * k];
    };
    const snap = (ring, onEdge) => {
      const moved = ring.map((p) => moveOnto(p, onEdge));
      const out = [];
      for (let i = 0; i < moved.length; i++) {
        const p = moved[i], q = moved[(i + 1) % moved.length];
        out.push(p.at);
        // Two points on two lines that meet between them: the corner too, which the straight edge from one to the other would cut
        const s = p.on[p.on.length - 1], t = q.on[0];
        if (!s || !t || s === t || p.on.includes(t) || q.on.includes(s) || s.r || t.r) continue;
        const c = meet(s, t);
        if (!c) continue;
        const pq = Math.hypot(q.at[0] - p.at[0], q.at[1] - p.at[1]);
        const cp = Math.hypot(c[0] - p.at[0], c[1] - p.at[1]), cq = Math.hypot(c[0] - q.at[0], c[1] - q.at[1]);
        if (cp < 0.005 || cq < 0.005 || cp > 12 || cq > 12 || cp + cq > pq + 0.75) continue;
        out.push(c);
        corners++;
      }
      return despike(out).map(([x, z]) => [q2(x), q2(z)]);
    };
    // Without a point where the ring doubles back on itself, a thin spike: one moved onto a line just past where it meets another
    const despike = (ring) => {
      let out = ring;
      for (let changed = true; changed && out.length > 3;) {
        changed = false;
        const keep = out.filter((b, i) => {
          const a = out[(i + out.length - 1) % out.length], c = out[(i + 1) % out.length];
          const ux = b[0] - a[0], uz = b[1] - a[1], vx = c[0] - b[0], vz = c[1] - b[1];
          const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
          if (lu < 1e-6 || lv < 1e-6) { changed = true; return false; }
          if (Math.abs(ux * vz - uz * vx) / 2 < SPIKE && ux * vx + uz * vz < -0.5 * lu * lv) { changed = true; return false; }
          return true;
        });
        if (keep.length < 3) break;
        out = keep;
      }
      return out;
    };
    for (const rings of tiledPolygons(raised, SQUARE, 0.02, MIN_LAWN / RAISED_RES ** 2, MIN_LAWN, null, snap)) {
      if (Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((t, r) => t + Math.abs(ringArea(r)), 0) < MIN_LAWN) continue;
      const votes = new Map();
      for (const [x, z] of rings[0]) {
        const a = areaAt(x, z, 1);
        if (a) votes.set(a, (votes.get(a) || 0) + 1);
      }
      const home = [...votes].sort((p, q) => q[1] - p[1])[0]?.[0];
      // To the centimetre, without a point repeated once rounded, nor the first again at the end
      lawns.push([home?.kerb === 'sandstone' ? 1 : 0, ...rings.map((r) => r.map(([x, z]) => [q2(x), q2(z)]).filter((p, i, all) => {
        const q = all[(i + 1) % all.length];
        return p[0] !== q[0] || p[1] !== q[1];
      }).flat())]);
      pieces++;
      area += Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((t, r) => t + Math.abs(ringArea(r)), 0);
    }
    // The paved areas, traced as the raised lawn is, so their edges and its meet on the same lines: [surface, outer, ...holes]
    for (const [surface, r] of [...plazaBy].sort((p, q) => p[0] - q[0])) {
      for (const rings of tiledPolygons(r, SQUARE, 0.02, MIN_LAWN / RAISED_RES ** 2, MIN_LAWN, null, snap)) {
        const held = Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((t, q) => t + Math.abs(ringArea(q)), 0);
        if (held < MIN_LAWN) continue;
        plazas.push([surface, ...rings.map((q) => q.map(([x, z]) => [q2(x), q2(z)]).filter((p, i, all) => {
          const n = all[(i + 1) % all.length];
          return p[0] !== n[0] || p[1] !== n[1];
        }).flat())]);
        plazaArea += held;
      }
    }
  }
  log(`${plazas.length} paved areas traced, ${(plazaArea / 1e4).toFixed(2)} ha`);
  log(`${pieces} pieces of raised lawn, ${(area / 1e4).toFixed(1)} ha, in ${clusters.length} rasters; ${moved} traced points moved onto their lines, ${kept} not, ${corners} corners put back`);
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

fs.writeFileSync(OUT, JSON.stringify({
  areas: areas.map((a) => ({ name: a.name, rings: a.rings.map((r) => flat(rdpRing(r, 0.5))), except: a.except })),
  paths, gates, hedges, ponds, rockPonds, islands, fountains, beds, seawalls, lawns, plazas, plants, small: [...SMALL]
}));
log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
