import { TILE, onMap } from './geodata.js';
import { blockAt } from './city-config.js';
import { GroundCells, SIDEWALK_TOP, addSurface, pointInPolygonXZ } from './ground-geometry.js';
import { groundHeight } from './surfaces.js';
import { SITE_CUTS } from './model-sites.js';

// What's drawn on the ground at a point, for whatever stands on it: the walker's feet, the bike's two wheels and the car's four. The highest
// of these, on their own triangles as they're drawn:
// - the map's paving and lawns (js/city-grid.js), laid on the height grid's nodes with addSurface(), and the beaches' sand and the coast's
//   rock over them;
// - a garden's paths, steps, beds and its ponds' coping (js/garden.js), as each tile's garden was built;
// - near you, the nature strips' lawn and footpath (js/verge.js) and the lots' driveways, crossovers, laybacks and paths (js/lot-details.js).
// The map's surfaces come with the tiles, and are looked through and their triangles made near you, a tile or a surface at a time as the
// world's jobs have room once the city round you is complete (buildNear(): 5-20 ms a surface, as js/garden.js and the lots have always
// made them), never while the first view loads: until then a surface isn't counted, and what stands there is at the paving's height, as
// it always was. The others are handed over as triangles (setLayer()).

// Each surface's lift over its triangles, as js/city-grid.js draws it
const SAND_LIFT = 0.06, ROCK_LIFT = 0.12;
const LIFT = { paving: SIDEWALK_TOP, lawn: SIDEWALK_TOP + 0.02, sand: SIDEWALK_TOP + SAND_LIFT, rock: SIDEWALK_TOP + ROCK_LIFT };
// A garden's (js/garden.js), over the ground, on the lawn as drawn: a path a little over the lawn, a centimetre apart by what it's made of
// so that where two meet one is always on top (timber lowest, then gravel, paving and asphalt, and steps over all of them: at one height
// the two fought for every pixel where they crossed); a track a centimetre over the lawn, a strip worn into the grass, not laid on it, which
// paved paths cross over
const LAWN_TOP = LIFT.lawn;
const PATH_TOP = LAWN_TOP + 0.05;
const PATH_LIFT = [0.02, 0.03, 0.01, 0]; // paving, asphalt, gravel, timber: over PATH_TOP
const STEPS_LIFT = 0.04;
const TRACK_TOP = LAWN_TOP + 0.01;
const TRACK = 3; // a garden path's kind: 0 a footpath, 1 steps, 2 a cycleway, 3 a track
/** A garden path's top over the ground, as drawn over the lawn, by its kind and surface: for the crowd walking it (js/pedestrian-system.js) */
const pathTop = (kind, surface) => (kind === TRACK ? TRACK_TOP : PATH_TOP + (kind === 1 ? STEPS_LIFT : PATH_LIFT[surface] ?? PATH_LIFT[2]));
const BOX = 32; // m: the cells the map's surfaces are indexed in
const CELL = 4; // m: the cells each surface's triangles, and each layer's, are indexed in
const AHEAD = 40; // m round you that the map's surfaces have their triangles made ahead of time
// Nothing stands on a triangle steeper than this (rise over run): the map's paving and lawns are laid on the height grid's nodes and their own
// edges, and where the ground steps (a cutting's wall, a retaining wall) a triangle can span the step, a sliver up to several metres off
// the ground at its foot or its top. What stands there stands on what's under it, or at the paving's height, as it always did.
const STEEP = 1.0;
// ...nor on one further than this from where it would stand without the lookup (the paving's height on a kerb's island, the ground's off it):
// a surface laid flat across such a step, a platform metres over the ground or under it. On slopes the lawn as drawn is up to a metre
// off the ground; the slivers across the map's walls are 2-7 m.
const CLIFF = 1.5;

const keyOf = (x, z, size) => Math.floor(x / size) * 100000 + Math.floor(z / size);

// --- A surface's triangles, as drawn ---------------------------------------------------------------------------------------------------

