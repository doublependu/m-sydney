import { GEO, onMap } from './geodata.js';
import { rawTerrainHeight, terrainHeight, terrainSlope } from './terrain.js';
import { landAt } from './city-config.js';

// Every surface something can stand on. The ground, which everything on it shares: roads, kerbs, footpaths, lawns,
// buildings, trees, people and cars all take their height from groundHeight(). And the structures: bridges, viaducts
// and tunnels, each a connected run of road links with heights of its own (tools/build-heights.mjs).
//
// The simulation stays on x and z. What lifts something off the plane is the surface it's on: entity.surface is 0 on the
// ground, or a structure's id. chooseSurface() picks it by continuity: the nearest road whose height is within STEP of
// where you are now. Roads stacked over each other never mix, and a ramp leaving a street can be taken or passed by.
// Nothing can step onto a surface more than STEP above or below it, which is what makes a deck's parapets and a
// tunnel's walls hold, and what lets a car pass under a bridge.

const KIND = { GROUND: 0, BRIDGE: 1, TUNNEL: 2, CUTTING: 3 };
const CUT_SLOPE = 4; // m beside a cutting's road over which the ground climbs back to its own height
const STEP = 1.5; // m of height between surfaces that can be stepped across
const SWITCH = 0.6; // m: the most a surface can differ by for something still on another to move onto it. More than a low deck's lift over the ground lowered under it
const SAME_LEVEL = 3; // m: vehicles nearer than this in height are on one level and can meet
const DECK_HALF = 12.5; // m either side of the Harbour Bridge's corridor cars could use, when it was one road (before plan 5)
const LOW_DECK = 3; // m: a structure lower than this over the ground lowers the ground under it, so it can't show through
const TUNNEL_COVER = 6.3; // m: a tunnel with less ground than this over its road is an open cutting (js/structures.js)
const TUNNEL_HEIGHT = 5.6; // m from a tunnel's road up to its ceiling
const MOUTH_AT_NODE = 1; // m of a tunnel left open where it's covered from the very node it meets the open road at (deriveTunnels())
const DECK_DEPTH = 1.4; // m from a deck's road down to its soffit
const OVERHEAD = 4; // m: a deck less than this above a road isn't over it
const DRAWN_PAST_EDGE = 1.1; // m past its edge that a road's surface is drawn, under the kerbs (js/ground-geometry.js)
const CELL = 32;

const RG = GEO.roadGraph;
const N = RG.nodes;

// --- Links with their heights --------------------------------------------------------------------------------------
// The links of the tiles held. A link's structure and where a tunnel opens are worked out with the whole map, when the
// tiles are made (tools/build-tiles.mjs).
const LINKS = [];
const linkById = new Map();
const STRUCTURES = GEO.structures.map((s, id) => (s ? { id, links: [], kind: s[0], deck: !!s[1], motorway: !!s[2] } : null));
const DECK_STRUCTURE = STRUCTURES.find((s) => s?.deck)?.id ?? 0; // the Harbour Bridge's

