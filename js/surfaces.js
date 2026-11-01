import { GEO } from './geodata.js';
import { terrainHeight, terrainSlope } from './terrain.js';
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
const SAME_LEVEL = 3; // m: vehicles nearer than this in height are on one level and can meet
const DECK_HALF = 12.5; // m either side of the Harbour Bridge's centre line that cars can use (js/bridge.js)
const LOW_DECK = 3; // m: a structure lower than this over the ground lowers the ground under it, so it can't show through
const TUNNEL_COVER = 6.3; // m: a tunnel with less ground than this over its road is an open cutting (js/structures.js)
const TUNNEL_HEIGHT = 5.6; // m from a tunnel's road up to its ceiling
const DECK_DEPTH = 1.4; // m from a deck's road down to its soffit
const OVERHEAD = 4; // m: a deck less than this above a road isn't over it
const CELL = 32;

const RG = GEO.roadGraph;
const N = RG.nodes;

// --- Links with their heights --------------------------------------------------------------------------------------
const LINKS = RG.links.map((l, id) => {
  const [a, b, ni, width, lanes, dir, inner, major, deck, kind = 0, layer = 0, flags = 0, ys = null] = l;
  const pts = [{ x: N[a * 2], z: N[a * 2 + 1] }];
  for (let k = 0; k < inner.length; k += 2) pts.push({ x: inner[k], z: inner[k + 1] });
  pts.push({ x: N[b * 2], z: N[b * 2 + 1] });
  if (kind && ys && ys.length === pts.length) pts.forEach((p, i) => { p.y = ys[i]; });
  else for (const p of pts) p.y = NaN; // on the ground: groundHeight() there
  // A street sunk into a cutting is on the ground (the ground follows it down), with heights of its own
  const cut = kind === KIND.CUTTING && !!ys;
  return {
    id, a, b, name: RG.names[ni], width, lanes, dir, major: !!major, deck: !!deck, kind: cut ? KIND.GROUND : kind && ys ? kind : 0,
    cut, layer, motorway: !!(flags & 1), pts, sid: 0, half: deck ? DECK_HALF : width / 2 + 0.6
  };
});

// Structures: links off the ground, joined where they share a node
const STRUCTURES = [null];
{
  const parent = new Map();
  const find = (n) => {
    let r = n;
    while (parent.get(r) !== r) r = parent.get(r);
    return r;
  };
  for (const l of LINKS) if (l.kind) { if (!parent.has(l.a)) parent.set(l.a, l.a); if (!parent.has(l.b)) parent.set(l.b, l.b); }
  for (const l of LINKS) if (l.kind) parent.set(find(l.a), find(l.b));
  const ids = new Map();
  for (const l of LINKS) {
    if (!l.kind) continue;
    const root = find(l.a);
    if (!ids.has(root)) {
      ids.set(root, STRUCTURES.length);
      STRUCTURES.push({ id: STRUCTURES.length, links: [], kind: l.kind, deck: false, motorway: false });
    }
    const s = STRUCTURES[ids.get(root)];
    l.sid = s.id;
    s.links.push(l);
    s.deck ||= l.deck;
    s.motorway ||= l.motorway;
    if (l.kind === KIND.TUNNEL) s.kind = KIND.TUNNEL;
  }
}

const DECK_STRUCTURE = LINKS.find((l) => l.deck)?.sid ?? 0; // the Harbour Bridge's

// --- Spatial index of every link segment ---------------------------------------------------------------------------
const segCells = new Map();
const lowCells = new Map(); // segments of structures low over the ground
const cutCells = new Map(); // segments of streets sunk into cuttings
const SEGMENTS = [];
let onCutRoad = false; // set by cutGround()
const addToCells = (cells, seg, pad) => {
  for (let ix = Math.floor((Math.min(seg.ax, seg.bx) - pad) / CELL); ix <= Math.floor((Math.max(seg.ax, seg.bx) + pad) / CELL); ix++) {
    for (let iz = Math.floor((Math.min(seg.az, seg.bz) - pad) / CELL); iz <= Math.floor((Math.max(seg.az, seg.bz) + pad) / CELL); iz++) {
      const k = ix * 100000 + iz;
      let list = cells.get(k);
      if (!list) cells.set(k, (list = []));
      list.push(seg);
    }
  }
};
for (const l of LINKS) {
  let s0 = 0;
  for (let i = 1; i < l.pts.length; i++) {
    const p = l.pts[i - 1], q = l.pts[i];
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len < 1e-6) continue;
    const seg = { link: l, ax: p.x, az: p.z, ay: p.y, bx: q.x, bz: q.z, by: q.y, len, ux: (q.x - p.x) / len, uz: (q.z - p.z) / len, s0 };
    SEGMENTS.push(seg);
    addToCells(segCells, seg, l.half + 2);
    if (l.cut) addToCells(cutCells, seg, l.half + 1 + CUT_SLOPE);
    // Where the ground would show through a low deck, or close over a tunnel's cutting, it's lowered (groundHeight)
    if (l.kind === KIND.BRIDGE && Math.min(p.y - terrainHeight(p.x, p.z), q.y - terrainHeight(q.x, q.z)) < LOW_DECK) addToCells(lowCells, seg, l.half + 1);
    s0 += len;
  }
}

