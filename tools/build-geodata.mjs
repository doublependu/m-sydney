// tools/build-geodata.mjs: writes js/geodata.js from the snapshots in tools/data (see tools/fetch-data.mjs).
// usage: node --max-old-space-size=8192 tools/build-geodata.mjs [out.js]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BEARING, BitRaster, DETAIL_BOUNDS, DETAIL_RECTS, GRID, Raster, dataPath, bbox, fromWorld, chainRings, elementRings, flat, inDetail, jsonLines, load, log, q1, rdp,
  ringArea, tiledPolygons, toWorld
} from './geo-common.mjs';
import { heightSampler } from './fetch-elevation.mjs';
import { MARGIN, REGION, regionsOver, runJobs } from './geodata/regions.mjs';
import { editWays } from './local-edits.mjs';

const OUT = (process.argv[2]?.startsWith('--') ? null : process.argv[2]) || fileURLToPath(new URL('./data/generated/geodata.js', import.meta.url));
const B = DETAIL_BOUNDS;
const RES = 1;
const KERB_CLEAR = 0.4; // m past a road's edge that its kerbs stand: what's drawn runs 0.6 m past it, under them

const REUSE = process.argv.includes('--reuse-rasters'); // Land and walls from the last run, as they don't change between its two runs
const GENERATED = fileURLToPath(new URL('./data/generated/', import.meta.url));

// The ocean and what opens off it, like Botany Bay: everything east of the coastline. Its ways point with the land on their left, so strung
// together from the south they run north, and the far side of the sea closes the ring. A closed chain is an island.
const WIDE = { x0: B.x0 - 6000, x1: B.x1 + 6000, z0: B.z0 - 6000, z1: B.z1 + 6000 };
function seaRings() {
  const chains = chainRings(load('coast.json').elements.filter((e) => e.geometry).map((e) => e.geometry.map((g) => toWorld(g.lon, g.lat))));
  const isClosed = (c) => Math.hypot(c[0][0] - c[c.length - 1][0], c[0][1] - c[c.length - 1][1]) < 1;
  const islands = chains.filter((c) => isClosed(c));
  const open = chains.filter((c) => !isClosed(c) && c.length > 100).sort((p, q) => q[0][1] - p[0][1]);
  const shore = open.flat();
  const last = shore[shore.length - 1], first = shore[0];
  const FAR = 60000;
  return { sea: [...shore, [last[0] + FAR, last[1]], [last[0] + FAR, first[1] + FAR], [first[0], first[1] + FAR]], islands };
}

// --- Land: the detail rectangles minus the sea, the harbour and the rivers, plus the piers. A region at a time. --------------
const harbour = load('harbour.json').elements.find((e) => e.id === 15522136);
const { outer: harbourOuter, inner: harbourInner } = elementRings(harbour);
log(`harbour: ${harbourOuter.length} outer, ${harbourInner.length} inner rings`);
const osmLand = load('land.json').elements;
const { sea, islands } = seaRings();
log(`coast: ${sea.length} points, ${islands.length} islands`);
const REGIONS = regionsOver(DETAIL_RECTS);
const landFrame = { x0: Math.floor(B.x0 / REGION) * REGION, z0: Math.floor(B.z0 / REGION) * REGION, x1: Math.ceil(B.x1 / REGION) * REGION, z1: Math.ceil(B.z1 / REGION) * REGION };
let land;
let shores;
const landFile = GENERATED + 'land.bin', shoresFile = GENERATED + 'shores.json';
const riversAndPiers = () => {
  // Rivers, canals and lagoons at the level of the sea, like the Cooks River. A pond in a park or a reservoir up a hill stays out of it: the water
  // here is one sheet at sea level, and those would need one of their own.
  const seaLevel = heightSampler(5);
  const rivers = [];
  const piers = [];
  for (const e of osmLand) {
    if (e.tags?.man_made === 'pier') {
      const { outer } = elementRings(e);
      for (const ring of outer) {
        const closed = ring.length > 3 && Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 0.5;
        if (!ring.some(([x, z]) => inDetail(x, z))) continue;
        const width = parseFloat(e.tags.width) || 3;
        if (!closed && width < 2.5) continue;
        piers.push({ ring, closed, width });
      }
      continue;
    }
    if (e.tags?.natural !== 'water' || /^(pond|basin|wastewater|reservoir|reflecting_pool|pool|stream_pool|fountain)$/.test(e.tags.water || '')) continue;
    const { outer, inner } = elementRings(e);
    const low = outer.filter((ring) => {
      if (ring.length < 4 || Math.abs(ringArea(ring)) < 1500 || !ring.some(([x, z]) => inDetail(x, z))) return false;
      const heights = ring.map(([x, z]) => seaLevel(...fromWorld(x, z))).filter((y) => y !== null);
      return !heights.length || heights.reduce((t, y) => t + y, 0) / heights.length <= 3;
    });
    if (low.length) rivers.push({ outer: low, inner });
  }
  log(`${rivers.length} rivers, canals and lagoons, ${piers.length} piers`);
  return { rivers, piers };
};
if (REUSE && fs.existsSync(landFile) && fs.existsSync(shoresFile)) {
  land = BitRaster.load(landFile);
  shores = JSON.parse(fs.readFileSync(shoresFile, 'utf8'));
  log('land from the last run');
} else {
  land = new BitRaster(landFrame.x0, landFrame.z0, landFrame.x1, landFrame.z1, RES);
  const { rivers, piers } = riversAndPiers();
  const started = Date.now();
  const results = await runJobs({ landFrame, landBuffer: land.bits.buffer, water: { sea, islands, harbourOuter, harbourInner, rivers, piers } },
    REGIONS.map((r) => ({ kind: 'land', ...r })));
  shores = results.flatMap((r) => r.shores);
  log(`land: ${shores.length} pieces in ${REGIONS.length} regions, ${(results.reduce((t, r) => t + r.cells, 0) / 1e6).toFixed(1)} km², in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  land.save(landFile);
  fs.writeFileSync(shoresFile, JSON.stringify(shores));
}

// --- Building walls keep the curbs honest: OSM rarely has road widths --------------------------------------------------
const wallsFile = GENERATED + 'walls.bin';
let walls;
if (REUSE && fs.existsSync(wallsFile)) walls = BitRaster.load(wallsFile);
else {
  walls = new BitRaster(landFrame.x0, landFrame.z0, landFrame.x1, landFrame.z1, RES);
  let walled = 0;
  for (const b of jsonLines(dataPath('overture_syd.json'))) {
    if (b.class === 'roof' || b.is_underground) continue;
    const g = typeof b.g === 'string' ? JSON.parse(b.g) : b.g;
    for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) walls.fillRing(poly[0].map(([lon, lat]) => toWorld(lon, lat)));
    walled++;
  }
  log(`${walled} buildings' walls`);
  walls.save(wallsFile);
}
function wallClearance(pts) {
  const left = [], right = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    for (let s = 2; s < L; s += 6) {
      const x = ax + ux * s, z = az + uz * s;
      for (const [out, sign] of [[left, 1], [right, -1]]) {
        let d = 1;
        while (d < 24 && !walls.at(x - uz * d * sign, z + ux * d * sign)) d++;
        out.push(d);
      }
    }
  }
  const low = (v) => (v.length ? v.sort((p, q) => p - q)[Math.floor(v.length * 0.2)] : 24);
  return Math.min(low(left), low(right));
}

