// tools/build-geodata.mjs: writes js/geodata.js from the snapshots in tools/data (see tools/fetch-data.mjs).
// usage: node --max-old-space-size=8192 tools/build-geodata.mjs [out.js]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BEARING, DETAIL_BOUNDS, DETAIL_RECTS, GRID, Raster, bbox, chainRings, elementRings, flat, inDetail, load, log, q1, rdp,
  rdpRing, ringArea, tiledPolygons, toWorld
} from './geo-common.mjs';

const OUT = process.argv[2] || fileURLToPath(new URL('../js/geodata.js', import.meta.url));
const B = DETAIL_BOUNDS;
const RES = 1;

// --- Land: the detail rectangles minus Port Jackson, plus the piers -----------------------------------------------------
const harbour = load('harbour.json').elements.find((e) => e.id === 15522136);
const { outer: harbourOuter, inner: harbourInner } = elementRings(harbour);
log(`harbour: ${harbourOuter.length} outer, ${harbourInner.length} inner rings`);
const land = new Raster(B.x0, B.z0, B.x1, B.z1, RES);
for (const r of DETAIL_RECTS) {
  for (let j = 0; j < land.h; j++) {
    const z = land.z0 + (j + 0.5) * RES;
    if (z < r.z0 || z > r.z1) continue;
    for (let i = 0; i < land.w; i++) {
      const x = land.x0 + (i + 0.5) * RES;
      if (x >= r.x0 && x <= r.x1) land.d[j * land.w + i] = 1;
    }
  }
}
{
  const water = new Raster(B.x0, B.z0, B.x1, B.z1, RES);
  for (const r of harbourOuter) water.fillRing(r, 1);
  for (const r of harbourInner) water.fillRing(r, 0);
  for (let i = 0; i < land.d.length; i++) if (water.d[i]) land.d[i] = 0;
}
const osmLand = load('land.json').elements;
const piers = [];
for (const e of osmLand) {
  if (e.tags?.man_made !== 'pier') continue;
  const { outer } = elementRings(e);
  for (const ring of outer) {
    const closed = ring.length > 3 && Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 0.5;
    if (!ring.some(([x, z]) => inDetail(x, z))) continue;
    if (closed) land.fillRing(ring, 1);
    else {
      const w = parseFloat(e.tags.width) || 3;
      if (w < 2.5) continue;
      for (let i = 0; i + 1 < ring.length; i++) land.stampSegment(...ring[i], ...ring[i + 1], w / 2, 1);
    }
    piers.push({ name: e.tags.name || '', ring, closed });
  }
}
log(`${piers.length} piers joined to the land`);
land.open(1.2);
const { labels: landLabels, comps: landComps } = land.label();
const shores = [];
for (const c of landComps.filter((q) => q.n >= 4000).sort((p, q) => q.n - p.n)) {
  const rings = land.traceRings(landLabels, c).map((r) => rdpRing(r, 1.2));
  rings.sort((p, q) => Math.abs(ringArea(q)) - Math.abs(ringArea(p)));
  shores.push(rings);
}
for (let i = 0; i < land.d.length; i++) if (!landComps[landLabels[i] - 1] || landComps[landLabels[i] - 1].n < 4000) land.d[i] = 0;
log(`land: ${shores.length} masses, ${(land.d.reduce((t, v) => t + v, 0) / 1e6).toFixed(2)} km²`);