// --- Tunnels ---------------------------------------------------------------------------------------------------------
// Open at an end where it reaches the surface, for as long as the ground hasn't closed over it, and a tube everywhere
// else. Never open in the middle: a street's cutting that passes over a deeper tunnel leaves that tunnel less cover, not
// a hole in the street. A link wholly open passes the opening on to the links after it.
{
  const linksAt = new Map();
  for (const l of LINKS) for (const n of [l.a, l.b]) (linksAt.get(n) || linksAt.set(n, []).get(n)).push(l);
  const lengthOf = (l) => l.pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - l.pts[i - 1].x, p.z - l.pts[i - 1].z) : 0), 0);
  // Metres open from one end of a link: till the ground closes over it
  const openFrom = (l, fromA) => {
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
  // Nodes where a tunnel can come to the surface: it stops being a tunnel there
  const mouths = [];
  for (const l of tunnels) {
    l.length = lengthOf(l);
    l.openA = 0;
    l.openB = 0;
    for (const n of [l.a, l.b]) {
      const others = linksAt.get(n).filter((o) => o !== l);
      if (!others.length || others.some((o) => o.kind !== KIND.TUNNEL)) mouths.push(n);
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
      const open = openFrom(l, fromA);
      if (fromA) l.openA = Math.min(open, l.length);
      else l.openB = Math.min(open, l.length);
      if (open === Infinity) mouths.push(fromA ? l.b : l.a);
    }
  }
  // A roof a few metres long is no tunnel
  for (const l of tunnels) if (l.openA && l.openB && l.length - l.openA - l.openB < 5) l.openA = l.length;
  for (const seg of SEGMENTS) {
    const l = seg.link;
    if (l.kind === KIND.TUNNEL && (seg.s0 < l.openA || seg.s0 + seg.len > l.length - l.openB)) addToCells(lowCells, seg, l.half + 1);
  }
}

/** Whether a tunnel link is under cover `s` metres along it */
function tunnelCovered(link, s) {
  return s >= link.openA && s <= link.length - link.openB;
}

// Tunnel mouths: where each tunnel's cutting closes over, facing into the tunnel, with the length of open cutting outside
// it and how the road climbs along that. The ground is a lattice, which can't step from the cutting's floor up to the
// ground over the tube in no distance: its slope would close the mouth, so the ground's materials leave out what falls
// inside one (js/tunnel-mouths.js)
const PORTALS = [];
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
        PORTALS.push({
          x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t, y, ux: (q.x - p.x) / L, uz: (q.z - p.z) / L,
          half: l.half + 0.3, open, rise: (y - pts[0].y) / open
        });
        break;
      }
      s += L;
    }
  }
}

// Where (x, z) falls on a segment: the distance along it (t, 0-1), across it (off, to the right of travel) and from it
function project(seg, x, z) {
  const t = Math.max(0, Math.min(1, ((x - seg.ax) * seg.ux + (z - seg.az) * seg.uz) / seg.len));
  const px = seg.ax + seg.ux * seg.len * t, pz = seg.az + seg.uz * seg.len * t;
  const off = -(x - px) * seg.uz + (z - pz) * seg.ux;
  return { t, px, pz, off, d: Math.hypot(x - px, z - pz) };
}