// Each link's OSM class, from its flags (tools/build-geodata.mjs has the same list). 0 where the map doesn't say: tiles made before it
const ROAD_CLASSES = ['', 'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'link', 'pedestrian'];
const ROAD_CLASS = Object.fromEntries(ROAD_CLASSES.map((name, i) => [name, i]));
const roadClass = (flags) => (flags >> 1) & 15;

// A one-way road's own lanes as OSM counts them, m from its middle line: 3.3 m apart, as tools/build-geodata.mjs made its width from
// them (3.3 m a lane and 1.5 m more), or closer on a road the map draws narrower, down to 3 m. As many as fit at 3 m.
const LANE_WIDTH = 3.3, NARROWEST_LANE = 3;
function ownLaneOffsets(width, lanes) {
  const n = Math.max(1, Math.min(lanes, Math.floor(width / NARROWEST_LANE)));
  const step = Math.min(LANE_WIDTH, width / n);
  return Array.from({ length: n }, (_, k) => (k - (n - 1) / 2) * step);
}

function linkFromRecord(l) {
  const [a, b, ni, width, lanes, dir, inner, major, deck, kind = 0, layer = 0, flags = 0, ys = null, sid = 0, openA = 0, openB = 0, length = 0, profile = null, lean = null] = l;
  const pts = [{ x: N[a * 2], z: N[a * 2 + 1] }];
  for (let k = 0; k < inner.length; k += 2) pts.push({ x: inner[k], z: inner[k + 1] });
  pts.push({ x: N[b * 2], z: N[b * 2 + 1] });
  if (kind && ys && ys.length === pts.length) pts.forEach((p, i) => { p.y = ys[i]; });
  else for (const p of pts) p.y = NaN; // on the ground: groundHeight() there
  // A street sunk into a cutting is on the ground (the ground follows it down), with heights of its own
  const cut = kind === KIND.CUTTING && !!ys;
  const link = {
    id: l.id, a, b, name: RG.names[ni], width, lanes, dir, major: !!major, deck: !!deck, kind: cut ? KIND.GROUND : kind && ys ? kind : 0,
    cut, layer, motorway: !!(flags & 1), cls: roadClass(flags), pts, sid, half: width / 2 + 0.6, openA, openB, length,
    // A tunnel open to the sky all along, between sheer walls (flag 64, tools/build-geodata.mjs openCutting)
    openCutting: !!(flags & 64),
    // Buses and nothing else, as the bus lane between the Harbour Bridge's east pylons (flag 32, tools/build-geodata.mjs)
    busOnly: !!(flags & 32)
  };
  // A road on the ground has a shape of its own (tools/build-heights.mjs): heights and lean at even steps along it
  if (profile) {
    const heights = new Float32Array(profile.length);
    let q = 0;
    profile.forEach((d, i) => { q += d; heights[i] = q * 0.05; });
    link.profile = heights;
    link.lean = Float32Array.from(lean, (v) => v / 1000);
    link.along = [0];
    for (let i = 1; i < pts.length; i++) link.along.push(link.along[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  return link;
}

// --- Spatial index of every link segment ---------------------------------------------------------------------------
const segCells = new Map();
const lowCells = new Map(); // segments of structures low over the ground
const cutCells = new Map(); // segments of streets sunk into cuttings
const SEGMENTS = [];
const edgesKept = new Set(); // structure links whose edges have been worked out (linkEdges())
let onCutRoad = false, cutRoad = null; // set by cutGround()

// The floors of the buildings with models of their own that are here at the moment (js/interiors.js): { minX, maxX, minZ, maxZ, at(x, z) },
// `at` the floor's height there, or null where it has none. Inside its box, that's the ground.
const floors = new Map();
const setFloor = (id, floor) => floors.set(id, floor);
const clearFloor = (id) => floors.delete(id);
function modelFloor(x, z) {
  for (const f of floors.values()) {
    if (x < f.minX || x > f.maxX || z < f.minZ || z > f.maxZ) continue;
    const y = f.at(x, z);
    if (y !== null) return y;
  }
  return null;
}
/** Whether (x, z) is on a model's floor: no kerb to stand on there */
const onFloor = (x, z) => floors.size > 0 && modelFloor(x, z) !== null;
const addToCells = (cells, seg, pad, added) => {
  for (let ix = Math.floor((Math.min(seg.ax, seg.bx) - pad) / CELL); ix <= Math.floor((Math.max(seg.ax, seg.bx) + pad) / CELL); ix++) {
    for (let iz = Math.floor((Math.min(seg.az, seg.bz) - pad) / CELL); iz <= Math.floor((Math.max(seg.az, seg.bz) + pad) / CELL); iz++) {
      const k = ix * 100000 + iz;
      let list = cells.get(k);
      if (!list) cells.set(k, (list = []));
      list.push(seg);
      added?.push(cells, k, seg);
    }
  }
};

// Each link's entries in the cells, to take them out again
const placed = new Map();
const linksAtNode = new Map(); // node id -> the links meeting there
const plates = new Map(); // node id -> its junction's plate, once asked for (plateAt())
function placeLink(l) {
  for (const n of [l.a, l.b]) {
    (linksAtNode.get(n) || linksAtNode.set(n, []).get(n)).push(l);
    plates.delete(n);
  }
  const added = [];
  const segs = [];
  let s0 = 0;
  for (let i = 1; i < l.pts.length; i++) {
    const p = l.pts[i - 1], q = l.pts[i];
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len < 1e-6) continue;
    const seg = { link: l, ax: p.x, az: p.z, ay: p.y, bx: q.x, bz: q.z, by: q.y, len, ux: (q.x - p.x) / len, uz: (q.z - p.z) / len, s0, prev: segs[segs.length - 1] ?? null, next: null };
    if (seg.prev) seg.prev.next = seg;
    segs.push(seg);
    SEGMENTS.push(seg);
    addToCells(segCells, seg, l.half + 2, added);
    if (l.cut) addToCells(cutCells, seg, l.half + 1 + CUT_SLOPE, added);
    // Where the ground would show through a low deck, or close over a tunnel's cutting, it's lowered (groundHeight)
    if (l.kind === KIND.BRIDGE && Math.min(p.y - rawTerrainHeight(p.x, p.z), q.y - rawTerrainHeight(q.x, q.z)) < LOW_DECK) addToCells(lowCells, seg, l.half + 1, added);
    if (l.kind === KIND.TUNNEL && (seg.s0 < l.openA || seg.s0 + seg.len > l.length - l.openB)) addToCells(lowCells, seg, l.half + 1, added);
    s0 += len;
  }
  placed.set(l.id, { added, segs });
  edgesChanged(l);
}
function unplaceLink(l) {
  for (const n of [l.a, l.b]) {
    const list = linksAtNode.get(n);
    list.splice(list.indexOf(l), 1);
    if (!list.length) linksAtNode.delete(n);
    plates.delete(n);
  }
  const { added, segs } = placed.get(l.id);
  placed.delete(l.id);
  for (let i = 0; i < added.length; i += 3) {
    const cells = added[i], list = cells.get(added[i + 1]);
    const at = list.lastIndexOf(added[i + 2]);
    if (at >= 0) {
      list[at] = list[list.length - 1];
      list.pop();
    }
    if (!list.length) cells.delete(added[i + 1]);
  }
  const gone = new Set(segs);
  for (let i = SEGMENTS.length - 1; i >= 0 && gone.size; i--) {
    if (!gone.has(SEGMENTS[i])) continue;
    gone.delete(SEGMENTS[i]);
    SEGMENTS[i] = SEGMENTS[SEGMENTS.length - 1];
    SEGMENTS.pop();
  }
  edgesChanged(l);
}

onMap({
  addLink(record) {
    const link = linkFromRecord(record);
    link.slot = LINKS.length;
    LINKS.push(link);
    linkById.set(link.id, link);
    placeLink(link);
    if (link.sid) STRUCTURES[link.sid].links.push(link);
  },
  removeLink(record) {
    const link = linkById.get(record.id);
    unplaceLink(link);
    linkById.delete(link.id);
    const last = LINKS.pop();
    if (last !== link) {
      LINKS[link.slot] = last;
      last.slot = link.slot;
    }
    if (link.sid) {
      const list = STRUCTURES[link.sid].links;
      list.splice(list.indexOf(link), 1);
    }
  }
});

// --- Tunnels ---------------------------------------------------------------------------------------------------------
/** Whether a tunnel link is under cover `s` metres along it */
function tunnelCovered(link, s) {
  return s >= link.openA && s <= link.length - link.openB;
}

// Tunnel mouths: where each tunnel's cutting closes over, facing into the tunnel, with the length of open cutting outside
// it and how the road climbs along that. The ground is a lattice, which can't step from the cutting's floor up to the
// ground over the tube in no distance: its slope would close the mouth, so the ground's materials leave out what falls
// inside one (js/tunnel-mouths.js)
const PORTALS = [];
onMap({
  addTile(tile) { for (const p of tile.portals || []) PORTALS.push(p); },
  removeTile(tile) {
    if (!tile.portals?.length) return;
    const gone = new Set(tile.portals);
    let n = 0;
    for (const p of PORTALS) if (!gone.has(p)) PORTALS[n++] = p;
    PORTALS.length = n;
  }
});

/**
 * Open at an end where it reaches the surface, for as long as the ground hasn't closed over it, and a tube everywhere else.
 * Never open in the middle: a street's cutting that passes over a deeper tunnel leaves that tunnel less cover, not a hole in
 * the street. A link wholly open passes the opening on to the links after it. Run once with the whole map, when the tiles
 * are made (tools/tiles/derive.mjs): the game reads the results off each link.
 */
function deriveTunnels() {
  const linksAt = new Map();
  for (const l of LINKS) for (const n of [l.a, l.b]) (linksAt.get(n) || linksAt.set(n, []).get(n)).push(l);
  const lengthOf = (l) => l.pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - l.pts[i - 1].x, p.z - l.pts[i - 1].z) : 0), 0);
  // Metres open from one end of a link: till the ground closes over it
  const openFrom = (l, fromA) => {
    if (l.openCutting) return Infinity;
    const pts = fromA ? l.pts : [...l.pts].reverse();
    let s = 0;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i], L = Math.hypot(q.x - p.x, q.z - p.z);
      for (let d = 0; d < L; d += 2) {
        const t = d / L, x = p.x + (q.x - p.x) * t, z = p.z + (q.z - p.z) * t, y = p.y + (q.y - p.y) * t;
        if (cutGround(x, z) - y >= TUNNEL_COVER || (y < -8 && !landAt(x, z))) return s + d;
      }
      s += L;
    }
    return Infinity;
  };
  const tunnels = LINKS.filter((l) => l.kind === KIND.TUNNEL);
  // Nodes where a tunnel can come to the surface: it stops being a tunnel there. Those where a road joins it, or where the tunnel
  // before it is open all the way, are open to the sky: a tunnel covered from its first metre there has its mouth right at the node
  const mouths = [], entrances = new Set();
  for (const l of tunnels) {
    l.length = lengthOf(l);
    l.openA = 0;
    l.openB = 0;
    for (const n of [l.a, l.b]) {
      const others = linksAt.get(n).filter((o) => o !== l);
      if (!others.length || others.some((o) => o.kind !== KIND.TUNNEL)) mouths.push(n);
      if (others.some((o) => o.kind !== KIND.TUNNEL)) entrances.add(n);
    }
  }
  const seen = new Set();
  while (mouths.length) {
    const n = mouths.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    for (const l of linksAt.get(n)) {
      if (l.kind !== KIND.TUNNEL) continue;
      const fromA = l.a === n;
      // A metre of it open, at least, where it starts at an entrance: so it has a mouth, its face and the ground's cut there
      const open = Math.max(openFrom(l, fromA), entrances.has(n) ? Math.min(MOUTH_AT_NODE, l.length / 2) : 0);
      if (fromA) l.openA = Math.min(open, l.length);
      else l.openB = Math.min(open, l.length);
      if (open === Infinity) {
        mouths.push(fromA ? l.b : l.a);
        entrances.add(fromA ? l.b : l.a);
      }
    }
  }
  // A roof a few metres long is no tunnel
  for (const l of tunnels) if ((l.openA || l.openB) && l.length - l.openA - l.openB < 5) l.openA = l.length;
  for (const seg of SEGMENTS) {
    const l = seg.link;
    if (l.kind === KIND.TUNNEL && (seg.s0 < l.openA || seg.s0 + seg.len > l.length - l.openB)) addToCells(lowCells, seg, l.half + 1);
  }
  const portals = [];
  for (const l of LINKS) {
    if (l.kind !== KIND.TUNNEL || l.openA + l.openB >= l.length) continue;
    for (const [open, pts] of [[l.openA, l.pts], [l.openB, [...l.pts].reverse()]]) {
      if (!open) continue;
      let s = 0;
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i], L = Math.hypot(q.x - p.x, q.z - p.z);
        if (L < 1e-6) continue;
        if (s + L >= open) {
          const t = (open - s) / L, y = p.y + (q.y - p.y) * t;
          portals.push({
            x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t, y, ux: (q.x - p.x) / L, uz: (q.z - p.z) / L,
            half: l.half + 0.3, open, rise: (y - pts[0].y) / open
          });
          break;
        }
        s += L;
      }
    }
  }
  return { tunnels: Object.fromEntries(tunnels.map((l) => [l.id, [l.openA, l.openB, l.length]])), portals };
}

// Where (x, z) falls on a segment: the distance along it (t, 0-1), across it (off, to the right of travel) and from it
function project(seg, x, z) {
  const t = Math.max(0, Math.min(1, ((x - seg.ax) * seg.ux + (z - seg.az) * seg.uz) / seg.len));
  const px = seg.ax + seg.ux * seg.len * t, pz = seg.az + seg.uz * seg.len * t;
  const off = -(x - px) * seg.uz + (z - pz) * seg.ux;
  return { t, px, pz, off, d: Math.hypot(x - px, z - pz) };
}

// Ground roads under (x, z): whether it's on one's carriageway
// `margin` can be as much as segCells holds around a road: 2 m
function onGroundRoad(x, z, margin = 0.6) {
  for (const seg of segCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
    if (seg.link.kind) continue;
    if (project(seg, x, z).d < seg.link.width / 2 + margin) return true;
  }
  return false;
}

// How far from the water a car, a rider or a walker has to stay. A road at ground level that meets water crosses it on a
// culvert the map doesn't show, as most creeks are crossed, so the road and its edges count as land.
const SHORE_CLEARANCE = 2.5;
function clearOfWater(x, z) {
  return [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].every(([u, v]) => landAt(x + u * SHORE_CLEARANCE, z + v * SHORE_CLEARANCE)) || onGroundRoad(x, z, 2);
}

