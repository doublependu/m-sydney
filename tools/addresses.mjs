// tools/addresses.mjs: G-NAF's address points matched to the buildings and their streets to the roads, for tools/build-buildings.mjs.
// Each point goes to the building it's in, or else to the nearest within NEAR m, and the pieces of a building share theirs. A building's
// streets are those its points name, weighed by how many addresses each is (a block of flats' units), matched by name (js/addresses.js streetKey(); where that isn't found, the aliases in tools/local/,
// then looseStreetKey()) to the roads within FIND m of its middle: the one with most of its points first, ties to the nearest. For each street it keeps the point on it nearest the
// building's middle, its numbers there, and, for a house or a low-rise flat or shop, the wall of its outline that faces it
// (js/addresses.js outerWalls()' index): a house's as its walls pick their front (js/building-footprints.js houseFront(), party walls
// counted as the game counts them), a flat's or shop's the one nearest that street's points of those facing it (facingWalls()).
// Its steps (the buildings in cells and the point in one, the street of a name near a point, a building's walls against its neighbours)
// are tools/terrace-rows.mjs' too, which cuts rows into their houses before the match.
import { facingWalls, looseStreetKey, numberSpan, outerWalls, wallDistance } from '../js/addresses.js';
import { houseFront, partyWallHeight } from '../js/building-footprints.js';
import { polygonContains } from '../js/building-collision.js';

export const NEAR = 8; // m: a point in no building goes to the nearest within this
export const FIND = 100; // m from a building's middle that a street of its addresses is looked for
export const LOW_RISE = 15; // m: flats, shops and offices under this follow a house's door rules
const CELL = 20, ROAD_CELL = 100;
const FLATS = 2, WORK = 3; // tools/build-buildings.mjs KIND

/**
 * `records`: the buildings in the tiles' order, each { outline: [{ outer, holes }] (points { x, z }, as the tiles have them), area,
 * height, kind, group, bottom, house (whether its style has a look: js/house-styles.js) }. `points`: an iterable of { x, z, street
 * (streetKey()'d), number (parseNumber()'s, or null), addresses (how many it is: its units; 1 if not given) }. `roads`: [{ name (streetKey()'d), pts: [[x, z], ...], onGround }].
 * `aliases`: Map of a street's name as G-NAF has it to the road's name to look for where it's found under its own nowhere near.
 * The answer: { address: Map of record index to [{ x, z, wall, number, at }] (x, z in 0.5 m; `at` the middle of that street's
 * addresses in 0.5 m; `wall` -1 for none), stats, notFound: Map of street name to { buildings it wasn't found for, at: the first one's middle },
 * aliased: Map of alias to buildings found by it }.
 */
