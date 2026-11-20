import { onMap } from './geodata.js';
import { onGroundRoad } from './surfaces.js';

// Still water on land, and who it holds back: a garden's ponds, its ponds edged with rocks and its fountains' basins (tile.garden), and the
// lakes outside the gardens (tile.lakes), all drawn by js/garden.js. The land raster has every one of them as land, so the sea's rule
// (js/surfaces.js clearOfWater()) never sees them. Here they're rings again, from each tile's data as it's held, before its garden is
// built (that waits for its neighbours), so a teleport to a pond's shore is held there at once. Walker, bike and car stop at the shore
// (js/controllers.js) and arrive out of the water (js/arrivals.js), each tested by its body, not just its middle.

// Each body along its heading: half its middle line, and its round. The walker's 0.3 m puts its feet at the water's edge, on the outer
// half of a pond's coping (0.32 m, astride it) or the land's half of a lake's bank (0.6 m); its 0.48 for buildings would leave it a step
// short of a coping it could stand on. The bike's ends at its tyres (axles 0.58 m from its middle, tyres 0.39 round), the car's at its box
// (0.86 by 2.18 m, js/controllers.js collisionBody())
const BODIES = { person: [0, 0.3], cyclist: [0.72, 0.25], car: [1.32, 0.86] };
// A fountain's granite rim straddles its basin's edge, 0.55 m wide (js/garden.js FOUNTAIN.rimWidth): a body is held at its outer face,
// so no foot, tyre or bumper goes into the stone
const RIM = 0.275;
const BIG = 64; // m: the cells the pieces are kept in
const CELL = 8; // m: the cells the garden paths' segments are kept in
const EDGE = 4; // m: the cells a piece's edges are kept in, so a body is measured against the shore near it, not all of a lake's
const REACH = 2; // m past a body's round that how far it's in the water is measured: deeper counts as that deep
const STEP = 0.25; // m between the points along a body's middle line where how far in is measured
// m past a path's width: a body touching the water has its middle within 2.5 m of it (the car's half length and round, and a rim), so a
// path's segment no nearer any water's box than this is never on dry ground that matters
const PATH_NEAR = 3;

// BIG cell -> [piece]: { kind, margin, x0, x1, z0, z1, tile, rings (flat [x, z, ...] each, the outer first) }. A piece's edges are indexed
// the first time a body comes near it (indexEdges()), not as its tile comes in: most never are
const pieceCells = new Map();
const pieceKeysOf = new Map(); // tile key -> the BIG cells it put pieces in
// The tiles' garden paths, { paths ([kind, surface, width, x, z, ...] each), x0, z0, x1, z1 (their box, widths included), indexed }. A
// garden tile has hundreds, nearly all far from any water: a tile's are put into pathCells the first time dry ground is asked for within
// their box, and only their segments near water. Any water or paths coming or going starts that over (forgetPaths())
const pathsOf = new Map();
const pathCells = new Map(); // CELL cell -> [{ ax, az, bx, bz, half }]
let stamp = 0; // a piece is looked at once per question, though it's in several cells

const cellKey = (ix, iz) => ix * 100000 + iz;

function put(cells, size, x0, z0, x1, z1, item, keys = null) {
  for (let ix = Math.floor(x0 / size); ix <= Math.floor(x1 / size); ix++) {
    for (let iz = Math.floor(z0 / size); iz <= Math.floor(z1 / size); iz++) {
      const key = cellKey(ix, iz);
      let list = cells.get(key);
      if (!list) cells.set(key, (list = []));
      list.push(item);
      keys?.add(key);
    }
  }
}

/** Whether (x, z) is inside a flat ring [x, z, ...] */
function insideRing(r, x, z) {
  let c = false;
  for (let i = 0, j = r.length - 2; i + 1 < r.length; j = i, i += 2) {
    const zi = r[i + 1], zj = r[j + 1];
    if ((zi > z) !== (zj > z) && x < r[j] + ((z - zj) * (r[i] - r[j])) / (zi - zj)) c = !c;
  }
  return c;
}