// --- The ground --------------------------------------------------------------------------------------------------------
// The ground with its cuttings, before anything is lowered for a structure. `onCutRoad`: (x, z) is on a cutting's road
function cutGround(x, z) {
  onCutRoad = false;
  let y = terrainHeight(x, z);
  // Down a cutting: on its road, the road's own height; beside it, the ground sloping back up to where it was. Where
  // carriageways overlap, the road whose centre line is nearest is the one you're on. A street that crosses over a
  // cutting without meeting it (over the tunnel the cutting leads to) stays where it is; one that joins it at a junction
  // follows it down.
  const key = Math.floor(x / CELL) * 100000 + Math.floor(z / CELL);
  const cuts = cutCells.get(key);
  if (cuts) {
    let on = null;
    for (const seg of segCells.get(key) || []) {
      if (seg.link.kind) continue;
      const p = project(seg, x, z);
      // A cutting's road runs a metre past its carriageway, so the kerbs along it stand in it, not on its slope. But a road's own
      // carriageway is its own: where two at different heights run side by side, one's margin doesn't take the other's lanes
      const reach = seg.link.half + (seg.link.cut ? 1 : 0);
      if (p.d > reach) continue;
      const inside = p.d <= seg.link.width / 2;
      if (!on || (inside && !on.inside) || (inside === on.inside && p.d < on.d)) on = { d: p.d, seg, t: p.t, inside };
    }
    const joins = (a, b) => a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b;
    if (on?.seg.link.cut) {
      // ...unless a street that doesn't meet it crosses over this spot: that street is the top of the cutting's portal, and
      // the ground here is the street. That's so of a street sunk into a cutting of its own too, if it's still higher than this
      // one (Falcon St over the Warringah Fwy): else the ground was the lower one, and the street over it had nothing under it.
      // One alongside only overlaps it, and the nearer centre line says which you're on.
      const onY = on.seg.ay + (on.seg.by - on.seg.ay) * on.t;
      const over = (segCells.get(key) || []).find((seg) => {
        if (seg.link.kind || seg.link === on.seg.link || joins(seg.link, on.seg.link)) return false;
        const d = project(seg, x, z).d;
        if (d > seg.link.width / 2 + 0.6) return false;
        if (seg.link.cut && ownRoadHeight(seg.link, x, z) <= onY + CUT_SAME) return false;
        // Across it, a street is its portal's top; alongside, only where the street's carriageway is here and the cutting's isn't
        if (Math.abs(seg.ux * on.seg.ux + seg.uz * on.seg.uz) < 0.87) return true;
        return d <= seg.link.width / 2 && (!on.inside || d < on.d);
      });
      if (over && !over.link.cut) return y;
      onCutRoad = true;
      cutRoad = over ? over.link : on.seg.link;
      return over ? ownRoadHeight(over.link, x, z) : Math.min(y, onY);
    }
    const ground = y;
    for (const seg of cuts) {
      const p = project(seg, x, z);
      const reach = seg.link.half + 1;
      if (p.d > reach + CUT_SLOPE || (on && !joins(on.seg.link, seg.link))) continue;
      const road = seg.ay + (seg.by - seg.ay) * p.t;
      y = Math.min(y, road + (ground - road) * Math.max(0, (p.d - reach) / CUT_SLOPE));
    }
  }
  return y;
}

/**
 * The ground's height at (x, z): on a road, the road's own surface; elsewhere the terrain, moved to meet the roads and lowered under a
 * structure's end where it would otherwise show through
 */
function groundHeight(x, z) {
  if (floors.size) {
    const y = modelFloor(x, z);
    if (y !== null) return y;
  }
  // The road here: one whose carriageway this is before one whose margin reaches it, then the nearest centre line
  let nearest = null, nd = Infinity, nearestInside = false;
  const list = segCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL));
  if (list) {
    for (let k = 0; k < list.length; k++) {
      const seg = list[k];
      if (seg.link.kind) continue;
      const d = segmentDistance(seg, x, z);
      if (d > seg.link.half) continue;
      const inside = d <= seg.link.width / 2;
      if ((inside && !nearestInside) || (inside === nearestInside && d < nd)) { nd = d; nearest = seg.link; nearestInside = inside; }
    }
  }
  if (nearest?.profile) return sharedSurface(nearest, x, z);
  const y = cutGround(x, z);
  if (onCutRoad) return sharedSurface(cutRoad, x, z);
  const lows = lowCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL));
  if (!lows) return y;
  let low = Infinity;
  for (const seg of lows) {
    const p = project(seg, x, z);
    if (p.d > seg.link.half + 1) continue;
    const road = seg.ay + (seg.by - seg.ay) * p.t;
    // Under a deck only where it's low; over a tunnel only where it's still a cutting, and not over the same tunnel's tube where it
    // turns or runs on beside it: there the ground stays over its ceiling, or you'd see down into it
    if (seg.link.kind === KIND.TUNNEL ? tunnelCovered(seg.link, seg.s0 + seg.len * p.t) || overTube(seg.link.sid, x, z) : road - y >= LOW_DECK) continue;
    low = Math.min(low, road - 0.45);
  }
  if (low < y && !onGroundRoad(x, z)) return low;
  return y;
}

// Whether (x, z) is over a covered stretch of structure `sid`'s tunnel, within its width
function overTube(sid, x, z) {
  for (const seg of segCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
    if (seg.link.sid !== sid || seg.link.kind !== KIND.TUNNEL) continue;
    const p = project(seg, x, z);
    if (p.d <= seg.link.half && tunnelCovered(seg.link, seg.s0 + seg.len * p.t)) return true;
  }
  return false;
}

// A road's own shape at (x, z): its height along it, and a little lean across
function shapedHeight(l, x, z) {
  const P = l.pts;
  let best = Infinity, s = 0, off = 0;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], dx = b.x - a.x, dz = b.z - a.z, L = l.along[i] - l.along[i - 1];
    if (L < 1e-6) continue;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (L * L)));
    const px = a.x + dx * t, pz = a.z + dz * t, ex = x - px, ez = z - pz, d = ex * ex + ez * ez;
    if (d < best) {
      best = d;
      s = l.along[i - 1] + L * t;
      off = (ex * dz - ez * dx) / L; // to the left of its way from a to b
    }
  }
  const H = l.profile, n = H.length;
  const u = (s / (l.along[l.along.length - 1] || 1)) * (n - 1);
  const i = Math.min(Math.floor(u), n - 2), t = u - i;
  // Through the heights smoothly, so nothing kinks at a station
  const p0 = H[Math.max(i - 1, 0)], p1 = H[i], p2 = H[i + 1], p3 = H[Math.min(i + 2, n - 1)];
  const y = p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  // Straight across, as far as what's drawn under the kerbs, so that its few points across the road are enough to draw it
  const half = l.width / 2 + DRAWN_PAST_EDGE;
  return y + (l.lean[i] + (l.lean[i + 1] - l.lean[i]) * t) * Math.max(-half, Math.min(half, off));
}

function ownRoadHeight(l, x, z) {
  if (l.profile) return shapedHeight(l, x, z);
  if (l.cut) {
    const seg = nearestSegment(l, x, z);
    return seg.ay + (seg.by - seg.ay) * seg.t;
  }
  return terrainHeight(x, z);
}

// Roads overlap: where several meet, and where a divided road's two sides are mapped closer together than they're wide. There the
// surface is all of them, the nearer counting more, so it's one surface with no step in it, whichever road you ask. A cutting only
// joins in where it meets this road at a junction: a street along the edge of one stays up at its own level.
const smoothstep01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const joined = (a, b) => a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b;
const CARRIAGEWAY_FADE = 1.5; // m inside its edge that a road's say fades out
const CUT_SAME = 1.5; // m apart at most, for two cuttings overlapping to be one surface
const JUNCTION_MORE = 4; // m past its corners that a junction reaches
const PLATE_FADE = 0.35; // of its reach, where a junction's plate fades into the roads
const PLATE_MISS = 0.25; // m a plate may miss a road meeting it by
const PLATE_STEEPEST = 0.15;
const STRUCTURE_LOCK = 12; // m from where a road joins a structure

// A junction is a flat plate, tilted to suit the roads meeting there. Being flat, however it's cut into triangles and however many
// roads overlap on it, they all draw the same surface, and a wheel on it is on what's drawn.
function plateAt(n) {
  let plate = plates.get(n);
  if (plate !== undefined) return plate;
  const arms = linksAtNode.get(n);
  plate = null;
  // Not where a structure joins: there the road has to meet it exactly
  if (arms && arms.length >= 3 && arms.every((l) => !l.kind)) {
    const ground = arms;
    if (ground.length) {
      const first = ground[0].a === n ? ground[0].pts[0] : ground[0].pts[ground[0].pts.length - 1];
      let reach = 0;
      for (const arm of arms) reach = Math.max(reach, arm.half);
      reach += GEO.frame.corner + JUNCTION_MORE;
      // Through the height here and what each road reaches at the plate's edge, by least squares
      let y0 = 0;
      for (const arm of ground) y0 += ownRoadHeight(arm, first.x, first.z);
      y0 /= ground.length;
      let xx = 1e-3, xz = 0, zz = 1e-3, xy = 0, zy = 0;
      const rim = [];
      for (const arm of ground) {
        const pts = arm.a === n ? arm.pts : [...arm.pts].reverse();
        // Along the road from here, as far as the plate's edge or half way along it
        const length = pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) : 0), 0);
        const want = Math.min(reach, length / 2);
        let walked = 0, px = first.x, pz = first.z;
        for (let i = 1; i < pts.length; i++) {
          const L = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
          if (walked + L >= want) {
            const t = L ? (want - walked) / L : 0;
            px = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t;
            pz = pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t;
            break;
          }
          walked += L;
        }
        const dx = px - first.x, dz = pz - first.z, dy = ownRoadHeight(arm, px, pz) - y0;
        rim.push(dx, dz, dy);
        xx += dx * dx; xz += dx * dz; zz += dz * dz; xy += dx * dy; zy += dz * dy;
      }
      const det = xx * zz - xz * xz;
      const gx = (xy * zz - zy * xz) / det, gz = (zy * xx - xy * xz) / det;
      // No flat plate fits roads going up and down at once: those keep to blending between them
      let fits = Math.hypot(gx, gz) <= PLATE_STEEPEST;
      for (let i = 0; i < rim.length; i += 3) if (Math.abs(gx * rim[i] + gz * rim[i + 1] - rim[i + 2]) > PLATE_MISS) fits = false;
      if (fits) plate = { x: first.x, z: first.z, y: y0, gx, gz, reach };
    }
  }
  plates.set(n, plate);
  return plate;
}