const surfaces = new WeakMap();
/** The record of a polygon laid on the ground (rings: the outer and its holes, as js/city-config.js places them): its box, and its triangles once made */
function surfaceOf(rings) {
  let s = surfaces.get(rings);
  if (!s) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of rings[0]) {
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    }
    s = { rings, x0, x1, z0, z1, tris: null };
    surfaces.set(rings, s);
  }
  return s;
}

/** Its triangles, as addSurface() lays them (without their lift): [[x, y, z] x 3], in CELL m cells */
function buildSurface(s) {
  const cells = new GroundCells(1e6);
  addSurface(cells, s.rings, 0);
  s.tris = new Map();
  for (const c of cells.cells.values()) {
    const P = c.position, I = c.index;
    for (let i = 0; i < I.length; i += 3) {
      const t = [I[i], I[i + 1], I[i + 2]].map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
      const xs = t.map((v) => v[0]), zs = t.map((v) => v[2]);
      for (let cx = Math.floor(Math.min(...xs) / CELL); cx <= Math.floor(Math.max(...xs) / CELL); cx++) {
        for (let cz = Math.floor(Math.min(...zs) / CELL); cz <= Math.floor(Math.max(...zs) / CELL); cz++) {
          const key = cx * 100000 + cz;
          (s.tris.get(key) || s.tris.set(key, []).get(key)).push(t);
        }
      }
    }
  }
  return s;
}

/** The height of a surface's triangles at (x, z), making them if they aren't yet, or null off it. `standing`: none too steep to stand on */
function heightOn(s, x, z, standing = false) {
  if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) return null;
  if (!s.tris) buildSurface(s);
  for (const t of s.tris.get(keyOf(x, z, CELL)) || []) {
    const [a, b, c] = t;
    const y = standing ? standingIn(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], x, z) : heightInTriangle(t, x, z);
    if (y !== null) return y;
  }
  return null;
}

/** The height at (x, z) of the triangle [[x, y, z] x 3] over it, or null if it isn't over it */
function heightInTriangle([a, b, c], x, z) {
  return heightIn(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], x, z);
}
function heightIn(ax, ay, az, bx, by, bz, cx, cy, cz, x, z) {
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(d) < 1e-9) return null;
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
  const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
  const l3 = 1 - l1 - l2;
  if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) return null;
  return l1 * ay + l2 * by + l3 * cy;
}
/** heightIn(), or null on a triangle steeper than STEEP */
function standingIn(ax, ay, az, bx, by, bz, cx, cy, cz, x, z) {
  const y = heightIn(ax, ay, az, bx, by, bz, cx, cy, cz, x, z);
  if (y === null) return null;
  // Its plane's slope: y = ay + gx (x - ax) + gz (z - az)
  const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
  const den = ux * vz - uz * vx;
  const gx = (uy * vz - uz * vy) / den, gz = (ux * vy - uy * vx) / den;
  return gx * gx + gz * gz > STEEP * STEEP ? null : y;
}

// --- The map's surfaces, as the tiles come and go -----------------------------------------------------------------------------------