// --- Roads ---------------------------------------------------------------------------------------------------------------
const DRIVEN = /^(motorway|motorway_link|trunk|primary|secondary|tertiary|unclassified|residential|living_street|trunk_link|primary_link|secondary_link|tertiary_link)$/;
const MAJOR = /^(motorway|trunk|primary|secondary)/;
const MOTORWAY = /^motorway/;
// Each link's OSM class, in its flags from the second bit (js/surfaces.js ROAD_CLASSES has the same list): road markings and
// how busy a street is follow it
const ROAD_CLASSES = ['', 'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'link', 'pedestrian'];
const classOf = (highway) => Math.max(0, /_link$/.test(highway) ? ROAD_CLASSES.indexOf('link') : ROAD_CLASSES.indexOf(highway));
const WIDTH = { motorway: 11, motorway_link: 7, trunk: 17, primary: 15, secondary: 13.5, tertiary: 11.5, unclassified: 9, residential: 8.8, living_street: 6.5, service: 5.5, trunk_link: 7, primary_link: 7, secondary_link: 7, tertiary_link: 7 };
const oneWay = (t) => t.oneway === 'yes' || t.oneway === '-1' || t.junction === 'roundabout' || t.junction === 'circular';
function classWidth(t) {
  const w = parseFloat(t.width);
  if (w > 2) return w;
  const lanes = parseInt(t.lanes, 10) || 0;
  if (lanes) return Math.max(oneWay(t) ? 5 : 6.4, lanes * 3.3 + (oneWay(t) ? 1.5 : 2.5));
  return WIDTH[t.highway] || 8.8;
}
// covered=yes is a street with something built over it: Argyle, George and Cumberland Sts under the bridge's approach and
// Hickson Rd under the Walsh Bay wharves are the only ways out of The Rocks, and through it to the bridge. They're streets
// at ground level. Tunnels, bridges and motorways are all kept, each on its own level (KIND below).
const underground = (t) => t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage';
// Under the ground's level but open to the sky all along, between sheer walls: tunnel=yes with cutting=yes, which OSM never has
// together, so only a hand edit makes one (the Cahill's loop up to the bridge, tools/local/harbour-bridge-cbd.json). Flag 64: the
// game never closes it over, however deep it runs (js/surfaces.js deriveTunnels)
const openCutting = (t) => underground(t) && t.cutting === 'yes';
// Bus-only: access=no, for buses. Taken in only where an area's hand edits name the way (tools/local/), as the bus lane between
// the Harbour Bridge's east pylons: the map has 279 of them, and taking them all at once would change tiles everywhere. Their
// links carry flag 32, and traffic keeps cars off them (js/road-network.js busOnly)
const busOnly = (t) => t.access === 'no' && (t.psv === 'designated' || t.bus === 'designated');
function driven(t, w) {
  if (busOnly(t) && w?.local) return DRIVEN.test(t.highway);
  if (t.access === 'private' || t.access === 'no' || t.motor_vehicle === 'no' || t.motorcar === 'no') return false;
  if (t.highway === 'service') return !!t.name && !/parking_aisle|driveway/.test(t.service || '');
  return DRIVEN.test(t.highway);
}
// Hand edits by area (tools/local/): applied to OSM's own ways, so every later step sees them as OSM
const osmRoads = (() => {
  const edited = editWays(load('all_roads.json').elements.filter((e) => e.geometry));
  log(edited.summary);
  return edited.elements;
})();
const inPlay = (w) => w.geometry.some((g) => inDetail(...toWorld(g.lon, g.lat)));

// The Harbour Bridge: a corridor along the real alignment, from Upper Fort St in The Rocks to the Pacific Hwy at North Sydney,
// with its own height (js/bridge.js): OSM's northbound Bradfield Hwy, four lanes. OSM draws the bridge as several one-way
// carriageways side by side. Those east of the corridor are kept as they are, on its deck: the Bradfield Hwy southbound, and the
// Cahill Expressway's two lanes, the bus lane and the one through the east pylons. Before plan 5 the corridor was all of them,
// one road 23 m wide carrying three lanes each way.
const BRIDGE_WAYS = [172606922, 1530533294, 1530532875, 1530532878, 171978153, 1530530701, 1530530700, 1530531824, 1530531818, 388949145, 11900573, 4354223, 723859054];
const bridgeOsm = BRIDGE_WAYS.map((id) => {
  const way = osmRoads.find((w) => w.id === id);
  if (!way) throw new Error(`Bridge way ${id} is gone from the snapshot`);
  return way;
});
const bridgeRaw = [];
for (const way of bridgeOsm) {
  const pts = way.geometry.map((g) => toWorld(g.lon, g.lat));
  bridgeRaw.push(...(bridgeRaw.length ? pts.slice(1) : pts));
}
const toBridge = (x, z) => onBridge(x, z).d;
// Where (x, z) is along the corridor: { s (m from its south end), off (m east of it, to the right travelling north), d }
const bridgeAlong = [0];
for (let i = 1; i < bridgeRaw.length; i++) bridgeAlong.push(bridgeAlong[i - 1] + Math.hypot(bridgeRaw[i][0] - bridgeRaw[i - 1][0], bridgeRaw[i][1] - bridgeRaw[i - 1][1]));
function onBridge(x, z) {
  let best = { d: Infinity, s: 0, off: 0 };
  for (let i = 1; i < bridgeRaw.length; i++) {
    const [ax, az] = bridgeRaw[i - 1], [bx, bz] = bridgeRaw[i];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (L * L)));
    const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - x, pz - z);
    if (d < best.d) best = { d, s: bridgeAlong[i - 1] + t * L, off: (-(x - px) * dz + (z - pz) * dx) / L };
  }
  return best;
}
// The deck east of the corridor: its southbound lanes, the bus lane and the Cahill's lane, from where they leave the approaches'
// ramps to where they reach them again. A way all on it is part of the deck (its height is the deck's, tools/build-heights.mjs).
// s here is along OSM's northbound ways (bridgeRaw), which start 24 m north of the game's corridor (js/bridge.js). The southbound's
// and the Cahill's pieces from where their ramps meet the deck (170 m along the corridor, 146 m here) to 228 m (204 m here) are on
// it: from 170 they weren't, so the deck stopped at the northbound's edge and its east barrier stood in the southbound's lanes.
const DECK_EAST = { from: 4.5, to: 28, s0: 140, s1: 1800 };
const onDeckEast = (x, z) => {
  const b = onBridge(x, z);
  return b.off >= DECK_EAST.from && b.off <= DECK_EAST.to && b.s >= DECK_EAST.s0 && b.s <= DECK_EAST.s1;
};
const eastOfCorridor = (w) => {
  const offs = w.geometry.map((g) => onBridge(...toWorld(g.lon, g.lat))).filter((b) => b.d < 30).map((b) => b.off);
  return offs.length && offs.reduce((t, o) => t + o, 0) / offs.length > DECK_EAST.from;
};
const BRIDGE_IDS = new Set(BRIDGE_WAYS);
const BRIDGE_NODES = new Set(bridgeOsm.flatMap((w) => w.nodes));
// A one-way road from beside the corridor that ends on one of its nodes: a way on, not along it. The Western Distributor's last 37 m
// (OSM 1097892516), where the Clarence St ramp has joined it, ends where the corridor's first way becomes four lanes: dropped as along
// the bridge, the two main ways up from the city were left ending in the air. (Ways off at the north end are joined, below.)
const wayOn = (w) => {
  if (w.tags?.oneway !== 'yes') return false;
  const first = w.geometry[0];
  return BRIDGE_NODES.has(w.nodes[w.nodes.length - 1]) && Math.abs(onBridge(...toWorld(first.lon, first.lat)).off) > 6;
};
// Along the corridor, and so it: the northbound ways it's made of, and any that run on along it. Not those east of it, nor ways on.
const alongBridge = (w) => {
  if (BRIDGE_IDS.has(w.id)) return true;
  if (wayOn(w)) return false;
  if (!MOTORWAY.test(w.tags?.highway || '') && w.tags?.bridge !== 'yes') return false;
  const pts = w.geometry.map((g) => toWorld(g.lon, g.lat));
  return pts.filter(([x, z]) => toBridge(x, z) < 30).length >= pts.length * 0.5 && !eastOfCorridor(w);
};
const kept = osmRoads.filter((w) => driven(w.tags || {}, w) && inPlay(w) && !alongBridge(w));
// Plain streets rarely tell the whole story: a short underpass or an unnamed service road can be all that joins a
// neighbourhood to the rest. Bring back any road that joins two parts of the network, shortest first.
{
  const parent = new Map();
  const find = (n) => {
    if (!parent.has(n)) parent.set(n, n);
    let r = n;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(n) !== r) { const next = parent.get(n); parent.set(n, r); n = next; }
    return r;
  };
  const size = new Map();
  for (const w of kept) for (let i = 0; i + 1 < w.nodes.length; i++) parent.set(find(w.nodes[i]), find(w.nodes[i + 1]));
  for (const w of kept) for (const n of w.nodes) size.set(find(n), (size.get(find(n)) || 0) + 1);
  const lengthOf = (w) => w.geometry.reduce((t, g, i, all) => (i ? t + Math.hypot(...toWorld(g.lon, g.lat).map((v, k) => v - toWorld(all[i - 1].lon, all[i - 1].lat)[k])) : t), 0);
  const allowed = (t) => t.access !== 'private' && t.access !== 'no' && t.motor_vehicle !== 'no' && t.motorcar !== 'no' && !/parking_aisle|driveway/.test(t.service || '') && !/^(motorway|pedestrian)/.test(t.highway || '');
  const spare = osmRoads.filter((w) => !kept.includes(w) && inPlay(w) && allowed(w.tags || {}) && !alongBridge(w) && lengthOf(w) < 160).map((w) => [lengthOf(w), w]).sort((p, q) => p[0] - q[0]);
  let restored = 0;
  for (let round = 0; round < 3; round++) {
    for (const [, w] of spare) {
      if (kept.includes(w)) continue;
      const roots = new Set(w.nodes.filter((n) => parent.has(n)).map(find));
      if (roots.size < 2) continue;
      kept.push(w);
      restored++;
      for (let i = 0; i + 1 < w.nodes.length; i++) parent.set(find(w.nodes[i]), find(w.nodes[i + 1]));
    }
  }
  log(`${restored} connecting roads restored`);
}
const uses = new Map();
for (const w of kept) w.nodes.forEach((n, i) => uses.set(n, (uses.get(n) || 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1)));
const nodes = [];
const nodeId = new Map();
const nameId = new Map();
const names = [];
const idOf = (n, p) => {
  if (!nodeId.has(n)) { nodeId.set(n, nodes.length / 2); nodes.push(q1(p[0]), q1(p[1])); }
  return nodeId.get(n);
};
const nameOf = (n) => {
  if (!nameId.has(n)) { nameId.set(n, names.length); names.push(n); }
  return nameId.get(n);
};
const CORNER = 3.6; // m a junction reaches past its widest road: the kerb's radius
const links = [];
const strips = [];
let narrowed = 0;
const onLand = (x, z) => land.at(x, z) === 1;