// How far (x, z) is from a stretch of road, with nothing to allocate: this is asked a great deal
function segmentDistance(seg, x, z) {
  const ex = x - seg.ax, ez = z - seg.az;
  const along = ex * seg.ux + ez * seg.uz;
  const t = along <= 0 ? 0 : along >= seg.len ? seg.len : along;
  return Math.hypot(ex - seg.ux * t, ez - seg.uz * t);
}
function linkDistance(l, x, z) {
  const P = l.pts;
  let best = Infinity;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    const ex = a.x + dx * t - x, ez = a.z + dz * t - z, d = ex * ex + ez * ez;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// A street crossing over a cutting without meeting it stays where it is, and overlapping cuttings are one surface only if they're level
function sameSurface(a, b, x, z) {
  if (!a.cut && !b.cut) return true;
  if ((!a.cut || !b.cut) && !joined(a, b)) return false;
  return Math.abs(ownRoadHeight(a, x, z) - ownRoadHeight(b, x, z)) < CUT_SAME;
}

const JUNCTION_FAR = 40; // m: no junction reaches further than this
/** Whether (x, z) is near enough an end of `link` where three roads or more meet to be in that junction */
function inJunction(link, x, z) {
  for (let e = 0; e < 2; e++) {
    const end = e ? link.pts[link.pts.length - 1] : link.pts[0];
    if (Math.hypot(x - end.x, z - end.z) < JUNCTION_FAR && (linksAtNode.get(e ? link.b : link.a)?.length ?? 0) >= 3) return true;
  }
  return false;
}
const nearLinks = [];
const nearNodes = [];
function sharedSurface(link, x, z) {
  nearLinks.length = 0;
  nearLinks.push(link);
  const cellSegments = segCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL));
  if (cellSegments) {
    for (let k = 0; k < cellSegments.length; k++) {
      const seg = cellSegments[k], l = seg.link;
      if (l === link || l.kind || nearLinks.includes(l) || segmentDistance(seg, x, z) > l.half) continue;
      if (sameSurface(l, link, x, z)) nearLinks.push(l);
    }
  }
  // A junction with no plate: all its roads, while near enough
  for (let e = 0; e < 2; e++) {
    const end = e ? link.pts[link.pts.length - 1] : link.pts[0];
    if (Math.abs(x - end.x) > JUNCTION_FAR || Math.abs(z - end.z) > JUNCTION_FAR) continue;
    const n = e ? link.b : link.a;
    const arms = linksAtNode.get(n);
    if (arms && arms.length >= 3 && !plateAt(n)) {
      for (let k = 0; k < arms.length; k++) {
        const arm = arms[k];
        if (!arm.kind && !nearLinks.includes(arm) && sameSurface(arm, link, x, z)) nearLinks.push(arm);
      }
    }
  }
  // The roads here, the nearer counting more
  let base;
  if (nearLinks.length === 1) base = ownRoadHeight(link, x, z);
  else {
    let sum = 0, weight = 0;
    for (let k = 0; k < nearLinks.length; k++) {
      const l = nearLinks[k];
      const d = linkDistance(l, x, z);
      let fade = d >= l.half ? 0 : Math.min(1, (l.half - d) / CARRIAGEWAY_FADE);
      for (let e = 0; e < 2; e++) {
        const end = e ? l.pts[l.pts.length - 1] : l.pts[0];
        if (Math.abs(x - end.x) > JUNCTION_FAR || Math.abs(z - end.z) > JUNCTION_FAR) continue;
        const n = e ? l.b : l.a;
        const arms = linksAtNode.get(n);
        if (!arms || arms.length < 3 || plateAt(n)) continue;
        let reach = 0;
        for (let a = 0; a < arms.length; a++) if (arms[a].half > reach) reach = arms[a].half;
        reach += GEO.frame.corner + JUNCTION_MORE;
        const dn = Math.hypot(x - end.x, z - end.z);
        if (dn < reach) fade = Math.max(fade, smoothstep01((reach - dn) / (reach * PLATE_FADE)));
      }
      if (fade <= 0) continue;
      const w = fade / (d + 0.5) ** 2;
      sum += ownRoadHeight(l, x, z) * w;
      weight += w;
    }
    base = weight ? sum / weight : ownRoadHeight(link, x, z);
  }
  // ...and any junction's plate taking over from them
  nearNodes.length = 0;
  let plateSum = 0, plateShare = 0;
  for (let k = 0; k < nearLinks.length; k++) {
    const l = nearLinks[k];
    for (let e = 0; e < 2; e++) {
      const end = e ? l.pts[l.pts.length - 1] : l.pts[0];
      if (Math.abs(x - end.x) > JUNCTION_FAR || Math.abs(z - end.z) > JUNCTION_FAR) continue;
      const n = e ? l.b : l.a;
      if (nearNodes.includes(n)) continue;
      nearNodes.push(n);
      const plate = plateAt(n);
      if (!plate) continue;
      const dn = Math.hypot(x - plate.x, z - plate.z);
      if (dn >= plate.reach) continue;
      const share = smoothstep01((plate.reach - dn) / (plate.reach * PLATE_FADE));
      plateSum += share * (plate.y + plate.gx * (x - plate.x) + plate.gz * (z - plate.z));
      plateShare += share;
    }
  }
  let y = plateShare ? base + (plateSum / plateShare - base) * Math.min(1, plateShare) : base;
  // Where a road joins a structure it meets it exactly, whatever else is near
  for (let e = 0; e < 2; e++) {
    const end = e ? link.pts[link.pts.length - 1] : link.pts[0];
    if (Math.abs(x - end.x) > STRUCTURE_LOCK || Math.abs(z - end.z) > STRUCTURE_LOCK) continue;
    const arms = linksAtNode.get(e ? link.b : link.a);
    if (!arms || !arms.some((l) => l.kind)) continue;
    const near = 1 - Math.hypot(x - end.x, z - end.z) / STRUCTURE_LOCK;
    if (near > 0) y += (ownRoadHeight(link, x, z) - y) * smoothstep01(near);
  }
  return y;
}

/**
 * The surface of one road on the ground at (x, z): its own shape, or a cutting's own profile. Roads side by side at different
 * heights (a street along the edge of a freeway's cutting) each keep their own, where groundHeight() has to pick one.
 */