// --- Building walls keep the curbs honest: OSM rarely has road widths --------------------------------------------------
const overture = fs.readFileSync(new URL('../tools/data/overture_syd.json', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const walls = new Raster(B.x0, B.z0, B.x1, B.z1, RES);
for (const b of overture) {
  if (b.class === 'roof' || b.is_underground) continue;
  const g = typeof b.g === 'string' ? JSON.parse(b.g) : b.g;
  for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) walls.fillRing(poly[0].map(([lon, lat]) => toWorld(lon, lat)), 1);
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
const DRIVEN = /^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|trunk_link|primary_link|secondary_link|tertiary_link)$/;
const MAJOR = /^(trunk|primary|secondary)/;
const WIDTH = { trunk: 17, primary: 15, secondary: 13.5, tertiary: 11.5, unclassified: 9, residential: 8.8, living_street: 6.5, service: 5.5, trunk_link: 7, primary_link: 7, secondary_link: 7, tertiary_link: 7 };
const oneWay = (t) => t.oneway === 'yes' || t.oneway === '-1' || t.junction === 'roundabout' || t.junction === 'circular';
function classWidth(t) {
  const w = parseFloat(t.width);
  if (w > 2) return w;
  const lanes = parseInt(t.lanes, 10) || 0;
  if (lanes) return Math.max(oneWay(t) ? 5 : 6.4, lanes * 3.3 + (oneWay(t) ? 1.5 : 2.5));
  return WIDTH[t.highway] || 8.8;
}
// covered=yes is a street with something built over it: Argyle, George and Cumberland Sts under the bridge's approach and
// Hickson Rd under the Walsh Bay wharves are the only ways out of The Rocks, and through it to the bridge
const underground = (t) => t.tunnel && t.tunnel !== 'no';
function driven(t) {
  if (t.access === 'private' || t.access === 'no' || t.motor_vehicle === 'no' || t.motorcar === 'no') return false;
  if (underground(t)) return false;
  if (t.highway === 'service') return !!t.name && !/parking_aisle|driveway/.test(t.service || '');
  return DRIVEN.test(t.highway);
}
const osmRoads = load('all_roads.json').elements.filter((e) => e.geometry);
const inPlay = (w) => w.geometry.some((g) => inDetail(...toWorld(g.lon, g.lat)));
const kept = osmRoads.filter((w) => driven(w.tags || {}) && inPlay(w));
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
  const spare = osmRoads.filter((w) => !kept.includes(w) && inPlay(w) && allowed(w.tags || {}) && lengthOf(w) < 160).map((w) => [lengthOf(w), w]).sort((p, q) => p[0] - q[0]);
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
for (const w of kept) {
  const t = w.tags;
  const pts = w.geometry.map((g) => toWorld(g.lon, g.lat));
  const dir = (t.oneway === 'yes' || t.junction === 'roundabout' || t.junction === 'circular') ? 1 : t.oneway === '-1' ? -1 : 0;
  const lanes = parseInt(t.lanes, 10) || 0;
  let a = 0;
  for (let i = 1; i < pts.length; i++) {
    if (i !== pts.length - 1 && !(uses.get(w.nodes[i]) > 1)) continue;
    const seg = pts.slice(a, i + 1);
    const start = a;
    a = i;
    const mid = seg[seg.length >> 1];
    if (!inDetail(...seg[0]) || !inDetail(...seg[seg.length - 1]) || !inDetail(...mid)) continue;
    if (!onLand(...mid) && !onLand(...seg[0])) continue;
    const want = classWidth(t);
    const least = dir ? 4.8 : 6.4;
    const walled = (wallClearance(seg) - 2.2) * 2;
    const width = Math.max(least, Math.min(want, walled));
    if (width < want) narrowed++;
    const ia = idOf(w.nodes[start], pts[start]);
    const ib = idOf(w.nodes[i], pts[i]);
    if (ia === ib) continue;
    strips.push({ pts: seg, r: width / 2 });
    links.push([ia, ib, nameOf(t.name || ''), q1(width), lanes, dir, rdp(seg, 0.4).slice(1, -1).flatMap(([x, z]) => [q1(x), q1(z)]), MAJOR.test(t.highway) ? 1 : 0]);
  }
}
// The Harbour Bridge: one two-way corridor along the real alignment, from Upper Fort St in The Rocks to the Pacific Hwy
// at North Sydney. It has its own height (js/bridge.js), so nothing under it stands in its way.
const BRIDGE_WAYS = [172606922, 1530533294, 1530532875, 1530532878, 171978153, 1530530701, 1530530700, 1530531824, 1530531818, 388949145, 11900573, 4354223, 723859054];
const nearestNode = (x, z) => {
  let best = -1, bd = Infinity;
  for (let i = 0; i < nodes.length; i += 2) {
    const d = Math.hypot(nodes[i] - x, nodes[i + 1] - z);
    if (d < bd) { bd = d; best = i / 2; }
  }
  return best;
};
const bridgePath = [];
for (const id of BRIDGE_WAYS) {
  const way = osmRoads.find((w) => w.id === id);
  if (!way) throw new Error(`Bridge way ${id} is gone from the snapshot`);
  const pts = way.geometry.map((g) => toWorld(g.lon, g.lat));
  bridgePath.push(...(bridgePath.length ? pts.slice(1) : pts));
}
{
  const a = nearestNode(...bridgePath[0]), b = nearestNode(...bridgePath[bridgePath.length - 1]);
  const path = [[nodes[a * 2], nodes[a * 2 + 1]], ...rdp(bridgePath, 0.6).slice(1, -1), [nodes[b * 2], nodes[b * 2 + 1]]];
  links.push([a, b, nameOf('Sydney Harbour Bridge'), 23, 6, 0, path.slice(1, -1).flatMap(([x, z]) => [q1(x), q1(z)]), 1, 1]);
  bridgePath.length = 0;
  bridgePath.push(...path);
}

log(`roads: ${kept.length} ways, ${nodes.length / 2} nodes, ${links.length} links, ${narrowed} narrowed to fit their walls`);

// Signals sit at stop lines in OSM: move them to the junction they control
const cell = new Map();
const degree = new Uint16Array(nodes.length / 2);
for (const l of links) { degree[l[0]]++; degree[l[1]]++; }
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

// --- Curb islands: land minus every roadway ----------------------------------------------------------------------------
const curb = new Raster(B.x0, B.z0, B.x1, B.z1, RES);
curb.d.set(land.d);
for (const { pts, r } of strips) for (let i = 0; i + 1 < pts.length; i++) curb.stampSegment(...pts[i], ...pts[i + 1], r);
// Kerbs round off at junctions, or turning traffic would have to cut the corners
{
  const reach = new Float32Array(nodes.length / 2);
  for (const l of links) { reach[l[0]] = Math.max(reach[l[0]], l[3] / 2); reach[l[1]] = Math.max(reach[l[1]], l[3] / 2); }
  for (let n = 0; n < reach.length; n++) if (degree[n] >= 3) curb.stampSegment(nodes[n * 2], nodes[n * 2 + 1], nodes[n * 2], nodes[n * 2 + 1], reach[n] + CORNER);
}
const { labels, comps } = curb.label();
log(`${comps.length} curb islands before filtering`);

// --- Parks ------------------------------------------------------------------------------------------------------------
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
const parkRaster = new Raster(B.x0, B.z0, B.x1, B.z1, RES, Uint16Array);
parkShapes.forEach((p, i) => parkRaster.fillRing(p.ring, i + 1));
log(`${parkShapes.length} park shapes`);

const blocks = [];
for (const c of comps) {
  if (c.n < 24) continue;
  const rings = curb.traceRings(labels, c).map((r) => rdpRing(r, 0.75)).filter((r) => r.length >= 3);
  if (!rings.length) continue;
  rings.sort((p, q) => Math.abs(ringArea(q)) - Math.abs(ringArea(p)));
  const [outer, ...rest] = rings;
  const holes = rest.filter((r) => Math.abs(ringArea(r)) > 16);
  let inPark = 0;
  const hits = new Map();
  for (let j = c.j0; j <= c.j1; j++) {
    for (let i = c.i0; i <= c.i1; i++) {
      const k = j * curb.w + i;
      if (labels[k] !== c.id) continue;
      const p = parkRaster.d[k];
      if (p) { inPark++; hits.set(p, (hits.get(p) || 0) + 1); }
    }
  }
  const top = [...hits].sort((p, q) => q[1] - p[1]).find(([p]) => parkShapes[p - 1].name) || [0];
  blocks.push([flat(outer), holes.map(flat), Math.round((inPark / c.n) * 100) / 100, top[0] ? parkShapes[top[0] - 1].name : '']);
}
log(`${blocks.length} curb islands, ${blocks.filter((b) => b[2] > 0.6).length} parks`);

// Lawn wherever parkland lies on a curb island, whichever block it shares
const lawnRaster = new Raster(B.x0, B.z0, B.x1, B.z1, RES);
for (let i = 0; i < lawnRaster.d.length; i++) lawnRaster.d[i] = parkRaster.d[i] && curb.d[i] ? 1 : 0;
lawnRaster.open(1.5);
const lawns = tiledPolygons(lawnRaster, 240, 1, 40, 12).map((rings) => rings.map(flat));
log(`${lawns.length} lawns, ${(lawnRaster.d.reduce((t, v) => t + v, 0) / 1e6).toFixed(2)} km²`);

// Paving is the rest of each curb island. It runs a metre under the lawn's edge, so the two can't part where they meet.
const paved = new Raster(B.x0, B.z0, B.x1, B.z1, RES);
{
  const toEdge = lawnRaster.edt((v) => v === 0);
  for (let i = 0; i < paved.d.length; i++) paved.d[i] = curb.d[i] && toEdge[i] <= 2.5 && comps[labels[i] - 1]?.n >= 24 ? 1 : 0;
}
const pavements = tiledPolygons(paved, 240, 0.75).map((rings) => rings.map(flat));
// Scraps of land too small to be a curb island, left between the roads: road surface
const fills = [];
for (const c of comps) {
  if (c.n >= 24) continue;
  const ring = curb.traceRings(labels, c).sort((p, q) => Math.abs(ringArea(q)) - Math.abs(ringArea(p)))[0];
  if (ring && ring.length >= 3) fills.push(flat(ring));
}
log(`${pavements.length} pavements, ${fills.length} road scraps`);

// --- Named roads that aren't driven: motorways, tunnels and pedestrian streets, for the maps and location labels -----
const scenery = osmRoads.filter((w) => {
  const t = w.tags || {};
  return t.name && (/^motorway|^pedestrian/.test(t.highway)) && w.geometry.some((g) => inDetail(...toWorld(g.lon, g.lat)));
}).map((w) => {
  const t = w.tags;
  return [t.name, t.highway === 'pedestrian' ? 'p' : t.tunnel && t.tunnel !== 'no' ? 't' : 'm', flat(rdp(w.geometry.map((g) => toWorld(g.lon, g.lat)), 1.5))];
});

const lengthOf = (pts) => pts.reduce((t, p, i) => (i ? t + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
// Elevated motorways: scenery with traffic on it. Ways chained end to end, in their direction of travel; nothing that
// runs along the Harbour Bridge's corridor, which has its own model.
const nearBridge = (x, z) => bridgePath.some(([ax, az], i) => {
  const [bx, bz] = bridgePath[i + 1] ?? [ax, az]; // along each stretch: the span is one straight line a kilometre long
  const dx = bx - ax, dz = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(ax + dx * t - x, az + dz * t - z) < 60;
});
const elevated = osmRoads.filter((w) => {
  const t = w.tags || {};
  if (!/^motorway/.test(t.highway || '') || !t.bridge || t.bridge === 'no' || t.oneway !== 'yes') return false;
  const pts = w.geometry.map((g) => toWorld(g.lon, g.lat));
  return pts.some(([x, z]) => inDetail(x, z)) && !pts.some(([x, z]) => nearBridge(x, z));
});
const startingAt = new Map(elevated.map((w) => [w.nodes[0], w]));
const followed = new Set(elevated.map((w) => w.nodes[w.nodes.length - 1]));
const viaducts = [];
const chained = new Set();
// Heads first, so a carriageway stays whole; what's left over is each branch at a split, from the split on
for (const first of [...elevated.filter((w) => !followed.has(w.nodes[0])), ...elevated]) {
  if (chained.has(first)) continue;
  const line = [];
  let lanes = 0, layer = 1;
  for (let w = first; w && !chained.has(w); w = startingAt.get(w.nodes[w.nodes.length - 1])) {
    chained.add(w);
    lanes = Math.max(lanes, parseInt(w.tags.lanes, 10) || 2);
    layer = Math.max(layer, parseInt(w.tags.layer, 10) || 1);
    line.push(...w.geometry.map((g) => toWorld(g.lon, g.lat)));
  }
  if (lengthOf(line) > 120) viaducts.push({ lanes: Math.min(4, lanes), layer: Math.min(3, layer), pts: flat(rdp(line, 1)) });
}
log(`${viaducts.length} elevated motorways`);

// Street furniture where it really stands
const furniture = load('nodes.json').elements;
const pointsOf = (test) => furniture.filter(test).flatMap((e) => toWorld(e.lon, e.lat).map(q1)).reduce((out, v, i, all) => {
  if (i % 2 === 0 && inDetail(v, all[i + 1])) out.push(v, all[i + 1]);
  return out;
}, []);
const postBoxes = pointsOf((e) => e.tags?.amenity === 'post_box');
const busShelters = pointsOf((e) => e.tags?.highway === 'bus_stop' && e.tags.shelter === 'yes');

// --- Light rail, for the moving scenery ---------------------------------------------------------------------------------
const rail = load('rail.json').elements;
// The light rail as continuous lines, the longest first
const lightRail = chainRings(rail.filter((e) => e.type === 'way' && e.tags?.railway === 'light_rail' && !(e.tags.tunnel && e.tags.tunnel !== 'no') && e.geometry)
  .map((e) => e.geometry.map((g) => toWorld(g.lon, g.lat)))).sort((p, q) => lengthOf(q) - lengthOf(p)).slice(0, 4).map((line) => flat(rdp(line, 1)));
const ferries = rail.filter((e) => e.type === 'way' && e.tags?.route === 'ferry' && /Circular Quay|Barangaroo|Darling Harbour|Milsons Point/.test(e.tags.name || '') && e.geometry)
  .map((e) => flat(rdp(e.geometry.map((g) => toWorld(g.lon, g.lat)), 6))).slice(0, 12);
const stations = rail.filter((e) => e.type === 'node' && e.tags?.railway === 'station' && e.tags.name)
  .map((e) => [e.tags.name, ...toWorld(e.lon, e.lat).map(q1)]);

// --- Everything beyond the detail: harbour, ocean and the land around them, with the play area cut out ----------------
const WIDE = { x0: -24000, x1: 11000, z0: -24000, z1: 16000 };
const wide = new Raster(WIDE.x0, WIDE.z0, WIDE.x1, WIDE.z1, 6);
wide.d.fill(1);
{
  const chains = chainRings(load('coast.json').elements.filter((e) => e.geometry).map((e) => e.geometry.map((g) => toWorld(g.lon, g.lat))))
    .filter((c) => c.length > 200 && bbox(c).x1 > 5000).sort((p, q) => bbox(q).z1 - bbox(p).z1);
  const shore = chains.flat();
  wide.fillRing([...shore, [shore[shore.length - 1][0], WIDE.z0 - 100], [WIDE.x1 + 100, WIDE.z0 - 100], [WIDE.x1 + 100, WIDE.z1 + 100], [shore[0][0], WIDE.z1 + 100]], 0);
}
for (const r of harbourOuter) wide.fillRing(r, 0);
for (const r of harbourInner) wide.fillRing(r, 1);
for (const r of DETAIL_RECTS) {
  for (let j = Math.max(0, Math.ceil((r.z0 + 3 - wide.z0) / 6)); j < wide.h && wide.z0 + j * 6 < r.z1 - 3; j++) {
    for (let i = Math.max(0, Math.ceil((r.x0 + 3 - wide.x0) / 6)); i < wide.w && wide.x0 + i * 6 < r.x1 - 3; i++) wide.d[j * wide.w + i] = 0;
  }
}
const surroundings = tiledPolygons(wide, 1800, 5, 8, 400).map((rings) => rings.map(flat));
log(`surroundings: ${surroundings.length} land masses, ${surroundings.flat().reduce((t, r) => t + r.length / 2, 0)} points`);
// Land use beyond the play area, one value per 60 m cell: 1 housing, 2 bush and parks, 3 offices and shops
const use = new Raster(WIDE.x0, WIDE.z0, WIDE.x1, WIDE.z1, 60);
{
  const wideLand = load('wide_land.json').elements;
  const fill = (filter, value) => {
    for (const e of wideLand) {
      const t = e.tags || {};
      if (!filter(t)) continue;
      for (const r of elementRings(e).outer) if (r.length > 3) use.fillRing(r, value);
    }
  };
  fill((t) => t.landuse === 'residential', 1);
  fill((t) => t.landuse === 'commercial' || t.landuse === 'retail', 3);
  fill((t) => t.leisure || t.boundary === 'national_park' || t.natural === 'wood' || t.natural === 'scrub', 2);
}
const landuse = { x0: use.x0, z0: use.z0, w: use.w, h: use.h, cell: 60, runs: [] };
{
  let value = use.d[0], count = 0;
  for (const v of use.d) {
    if (v === value) count++;
    else { landuse.runs.push(value, count); value = v; count = 1; }
  }
  landuse.runs.push(value, count);
}
log(`land use: ${landuse.runs.length / 2} runs`);

const GEO = {
  version: 1,
  frame: { bearingDeg: BEARING, origin: 'Town Hall', units: 'm', detail: DETAIL_RECTS, corner: CORNER,
    heights: { x0: GRID.x0, z0: GRID.z0, cell: GRID.cell, w: Math.round((GRID.x1 - GRID.x0) / GRID.cell) + 1, h: Math.round((GRID.z1 - GRID.z0) / GRID.cell) + 1 } },
  shores: shores.map((rings) => rings.map((r) => flat(r))),
  surroundings,
  landuse,
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
  viaducts,
  postBoxes,
  busShelters
};
const json = JSON.stringify(GEO);
fs.writeFileSync(OUT, `// js/geodata.js: GENERATED by tools/build-geodata.mjs, do not edit by hand.
// Sydney in the game's world frame: 1 unit = 1 m, x = grid east, z = grid south, origin at Town Hall, axes turned
// ${BEARING}° from true north. Polygons and polylines are flat [x0, z0, x1, z1, ...] arrays.
// Sources: © OpenStreetMap contributors (ODbL), City of Sydney open data (CC BY 4.0).
export const GEO = ${json};
`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
for (const [k, v] of Object.entries(GEO)) log(`  ${k}: ${(JSON.stringify(v).length / 1024).toFixed(0)} KB`);