// Each link is on a level. KIND 0: on the ground (covered streets too); 1: a bridge or viaduct, with its own height;
// 2: a tunnel. js/build-heights.mjs works out every height. A short bridge over nothing mapped (a culvert, a lane over
// a gully) is a road on the ground: nothing passes under it, and its height comes from the contours like any other.
const KIND = { GROUND: 0, BRIDGE: 1, TUNNEL: 2 };
const lengthOfPts = (pts) => pts.reduce((t, p, i) => (i ? t + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
// Everything a bridge might pass over: roads and paths of every kind, and railways
const crossables = [];
{
  const railWays = load('rail.json').elements.filter((e) => e.type === 'way' && e.geometry && e.tags?.railway);
  for (const w of [...osmRoads, ...railWays]) {
    if (!w.geometry.some((g) => inDetail(...toWorld(g.lon, g.lat)))) continue;
    crossables.push({ id: w.id, nodes: new Set(w.nodes), pts: w.geometry.map((g) => toWorld(g.lon, g.lat)), layer: parseInt(w.tags?.layer, 10) || 0, bridge: !!(w.tags?.bridge && w.tags.bridge !== 'no'), tunnel: underground(w.tags || {}) });
  }
}
const crossCells = new Map();
for (const c of crossables) {
  for (let i = 1; i < c.pts.length; i++) {
    const [ax, az] = c.pts[i - 1], [bx, bz] = c.pts[i];
    for (let ix = Math.floor(Math.min(ax, bx) / 40); ix <= Math.floor(Math.max(ax, bx) / 40); ix++) {
      for (let iz = Math.floor(Math.min(az, bz) / 40); iz <= Math.floor(Math.max(az, bz) / 40); iz++) {
        const k = ix * 100000 + iz;
        if (!crossCells.has(k)) crossCells.set(k, []);
        crossCells.get(k).push([c, i]);
      }
    }
  }
}
const segmentsCross = (p, q, r, t) => {
  const d = (q[0] - p[0]) * (t[1] - r[1]) - (q[1] - p[1]) * (t[0] - r[0]);
  if (Math.abs(d) < 1e-9) return false;
  const u = ((r[0] - p[0]) * (t[1] - r[1]) - (r[1] - p[1]) * (t[0] - r[0])) / d;
  const v = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
  return u > 0.01 && u < 0.99 && v > 0.01 && v < 0.99;
};
// Whether a way passes over (or under) another without a shared node, which is how OSM draws levels apart
function crossesAnother(w, pts) {
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    for (let ix = Math.floor(Math.min(p[0], q[0]) / 40); ix <= Math.floor(Math.max(p[0], q[0]) / 40); ix++) {
      for (let iz = Math.floor(Math.min(p[1], q[1]) / 40); iz <= Math.floor(Math.max(p[1], q[1]) / 40); iz++) {
        for (const [c, j] of crossCells.get(ix * 100000 + iz) || []) {
          if (c.id === w.id || w.nodes.some((n) => c.nodes.has(n) && (n === w.nodes[i - 1] || n === w.nodes[i]))) continue;
          if (segmentsCross(p, q, c.pts[j - 1], c.pts[j])) return true;
        }
      }
    }
  }
  return false;
}
function kindOf(w, pts) {
  const t = w.tags;
  if (underground(t)) return KIND.TUNNEL;
  // A way onto the corridor climbs to the deck's height where it meets it: part of the bridge, as the joins below are (on the ground,
  // the Western Distributor met the deck 3.6 m below it)
  if (wayOn(w)) return KIND.BRIDGE;
  const layer = parseInt(t.layer, 10) || 0;
  const bridge = !!(t.bridge && t.bridge !== 'no');
  if (!bridge && !(layer > 0 && crossesAnother(w, pts))) return KIND.GROUND;
  if (MOTORWAY.test(t.highway) || lengthOfPts(pts) >= 80 || pts.some(([x, z]) => !onLand(x, z)) || crossesAnother(w, pts)) return KIND.BRIDGE;
  return KIND.GROUND;
}
// Heights along a structure need points along it: no gap over 15 m
const densify = (pts, step = 15) => {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / step);
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
};
// A road that comes back near itself, a hairpin down a gorge, is no wider than the gap between its legs: else its outer lanes run on
// the leg below, metres lower, and a car stops dead there (Berowra Waters Road). Two of its points count as two legs when they're
// further apart along the road than three times the gap between them and 10 m more, which a curve's own points never are.
const segDistance = ([px, pz], [ax, az], [bx, bz]) => {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
};
function legGap(pts, from, to) {
  const along = [0];
  for (let k = 1; k < pts.length; k++) along.push(along[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  let least = Infinity;
  for (let a = from; a <= to; a++) {
    for (let k = 1; k < pts.length; k++) {
      const d = segDistance(pts[a], pts[k - 1], pts[k]);
      if (d >= least) continue;
      const apart = Math.min(Math.abs(along[k] - along[a]), Math.abs(along[k - 1] - along[a]));
      if (apart > 3 * d + 10) least = d;
    }
  }
  return least;
}
let hairpins = 0;
const kinds = [0, 0, 0];
for (const w of kept) {
  const t = w.tags;
  const pts = w.geometry.map((g) => toWorld(g.lon, g.lat));
  const dir = (t.oneway === 'yes' || t.junction === 'roundabout' || t.junction === 'circular') ? 1 : t.oneway === '-1' ? -1 : 0;
  const lanes = parseInt(t.lanes, 10) || 0;
  const kind = kindOf(w, pts);
  const layer = Math.max(-5, Math.min(5, parseInt(t.layer, 10) || 0));
  const flags = (MOTORWAY.test(t.highway) ? 1 : 0) | (classOf(t.highway) << 1) | (busOnly(t) ? 32 : 0) | (openCutting(t) ? 64 : 0);
  let a = 0;
  for (let i = 1; i < pts.length; i++) {
    if (i !== pts.length - 1 && !(uses.get(w.nodes[i]) > 1)) continue;
    const seg = pts.slice(a, i + 1);
    const start = a;
    a = i;
    const mid = seg[seg.length >> 1];
    if (!inDetail(...seg[0]) || !inDetail(...seg[seg.length - 1]) || !inDetail(...mid)) continue;
    // Over the water only on a bridge, under it only in a tunnel
    if (kind === KIND.GROUND && !onLand(...mid) && !onLand(...seg[0])) continue;
    const want = classWidth(t);
    const least = dir ? 4.8 : 6.4;
    const walled = kind === KIND.GROUND ? (wallClearance(seg) - 2.2) * 2 : want;
    // Its legs' roads and the wall between them (js/surfaces.js: 0.6 m past the road each side)
    const legs = legGap(pts, start, i) - 1.2;
    if (legs < want) hairpins++;
    const width = Math.max(least, Math.min(want, walled, legs));
    if (width < want) narrowed++;
    const ia = idOf(w.nodes[start], pts[start]);
    const ib = idOf(w.nodes[i], pts[i]);
    if (ia === ib) continue;
    // Only roads on the ground cut the curb islands: under a bridge or over a tunnel the ground is whatever is there. And an open
    // cutting, which is open to the sky all along: else the island's footpath was laid over its road, down between its walls
    if (kind === KIND.GROUND || openCutting(t)) strips.push({ pts: seg, r: width / 2 + KERB_CLEAR });
    kinds[kind]++;
    const shape = kind === KIND.GROUND ? rdp(seg, 0.4) : densify(rdp(seg, 0.4));
    // On the bridge's deck east of the corridor, all of it: part of the deck
    const deck = kind === KIND.BRIDGE && seg.every(([x, z]) => onDeckEast(x, z)) ? 1 : 0;
    links.push([ia, ib, nameOf(t.name || ''), q1(width), lanes, dir, shape.slice(1, -1).flatMap(([x, z]) => [q1(x), q1(z)]), MAJOR.test(t.highway) ? 1 : 0, deck, kind, layer, flags]);
  }
}
log(`levels: ${kinds[0]} links on the ground, ${kinds[1]} on bridges, ${kinds[2]} in tunnels; ${hairpins} narrowed to the gap between a hairpin's legs`);

// The corridor: links between every node of the bridge's ways that another road meets, so ramps join it where they do
const nearestNode = (x, z) => {
  let best = -1, bd = Infinity;
  for (let i = 0; i < nodes.length; i += 2) {
    const d = Math.hypot(nodes[i] - x, nodes[i + 1] - z);
    if (d < bd) { bd = d; best = i / 2; }
  }
  return best;
};
const bridgePath = [];
// OSM's northbound Bradfield Hwy, four lanes, as classWidth() makes a one-way road of four lanes. In the afternoon, which is the
// only time the game has: in the morning the tidal lane runs south (js/harbour-bridge.js shows it on the lane signals).
const CORRIDOR = { width: 14.7, lanes: 4 };
{
  // Every point of the chained ways, each with its OSM node
  const path = [];
  for (const way of bridgeOsm) {
    const pts = way.geometry.map((g) => toWorld(g.lon, g.lat));
    pts.forEach((p, k) => { if (path.length && k === 0) return; path.push({ p, node: way.nodes[k] }); });
  }
  const startNode = nearestNode(...path[0].p), endNode = nearestNode(...path[path.length - 1].p);
  const stops = [{ i: 0, id: startNode }];
  for (let i = 1; i < path.length - 1; i++) if (uses.has(path[i].node)) stops.push({ i, id: idOf(path[i].node, path[i].p) });
  stops.push({ i: path.length - 1, id: endNode });
  const ends = stops.map((st) => [nodes[st.id * 2], nodes[st.id * 2 + 1]]);
  for (let k = 0; k + 1 < stops.length; k++) {
    const pts = [ends[k], ...path.slice(stops[k].i + 1, stops[k + 1].i).map((q) => q.p), ends[k + 1]];
    const shape = densify(rdp(pts, 0.6), 20);
    links.push([stops[k].id, stops[k + 1].id, nameOf('Sydney Harbour Bridge'), CORRIDOR.width, CORRIDOR.lanes, 1, shape.slice(1, -1).flatMap(([x, z]) => [q1(x), q1(z)]), 1, 1, KIND.BRIDGE, 1, 1]);
    bridgePath.push(...(bridgePath.length ? shape.slice(1) : shape));
  }
  log(`Harbour Bridge: ${stops.length - 1} links, ${stops.length - 2} roads joining it`);
}

// A motorway the corridor cut off (it ran on along the bridge in OSM) ends beside it: join it to the corridor there. Further off than
// this, a join runs over other roads with no room between them.
const JOIN_REACH = 45;
const corridorName = nameOf('Sydney Harbour Bridge');
{
  const degree = new Map();
  for (const l of links) { degree.set(l[0], (degree.get(l[0]) || 0) + 1); degree.set(l[1], (degree.get(l[1]) || 0) + 1); }
  let joined = 0;
  for (const l of [...links]) {
    if (!(l[11] & 1) || l[8]) continue;
    for (const end of [0, 1]) {
      const n = l[end];
      if (degree.get(n) !== 1) continue;
      const x = nodes[n * 2], z = nodes[n * 2 + 1];
      if (toBridge(x, z) > JOIN_REACH) continue;
      // The nearest point of a corridor link, which is split there
      let best = null;
      for (const c of links) {
        if (!c[8] || c[2] !== corridorName) continue; // the corridor, not the deck's other carriageways
        const pts = [[nodes[c[0] * 2], nodes[c[0] * 2 + 1]]];
        for (let k = 0; k < c[6].length; k += 2) pts.push([c[6][k], c[6][k + 1]]);
        pts.push([nodes[c[1] * 2], nodes[c[1] * 2 + 1]]);
        for (let k = 1; k < pts.length; k++) {
          const [ax, az] = pts[k - 1], [bx, bz] = pts[k];
          const dx = bx - ax, dz = bz - az;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
          const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - x, pz - z);
          if (!best || d < best.d) best = { d, c, pts, k, px, pz };
        }
      }
      if (!best || best.d > JOIN_REACH) continue;
      const { c, pts, k, px, pz } = best;
      const flatOf = (list) => list.flatMap(([a, b]) => [q1(a), q1(b)]);
      // Near one of the corridor's nodes, join it there; otherwise split the corridor link at the nearest point
      let id;
      const ends = [[c[0], pts[0]], [c[1], pts[pts.length - 1]]];
      const close = ends.find(([, p]) => Math.hypot(p[0] - px, p[1] - pz) < 12);
      if (close) id = close[0];
      else {
        id = nodes.length / 2;
        nodes.push(q1(px), q1(pz));
        const head = [...pts.slice(1, k), [px, pz]], tail = pts.slice(k, -1);
        links.push([id, c[1], c[2], c[3], c[4], c[5], flatOf(tail), c[7], 1, c[9], c[10], c[11]]);
        c[1] = id;
        c[6] = flatOf(head.slice(0, -1));
      }
      const [nx, nz] = [nodes[id * 2], nodes[id * 2 + 1]];
      // Traffic on a one-way road flows from its first node to its last
      const into = (end === 1) === (l[5] >= 0);
      const [from, to] = into ? [[n, x, z], [id, nx, nz]] : [[id, nx, nz], [n, x, z]];
      const shape = flatOf(densify([[from[1], from[2]], [to[1], to[2]]]).slice(1, -1));
      links.push([from[0], to[0], l[2], l[3], l[4], 1, shape, 1, 0, KIND.BRIDGE, l[10], 1]);
      degree.set(n, 2);
      joined++;
    }
  }
  log(`${joined} motorways joined to the corridor`);
}

log(`roads: ${kept.length} ways, ${nodes.length / 2} nodes, ${links.length} links, ${narrowed} narrowed to fit their walls`);

// Signals sit at stop lines in OSM: move them to the junction they control
const cell = new Map();
// Junctions on the ground only: a motorway's merges have no signals, and nothing on a bridge has a kerb
const degree = new Uint16Array(nodes.length / 2);
for (const l of links) if (!l[9]) { degree[l[0]]++; degree[l[1]]++; }
for (let i = 0; i < nodes.length; i += 2) {
  const k = Math.floor(nodes[i] / 32) * 100000 + Math.floor(nodes[i + 1] / 32);
  if (!cell.has(k)) cell.set(k, []);
  cell.get(k).push(i / 2);
}
const signalIds = new Set();
for (const e of load('nodes.json').elements) {
  if (e.tags?.highway !== 'traffic_signals') continue;
  const [x, z] = toWorld(e.lon, e.lat);
  let best = -1, bd = 30;
  for (let i = Math.floor((x - 30) / 32); i <= Math.floor((x + 30) / 32); i++) {
    for (let j = Math.floor((z - 30) / 32); j <= Math.floor((z + 30) / 32); j++) {
      for (const n of cell.get(i * 100000 + j) || []) {
        if (degree[n] < 3) continue;
        const d = Math.hypot(nodes[n * 2] - x, nodes[n * 2 + 1] - z);
        if (d < bd) { bd = d; best = n; }
      }
    }
  }
  if (best >= 0) signalIds.add(best);
}
const signals = [...signalIds].flatMap((n) => [nodes[n * 2], nodes[n * 2 + 1]]);
log(`${signals.length / 2} signalised junctions`);

// --- Curb islands, lawns and pavements: land minus every roadway, a region at a time --------------------------------------
// (They're cut KERB_CLEAR past each road's edge, and traced no looser than this, so a kerb can't come into a lane)
const capsules = []; // ax, az, bx, bz, r
for (const { pts, r } of strips) for (let i = 0; i + 1 < pts.length; i++) capsules.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], r]);
// Structures low over the ground too, as tools/build-heights.mjs found on the run before this one: this build's, on the second run. The
// first doesn't read them, or every build would start from what the last one left, and no two would come out the same (plan 5).
{
  const lowDecks = new URL('./data/generated/low-decks.json', import.meta.url);
  if (REUSE && fs.existsSync(lowDecks)) {
    const stretches = JSON.parse(fs.readFileSync(lowDecks, 'utf8'));
    for (const [ax, az, bx, bz, r] of stretches) capsules.push([ax, az, bx, bz, r]);
    log(`${stretches.length} stretches of low structure cut from the curb islands`);
  } else log('no low structures yet: run this again after tools/build-heights.mjs');
}
// Kerbs round off at junctions, or turning traffic would have to cut the corners
{
  const reach = new Float32Array(nodes.length / 2);
  for (const l of links) if (!l[9]) { reach[l[0]] = Math.max(reach[l[0]], l[3] / 2); reach[l[1]] = Math.max(reach[l[1]], l[3] / 2); }
  for (let n = 0; n < reach.length; n++) if (degree[n] >= 3) capsules.push([nodes[n * 2], nodes[n * 2 + 1], nodes[n * 2], nodes[n * 2 + 1], reach[n] + CORNER]);
}
const parkShapes = [];
const addPark = (name, rings) => { for (const ring of rings) if (ring.length > 3 && ring.some(([x, z]) => inDetail(x, z))) parkShapes.push({ name, ring }); };
for (const e of osmLand) {
  const t = e.tags || {};
  if (t.leisure === 'park' || t.leisure === 'garden' || t.leisure === 'common' || t.leisure === 'pitch' || t.natural === 'wood'
    || t.landuse === 'recreation_ground' || t.landuse === 'village_green' || t.landuse === 'grass') addPark(t.name || '', elementRings(e).outer);
}
for (const f of load('cos_parks.json')) {
  const g = f.geometry;
  if (!g) continue;
  const name = f.properties.Name || f.properties.NAME || f.properties.ParkName || '';
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  addPark(String(name), polys.map((p) => p[0].map(([lon, lat]) => toWorld(lon, lat))));
}
log(`${parkShapes.length} park shapes`);
const blocks = [], lawns = [], pavements = [], fills = [];
{
  const started = Date.now();
  const inWindow = (w, x0, x1, z0, z1) => x1 >= w.x0 && x0 <= w.x1 && z1 >= w.z0 && z0 <= w.z1;
  const jobs = REGIONS.map((r) => ({ kind: 'blocks', core: r.core, window: r.window, capsules: [], parks: [] }));
  // Each capsule to the regions it reaches, without looking at them all: they're 7.2 km apart
  const byKey = new Map(jobs.map((job, i) => [REGIONS[i].key, job]));
  for (const [ax, az, bx, bz, r] of capsules) {
    const x0 = Math.min(ax, bx) - r, x1 = Math.max(ax, bx) + r, z0 = Math.min(az, bz) - r, z1 = Math.max(az, bz) + r;
    for (let ix = Math.floor((x0 - MARGIN) / REGION); ix <= Math.floor((x1 + MARGIN) / REGION); ix++) {
      for (let iz = Math.floor((z0 - MARGIN) / REGION); iz <= Math.floor((z1 + MARGIN) / REGION); iz++) {
        const job = byKey.get(`${ix}_${iz}`);
        if (job && inWindow(job.window, x0, x1, z0, z1)) job.capsules.push(ax, az, bx, bz, r);
      }
    }
  }
  for (const park of parkShapes) {
    const b = bbox(park.ring);
    for (const job of jobs) if (inWindow(job.window, b.x0, b.x1, b.z0, b.z1)) job.parks.push(park);
  }
  const results = await runJobs({ landFrame, landBuffer: land.bits.buffer, water: null }, jobs);
  let cut = 0;
  for (const r of results) {
    for (const b of r.blocks) blocks.push(b);
    for (const l of r.lawns) lawns.push(l);
    for (const p of r.pavements) pavements.push(p);
    for (const f of r.fills) fills.push(f);
    cut += r.cutPieces;
  }
  log(`${blocks.length} curb islands, ${cut} of them parts of one too big for a region, ${blocks.filter((b) => b[2] > 0.6).length} parks; ${lawns.length} lawns, ${pavements.length} pavements, ${fills.length} road scraps, in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

// --- Named roads that aren't driven: motorways, tunnels and pedestrian streets, for the maps and location labels -----
const scenery = osmRoads.filter((w) => {
  const t = w.tags || {};
  return t.name && (/^motorway|^pedestrian/.test(t.highway)) && w.geometry.some((g) => inDetail(...toWorld(g.lon, g.lat)));
}).map((w) => {
  const t = w.tags;
  return [t.name, t.highway === 'pedestrian' ? 'p' : t.tunnel && t.tunnel !== 'no' ? 't' : 'm', flat(rdp(w.geometry.map((g) => toWorld(g.lon, g.lat)), 1.5))];
});

// Street furniture where it really stands
const furniture = load('nodes.json').elements;
const pointsOf = (test) => furniture.filter(test).flatMap((e) => toWorld(e.lon, e.lat).map(q1)).reduce((out, v, i, all) => {
  if (i % 2 === 0 && inDetail(v, all[i + 1])) out.push(v, all[i + 1]);
  return out;
}, []);
const postBoxes = pointsOf((e) => e.tags?.amenity === 'post_box');
// Which suburb you're in, for the labels and the map
const suburbs = load('nodes.json').elements.filter((e) => /^(suburb|quarter|neighbourhood)$/.test(e.tags?.place || '') && e.tags.name).map((e) => {
  const [x, z] = toWorld(e.lon, e.lat);
  return [e.tags.name, Math.round(x), Math.round(z)];
});
log(`${suburbs.length} suburbs`);
const busShelters = pointsOf((e) => e.tags?.highway === 'bus_stop' && e.tags.shelter === 'yes');

// --- Light rail, for the moving scenery ---------------------------------------------------------------------------------
const rail = load('rail.json').elements;
// The light rail as continuous lines, the longest first
const lightRail = chainRings(rail.filter((e) => e.type === 'way' && e.tags?.railway === 'light_rail' && !(e.tags.tunnel && e.tags.tunnel !== 'no') && e.geometry)
  .map((e) => e.geometry.map((g) => toWorld(g.lon, g.lat)))).sort((p, q) => lengthOfPts(q) - lengthOfPts(p)).slice(0, 4).map((line) => flat(rdp(line, 1)));
const ferries = rail.filter((e) => e.type === 'way' && e.tags?.route === 'ferry' && /Circular Quay|Barangaroo|Darling Harbour|Milsons Point/.test(e.tags.name || '') && e.geometry)
  .map((e) => flat(rdp(e.geometry.map((g) => toWorld(g.lon, g.lat)), 6))).slice(0, 12);
const stations = rail.filter((e) => e.type === 'node' && e.tags?.railway === 'station' && e.tags.name)
  .map((e) => [e.tags.name, ...toWorld(e.lon, e.lat).map(q1)]);

// --- Everything beyond the detail: harbour, ocean and the land around them, with the play area cut out ----------------
const wide = new Raster(WIDE.x0, WIDE.z0, WIDE.x1, WIDE.z1, 6);
wide.d.fill(1);
wide.fillRing(sea, 0);
for (const r of islands) wide.fillRing(r, 1);
for (const r of harbourOuter) wide.fillRing(r, 0);
for (const r of harbourInner) wide.fillRing(r, 1);
for (const r of DETAIL_RECTS) {
  for (let j = Math.max(0, Math.ceil((r.z0 + 3 - wide.z0) / 6)); j < wide.h && wide.z0 + j * 6 < r.z1 - 3; j++) {
    for (let i = Math.max(0, Math.ceil((r.x0 + 3 - wide.x0) / 6)); i < wide.w && wide.x0 + i * 6 < r.x1 - 3; i++) wide.d[j * wide.w + i] = 0;
  }
}
const surroundings = tiledPolygons(wide, 1800, 5, 8, 400).map((rings) => rings.map(flat));
log(`surroundings: ${surroundings.length} land masses, ${surroundings.flat().reduce((t, r) => t + r.length / 2, 0)} points`);
const GEO = {
  version: 1,
  frame: { bearingDeg: BEARING, origin: 'Town Hall', units: 'm', detail: DETAIL_RECTS, corner: CORNER,
    heights: { x0: GRID.x0, z0: GRID.z0, cell: GRID.cell, w: Math.round((GRID.x1 - GRID.x0) / GRID.cell) + 1, h: Math.round((GRID.z1 - GRID.z0) / GRID.cell) + 1 } },
  shores,
  surroundings,
  roadGraph: { nodes, links, names },
  bridge: flat(bridgePath),
  signals,
  blocks,
  lawns,
  pavements,
  fills,
  scenery,
  lightRail,
  ferries,
  stations,
  postBoxes,
  busShelters,
  suburbs
};
const json = JSON.stringify(GEO);
// A string for JSON.parse, not an object literal: the browser gets through it about four times as fast, and the phone's load
// time feels that
const parsedLater = (text) => `JSON.parse('${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`;
fs.writeFileSync(OUT, `// js/geodata.js: GENERATED by tools/build-geodata.mjs, do not edit by hand.
// Sydney in the game's world frame: 1 unit = 1 m, x = grid east, z = grid south, origin at Town Hall, axes turned
// ${BEARING}° from true north. Polygons and polylines are flat [x0, z0, x1, z1, ...] arrays.
// Sources: © OpenStreetMap contributors (ODbL), City of Sydney open data (CC BY 4.0).
export const GEO = ${parsedLater(json)};
`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
for (const [k, v] of Object.entries(GEO)) log(`  ${k}: ${(JSON.stringify(v).length / 1024).toFixed(0)} KB`);