const mapCells = new Map(); // BOX cell -> [{ s, lift, what }]
const byTile = new Map(); // tile key -> its entries
const pending = new Map(); // tile key -> a tile held but not looked through yet
const ptsOf = (flat) => {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i], z: flat[i + 1] });
  return out;
};
function placeEntry(e, sign) {
  const { s } = e;
  for (let cx = Math.floor(s.x0 / BOX); cx <= Math.floor(s.x1 / BOX); cx++) {
    for (let cz = Math.floor(s.z0 / BOX); cz <= Math.floor(s.z1 / BOX); cz++) {
      const key = cx * 100000 + cz;
      if (sign > 0) (mapCells.get(key) || mapCells.set(key, []).get(key)).push(e);
      else {
        const list = mapCells.get(key)?.filter((o) => o !== e);
        if (list?.length) mapCells.set(key, list);
        else mapCells.delete(key);
      }
    }
  }
}
/** A tile's paving, lawns and beaches into the cells, as entries */
function indexTile(tile) {
  const entries = [];
  for (const rings of tile.placedPavements || []) entries.push({ s: surfaceOf(rings), lift: LIFT.paving, what: 'paving' });
  for (const rings of tile.placedLawns || []) entries.push({ s: surfaceOf(rings), lift: LIFT.lawn, what: 'lawn' });
  // Beaches (0) and the coast's bare rock (1) on the land; the rock shelves in the sea (2) stand on the water, not the ground
  for (const [kind, ...flats] of tile.sand || []) {
    if (kind !== 0 && kind !== 1) continue;
    entries.push({ s: surfaceOf(flats.map(ptsOf)), lift: kind === 0 ? LIFT.sand : LIFT.rock, what: kind === 0 ? 'sand' : 'rock' });
  }
  for (const e of entries) placeEntry(e, 1);
  byTile.set(tile.key, entries);
}
onMap({
  addTile(tile) {
    pending.set(tile.key, tile);
  },
  removeTile(tile) {
    pending.delete(tile.key);
    for (const e of byTile.get(tile.key) || []) placeEntry(e, -1);
    byTile.delete(tile.key);
    dropLayer(`garden:${tile.key}`);
  }
});
// A tile's lawns reach 240 m past its edge (tools/geo-common.mjs tiledPolygons())
const TILE_REACH = 250;

// A model's site cut out of the ground (js/model-sites.js): the model draws what's there
const inCut = (x, z) => SITE_CUTS.some((c) => x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ && pointInPolygonXZ(c.poly, x, z));

// --- Layers handed over as triangles -------------------------------------------------------------------------------------------------

const layers = new Map(); // name -> { x0, x1, z0, z1, tris (x, y, z, each corner of each, in the world), cells: CELL cell -> [index of a triangle] }

/**
 * What something draws over the ground, as triangles facing up: `tris`, x, y, z of each corner, in the world's heights, or a list of
 * such arrays. Replaces what was there under `name`.
 */
function setLayer(name, tris) {
  const all = Array.isArray(tris) ? concat(tris) : tris;
  if (!all.length) {
    layers.delete(name);
    return;
  }
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const cells = new Map();
  for (let i = 0; i < all.length; i += 9) {
    const ax = Math.min(all[i], all[i + 3], all[i + 6]), bx = Math.max(all[i], all[i + 3], all[i + 6]);
    const az = Math.min(all[i + 2], all[i + 5], all[i + 8]), bz = Math.max(all[i + 2], all[i + 5], all[i + 8]);
    x0 = Math.min(x0, ax); x1 = Math.max(x1, bx); z0 = Math.min(z0, az); z1 = Math.max(z1, bz);
    for (let cx = Math.floor(ax / CELL); cx <= Math.floor(bx / CELL); cx++) {
      for (let cz = Math.floor(az / CELL); cz <= Math.floor(bz / CELL); cz++) {
        const key = cx * 100000 + cz;
        (cells.get(key) || cells.set(key, []).get(key)).push(i);
      }
    }
  }
  layers.set(name, { x0, x1, z0, z1, tris: all, cells });
}
function concat(list) {
  const out = new Float32Array(list.reduce((n, a) => n + a.length, 0));
  let n = 0;
  for (const a of list) {
    out.set(a, n);
    n += a.length;
  }
  return out;
}
const dropLayer = (name) => layers.delete(name);
/** Every layer whose name starts with `prefix` gone */
function dropLayers(prefix) {
  for (const name of [...layers.keys()]) if (name.startsWith(prefix)) layers.delete(name);
}

/** The triangles in ground cells (js/ground-geometry.js GroundCells), x, y, z of each corner */
function trianglesOf(cells) {
  let n = 0;
  for (const c of cells.cells.values()) n += c.index.length;
  const out = new Float32Array(n * 3);
  let k = 0;
  for (const c of cells.cells.values()) {
    const P = c.position, I = c.index;
    for (let i = 0; i < I.length; i++) {
      const v = I[i] * 3;
      out[k++] = P[v];
      out[k++] = P[v + 1];
      out[k++] = P[v + 2];
    }
  }
  return out;
}