function roadHeight(link, x, z) {
  if (link.profile || link.cut) return sharedSurface(link, x, z);
  const ground = terrainHeight(x, z);
  // Each cutting it meets at a junction, from the nearest point of that cutting's road
  let y = ground;
  const seen = new Set();
  for (const seg of cutCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
    const other = seg.link;
    if (seen.has(other) || (other.a !== link.a && other.a !== link.b && other.b !== link.a && other.b !== link.b)) continue;
    seen.add(other);
    const near = nearestSegment(other, x, z);
    const reach = other.half + 1;
    if (near.d > reach + CUT_SLOPE) continue;
    const road = near.ay + (near.by - near.ay) * near.t;
    y = Math.min(y, road + (ground - road) * Math.max(0, (near.d - reach) / CUT_SLOPE));
  }
  return y;
}
function nearestSegment(link, x, z) {
  let best = null;
  for (let i = 1; i < link.pts.length; i++) {
    const a = link.pts[i - 1], b = link.pts[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    const d = Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
    if (!best || d < best.d) best = { d, t, ay: a.y, by: b.y };
  }
  return best;
}

/** The road on the ground whose carriageway (x, z) is on, its centre line nearest; null off the roads. `near`: for
 *  something at that height, only the roads within a step of it, where carriageways overlap at different heights. */
function groundRoadAt(x, z, near = null) {
  let best = null, bd = Infinity;
  for (const seg of segCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
    if (seg.link.kind) continue;
    const d = segmentDistance(seg, x, z);
    if (d > seg.link.half || d >= bd || (near !== null && Math.abs(roadHeight(seg.link, x, z) - near) >= STEP)) continue;
    bd = d;
    best = seg.link;
  }
  return best;
}

// --- Roads side by side ----------------------------------------------------------------------------------------------
// Where a ramp joins a motorway, or two carriageways run together, OSM draws each as a line of its own. Each raised road had a
// barrier and a side wall along both its edges, so where two met side by side at one level, walls stood in the road. An edge
// with another road beside it at its level is open: no barrier, no wall, and the gap between the two filled with deck.
const EDGE_GAP = 2.5; // m between two roads' surfaces that's still one deck: less than a car's width
const EDGE_LEVEL = 0.35; // m apart in height, at most, to be at one level

/** Whether `other` only carries `link` on: the two of them alone at a node, one road drawn as two links */
function carriesOn(link, other) {
  for (const n of [link.a, link.b]) {
    if (n !== other.a && n !== other.b) continue;
    if ((linksAtNode.get(n)?.length ?? 0) === 2) return true;
  }
  return false;
}
/** A road's surface at (x, z) on segment `seg`, whatever kind it is */
const surfaceOn = (seg, p, x, z) => (seg.link.kind ? seg.ay + (seg.by - seg.ay) * p.t : roadHeight(seg.link, x, z));

/**
 * Another road beside the edge of `link` at (x, z), its edge's own point, at height y, across from it in direction (nx, nz):
 * { gap, out, link, y, opposite }, where gap is how far out the other road's surface begins (0 where they overlap, and `out`
 * less than 0 by how far they do), or null where
 * nothing at this level is within EDGE_GAP. `opposite`: its traffic comes the other way, a divided road's other carriageway,
 * which has a median barrier between the two rather than nothing. The Harbour Bridge's deck and what joins it are drawn by
 * js/harbour-bridge.js. `ux, uz`: the way `link` runs at that point.
 */
function edgeNeighbour(link, x, z, nx, nz, y, ux, uz) {
  let best = null;
  for (const d of [0.3, 1, 1.75, EDGE_GAP]) {
    const px = x + nx * d, pz = z + nz * d;
    for (const seg of segCells.get(Math.floor(px / CELL) * 100000 + Math.floor(pz / CELL)) || []) {
      const other = seg.link;
      if (other === link || other.deck || carriesOn(link, other)) continue;
      const p = project(seg, px, pz);
      if (p.d > other.half) continue;
      const oy = surfaceOn(seg, p, px, pz);
      if (Math.abs(oy - y) > EDGE_LEVEL) continue;
      // How far out its surface begins, from the edge; and `out`, the same with a sign, less than 0 where the two overlap
      const q = project(seg, x, z);
      const gap = Math.max(0, q.d - other.half), out = (q.px - x) * nx + (q.pz - z) * nz - other.half;
      // Traffic each way on each: one-way roads running opposite ways
      const opposite = link.dir !== 0 && other.dir !== 0 && (seg.ux * ux + seg.uz * uz) * link.dir * other.dir < -0.5;
      if (!best || gap < best.gap) best = { gap, out, link: other, y: oy, opposite };
    }
    if (best) return best;
  }
  return null;
}

/** Another road whose lanes (x, z) is in, at height y give or take `level`, other than `link` and what carries it on: or null */
function laneAt(x, z, y, link, level = 0.5) {
  for (const seg of segCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
    const other = seg.link;
    if (other === link || other.deck || carriesOn(link, other)) continue;
    const p = project(seg, x, z);
    if (p.d > other.width / 2 || Math.abs(surfaceOn(seg, p, x, z) - y) > level) continue;
    return other;
  }
  return null;
}

// --- Structures ----------------------------------------------------------------------------------------------------
/** The nearest place on structure `sid` to (x, z), within `reach` of its edge: { y, off, d, seg, link, inside } */
function structureAt(sid, x, z, reach = 0) {
  let best = null;
  for (const seg of segCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
    if (seg.link.sid !== sid) continue;
    const p = project(seg, x, z);
    if (p.d > seg.link.half + reach) continue;
    if (!best || p.d < best.d) best = { y: seg.ay + (seg.by - seg.ay) * p.t, off: p.off, d: p.d, px: p.px, pz: p.pz, seg, link: seg.link, s: seg.s0 + p.t * seg.len };
  }
  if (best) best.inside = best.d <= best.link.half;
  return best;
}

/** Every level of every structure over or under (x, z): [{ sid, y, d }]. One structure can be on two: a ramp parting from a
 *  road. On the Harbour Bridge's deck, the deck alone: the ramps that join it start at its edge. */
function structuresAt(x, z, margin = 0) {
  const out = [];
  const segs = segCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || [];
  let onDeck = null;
  for (const seg of segs) {
    if (!seg.link.kind) continue;
    const p = project(seg, x, z);
    if (p.d > seg.link.half - margin) continue;
    if (seg.link.sid === DECK_STRUCTURE && !seg.link.deck) {
      onDeck ??= segs.some((other) => other.link.deck && project(other, x, z).d <= other.link.half - margin);
      if (onDeck) continue;
    }
    const y = seg.ay + (seg.by - seg.ay) * p.t;
    const known = out.find((o) => o.sid === seg.link.sid && Math.abs(o.y - y) < STEP);
    if (!known) out.push({ sid: seg.link.sid, y, d: p.d });
    else if (p.d < known.d) Object.assign(known, { y, d: p.d });
  }
  return out;
}

// --- Decks as drawn, for what stands on them -------------------------------------------------------------------------
// js/structures.js draws each raised road's edges from these stations and the same test, edgeNeighbour(): a barrier or a wall
// where nothing at its level is beside it, a median where the road beside carries traffic the other way, and the gap to a
// road going the same way filled with deck. What stands on a deck is held by what's drawn. The margin that keeps a body's
// middle in from the edge (js/controllers.js) is kept from a barrier, a wall or a median, not from an edge open to the road
// beside; the gap between two roads drawn as one is deck; and the ground under a deck as drawn, at its level, isn't a way off.
// Worked out for a link the first time something comes near it, so the tile build, which never asks, never pays for it.
const STATION_STEP = 6; // m between stations
const RAISED = 1; // m over the ground at its edge, where a deck has a barrier rather than a kerb
const FLARE = 4; // m over which a barrier's hold comes in from nothing at its end, as a barrier's end is flared into the verge
const MEDIAN_HALF = 0.25; // m: half a median barrier's width (js/structures.js)
const FILL_PAST = 0.1; // m the deck across a gap is drawn past the other road's edge
const NOSE = 0.4; // m: a nose's thickness, a barrier's (js/structures.js)

/** Stations along a link: { x, z, y, s }, every STATION_STEP or less, heights from its profile */
function linkStations(link) {
  const out = [];
  let s = 0;
  for (let i = 0; i + 1 < link.pts.length; i++) {
    const p = link.pts[i], q = link.pts[i + 1];
    const L = Math.hypot(q.x - p.x, q.z - p.z);
    const n = Math.max(1, Math.ceil(L / STATION_STEP));
    for (let k = 0; k < n; k++) out.push({ x: p.x + ((q.x - p.x) * k) / n, z: p.z + ((q.z - p.z) * k) / n, y: p.y + ((q.y - p.y) * k) / n, s: s + (L * k) / n });
    s += L;
  }
  const last = link.pts[link.pts.length - 1];
  out.push({ x: last.x, z: last.z, y: last.y, s });
  return out;
}

// A polyline offset `r` to its left (+) or right (-), mitred at the bends so the ribbon keeps its width round them
function offsetLine(pts, r) {
  return pts.map((p, i) => {
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const n1 = i > 0 ? leftOf(pts[i - 1], p) : leftOf(p, b);
    const n2 = i < pts.length - 1 ? leftOf(p, pts[i + 1]) : n1;
    let mx = n1.x + n2.x, mz = n1.z + n2.z;
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml; mz /= ml;
    const k = r / Math.max(0.35, mx * n1.x + mz * n1.z);
    return { x: p.x + mx * k, z: p.z + mz * k };
  });
}
function leftOf(p, q) {
  const L = Math.hypot(q.x - p.x, q.z - p.z) || 1;
  return { x: -(q.z - p.z) / L, z: (q.x - p.x) / L };
}

/** Whether a structure link's end at node n meets nothing else off the ground: a deck's start off a road on the ground, square there */
const freeEnd = (link, n) => !(linksAtNode.get(n) || []).some((o) => o !== link && o.kind);

// Links with their edges worked out (edgesKept, at the top, as links are placed from the first tile): a link placed or taken out
// near one changes what's beside it
function edgesChanged(l) {
  if (!edgesKept.size) return;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of l.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  for (const m of edgesKept) {
    const b = m.edges.box;
    if (m === l || (x0 <= b[1] && x1 >= b[0] && z0 <= b[3] && z1 >= b[2])) {
      m.edges = null;
      edgesKept.delete(m);
    }
  }
}

/**
 * Each side of a structure link as js/structures.js draws it, from the same stations and edgeNeighbour(). Station by station:
 * `open`, the road beside at its level, if any; `raised`, high enough over the ground for a barrier; `owns`, what's between the
 * two is this link's to draw: `fills`, the gap, and `median`, its median barrier, `mid` out from the edge. Stretch by stretch,
 * between stations j and j + 1:
 *   - `barrier`: a barrier or wall along the edge, where either end has nothing beside it. It's carried on to where the gap beside
 *     is filled, so no stretch is left with neither, but for where the road beside draws what's between them;
 *   - `line`: how far from the centre line the face of what holds a body stands at each end (the barrier where it's raised, a
 *     wall, or a median's face: its middle is MEDIAN_HALF further), or null;
 *   - `filled`: the gap beside drawn as deck, by this link;
 *   - `strip`: the road going the same way the gap is filled to, with the gap at each end, where this link fills it;
 *   - `reach`: how far out the deck as drawn reaches, at each end;
 *   - `nose`: where a filled gap ends beside a raised barrier, the nose drawn across the gap there, on the barrier's stretch:
 *     { i, s, gap, nx, nz }, its station, how far along, how far across and the way out. Each side's `noses` lists them.
 * `runs`: each side's stretches held, by a barrier or by a median, with whether the hold flares in at each end: not where the
 * link carries on into another of its structure, whose barrier carries on with it. `stations`: the stations to draw from, where
 * they aren't the link's own (js/structures.js on the Harbour Bridge's ramps): worked out afresh, not kept.
 */
function linkEdges(link, stations = null) {
  if (!stations && link.edges) return link.edges;
  const st = stations || linkStations(link);
  const n = st.length;
  const free = [freeEnd(link, link.a), freeEnd(link, link.b)];
  const pad = link.half + EDGE_GAP + 30;
  const box = [Infinity, -Infinity, Infinity, -Infinity];
  for (const p of st) { box[0] = Math.min(box[0], p.x - pad); box[1] = Math.max(box[1], p.x + pad); box[2] = Math.min(box[2], p.z - pad); box[3] = Math.max(box[3], p.z + pad); }
  const sides = new Map();
  for (const side of [1, -1]) {
    const row = offsetLine(st, link.half * side);
    const normal = [];
    const open = row.map((p, i) => {
      const a = st[Math.max(0, i - 1)], b = st[Math.min(n - 1, i + 1)], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
      normal.push({ x: -uz * side, z: ux * side });
      return edgeNeighbour(link, p.x, p.z, -uz * side, ux * side, st[i].y, ux, uz);
    });
    // A deck has a barrier a station either side of where it's raised; a tunnel has walls all along
    const bare = row.map((p, i) => link.kind === KIND.TUNNEL || st[i].y - groundHeight(p.x, p.z) > RAISED);
    const raised = bare.map((v, i) => v || !!bare[i - 1] || !!bare[i + 1]);
    const owns = open.map((o) => !!o && (!o.link.kind || link.id < o.link.id));
    const fills = open.map((o, i) => owns[i] && o.gap > 0.05);
    const median = open.map((o, i) => owns[i] && o.opposite);
    // A median barrier's middle, from this edge: halfway between the two roads' edges, in the middle of the gap or of the overlap
    const mid = open.map((o) => (o?.opposite ? o.out / 2 : 0));
    const middle = (i) => link.half + mid[i];
    const barrier = [], line = [], filled = [], strip = [], reach = [], kind = [], nose = [];
    // Where the road beside draws what's between the two (it fills the gap to this one, or stands its median in it), its fill, its nose
    // and its median close it: this one's barrier isn't carried on beside them
    const filledBeside = (i) => !!open[i] && !owns[i] && (open[i].opposite || open[i].gap > 0.05);
    for (let j = 0; j + 1 < n; j++) {
      const a = open[j], b = open[j + 1];
      barrier.push(!(a && b) && !filledBeside(j) && !filledBeside(j + 1));
      if (barrier[j]) {
        line.push(raised[j] || raised[j + 1] ? [link.half, link.half] : null);
        kind.push(line[j] ? 1 : 0);
      } else if (median[j] && median[j + 1]) {
        // The road that draws a median is what holds by it, on both its sides (decksAt())
        line.push([Math.max(0, middle(j) - MEDIAN_HALF), Math.max(0, middle(j + 1) - MEDIAN_HALF)]);
        kind.push(2);
      } else {
        line.push(null);
        kind.push(0);
      }
      // Filled where the gap is this link's to draw at both ends and open at either: tapering to nothing where the two meet
      filled.push(owns[j] && owns[j + 1] && (fills[j] || fills[j + 1]));
      strip.push(filled[j] && !a.opposite && !b.opposite ? { link: (a.link === b.link ? a : b).link, gap: [a.gap, b.gap] } : null);
      reach.push(a && b ? [link.half + a.gap + FILL_PAST, link.half + b.gap + FILL_PAST] : [link.half, link.half]);
      nose.push(null);
    }
    // The noses: a filled gap's end beside a raised barrier
    const isFilled = (j) => j >= 0 && j < n - 1 && filled[j];
    const noses = [];
    for (let i = 0; i < n; i++) {
      if (!fills[i] || isFilled(i - 1) === isFilled(i)) continue;
      const j = isFilled(i) ? i - 1 : i; // the stretch on the barrier's side
      if (j < 0 || j >= n - 1 || !barrier[j] || !line[j]) continue;
      const at = { i, s: st[i].s, gap: open[i].gap + FILL_PAST, nx: normal[i].x, nz: normal[i].z };
      nose[j] = at;
      noses.push(at);
    }
    const runs = [];
    for (let j = 0; j < n - 1; j++) {
      if (!kind[j]) continue;
      const lastRun = runs[runs.length - 1];
      if (lastRun && lastRun.to === j && lastRun.kind === kind[j]) { lastRun.to = j + 1; continue; }
      runs.push({ from: j, to: j + 1, kind: kind[j] });
    }
    sides.set(side, {
      open, raised, owns, fills, median, mid, normal, barrier, line, filled, strip, reach, nose, noses,
      runs: runs.map((r) => ({ s0: st[r.from].s, s1: st[r.to].s, flare0: r.from > 0 || free[0], flare1: r.to < n - 1 || free[1] }))
    });
  }
  const edges = { st, s: Float64Array.from(st, (p) => p.s), free, sides, box };
  if (stations) return edges;
  link.edges = edges;
  edgesKept.add(link);
  return edges;
}

// One side of a link `s` metres along it, between two stations: what holds a body there, how far the deck reaches (linkEdges())
const edgeHere = { line: null, median: false, flare: 1, strip: null, gap: 0, reach: 0, opens: 0, other: null, nose: null, stripNose: null };
function edgeAt(E, side, s) {
  const S = E.s;
  let lo = 0, hi = S.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (S[mid] <= s) lo = mid;
    else hi = mid;
  }
  const j = lo, f = S[hi] > S[lo] ? Math.max(0, Math.min(1, (s - S[lo]) / (S[hi] - S[lo]))) : 0;
  const one = E.sides.get(side);
  const lerp = ([a, b]) => a + (b - a) * f;
  const out = edgeHere;
  const line = one.line[j];
  out.line = line ? lerp(line) : null;
  out.median = !!line && !one.barrier[j];
  out.flare = 1;
  if (line) {
    for (const r of one.runs) {
      if (s < r.s0 - 1e-6 || s > r.s1 + 1e-6) continue;
      if (r.flare0) out.flare = Math.min(out.flare, (s - r.s0) / FLARE);
      if (r.flare1) out.flare = Math.min(out.flare, (r.s1 - s) / FLARE);
    }
    out.flare = Math.max(0, Math.min(1, out.flare));
  }
  const strip = one.strip[j];
  out.strip = strip ? strip.link : null;
  const a = one.open[j], b = one.open[hi];
  out.gap = a && b ? a.gap + (b.gap - a.gap) * f : 0;
  out.reach = lerp(one.reach[j]);
  out.opens = a?.link.kind ? a.link.sid : b?.link.kind ? b.link.sid : 0;
  out.other = a?.link ?? b?.link ?? null;
  out.nose = one.nose[j];
  // A filled gap ending in a nose at either end of this stretch
  out.stripNose = strip ? (one.nose[j - 1]?.i === j ? one.nose[j - 1] : one.nose[j + 1]?.i === hi ? one.nose[j + 1] : null) : null;
  return out;
}