// Ground roads under (x, z): whether it's on one's carriageway
function onGroundRoad(x, z) {
  for (const seg of segCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
    if (seg.link.kind) continue;
    if (project(seg, x, z).d < seg.link.width / 2 + 0.6) return true;
  }
  return false;
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
      // A cutting's road runs a metre past its carriageway, so the kerbs along it stand in it, not on its slope
      const reach = seg.link.half + (seg.link.cut ? 1 : 0);
      if (p.d <= reach && (!on || p.d < on.d)) on = { d: p.d, seg, t: p.t };
    }
    const joins = (a, b) => a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b;
    if (on?.seg.link.cut) {
      // ...unless a street that doesn't meet it crosses over this spot: that street is the top of the cutting's portal, and
      // the ground here is the street. One alongside only overlaps it, and the nearer centre line says which you're on.
      const over = (segCells.get(key) || []).some((seg) => {
        if (seg.link.kind || seg.link.cut || joins(seg.link, on.seg.link)) return false;
        const d = project(seg, x, z).d;
        if (d > seg.link.width / 2 + 0.6) return false;
        return Math.abs(seg.ux * on.seg.ux + seg.uz * on.seg.uz) < 0.87 || d < on.d;
      });
      if (over) return y;
      onCutRoad = true;
      return Math.min(y, on.seg.ay + (on.seg.by - on.seg.ay) * on.t);
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

/** The ground's height at (x, z): the terrain, lowered under a structure's end where it would otherwise show through */
function groundHeight(x, z) {
  const y = cutGround(x, z);
  if (onCutRoad) return y;
  const list = lowCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL));
  if (!list) return y;
  let low = Infinity;
  for (const seg of list) {
    const p = project(seg, x, z);
    if (p.d > seg.link.half + 1) continue;
    const road = seg.ay + (seg.by - seg.ay) * p.t;
    // Under a deck only where it's low; over a tunnel only where it's still a cutting
    if (seg.link.kind === KIND.TUNNEL ? tunnelCovered(seg.link, seg.s0 + seg.len * p.t) : road - y >= LOW_DECK) continue;
    low = Math.min(low, road - 0.45);
  }
  if (low < y && !onGroundRoad(x, z)) return low;
  return y;
}

/**
 * The surface of one road on the ground at (x, z): a cutting's own profile, or the ground, following any cutting it meets
 * at a junction down. Roads side by side at different heights (a street along the edge of a freeway's cutting) each
 * keep their own, where groundHeight() has to pick one.
 */
function roadHeight(link, x, z) {
  const ground = terrainHeight(x, z);
  if (link.cut) {
    const seg = nearestSegment(link, x, z);
    return Math.min(ground, seg.ay + (seg.by - seg.ay) * seg.t);
  }
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

/** The road on the ground whose carriageway (x, z) is on, its centre line nearest; null off the roads */
function groundRoadAt(x, z) {
  let best = null, bd = Infinity;
  for (const seg of segCells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
    if (seg.link.kind) continue;
    const d = project(seg, x, z).d;
    if (d <= seg.link.half && d < bd) { bd = d; best = seg.link; }
  }
  return best;
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
      onDeck ??= segs.some((other) => other.link.deck && project(other, x, z).d <= DECK_HALF - margin);
      if (onDeck) continue;
    }
    const y = seg.ay + (seg.by - seg.ay) * p.t;
    const known = out.find((o) => o.sid === seg.link.sid && Math.abs(o.y - y) < STEP);
    if (!known) out.push({ sid: seg.link.sid, y, d: p.d });
    else if (p.d < known.d) Object.assign(known, { y, d: p.d });
  }
  return out;
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
  const link = edge && LINKS[edge.link];
  if (!link) return edge?.sid ? surfaceHeight(edge.sid, x, z) : groundHeight(x, z);
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
  return here ? here.y : groundHeight(x, z);
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
    best = Math.min(best, project(seg, x, z).d);
  }
  return best;
}

/**
 * The surface under (x, z) for something now at height `y` on surface `current`: the nearest road within STEP of that
 * height, the ground counting as a road where it's nearest. `margin` keeps a body's edge on a structure. Returns
 * { sid, y } or null when every surface there is out of reach: the edge of a deck, a tunnel's wall.
 */
function chooseSurface(current, y, x, z, margin = 0) {
  let best = null;
  const g = groundHeight(x, z);
  const consider = (sid, height, d) => {
    if (Math.abs(height - y) >= STEP) return;
    // The nearest centre line, and the nearest to level. A near tie keeps you where you are.
    const rank = d + Math.abs(height - y) - (sid === current ? 0.75 : 0);
    if (!best || rank < best.rank) best = { sid, y: height, rank };
  };
  // On a structure the ground beside it is only a way off at its ends, where the two meet
  for (const s of structuresAt(x, z, margin)) consider(s.sid, s.y, s.d);
  consider(0, g, groundRoadDistance(x, z));
  return best && { sid: best.sid, y: best.y };
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
  DECK_DEPTH, DECK_HALF, KIND, LINKS, PORTALS, SAME_LEVEL, SEGMENTS, STEP, STRUCTURES, TUNNEL_COVER, TUNNEL_HEIGHT, ceilingOver, chooseSurface,
  edgeHeight, floorBelow, groundHeight, groundRoadAt, groundRoadDistance, inTunnel, onGroundRoad, roadHeight, roadRoute, sameLevel,
  structureAt, structuresAt, surfaceHeight, surfaceSlope, tunnelCovered
};