// --- The lookup ----------------------------------------------------------------------------------------------------------------------

let lastWhat = null;
/**
 * The top of the highest thing drawn on the ground at (x, z), in the world's heights, or null where there's nothing (a road, or where the
 * surfaces' triangles aren't made yet). drawnWhat() says what it was.
 */
function drawnTop(x, z) {
  let best = -Infinity, what = null, lo = null, hi = null;
  // The band a top must be in, worked out with the first that might count
  const band = () => {
    const nominal = groundHeight(x, z) + (blockAt(x, z) ? SIDEWALK_TOP : 0);
    lo = nominal - CLIFF;
    hi = nominal + CLIFF;
  };
  const list = mapCells.get(keyOf(x, z, BOX));
  if (list) {
    const cut = SITE_CUTS.length > 0 && inCut(x, z);
    for (const e of list) {
      const s = e.s;
      // Its triangles are made ahead of time (buildNear()), never in the frame that steps onto it
      if (cut || !s.tris || x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      const y = heightOn(s, x, z, true);
      if (y === null || y + e.lift <= best) continue;
      if (lo === null) band();
      if (y + e.lift >= lo && y + e.lift <= hi) {
        best = y + e.lift;
        what = e.what;
      }
    }
  }
  const key = keyOf(x, z, CELL);
  for (const [name, layer] of layers) {
    if (x < layer.x0 || x > layer.x1 || z < layer.z0 || z > layer.z1) continue;
    const T = layer.tris;
    for (const i of layer.cells.get(key) || []) {
      const y = standingIn(T[i], T[i + 1], T[i + 2], T[i + 3], T[i + 4], T[i + 5], T[i + 6], T[i + 7], T[i + 8], x, z);
      if (y === null || y <= best) continue;
      if (lo === null) band();
      if (y >= lo && y <= hi) {
        best = y;
        what = name;
      }
    }
  }
  lastWhat = what;
  return what === null ? null : best;
}
const drawnWhat = () => lastWhat;

/** How far over the ground (groundHeight(), the flat simulation's) the highest thing drawn at (x, z) is, or null where there's nothing */
function drawnOver(x, z) {
  const y = drawnTop(x, z);
  return y === null ? null : y - groundHeight(x, z);
}

/**
 * Ahead of time, one thing at a call: a tile held near (x, z) looked through, or the triangles of the map's surface nearest it within
 * `reach` that hasn't them yet. Whether it did anything.
 */
function buildNear(x, z, reach = AHEAD) {
  for (const [key, tile] of pending) {
    const d = Math.hypot(Math.max(tile.ix * TILE - x, 0, x - (tile.ix + 1) * TILE), Math.max(tile.iz * TILE - z, 0, z - (tile.iz + 1) * TILE));
    if (d > reach + TILE_REACH) continue;
    pending.delete(key);
    indexTile(tile);
    return true;
  }
  let next = null, nearest = Infinity;
  for (let cx = Math.floor((x - reach) / BOX); cx <= Math.floor((x + reach) / BOX); cx++) {
    for (let cz = Math.floor((z - reach) / BOX); cz <= Math.floor((z + reach) / BOX); cz++) {
      for (const { s } of mapCells.get(cx * 100000 + cz) || []) {
        if (s.tris) continue;
        const d = Math.hypot(Math.max(s.x0 - x, 0, x - s.x1), Math.max(s.z0 - z, 0, z - s.z1));
        if (d <= reach && d < nearest) {
          nearest = d;
          next = s;
        }
      }
    }
  }
  if (next) buildSurface(next);
  return !!next;
}

export {
  LAWN_TOP, LIFT, PATH_TOP, ROCK_LIFT, SAND_LIFT, TRACK, TRACK_TOP, buildNear, pathTop, buildSurface, drawnOver, drawnTop, drawnWhat, dropLayer, dropLayers, heightInTriangle, heightOn,
  setLayer, surfaceOf, trianglesOf
};