/** The height of `link`'s own surface at its nearest point to (x, z) */
function heightOnLink(link, x, z) {
  if (!link.kind) return roadHeight(link, x, z);
  let best = null;
  for (const seg of segCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
    if (seg.link !== link) continue;
    const p = project(seg, x, z);
    if (!best || p.d < best.d) best = { d: p.d, y: seg.ay + (seg.by - seg.ay) * p.t };
  }
  return best ? best.y : edgeHeight({ link: link.id }, x, z);
}

/**
 * Every level of every structure a body's middle can be at (x, z), the body kept `margin` in from what holds it, as drawn:
 * { levels: [{ sid, y, d, push, joins }], covers: [y], medians: [y] }. `push`: the place the body is held back to, in from a barrier
 * it's pressed into (a barrier's flared end, a median); `joins`, a structure it's drawn as one with here. `covers`: the heights
 * of every deck drawn over (x, z), what a body at that level can't step down through to the ground; `medians`, of the decks
 * whose median (x, z) is in, where the ground isn't a way through either, even off a road on the ground. The Harbour Bridge's
 * deck keeps to its own (structuresAt()).
 */
const decksHere = { levels: [], covers: [], medians: [] };
const found = [], passedOver = [];
function decksAt(x, z, margin = 0) {
  const levels = (decksHere.levels = []), covers = (decksHere.covers = []), medians = (decksHere.medians = []);
  found.length = 0;
  passedOver.length = 0;
  const segs = segCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || [];
  let onDeck = null;
  let link = null;
  let claim = false; // in a median's hold, what's added is the median's say
  const add = (sid, y, d, push = null, joins = 0, from = link) => found.push({ from, sid, y, d, push, joins, claim });
  for (const seg of segs) {
    link = seg.link;
    claim = false;
    if (!link.kind) continue;
    if (link.sid === DECK_STRUCTURE) {
      const p = project(seg, x, z);
      if (!link.deck) {
        onDeck ??= segs.some((other) => other.link.deck && project(other, x, z).d <= other.link.half - margin);
        if (onDeck) continue;
      } else {
        if (p.d <= link.half - margin) add(link.sid, seg.ay + (seg.by - seg.ay) * p.t, p.d);
        continue;
      }
    }
    const E = linkEdges(link);
    // How far along the segment, a centimetre past either end counting as on it. Past the link's end where it starts off a road on
    // the ground, nothing: it's square there, and the road beyond is the ground's. Past a bend, or a joint with the next of its
    // structure's links, round the corner, as the bend is drawn mitred and the joint as a disc
    const run = (x - seg.ax) * seg.ux + (z - seg.az) * seg.uz;
    if ((run < -0.01 && seg.s0 < 1e-6 && E.free[0]) || (run > seg.len + 0.01 && seg.s0 + seg.len > E.s[E.s.length - 1] - 1e-3 && E.free[1])) continue;
    // Round a bend only outside it, where neither segment reaches
    const before = run < -0.01, past = run > seg.len + 0.01;
    if (before && seg.prev && (x - seg.prev.ax) * seg.prev.ux + (z - seg.prev.az) * seg.prev.uz <= seg.prev.len + 0.01) continue;
    if (past && seg.next && (x - seg.next.ax) * seg.next.ux + (z - seg.next.az) * seg.next.uz >= -0.01) continue;
    const t = Math.max(0, Math.min(1, run / seg.len));
    const fx = seg.ax + seg.ux * seg.len * t, fz = seg.az + seg.uz * seg.len * t;
    const off = -(x - fx) * seg.uz + (z - fz) * seg.ux, side = off >= 0 ? 1 : -1, e = Math.hypot(x - fx, z - fz);
    // The way out from the road, to hold a body back along
    const ox = e > 1e-6 ? (x - fx) / e : -seg.uz * side, oz = e > 1e-6 ? (z - fz) / e : seg.ux * side;
    const y = seg.ay + (seg.by - seg.ay) * t;
    const s = seg.s0 + t * seg.len;
    const edge = edgeAt(E, side, s);
    const half = link.half;
    const hold = edge.line === null ? Infinity : Math.max(0, edge.line - margin * edge.flare);
    // A median has its say beside it, not round a corner, where it's past its end and the next road's lanes are
    if (edge.median && !before && !past) {
      // A median, which this link draws, holds a body either side of it: neither road's lanes count within it, or within the body's
      // margin of it on the other's side, where it's held out to that margin on the other road. The two can overlap far more than
      // their gap says (it's 0 where they do), so the other's own lanes don't say where the median is
      const middle = edge.line + MEDIAN_HALF, away = middle + MEDIAN_HALF + margin * edge.flare;
      if (e <= away) {
        passedOver.push(edge.other);
        medians.push(y);
        claim = true;
      }
      if (e > middle) {
        if (e <= edge.reach) covers.push(y);
        if (e < away) {
          const px = fx + ox * away, pz = fz + oz * away, other = edge.other;
          add(other.kind ? other.sid : 0, heightOnLink(other, px, pz), away, { x: px, z: pz, by: away - e }, edge.opens, null);
        }
        continue;
      }
    }
    // Behind a nose, between the barrier and the road beside: nothing to stand on, and not the ground either
    const reach = edge.nose && Math.abs(s - edge.nose.s) <= FLARE ? Math.max(edge.reach, half + edge.nose.gap) : edge.reach;
    if (e > reach) continue;
    covers.push(y);
    // How far out the body's middle may be, and how far this link takes it: across the gap to the road beside, but not within the
    // body's margin of a nose
    let top = edge.line !== null ? (edge.median ? edge.line + MEDIAN_HALF : half) : edge.strip ? half + edge.gap + FILL_PAST : half;
    if (edge.stripNose && Math.abs(s - edge.stripNose.s) < margin + NOSE / 2) top = half;
    if (e <= Math.min(hold, top)) {
      // On its own road, or the deck across the gap to the next, straight across from one's height to the other's
      const level = e > half && edge.strip ? y + (heightOnLink(edge.strip, x, z) - y) * Math.min(1, (e - half) / Math.max(edge.gap, FILL_PAST)) : y;
      add(link.sid, level, e, null, edge.opens);
    } else if (e <= top) {
      const back = hold - 1e-4;
      add(link.sid, y, back, { x: fx + ox * back, z: fz + oz * back, by: e - back }, edge.opens);
    }
  }
  // One level of each structure, the nearest centre line's, and where it's held back only if nothing holds it there unhindered. In a
  // median's hold, at its level, only what the median says: not another of the structure's links at a joint or a bend
  for (const f of found) {
    if (passedOver.includes(f.from) || (!f.claim && found.some((c) => c.claim && Math.abs(c.y - f.y) < STEP))) continue;
    const known = levels.find((o) => o.sid === f.sid && Math.abs(o.y - f.y) < STEP);
    if (!known) levels.push({ sid: f.sid, y: f.y, d: f.d, push: f.push, joins: f.joins });
    else if ((known.push && !f.push) || (!known.push === !f.push && f.d < known.d)) Object.assign(known, { y: f.y, d: f.d, push: f.push, joins: f.joins });
  }
  return decksHere;
}

