// tools/terrace-rows.mjs: rows of terraces the map draws as one footprint, cut into their houses at their street addresses, for
// tools/build-buildings.mjs. A house of a terrace style (js/house-styles.js look.terrace) whose outline holds G-NAF's points of two numbers
// or more on its main street, along its front, is cut square to its front halfway between each two neighbours' points: each piece a
// house of its own. Left whole: an outline of one number, or whose numbers are in one place (a block's units), with another building
// standing in it, or where a piece wouldn't be one simple outline.
import { houseFront } from '../js/building-footprints.js';
import { numberText } from '../js/addresses.js';
import { polygonContains } from '../js/building-collision.js';
import { indexBuildings, locate, streetFinder, wallsWithNeighbours } from './addresses.mjs';

export const MIN_HOUSE = 3; // m along the front: two numbers' points nearer than this are one house's, and no piece is narrower
const GRID = 0.5; // m: the buildings' outlines are kept in whole steps of this (tools/build-buildings.mjs PRECISION)

/**
 * `records`: the buildings, as tools/addresses.mjs matchAddresses() takes them, each with `terrace` where it's a house of a terrace
 * style. `points`, `roads`, `aliases`: as matchAddresses() takes them. The answer: { cuts: Map of record index to its pieces, in order
 * along its front, each { outer: [{ x, z }] (on the 0.5 m grid, wound as the row's), numbers: [text] }, stats: why rows were left whole }.
 */
export function cutRows(records, points, roads, { aliases = new Map() } = {}) {
  const stats = { rows: 0, cut: 0, houses: 0, oneNumber: 0, holes: 0, within: 0, noStreet: 0, noFront: 0, onePlace: 0, shape: 0, outOfOrder: 0 };
  const index = indexBuildings(records);
  const find = streetFinder(roads, aliases);
  const rows = new Set();
  records.forEach((r, i) => { if (r.terrace && !r.group && !r.bottom) rows.add(i); });
  const inside = new Map();
  for (const p of points) {
    if (!p.number) continue;
    const { hit } = locate(index, p.x, p.z);
    if (hit >= 0 && rows.has(hit)) (inside.get(hit) || inside.set(hit, []).get(hit)).push(p);
  }
  const cuts = new Map();
  for (const [i, pts] of inside) {
    const r = records[i];
    stats.rows++;
    // Its main street: the one most of its addresses are on, ties to the nearest
    const byStreet = new Map();
    for (const p of pts) (byStreet.get(p.street) || byStreet.set(p.street, []).get(p.street)).push(p);
    const numbersOf = (those) => new Set(those.map((p) => numberText(p.number)));
    if (![...byStreet.values()].some((those) => numbersOf(those).size >= 2)) { stats.oneNumber++; continue; }
    if (r.outline.length !== 1 || r.outline[0].holes.length) { stats.holes++; continue; }
    // Another building standing in it (a house traced over the row, which holds its own number): the cut would run through that one
    if ([...index.near(r.x0, r.z0, r.x1, r.z1)].some((j) => j !== i && polygonContains(r.outline[0], records[j].mx, records[j].mz))) { stats.within++; continue; }
    const streets = [];
    for (const [name, those] of byStreet) {
      const { found } = find(name, r.mx, r.mz);
      if (found) streets.push({ those, found, weight: those.reduce((n, p) => n + (p.addresses || 1), 0) });
    }
    if (!streets.length) { stats.noStreet++; continue; }
    streets.sort((p, q) => q.weight - p.weight || p.found.d - q.found.d);
    const main = streets[0];
    if (numbersOf(main.those).size < 2) { stats.oneNumber++; continue; }
    const front = houseFront(wallsWithNeighbours(records, index, r), main.found, r.mx, r.mz);
    if (!front) { stats.noFront++; continue; }
    // Along the front, from its start: each number's place, weighed by its addresses, then those nearer than MIN_HOUSE as one house
    const ux = (front.b.x - front.a.x) / front.width, uz = (front.b.y - front.a.y) / front.width;
    const along = (x, z) => (x - front.a.x) * ux + (z - front.a.y) * uz;
    const byNumber = new Map();
    for (const p of main.those) {
      const k = numberText(p.number), w = p.addresses || 1;
      const n = byNumber.get(k) || byNumber.set(k, { s: 0, w: 0, n: p.number.n * 100 + p.number.letter, numbers: [k] }).get(k);
      n.s += along(p.x, p.z) * w;
      n.w += w;
    }
    const places = [...byNumber.values()].map((n) => ({ ...n, s: n.s / n.w })).sort((p, q) => p.s - q.s);
    const ring = r.outline[0].outer;
    const ss = ring.map((p) => along(p.x, p.z));
    const s0 = Math.min(...ss), s1 = Math.max(...ss);
    const houses = [];
    for (const p of places) {
      const last = houses.at(-1);
      if (last && p.s - last.s < MIN_HOUSE) {
        last.s = (last.s * last.w + p.s * p.w) / (last.w + p.w);
        last.w += p.w;
        last.numbers.push(...p.numbers);
        last.n = Math.min(last.n, p.n);
      } else houses.push({ ...p, numbers: [...p.numbers] });
    }
    // An end house too narrow to be one goes with its neighbour
    while (houses.length > 1 && (houses[0].s + houses[1].s) / 2 - s0 < MIN_HOUSE) merge(houses, 0);
    while (houses.length > 1 && s1 - (houses.at(-2).s + houses.at(-1).s) / 2 < MIN_HOUSE) merge(houses, houses.length - 2);
    if (houses.length < 2) { stats.onePlace++; continue; }
    // Numbers that don't rise or fall along the row, letters counted (counted only: the points still say where each house is)
    const ns = houses.map((h) => h.n);
    if (!ns.every((n, k) => !k || n > ns[k - 1]) && !ns.every((n, k) => !k || n < ns[k - 1])) stats.outOfOrder++;
    const pieces = splitAlong(ring, ux, uz, front.a, houses.slice(1).map((h, k) => (houses[k].s + h.s) / 2));
    if (!pieces || pieces.some((piece, k) => !main.those.some((p) => houses[k].numbers.includes(numberText(p.number))
      && polygonContains({ outer: piece, holes: [] }, p.x, p.z)))) { stats.shape++; continue; }
    cuts.set(i, pieces.map((outer, k) => ({ outer, numbers: houses[k].numbers })));
    stats.cut++;
    stats.houses += pieces.length;
  }
  return { cuts, stats };
}

