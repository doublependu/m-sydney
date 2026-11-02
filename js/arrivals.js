import { blockAt, landAt } from './city-config.js';
import { BRIDGE_LENGTH, DECK_SID, bridgeAt, bridgePoint } from './bridge.js';
import { onMap } from './geodata.js';
import { KIND, LINKS, floorBelow, groundHeight, roadHeight, structureAt, structuresAt } from './surfaces.js';

// Where a new travel mode starts from where the last one left off: walkers on the nearest footpath, drivers in the
// nearest lane, riders on whichever is nearer, flyers straight up above the buildings around. "Nearest" means on the
// level you're on: getting out on a bridge doesn't drop you off it.

// Surrounding buildings are the roofs within AREA. A helicopter arrives above most of them (the 90th percentile), clear
// of anything right beside it, and never lower than OVER_GROUND. All heights in metres.
const FLY = { AREA: 200, CLOSE: 40, OVER_ROOFS: 30, OVER_GROUND: 60, OVER_CLOSE: 15, MAX: 380 };
// The top of the Harbour Bridge's arch, which is scenery rather than a collider, and how close to its line it counts
const ARCH_CLEAR = 150, ARCH_REACH = 45;

// The Harbour Bridge's footway: metres to the east of its centre line, and how far from each end of the corridor it runs
const FOOTWAY = { MIN: 13.2, MAX: 16.2, MIDDLE: 14.7, END: 70 };

const LANE_LEVEL = 4; // m: how far above or below your level a road can be and still count as on it
const LEVEL_COST = 3; // m of distance a metre of height counts as, when choosing between roads on nearby levels
const SEARCH = 3000; // m: the furthest anyone is taken

const SHORE = 2.5; // js/controllers.js keeps everyone this far from the water
const clearOfWater = (x, z) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].every(([u, v]) => landAt(x + u * SHORE, z + v * SHORE));

/** Could someone walk here: on a kerbed island of footpath or park, not a traffic island, not in the water? */
function walkable(x, z) {
  const block = blockAt(x, z);
  return !!block && !block.median && clearOfWater(x, z);
}

/** The nearest footpath to (x, z), rings outward. `isClear(x, z)`: nothing in the way. { x, z, d } or null */
function nearestFootpath(x, z, isClear = () => true, limit = SEARCH) {
  if (walkable(x, z) && isClear(x, z)) return { x, z, d: 0 };
  for (let r = 1.5; r <= limit; r += Math.max(1.5, r * 0.08)) {
    const points = Math.max(12, Math.min(64, Math.ceil((r * Math.PI * 2) / 3)));
    let best = null;
    for (let i = 0; i < points; i++) {
      const a = (i / points) * Math.PI * 2;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (walkable(px, pz) && isClear(px, pz)) { best = { x: px, z: pz, d: r }; break; }
    }
    if (best) return best;
  }
  return null;
}

// Segments of every road, in 64 m cells
const CELL = 64;
let laneCells = null;
onMap({ addLink() { laneCells = null; }, removeLink() { laneCells = null; } });
function index() {
  if (laneCells) return;
  laneCells = new Map();
  for (const link of LINKS) {
    for (let i = 1; i < link.pts.length; i++) {
      const p = link.pts[i - 1], q = link.pts[i];
      const L = Math.hypot(q.x - p.x, q.z - p.z);
      if (L < 0.5) continue;
      const seg = { link, p, q, L, ux: (q.x - p.x) / L, uz: (q.z - p.z) / L };
      const steps = Math.ceil(L / CELL) + 1, seen = new Set();
      for (let k = 0; k <= steps; k++) {
        const cx = Math.floor((p.x + ((q.x - p.x) * k) / steps) / CELL), cz = Math.floor((p.z + ((q.z - p.z) * k) / steps) / CELL);
        const key = cx * 100000 + cz;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!laneCells.has(key)) laneCells.set(key, []);
        laneCells.get(key).push(seg);
      }
    }
  }
}