// In a piece's water: inside its outer ring and none of its holes (its islands), by crossings over them all, of the edges level with it
function inside(p, x, z) {
  const E = p.edges ?? indexEdges(p);
  let c = false;
  for (const k of p.rows.get(Math.floor(z)) || []) {
    const az = E[k + 1], bz = E[k + 3];
    if ((az > z) !== (bz > z) && x < E[k] + ((z - az) * (E[k + 2] - E[k])) / (bz - az)) c = !c;
  }
  return c;
}

function pointSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L)) : 0;
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}

// The distance between two segments: 0 where they cross
function segSeg(ax, az, bx, bz, cx, cz, dx, dz) {
  const side = (px, pz, qx, qz, rx, rz) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  if (side(cx, cz, dx, dz, ax, az) * side(cx, cz, dx, dz, bx, bz) < 0 && side(ax, az, bx, bz, cx, cz) * side(ax, az, bx, bz, dx, dz) < 0) return 0;
  return Math.min(pointSeg(ax, az, cx, cz, dx, dz), pointSeg(bx, bz, cx, cz, dx, dz), pointSeg(cx, cz, ax, az, bx, bz), pointSeg(dx, dz, ax, az, bx, bz));
}

const near = []; // edgesNear()'s answer, used before the next question
let edgeStamp = 0;

// The edges of a piece's shore whose boxes come within `reach` of a segment's, each once, as its place in p.edges
function edgesNear(p, ax, az, bx, bz, reach) {
  near.length = 0;
  const seen = ++edgeStamp;
  for (let ix = Math.floor((Math.min(ax, bx) - reach) / EDGE); ix <= Math.floor((Math.max(ax, bx) + reach) / EDGE); ix++) {
    for (let iz = Math.floor((Math.min(az, bz) - reach) / EDGE); iz <= Math.floor((Math.max(az, bz) + reach) / EDGE); iz++) {
      for (const k of p.cells.get(cellKey(ix, iz)) || []) {
        if (p.seen[k >> 2] === seen) continue;
        p.seen[k >> 2] = seen;
        near.push(k);
      }
    }
  }
  return near;
}

// How near a segment comes to a piece's shore (its rings' edges), or `reach` where none is nearer than that
function shoreDistance(p, ax, az, bx, bz, reach) {
  const E = p.edges ?? indexEdges(p);
  let d = reach;
  for (const k of edgesNear(p, ax, az, bx, bz, reach)) {
    d = Math.min(d, segSeg(ax, az, bx, bz, E[k], E[k + 1], E[k + 2], E[k + 3]));
    if (d === 0) break;
  }
  return d;
}

// A tile's still water, as pieces: a pond with its islands as holes (js/garden.js islandsIn(): an island whose first point is in it), a
// fountain's basin (fountainOf(): a pond whose points' middle is within a fountain's reach of it) with its rim, a pond edged with rocks,
// and each piece of a lake (cut to the lawns' 240 m squares: a body over a seam is over one piece or the next)
function piecesOf(tile) {
  const out = [];
  const g = tile.garden;
  if (g) {
    const islands = (g.islands ?? []).filter((r) => r.length >= 6);
    const holesIn = (r) => islands.filter((h) => insideRing(r, h[0], h[1]));
    const fountainOf = (r) => {
      let mx = 0, mz = 0;
      for (let i = 0; i + 1 < r.length; i += 2) { mx += r[i]; mz += r[i + 1]; }
      mx /= r.length / 2;
      mz /= r.length / 2;
      return (g.fountains ?? []).some(([x, z, reach]) => Math.hypot(x - mx, z - mz) < reach);
    };
    for (const r of g.ponds ?? []) {
      if (r.length < 6) continue;
      if (fountainOf(r)) out.push({ kind: 'fountain', margin: RIM, rings: [r] });
      else out.push({ kind: 'pond', margin: 0, rings: [r, ...holesIn(r)] });
    }
    for (const r of g.rockPonds ?? []) if (r.length >= 6) out.push({ kind: 'rock', margin: 0, rings: [r, ...holesIn(r)] });
  }
  for (const [, ...flats] of tile.lakes ?? []) if (flats[0]?.length >= 6) out.push({ kind: 'lake', margin: 0, rings: flats });
  for (const p of out) {
    p.tile = tile.key;
    p.x0 = p.z0 = Infinity;
    p.x1 = p.z1 = -Infinity;
    const r = p.rings[0];
    for (let i = 0; i + 1 < r.length; i += 2) {
      p.x0 = Math.min(p.x0, r[i]);
      p.x1 = Math.max(p.x1, r[i]);
      p.z0 = Math.min(p.z0, r[i + 1]);
      p.z1 = Math.max(p.z1, r[i + 1]);
    }
  }
  return out;
}