function merge(houses, k) {
  const a = houses[k], b = houses[k + 1];
  houses.splice(k, 2, { s: (a.s * a.w + b.s * b.w) / (a.w + b.w), w: a.w + b.w, n: Math.min(a.n, b.n), numbers: [...a.numbers, ...b.numbers] });
}

/**
 * A ring ([{ x, z }], on the 0.5 m grid) cut by lines square to (ux, uz) at `cuts` m along it from `origin` ({ x, y }), increasing: one
 * ring between each two, in order, wound as the ring is; each new corner on the grid, as near the wall it cuts as the grid has it. Null
 * where a piece isn't one simple ring.
 */
export function splitAlong(ring, ux, uz, origin, cuts) {
  const along = (p) => (p.x - origin.x) * ux + (p.z - origin.y) * uz;
  let rest = [ring];
  const pieces = [];
  for (let c of cuts) {
    // Clear of every corner, so no corner is on the line
    while (rest.some((r) => r.some((p) => Math.abs(along(p) - c) < 0.01))) c += 0.02;
    const below = [], above = [];
    for (const r of rest) {
      const [b, a] = splitRing(r, (p) => along(p) - c, uz, -ux);
      below.push(...b);
      above.push(...a);
    }
    if (below.length !== 1) return null;
    pieces.push(below[0]);
    rest = above;
  }
  if (rest.length !== 1) return null;
  pieces.push(rest[0]);
  for (const piece of pieces) {
    tidy(piece);
    if (piece.length < 3 || crosses(piece) || Math.abs(area(piece)) < 6) return null;
  }
  return pieces;
}

// A piece's corners without repeats, and without spikes: where a new corner on the grid fell on or beside a wall that runs nearly along
// the cut (a step in the row's back, at a party wall), the ring runs out along the cut and back along that wall, a sliver of a few
// centimetres whose two walls would face the same way as the neighbour's over the cut: its tip goes
function tidy(ring) {
  for (let changed = true; changed && ring.length > 2;) {
    changed = false;
    for (let k = ring.length - 1; k >= 0 && ring.length > 2; k--) {
      const a = ring[(k + ring.length - 1) % ring.length], b = ring[k % ring.length], c = ring[(k + 1) % ring.length];
      if ((b.x === c.x && b.z === c.z) || spike(a, b, c)) { ring.splice(k % ring.length, 1); changed = true; }
    }
  }
}