// How far left of the centre line the lane to be in is, travelling along a road. Traffic keeps left here.
function laneOffset(link) {
  if (link.deck) return 5.4;
  if (link.dir !== 0) return 0;
  return Math.min(link.width / 4, Math.max(1.8, link.width / 2 - 1.6));
}

/**
 * The nearest lane to (x, z) on the level `y`, heading whichever way that road allows that's nearest `heading`. A road on
 * another level is left alone, and a tunnel is only for someone in it. `isClear(x, z)`: nothing there, traffic included.
 * { x, z, heading, surface, d } or null.
 */
function nearestLane(x, z, heading, y, surface = 0, isClear = () => true, limit = SEARCH) {
  index();
  const candidates = [];
  const seen = new Set();
  const inTunnelNow = surface && LINKS.some((l) => l.sid === surface && l.kind === KIND.TUNNEL);
  const hx = Math.sin(heading), hz = Math.cos(heading);
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  for (let ring = 0; ring * CELL <= limit; ring++) {
    for (let i = -ring; i <= ring; i++) {
      for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        for (const seg of laneCells.get((cx + i) * 100000 + cz + j) || []) {
          if (seen.has(seg)) continue;
          seen.add(seg);
          const { link, p, ux, uz, L } = seg;
          if (link.kind === KIND.TUNNEL && !(inTunnelNow && link.sid === surface)) continue;
          const t = Math.max(0, Math.min(L, (x - p.x) * ux + (z - p.z) * uz));
          const px = p.x + ux * t, pz = p.z + uz * t;
          const height = link.kind ? p.y + ((seg.q.y - p.y) * t) / L : roadHeight(link, px, pz);
          const off = Math.abs(height - y);
          if (off > LANE_LEVEL && (link.kind || surface)) continue;
          candidates.push({ seg, t, d: Math.hypot(px - x, pz - z), score: Math.hypot(px - x, pz - z) + off * LEVEL_COST });
        }
      }
    }
    // Nothing further out can beat what's here
    if (candidates.length) {
      const best = Math.min(...candidates.map((c) => c.score));
      if (best + CELL < ring * CELL) break;
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  for (const { seg, t, d } of candidates.slice(0, 24)) {
    const { link, ux, uz, L, p } = seg;
    const forward = link.dir > 0 || (link.dir === 0 && ux * hx + uz * hz >= 0);
    const fx = forward ? ux : -ux, fz = forward ? uz : -uz;
    const off = laneOffset(link);
    // Along the road a little, if something's in the way
    for (let s = 0; s <= 40; s += 8) {
      const along = t + (forward ? s : -s);
      if (along < 0 || along > L) break;
      // Left of travel is (fz, -fx)
      const lx = p.x + ux * along + fz * off, lz = p.z + uz * along - fx * off;
      if (!link.kind && !clearOfWater(lx, lz)) continue;
      if (isClear(lx, lz)) return { x: lx, z: lz, heading: Math.atan2(fx, fz), surface: link.sid, d };
    }
  }
  return null;
}

/** The height to fly at over (x, z), above the ground there. `roofs`: [{ top (above sea level), away (m) }] */
function flyingHeight(roofs, ground, least = 0) {
  const around = roofs.filter((r) => r.away <= FLY.AREA).map((r) => r.top).sort((a, b) => a - b);
  const most = around.length ? around[Math.min(around.length - 1, Math.floor(around.length * 0.9))] : -Infinity;
  const close = Math.max(-Infinity, ...roofs.filter((r) => r.away <= FLY.CLOSE).map((r) => r.top));
  const target = Math.max(most + FLY.OVER_ROOFS, ground + FLY.OVER_GROUND, close + FLY.OVER_CLOSE, least);
  return Math.min(target - ground, FLY.MAX);
}

/** The least height to fly at over (x, z) for the sake of what isn't a collider: the Harbour Bridge's arch */
function archClearance(x, z) {
  return bridgeAt(x, z, ARCH_REACH) ? ARCH_CLEAR : 0;
}

/** Where to stand on the Harbour Bridge's footway from (x, z), or null where the corridor has none */
function footwayNear(x, z) {
  const here = bridgeAt(x, z, 20);
  if (!here || here.s < FOOTWAY.END || here.s > BRIDGE_LENGTH - FOOTWAY.END) return null;
  const p = bridgePoint(here.s);
  return { x: p.x - p.uz * FOOTWAY.MIDDLE, z: p.z + p.ux * FOOTWAY.MIDDLE, surface: DECK_SID };
}

/** Holds a walker on the footway: where they end up from (x, z), or null if they've reached its end */
function holdOnFootway(x, z) {
  const here = bridgeAt(x, z, 20);
  if (!here || here.s < FOOTWAY.END || here.s > BRIDGE_LENGTH - FOOTWAY.END) return null;
  const p = bridgePoint(here.s);
  const off = Math.max(FOOTWAY.MIN, Math.min(FOOTWAY.MAX, here.off));
  return { x: p.x - p.uz * off, z: p.z + p.ux * off, y: here.y };
}

/** On structure `sid`: the edge of the road nearest (x, z), to stand clear of its traffic */
function roadEdge(sid, x, z) {
  const here = structureAt(sid, x, z, 40);
  if (!here) return null;
  const { seg, link, px, pz } = here;
  const side = (x - px) * -seg.uz + (z - pz) * seg.ux >= 0 ? 1 : -1;
  const out = Math.max(0, link.half - 1.2);
  return { x: px - seg.uz * side * out, z: pz + seg.ux * side * out, surface: sid };
}

/**
 * Where a mode starts from a place: { x, z, heading, surface, altitude?, footway? }, or null to stay put.
 * from: { x, z, heading, y (height above sea level), surface (0 on the ground), flying }.
 * world: { isClear(x, z), roofs(x, z) }. The mode's isClear accounts for what its body needs.
 */
function arrivalFor(mode, from, world) {
  const { x, z, heading } = from;
  const ground = groundHeight(x, z);
  if (mode === 'helicopter') {
    return { x, z, heading, surface: 0, altitude: flyingHeight(world.roofs(x, z), ground, archClearance(x, z)) };
  }
  // Out of the air, onto whatever's underneath: never into a tunnel, and the deck rather than the road under it
  const level = from.flying ? floorBelow(x, z, from.y) : from.y;
  const levelSurface = from.flying
    ? (structuresAt(x, z).find((st) => Math.abs(st.y - level) < 0.5)?.sid ?? 0)
    : from.surface;
  const onDeck = levelSurface === DECK_SID && DECK_SID !== 0;
  if (mode === 'car') {
    const lane = nearestLane(x, z, heading, level, levelSurface, world.isClear);
    return lane && { x: lane.x, z: lane.z, heading: lane.heading, surface: lane.surface };
  }
  if (mode === 'person' && levelSurface) {
    const footway = onDeck ? footwayNear(x, z) : null;
    if (footway) return { ...footway, heading, footway: true };
    const edge = roadEdge(levelSurface, x, z);
    if (edge) return { ...edge, heading };
  }
  if (mode === 'cyclist' && levelSurface) {
    const lane = nearestLane(x, z, heading, level, levelSurface, world.isClear);
    return lane && { x: lane.x, z: lane.z, heading: lane.heading, surface: lane.surface };
  }
  const path = nearestFootpath(x, z, world.isClear);
  if (mode === 'person') return path && { x: path.x, z: path.z, heading, surface: 0 };
  // A rider takes whichever is nearer. Already on one, stay there.
  const lane = !path || path.d > 0 ? nearestLane(x, z, heading, level, 0, world.isClear, path ? Math.max(CELL, path.d * 1.5) : SEARCH) : null;
  if (lane && (!path || lane.d <= path.d)) return { x: lane.x, z: lane.z, heading: lane.heading, surface: lane.surface };
  return path && { x: path.x, z: path.z, heading, surface: 0 };
}

export { FLY, FOOTWAY, arrivalFor, flyingHeight, footwayNear, holdOnFootway, nearestFootpath, nearestLane, roadEdge, walkable };