export function matchAddresses(records, points, roads, { aliases = new Map() } = {}) {
  const stats = { points: 0, inside: 0, near: 0, none: 0, noNumber: 0, buildings: 0, streets: 0, twoOrMore: 0, loose: 0, notFound: 0, walls: 0 };
  const index = indexBuildings(records);

  // Each point to its building, and the pieces of one building together
  const ownerOf = (i) => (records[i].group ? `g${records[i].group}` : i);
  const owners = new Map();
  for (const p of points) {
    stats.points++;
    const { hit, inside } = locate(index, p.x, p.z, NEAR);
    if (hit < 0) { stats.none++; continue; }
    if (inside) stats.inside++;
    else stats.near++;
    if (!p.number) stats.noNumber++;
    const key = ownerOf(hit);
    (owners.get(key) || owners.set(key, []).get(key)).push(p);
  }
  const find = streetFinder(roads, aliases);

  const wallsOf = (r) => wallsWithNeighbours(records, index, r);
  const half = (v) => Math.round(v * 2) / 2;
  const groups = new Map();
  records.forEach((r, i) => { if (r.group) (groups.get(r.group) || groups.set(r.group, []).get(r.group)).push(i); });
  const address = new Map(), notFound = new Map(), aliased = new Map();
  for (const [key, list] of owners) {
    const pieces = typeof key === 'number' ? [key] : groups.get(+key.slice(1));
    const ground = pieces.filter((i) => !records[i].bottom);
    if (!ground.length) continue;
    // Its middle as the game takes it (js/buildings.js wholeOf()): a building in pieces, its last on the ground in the tiles' order
    const { mx: cx, mz: cz } = records[ground.at(-1)];
    const byStreet = new Map();
    for (const p of list) (byStreet.get(p.street) || byStreet.set(p.street, []).get(p.street)).push(p);
    const streets = [];
    for (const [name, those] of byStreet) {
      const { found, how } = find(name, cx, cz);
      if (how === 'alias') aliased.set(name, (aliased.get(name) || 0) + 1);
      if (how === 'loose') stats.loose++;
      if (!found) {
        stats.notFound++;
        const miss = notFound.get(name) || notFound.set(name, { buildings: 0, at: [Math.round(cx), Math.round(cz)] }).get(name);
        miss.buildings++;
        continue;
      }
      streets.push({ those, weight: those.reduce((n, p) => n + (p.addresses || 1), 0), x: half(found.x), z: half(found.z), d: found.d });
    }
    if (!streets.length) continue;
    streets.sort((p, q) => q.weight - p.weight || p.d - q.d);
    // Which piece has them: the one on the ground nearest its main street, as a house in pieces has its front (js/buildings.js streetOf())
    const holder = ground.reduce((best, i) => (best < 0 || Math.hypot(records[i].mx - streets[0].x, records[i].mz - streets[0].z)
      < Math.hypot(records[best].mx - streets[0].x, records[best].mz - streets[0].z) ? i : best), -1);
    const r = records[holder];
    const tallest = Math.max(...pieces.map((i) => records[i].height));
    const lowRise = !r.house && (r.kind === FLATS || r.kind === WORK) && tallest < LOW_RISE;
    const walls = r.house || lowRise ? wallsOf(r) : null;
    address.set(holder, streets.map(({ those, weight, x, z }) => {
      const ax = those.reduce((s, p) => s + p.x * (p.addresses || 1), 0) / weight, az = those.reduce((s, p) => s + p.z * (p.addresses || 1), 0) / weight;
      let wall = -1;
      if (walls) {
        const front = houseFront(walls, { x, z }, r.mx, r.mz);
        const door = !front || r.house ? front : facingWalls(walls, { x, z }, r.mx, r.mz, front)
          .reduce((best, w) => (!best || wallDistance(w, ax, az) < wallDistance(best, ax, az) ? w : best), null);
        wall = door ? walls.indexOf(door) : -1;
      }
      if (wall >= 0) stats.walls++;
      return { x, z, wall, number: numberSpan(those.map((p) => p.number)), at: { x: half(ax), z: half(az) } };
    }));
    stats.buildings++;
    stats.streets += streets.length;
    if (streets.length > 1) stats.twoOrMore++;
  }
  return { address, stats, notFound, aliased };
}

/** Each record's box and middle (as js/tiles/tile-file.js works it out: mx, mz) set on it, and the records in 20 m cells */
export function indexBuildings(records) {
  const cells = new Map();
  records.forEach((r, i) => {
    const outer = r.outline.flatMap((p) => p.outer);
    r.x0 = Math.min(...outer.map((p) => p.x)); r.x1 = Math.max(...outer.map((p) => p.x));
    r.z0 = Math.min(...outer.map((p) => p.z)); r.z1 = Math.max(...outer.map((p) => p.z));
    r.mx = (r.x0 + r.x1) / 2; r.mz = (r.z0 + r.z1) / 2;
    for (let ix = Math.floor(r.x0 / CELL); ix <= Math.floor(r.x1 / CELL); ix++) {
      for (let iz = Math.floor(r.z0 / CELL); iz <= Math.floor(r.z1 / CELL); iz++) (cells.get(ix * 100000 + iz) || cells.set(ix * 100000 + iz, []).get(ix * 100000 + iz)).push(i);
    }
  });
  const near = (x0, z0, x1, z1) => {
    const out = new Set();
    for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
      for (let iz = Math.floor(z0 / CELL); iz <= Math.floor(z1 / CELL); iz++) for (const i of cells.get(ix * 100000 + iz) || []) out.add(i);
    }
    return out;
  };
  return { records, near };
}

function edgeDistance(r, x, z) {
  let d = Infinity;
  for (const p of r.outline) {
    for (const ring of [p.outer, ...p.holes]) {
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k], b = ring[(k + 1) % ring.length], dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
        d = Math.min(d, Math.hypot(a.x + dx * t - x, a.z + dz * t - z));
      }
    }
  }
  return d;
}