// A piece's edges, flat [ax, az, bx, bz, ...] over all its rings, indexed the first time a body comes near it: by the metre-high row
// they reach (inside()) and by the EDGE cells their boxes touch (edgesNear())
function indexEdges(p) {
  const edges = [];
  for (const g of p.rings) {
    for (let i = 0, j = g.length - 2; i + 1 < g.length; j = i, i += 2) edges.push(g[j], g[j + 1], g[i], g[i + 1]);
  }
  p.seen = new Float64Array(edges.length / 4);
  p.rows = new Map();
  p.cells = new Map();
  const add = (map, key, k) => (map.get(key) || map.set(key, []).get(key)).push(k);
  for (let k = 0; k < edges.length; k += 4) {
    const ax = edges[k], az = edges[k + 1], bx = edges[k + 2], bz = edges[k + 3];
    for (let row = Math.floor(Math.min(az, bz)); row <= Math.floor(Math.max(az, bz)); row++) add(p.rows, row, k);
    for (let ix = Math.floor(Math.min(ax, bx) / EDGE); ix <= Math.floor(Math.max(ax, bx) / EDGE); ix++) {
      for (let iz = Math.floor(Math.min(az, bz) / EDGE); iz <= Math.floor(Math.max(az, bz) / EDGE); iz++) add(p.cells, cellKey(ix, iz), k);
    }
  }
  return (p.edges = Float64Array.from(edges));
}

// Whether any piece of water's box comes within a box
function waterNear(x0, z0, x1, z1) {
  for (let ix = Math.floor(x0 / BIG); ix <= Math.floor(x1 / BIG); ix++) {
    for (let iz = Math.floor(z0 / BIG); iz <= Math.floor(z1 / BIG); iz++) {
      for (const p of pieceCells.get(cellKey(ix, iz)) || []) if (p.x0 <= x1 && p.x1 >= x0 && p.z0 <= z1 && p.z1 >= z0) return true;
    }
  }
  return false;
}

// A tile's garden paths into pathCells, those of their segments near water: over it, each is dry ground across its width
function indexPaths(t) {
  t.indexed = true;
  for (const f of t.paths) {
    const half = f[2] / 2, reach = half + PATH_NEAR;
    for (let i = 5; i + 1 < f.length; i += 2) {
      const ax = f[i - 2], az = f[i - 1], bx = f[i], bz = f[i + 1];
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), z0 = Math.min(az, bz), z1 = Math.max(az, bz);
      if (waterNear(x0 - reach, z0 - reach, x1 + reach, z1 + reach)) put(pathCells, CELL, x0 - half, z0 - half, x1 + half, z1 + half, { ax, az, bx, bz, half });
    }
  }
}

// Water come or gone can make other segments near it, and a tile's paths gone must go: index again as asked
function forgetPaths() {
  pathCells.clear();
  for (const t of pathsOf.values()) t.indexed = false;
}