/**
 * Room between the ground and the underside of the lowest deck over (x, z), reaching `r` past the deck's edge: Infinity under
 * open sky. What stands on the ground has to fit in it: trees, street lights, signs, buildings (tools/tiles/derive.mjs).
 */
function roomUnderDeck(x, z, r = 0) {
  const ground = groundHeight(x, z);
  let room = Infinity;
  for (const s of structuresAt(x, z, -r)) {
    if (STRUCTURES[s.sid]?.kind !== KIND.BRIDGE || s.y <= ground + 0.5) continue; // a road at the ground's own height isn't over it
    room = Math.min(room, s.y - DECK_DEPTH - ground);
  }
  return room;
}

/** Whether (x, z) on surface `sid` is inside a tunnel, under its roof */
function inTunnel(sid, x, z) {
  if (!sid || STRUCTURES[sid]?.kind !== KIND.TUNNEL) return false;
  let best = null;
  for (const seg of segCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
    if (seg.link.sid !== sid || seg.link.kind !== KIND.TUNNEL) continue;
    const p = project(seg, x, z);
    if (p.d <= seg.link.half + 1 && (!best || p.d < best.d)) best = { d: p.d, seg, t: p.t };
  }
  return !!best && tunnelCovered(best.seg.link, best.seg.s0 + best.seg.len * best.t);
}

/** The underside of whatever is over a road at height y on surface `sid` at (x, z): a tunnel's ceiling or a deck above
 *  (Infinity under open sky) */
function ceilingOver(sid, y, x, z) {
  let top = inTunnel(sid, x, z) ? y + TUNNEL_HEIGHT : Infinity;
  // Not a ramp only a metre or two above this road, where the two part or join: that's beside you, not over you
  for (const s of structuresAt(x, z)) if (s.y > y + OVERHEAD) top = Math.min(top, s.y - DECK_DEPTH);
  return top;
}

/** Height at (x, z) on a road-network edge's own road: its own link of a structure, or its road on the ground */
function edgeHeight(edge, x, z) {
  const link = edge && linkById.get(edge.link);
  if (!link) return edge?.sid ? surfaceHeight(edge.sid, x, z) : groundHeight(x, z);
  if (link.profile) return shapedHeight(link, x, z); // every frame for every car: its own road alone, which roads overlapping it agree with
  if (!link.kind) return roadHeight(link, x, z);
  let best = null;
  for (const seg of segCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
    if (seg.link !== link) continue;
    const p = project(seg, x, z);
    if (!best || p.d < best.d) best = { d: p.d, y: seg.ay + (seg.by - seg.ay) * p.t };
  }
  if (best) return best.y;
  const near = nearestSegment(link, x, z);
  return near.ay + (near.by - near.ay) * near.t;
}

/** The height of surface `sid` (0: the ground) at (x, z). Where it's on two levels there (a ramp parting from a road), the
 *  one nearest height `near`, for something already on it; otherwise the one whose centre line is nearest. */
function surfaceHeight(sid, x, z, near = null) {
  if (!sid) return groundHeight(x, z);
  if (near !== null) {
    let best = null;
    for (const s of structuresAt(x, z)) {
      if (s.sid === sid && (best === null || Math.abs(s.y - near) < Math.abs(best - near))) best = s.y;
    }
    if (best !== null) return best;
  }
  const here = structureAt(sid, x, z, 40);
  if (here) return here.y;
  // Its road isn't held yet, or is gone: the level it was on, not the ground far below
  return near ?? groundHeight(x, z);
}

/** Rise per metre of surface `sid` at (x, z), heading along (sin, cos) */
function surfaceSlope(sid, x, z, sin, cos, near = null) {
  if (!sid) return terrainSlope(x, z, sin, cos);
  return (surfaceHeight(sid, x + sin * 2.5, z + cos * 2.5, near) - surfaceHeight(sid, x - sin * 2.5, z - cos * 2.5, near)) / 5;
}

// How far (x, z) is from the centre line of the nearest road on the ground, up to `limit`
function groundRoadDistance(x, z, limit = 30) {
  let best = limit;
  for (const seg of segCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
    if (seg.link.kind) continue;
    best = Math.min(best, segmentDistance(seg, x, z));
  }
  return best;
}

/**
 * The surface under (x, z) for something now at height `y` on surface `current`: the nearest road within STEP of that
 * height, the ground counting as a road where it's nearest. `margin` keeps a body's middle in from a structure's barriers
 * and walls (decksAt()). Returns { sid, y }, with { x, z } as well where a barrier holds the body back to there, or null
 * when every surface there is out of reach: the edge of a deck, a tunnel's wall.
 */