const SLIVER = 0.3; // m
// Whether the ring turns back on itself at b: the nearer of a and c within SLIVER of the line from b to the other
function spike(a, b, c) {
  const ax = a.x - b.x, az = a.z - b.z, cx = c.x - b.x, cz = c.z - b.z;
  if (ax * cx + az * cz <= 0) return false;
  const la = Math.hypot(ax, az), lc = Math.hypot(cx, cz);
  return Math.abs(ax * cz - az * cx) / Math.max(la, lc) < SLIVER;
}

/**
 * A simple ring cut by the line f = 0 (f linear, no corner on it), (vx, vz) along the line: [the rings where f < 0, those where f > 0].
 * The line meets the ring at an even number of points; taken in turn along it, each two bound a stretch inside the ring, and a piece
 * follows the ring to the first, crosses to the second and follows the ring on. Each new point is on the grid and shared by the two
 * pieces it bounds, so their walls there are one wall.
 */
function splitRing(ring, f, vx, vz) {
  const nodes = [];
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k], q = ring[(k + 1) % ring.length], fp = f(p), fq = f(q);
    nodes.push({ x: p.x, z: p.z, side: fp > 0 });
    if ((fp > 0) !== (fq > 0)) {
      const t = fp / (fp - fq), x = p.x + (q.x - p.x) * t, z = p.z + (q.z - p.z) * t;
      nodes.push({ ...onGrid(p, q, x, z), cross: true, t: x * vx + z * vz });
    }
  }
  const crossings = nodes.map((n, k) => k).filter((k) => nodes[k].cross).sort((a, b) => nodes[a].t - nodes[b].t);
  if (!crossings.length) return nodes[0].side ? [[], [ring]] : [[ring], []];
  const partner = new Map();
  for (let k = 0; k < crossings.length; k += 2) { partner.set(crossings[k], crossings[k + 1]); partner.set(crossings[k + 1], crossings[k]); }
  const seen = new Set(), out = [[], []];
  for (let start = 0; start < nodes.length; start++) {
    if (nodes[start].cross || seen.has(start)) continue;
    const piece = [];
    let k = start, guard = 0;
    do {
      if (guard++ > 4 * nodes.length) return [[], []];
      const n = nodes[k];
      piece.push({ x: n.x, z: n.z });
      if (n.cross) {
        const j = partner.get(k);
        piece.push({ x: nodes[j].x, z: nodes[j].z });
        k = (j + 1) % nodes.length;
      } else {
        seen.add(k);
        k = (k + 1) % nodes.length;
      }
    } while (k !== start);
    out[nodes[start].side ? 1 : 0].push(piece);
  }
  return out;
}

// The grid's point nearest the wall from p to q, within half a metre of (x, z) where the line cuts it, and between p and q
function onGrid(p, q, x, z) {
  const dx = q.x - p.x, dz = q.z - p.z, L = Math.hypot(dx, dz) || 1;
  let best = null, score = Infinity;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const gx = (Math.round(x / GRID) + i) * GRID, gz = (Math.round(z / GRID) + j) * GRID;
      const t = ((gx - p.x) * dx + (gz - p.z) * dz) / (L * L);
      if (t < 0 || t > 1) continue;
      const off = Math.abs((gx - p.x) * dz - (gz - p.z) * dx) / L, from = Math.hypot(gx - x, gz - z);
      if (from > 0.75) continue;
      const s = off + 0.1 * from;
      if (s < score - 1e-9) { score = s; best = { x: gx, z: gz }; }
    }
  }
  return best || { x: Math.round(x / GRID) * GRID, z: Math.round(z / GRID) * GRID };
}

function area(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  return a / 2;
}

// Whether a ring's walls cross one another (touching at a corner counts: a piece pinched to a point isn't one outline)
function crosses(ring) {
  const n = ring.length;
  const orient = (a, b, c) => Math.sign((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j], d = ring[(j + 1) % n];
      const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
      if (o1 !== o2 && o3 !== o4) return true;
      if ((a.x === c.x && a.z === c.z) || (a.x === d.x && a.z === d.z) || (b.x === c.x && b.z === c.z) || (b.x === d.x && b.z === d.z)) return true;
    }
  }
  return false;
}