onMap({
  addTile(tile) {
    const pieces = piecesOf(tile), paths = tile.garden?.paths ?? [];
    if (!pieces.length && !paths.length) return;
    const keys = new Set();
    for (const p of pieces) put(pieceCells, BIG, p.x0, p.z0, p.x1, p.z1, p, keys);
    pieceKeysOf.set(tile.key, keys);
    if (paths.length) {
      const t = { paths, x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity, indexed: false };
      for (const f of paths) {
        const half = f[2] / 2;
        for (let i = 3; i + 1 < f.length; i += 2) {
          t.x0 = Math.min(t.x0, f[i] - half);
          t.x1 = Math.max(t.x1, f[i] + half);
          t.z0 = Math.min(t.z0, f[i + 1] - half);
          t.z1 = Math.max(t.z1, f[i + 1] + half);
        }
      }
      pathsOf.set(tile.key, t);
    }
    forgetPaths();
  },
  removeTile(tile) {
    const keys = pieceKeysOf.get(tile.key);
    if (!keys) return;
    pieceKeysOf.delete(tile.key);
    for (const key of keys) {
      const kept = (pieceCells.get(key) || []).filter((p) => p.tile !== tile.key);
      if (kept.length) pieceCells.set(key, kept);
      else pieceCells.delete(key);
    }
    pathsOf.delete(tile.key);
    forgetPaths();
  }
});

/**
 * Dry ground over still water: on a road's carriageway on the ground (the sea's own rule for a road meeting water: it crosses on a culvert
 * the map doesn't show), or within a garden path's width. Holker St's carriageway runs 0.3 m into a lake at Sydney Olympic Park, and
 * Centennial Park's paths 0.5-1 m into its ponds.
 */
function dryAt(x, z) {
  if (onGroundRoad(x, z, 0)) return true;
  for (const t of pathsOf.values()) if (!t.indexed && x >= t.x0 && x <= t.x1 && z >= t.z0 && z <= t.z1) indexPaths(t);
  for (const s of pathCells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL))) || []) {
    if (pointSeg(x, z, s.ax, s.az, s.bx, s.bz) <= s.half) return true;
  }
  return false;
}

/** The still water at (x, z) itself (a fountain's rim isn't), { kind: 'pond' | 'rock' | 'fountain' | 'lake', dry }, or null */
function waterAt(x, z) {
  for (const p of pieceCells.get(cellKey(Math.floor(x / BIG), Math.floor(z / BIG))) || []) {
    if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1 && inside(p, x, z)) return { kind: p.kind, dry: dryAt(x, z) };
  }
  return null;
}

/**
 * How far a body is into still water, in metres: its middle (x, z), its middle line `half` each way along `heading` (forward is sin, cos)
 * and its round `radius`, kept a fountain's rim further off a fountain. 0 where it's clear, or where its middle is on dry ground. In the
 * water, its round and how far its middle line is in (measured up to REACH from the shore, a point at a time), so a body in the water
 * already can be let out the way it gets no deeper.
 */