/**
 * The building (x, z) is in, the smallest where outlines overlap: { hit: its index, inside: true }; else, `reach` > 0, the nearest within
 * that many metres: { hit, inside: false }; else { hit: -1 }. `index`: indexBuildings()'.
 */
export function locate({ records, near }, x, z, reach = 0) {
  let hit = -1;
  for (const i of near(x, z, x, z)) {
    const r = records[i];
    if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1 && r.outline.some((q) => polygonContains(q, x, z)) && (hit < 0 || r.area < records[hit].area)) hit = i;
  }
  if (hit >= 0 || !(reach > 0)) return { hit, inside: hit >= 0 };
  let best = reach;
  for (const i of near(x - reach, z - reach, x + reach, z + reach)) {
    const d = edgeDistance(records[i], x, z);
    if (d < best) { best = d; hit = i; }
  }
  return { hit, inside: false };
}

/**
 * A street of a name near a point, as a building's addresses look for it: `find(name, x, z)` gives { found: the point of a road of that
 * name nearest (x, z) within FIND m, of the part on the ground if any of it is there ({ x, z, d }), how: 'name', 'alias' or 'loose' }, or
 * { found: null }. Where it isn't found as spelt: the aliases, then looseStreetKey().
 */
export function streetFinder(roads, aliases = new Map()) {
  // The roads by name, and by their loose names (prefixed ~), in 100 m cells
  const roadCells = new Map();
  for (const { name, pts, onGround } of roads) {
    if (!name) continue;
    for (let i = 1; i < pts.length; i++) {
      const seg = [...pts[i - 1], ...pts[i], onGround];
      for (let ix = Math.floor(Math.min(seg[0], seg[2]) / ROAD_CELL); ix <= Math.floor(Math.max(seg[0], seg[2]) / ROAD_CELL); ix++) {
        for (let iz = Math.floor(Math.min(seg[1], seg[3]) / ROAD_CELL); iz <= Math.floor(Math.max(seg[1], seg[3]) / ROAD_CELL); iz++) {
          for (const k of [`${ix},${iz},${name}`, `${ix},${iz},~${looseStreetKey(name)}`]) (roadCells.get(k) || roadCells.set(k, []).get(k)).push(seg);
        }
      }
    }
  }
  const streetNear = (name, x, z) => {
    let ground = null, any = null;
    for (let ix = Math.floor((x - FIND) / ROAD_CELL); ix <= Math.floor((x + FIND) / ROAD_CELL); ix++) {
      for (let iz = Math.floor((z - FIND) / ROAD_CELL); iz <= Math.floor((z + FIND) / ROAD_CELL); iz++) {
        for (const [ax, az, bx, bz, onGround] of roadCells.get(`${ix},${iz},${name}`) || []) {
          const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
          const q = { x: ax + dx * t, z: az + dz * t };
          q.d = Math.hypot(q.x - x, q.z - z);
          if (q.d > FIND) continue;
          if (!any || q.d < any.d) any = q;
          if (onGround && (!ground || q.d < ground.d)) ground = q;
        }
      }
    }
    return ground || any;
  };
  return (name, x, z) => {
    let found = streetNear(name, x, z);
    if (found) return { found, how: 'name' };
    if (aliases.has(name) && (found = streetNear(aliases.get(name), x, z))) return { found, how: 'alias' };
    if ((found = streetNear(`~${looseStreetKey(name)}`, x, z))) return { found, how: 'loose' };
    return { found: null };
  };
}

/**
 * A record's outer walls (js/addresses.js outerWalls()) with their party walls as the game finds them (js/building-footprints.js
 * partyWallHeight(): `adjacentHeight`), against every building, for one not in pieces. `index`: indexBuildings()'.
 */
export function wallsWithNeighbours(records, { near }, r) {
  const walls = outerWalls(r.outline);
  const around = !r.group && r.height <= 60 ? [...near(r.x0 - 2, r.z0 - 2, r.x1 + 2, r.z1 + 2)].map((i) => records[i])
    .map((n) => ({ polygons: n.outline, height: n.height + 0.22, x0: n.x0, x1: n.x1, z0: n.z0, z1: n.z1 })) : [];
  for (const w of walls) w.adjacentHeight = w.width && around.length ? partyWallHeight({ polygons: r.outline }, w.a, w.b, around) : 0;
  return walls;
}