function chooseSurface(current, y, x, z, margin = 0) {
  const candidates = [];
  const consider = (sid, height, d, push = null, joins = 0) => {
    const gap = Math.abs(height - y);
    if (gap < STEP) candidates.push({ sid, y: height, d, gap, push, joins });
  };
  // On a structure the ground beside it is only a way off at its ends, where the two meet
  const { levels, covers, medians } = decksAt(x, z, margin);
  for (const s of levels) consider(s.sid, s.y, s.d, s.push, s.joins);
  // ...and on the ground, the road at this height, where another passes over it with nothing but its own surface. Past its
  // carriageway's edge only while the ground there is still at its level: where the ground beside it is another road's, at
  // another height (a cutting beside a deeper one, the Harbour Tunnel's approach beside the Cahill), its edge is a wall, or a
  // car held at its own road's height would be drawn under that other road. Not in a junction, where a turn's curve cuts
  // across the corner between two roads and a wall would stop it
  const road = groundRoadAt(x, z, y);
  // Not the ground under a deck as drawn, at the deck's level, but for a road on it: the gap between two roads drawn as one, a
  // deck's first metres off the road it carries on from. What's drawn there is the deck. Nor in a median, road or not
  if (!medians.some((my) => Math.abs(my - y) < STEP) && (road || !covers.some((cy) => Math.abs(cy - y) < SWITCH))) {
    const roadDistance = groundRoadDistance(x, z);
    const ground = groundHeight(x, z);
    consider(0, ground, roadDistance);
    if (road) {
      const own = roadHeight(road, x, z);
      if (Math.abs(ground - own) < STEP || linkDistance(road, x, z) <= road.width / 2 || inJunction(road, x, z)) consider(0, own, roadDistance);
    }
  }
  // A tunnel's walls hold: nothing moves sideways from one tunnel into another, even where the two run so close their roads touch.
  // Two tunnels never share a node, or they'd be one structure, so there's no way from one to the other but through a wall. Where
  // their roads are drawn as one, with no wall between, they're one road
  if (current && STRUCTURES[current]?.kind === KIND.TUNNEL) {
    for (let i = candidates.length - 1; i >= 0; i--) {
      const c = candidates[i];
      if (c.sid !== current && c.sid && STRUCTURES[c.sid]?.kind === KIND.TUNNEL && c.joins !== current) candidates.splice(i, 1);
    }
  }
  // Something only moves to another surface at about the same height, where a ramp joins a road. Passing close to a road a metre below
  // isn't a reason to drop onto it, while what it's on is still there.
  let pool = candidates.filter((c) => c.gap < SWITCH);
  // On a structure, it stays on as long as there's structure under it: it's the road ending that takes it off
  if (current && pool.some((c) => c.sid === current)) pool = pool.filter((c) => c.sid === current);
  if (!pool.length) {
    pool = candidates.filter((c) => c.sid === current);
    if (!pool.length) pool = candidates;
  }
  let best = null, bestRank = Infinity;
  for (const c of pool) {
    // The nearest to level first, then the nearest centre line, then the least held back. A near tie keeps you where you are.
    const rank = c.d + 3 * c.gap - (c.sid === current ? 0.75 : 0) + (c.push ? 3 * c.push.by : 0);
    if (rank < bestRank) { best = c; bestRank = rank; }
  }
  if (!best) return null;
  return best.push ? { sid: best.sid, y: best.y, x: best.push.x, z: best.push.z } : { sid: best.sid, y: best.y };
}

/**
 * A body at (fx, fz) on surface `sid` at height `y`, moved towards (tx, tz) with its middle kept `margin` in from what holds it:
 * where it ends, and on what. Held back to a barrier's line where it's pressed into one; where nothing is in reach (over a
 * deck's edge, into a tunnel's wall), stopped at the edge and slid along it as along a wall. { x, z, sid, y, held }. The
 * player's every step (js/controllers.js), and what the checks drive by.
 */
function moveOver(sid, y, fx, fz, tx, tz, margin = 0) {
  let here = chooseSurface(sid, y, tx, tz, margin), x = tx, z = tz;
  const held = !here || here.x !== undefined;
  if (!here) {
    // Along the wall where we know which way it runs, a structure's edge: keeping one axis of the move instead would cost a car
    // skimming a diagonal barrier most of its speed, every frame, and stop it dead for no reason it can see
    const along = sid ? structureAt(sid, fx, fz, 2)?.seg : null;
    const run = along ? (tx - fx) * along.ux + (tz - fz) * along.uz : 0;
    const sx = along ? fx + along.ux * run : 0, sz = along ? fz + along.uz * run : 0;
    if (along && (here = chooseSurface(sid, y, sx, sz, margin))) { x = sx; z = sz; }
    else if ((here = chooseSurface(sid, y, tx, fz, margin))) z = fz;
    else if ((here = chooseSurface(sid, y, fx, tz, margin))) x = fx;
    else { x = fx; z = fz; here = { sid, y }; }
  }
  if (here.x !== undefined) { x = here.x; z = here.z; }
  return { x, z, sid: here.sid, y: here.y, held };
}

/** Whether two things at heights ya and yb are on one level, so they can meet */
const sameLevel = (ya, yb) => Math.abs(ya - yb) < SAME_LEVEL;

/** Ground under (x, z) for something that flies or falls: the highest surface at or below height y */
function floorBelow(x, z, y) {
  let top = groundHeight(x, z);
  for (const s of structuresAt(x, z)) if (s.y <= y + 0.5 && s.y > top && STRUCTURES[s.sid].kind !== KIND.TUNNEL) top = s.y;
  return top;
}

/**
 * The way along the road graph through `waypoints` ({ x, z, name? }: each is the end of a link nearest it, of a road
 * by that name if given), keeping to one-way streets: points every `step` m with the height and surface there, and
 * whether it's inside a tunnel. For scripts that drive somewhere in particular; null if there's no way.
 */
function roadRoute(waypoints, step = 8) {
  const out = new Map();
  for (const l of LINKS) {
    if (l.dir >= 0) (out.get(l.a) || out.set(l.a, []).get(l.a)).push({ l, to: l.b, fwd: true });
    if (l.dir <= 0) (out.get(l.b) || out.set(l.b, []).get(l.b)).push({ l, to: l.a, fwd: false });
  }
  const lengthOf = (l) => l.pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - l.pts[i - 1].x, p.z - l.pts[i - 1].z) : 0), 0);
  const snap = ({ x, z, name }) => {
    let best = null;
    for (const l of LINKS) {
      if (name && l.name !== name) continue;
      for (const [n, p] of [[l.a, l.pts[0]], [l.b, l.pts[l.pts.length - 1]]]) {
        const d = Math.hypot(p.x - x, p.z - z);
        if (!best || d < best.d) best = { n, d };
      }
    }
    return best?.n;
  };
  // Shortest way from node `from` to node `to`, as [link, forwards] steps
  const between = (from, to) => {
    const dist = new Map([[from, 0]]), back = new Map(), heap = [[0, from]];
    while (heap.length) {
      let k = 0;
      for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[k][0]) k = i;
      const [d, n] = heap.splice(k, 1)[0];
      if (n === to) break;
      if (d > dist.get(n)) continue;
      for (const e of out.get(n) || []) {
        const nd = d + lengthOf(e.l);
        if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); back.set(e.to, e); heap.push([nd, e.to]); }
      }
    }
    if (from !== to && !back.has(to)) return null;
    const steps = [];
    for (let n = to; n !== from; n = back.get(n).fwd ? back.get(n).l.a : back.get(n).l.b) steps.unshift(back.get(n));
    return steps;
  };
  const nodes = waypoints.map(snap);
  const steps = [];
  for (let i = 1; i < nodes.length; i++) {
    const leg = between(nodes[i - 1], nodes[i]);
    if (!leg) return null;
    steps.push(...leg);
  }
  const points = [];
  let carry = 0;
  for (const { l, fwd } of steps) {
    const pts = fwd ? l.pts : [...l.pts].reverse();
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i], L = Math.hypot(q.x - p.x, q.z - p.z);
      for (let s = carry; s < L; s += step) {
        const t = s / L, x = p.x + (q.x - p.x) * t, z = p.z + (q.z - p.z) * t;
        const y = l.kind ? p.y + (q.y - p.y) * t : roadHeight(l, x, z);
        points.push({ x, z, y, sid: l.sid, name: l.name, link: l.id, tunnel: inTunnel(l.sid, x, z), twoWay: l.dir === 0 });
      }
      carry = (carry - L) % step;
      if (carry < 0) carry += step;
    }
  }
  return points;
}

export {
  setFloor, clearFloor, onFloor, decksAt, DECK_DEPTH, DECK_HALF, DECK_STRUCTURE, KIND, LINKS, PORTALS, ROAD_CLASS, ROAD_CLASSES, deriveTunnels, linkById, roadClass, SAME_LEVEL, SEGMENTS, STATION_STEP, STEP, STRUCTURES, TUNNEL_COVER, TUNNEL_HEIGHT, ceilingOver, chooseSurface,
  clearOfWater, EDGE_GAP, edgeHeight, edgeNeighbour, floorBelow, laneAt, linkEdges, linkStations, moveOver, offsetLine, groundHeight, groundRoadAt, groundRoadDistance, inTunnel, onGroundRoad, ownLaneOffsets, roadHeight, roadRoute, roomUnderDeck, sameLevel,
  structureAt, structuresAt, surfaceHeight, surfaceSlope, tunnelCovered
};