function bodyInWater(x, z, heading, half, radius) {
  const ux = Math.sin(heading) * half, uz = Math.cos(heading) * half;
  const ax = x - ux, az = z - uz, bx = x + ux, bz = z + uz;
  const q = radius + RIM + REACH;
  const x0 = Math.min(ax, bx) - q, x1 = Math.max(ax, bx) + q, z0 = Math.min(az, bz) - q, z1 = Math.max(az, bz) + q;
  const seen = ++stamp;
  let depth = 0, dry = null;
  for (let ix = Math.floor(x0 / BIG); ix <= Math.floor(x1 / BIG); ix++) {
    for (let iz = Math.floor(z0 / BIG); iz <= Math.floor(z1 / BIG); iz++) {
      for (const p of pieceCells.get(cellKey(ix, iz)) || []) {
        if (p._seen === seen) continue;
        p._seen = seen;
        if (p.x1 < x0 || p.x0 > x1 || p.z1 < z0 || p.z0 > z1) continue;
        const R = radius + p.margin;
        const d = shoreDistance(p, ax, az, bx, bz, R);
        // A middle line that crosses the shore, or starts inside, is in; one wholly outside is in only within its round
        const into = d === 0 || inside(p, ax, az);
        if (!into && d >= R) continue;
        dry ??= dryAt(x, z);
        if (dry) return 0;
        if (!into) {
          depth = Math.max(depth, R - d);
          continue;
        }
        let deepest = 0;
        const n = Math.max(1, Math.ceil((2 * half) / STEP));
        for (let k = 0; k <= n; k++) {
          const px = ax + ((bx - ax) * k) / n, pz = az + ((bz - az) * k) / n;
          if (inside(p, px, pz)) deepest = Math.max(deepest, shoreDistance(p, px, pz, px, pz, REACH));
        }
        depth = Math.max(depth, R + deepest);
      }
    }
  }
  return depth;
}

/**
 * Which way the shore runs beside a travel mode's body at (x, z), facing `heading`: { x, z }, along the edge of still water nearest its
 * middle line within its round, a rim and REACH, or null. js/controllers.js slides a body held at the shore along it, as a shore that
 * isn't square to the world's axes would stop a slide along either.
 */
function shoreAlong(mode, x, z, heading = 0) {
  const body = BODIES[mode];
  if (!body) return null;
  const ux = Math.sin(heading) * body[0], uz = Math.cos(heading) * body[0];
  const ax = x - ux, az = z - uz, bx = x + ux, bz = z + uz;
  const q = body[1] + RIM + REACH;
  const x0 = Math.min(ax, bx) - q, x1 = Math.max(ax, bx) + q, z0 = Math.min(az, bz) - q, z1 = Math.max(az, bz) + q;
  const seen = ++stamp;
  // Of two edges as near (a corner's), the first round its ring
  let best = q, bestAt = Infinity, bestOf = null, along = null;
  for (let ix = Math.floor(x0 / BIG); ix <= Math.floor(x1 / BIG); ix++) {
    for (let iz = Math.floor(z0 / BIG); iz <= Math.floor(z1 / BIG); iz++) {
      for (const p of pieceCells.get(cellKey(ix, iz)) || []) {
        if (p._seen === seen) continue;
        p._seen = seen;
        if (p.x1 < x0 || p.x0 > x1 || p.z1 < z0 || p.z0 > z1) continue;
        const E = p.edges ?? indexEdges(p);
        for (const k of edgesNear(p, ax, az, bx, bz, q)) {
          const d = segSeg(ax, az, bx, bz, E[k], E[k + 1], E[k + 2], E[k + 3]);
          const L = Math.hypot(E[k + 2] - E[k], E[k + 3] - E[k + 1]);
          if ((d < best || (d === best && p === bestOf && k < bestAt)) && L > 0) {
            best = d;
            bestAt = k;
            bestOf = p;
            along = { x: (E[k + 2] - E[k]) / L, z: (E[k + 3] - E[k + 1]) / L };
          }
        }
      }
    }
  }
  return along;
}

/** How far a travel mode's body at (x, z), facing `heading`, is into still water: 0 for the helicopter, which no ground rule holds */
function stillWaterDepth(mode, x, z, heading = 0) {
  const body = BODIES[mode];
  return body ? bodyInWater(x, z, heading, body[0], body[1]) : 0;
}

const inStillWater = (mode, x, z, heading = 0) => stillWaterDepth(mode, x, z, heading) > 0;

export { BODIES as WATER_BODIES, RIM as FOUNTAIN_RIM, bodyInWater, dryAt, inStillWater, shoreAlong, stillWaterDepth, waterAt };
