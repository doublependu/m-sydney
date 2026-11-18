import * as THREE from 'three/webgpu';
import { groundHeight } from './surfaces.js';
import { createGardenBedMaterial, createGardenPathMaterial, createParkLawnMaterial, createPondMaterial, createSandstoneWallMaterial } from './tsl-materials.js';
import { CITY_BOUNDS, LAWNS, PAVEMENTS } from './city-config.js';
import { GroundCells, SIDEWALK_TOP, addSurface } from './ground-geometry.js';
import { TILE } from './geodata.js';
import {
  KERB_PROUD, LAWN_TOP, PATH_TOP, RAISED_TOP, TRACK, TRACK_LIFT, TRACK_TOP, buildSurface, heightInTriangle, heightOn, pathTop, setLayer, surfaceOf,
  trianglesOf
} from './drawn-ground.js';
import { areaOf, drape, drapePolygon } from './drape.js';

// A garden's ground, laid over a tile's lawns (tools/build-garden.mjs): its footpaths, beds, hedges, ponds and the gates on its paths, and in
// a formal park the lawn raised over its paved paths, kerbed along every edge. Only a few areas have them yet: the Royal Botanic Garden,
// the Domain, round the Opera House and Circular Quay, Bronte Park, the CBD's parks (Hyde Park, Barangaroo Reserve, Observatory Hill,
// Wynyard Park), Bradfield Park under the Harbour Bridge's north end, Prince Alfred Park, Darling Harbour's Tumbalong Park and Chinese
// Garden of Friendship, and Centennial Park and Moore Park.
//   tile.garden: { paths: [[kind, surface, width, x, z, ...]], gates: [[x, z, heading, width]], hedges: [[height, width, x, z, ...]],
//     ponds: [[x, z, ...]], beds: [[kind, x, z, ...]], seawalls: [[side, x, z, ...]], lawns: [[kerb, [x, z, ...], ...holes]],
//     plazas: [[surface, [x, z, ...], ...holes]], fountains: [[x, z, r]], rockPonds: [[x, z, ...]], islands: [[x, z, ...]] }
//   (a raised lawn's pieces, `kerb` what its kerbs are: 0 concrete, 1 sandstone; paved areas, as plazas round a fountain, and fountains,
//   each the middle of one of its ponds and how far that is from the pond's edge, ponds edged with rocks, and islands in its ponds, with the
//   tile their pond's in, where a tile has any)
// In layers, each laid exactly on the triangles of what's under it (js/drape.js), so on a slope none comes up through another: the map's
// lawn and paving (js/city-grid.js); the paths, just over them; the raised lawn 8 cm over the map's lawn, its kerbs' tops 1 cm over it
// at their outer edge, their faces down to the paths; and tracks and beds on the raised lawn, or tracks on the map's lawn off it.
// Kinds of path: 0 a footpath, 1 steps, 2 a cycleway, 3 a track (a worn strip on the lawn, with no kerb, whatever it was in OSM). Surfaces:
// 0 paving, 1 asphalt, 2 gravel, 3 timber, 4 trodden grass, 5 dirt, 6 sand, 7 concrete. Trodden grass is drawn only as a track.
// Beds, by what's planted in them: 0 shrubs, 1 succulents on gravel, 2 flowers and roses, 3 Australian natives.

// Heights over the ground: the lawn's, the raised lawn's, a path's by what it's made of, a track's, the steps' and pathTop() are
// js/drawn-ground.js's (each lies a little over the lawn as it's drawn, lawnSurface()), which stands you on them too
const linearHex = (hex) => new THREE.Color(hex).toArray();
const BED_LIFT = 0.03; // a bed over the lawn it's dug in
const BED_TOP = LAWN_TOP + BED_LIFT;
const POND_TOP = LAWN_TOP + 0.02;
const COPING = { width: 0.32, rise: 0.08 };
// A fountain's basin (tools/build-garden.mjs `fountains`): its rim over the pond's level, its water under the rim's top, and its middle's
// plinth, for a basin at least `plinthFrom` m from its middle to its edge (the Archibald Fountain's is 10.6): a smaller one, as East
// Circular Quay's (4.2), has the rim alone
const FOUNTAIN = { rim: 0.42, rimWidth: 0.55, water: 0.3, plinthFrom: 8 };
const GRANITE = linearHex(0x6e5048), BRONZE = linearHex(0x3b3426);
// A pond edged with rocks (a Chinese garden's lake: grey limestone boulders along the water, some stacked into a rockery): one every
// `every` m or so along its edge, `w` along it and `d` across, from under the water to `h` over it, narrowing to an uneven top; one in
// `stacked` with a smaller one on it; mid greys, as paler ones read white in the sun. Not stood on, as a fountain's rim isn't.
const ROCKS = { every: 0.9, w: [0.55, 1.3], d: [0.5, 1.0], h: [0.15, 0.55], under: 0.15, stacked: 0.25, shared: 0.2,
  tones: [0x8e8a80, 0x7a766d, 0x9a958a, 0x6c6962].map(linearHex) };
const KERB_WIDTH = 0.1; // m: in the corridor beside its path's edge, or round a pond in its water (tools/build-garden.mjs)
const KERB_STONE = [linearHex(0xa9a59b), linearHex(0xc4a679)]; // concrete, sandstone (the Royal Botanic Garden's)
const KERB_FOOT = 0.04; // m a kerb's face reaches under whatever it stands on
const UNDER_KERB = 0.03; // m a kerbed path is drawn wider either side, under its kerbs, so no lawn shows between the two
const SQUARE = 240; // m: the squares the raised lawn is traced in, whose edges are seams, not edges
const STEP = 2; // m between a pond's coping's points, so it follows the lawn's triangles
const PIECE = 3; // m: a bed's or pond's triangles are cut no longer than this, to follow the lawn
// A sea wall's parapet along the shore, its face from under the water up to its top, so the water's level shows against the stone. It
// stands from a metre out past the shore's line (js/city-grid.js draws the sea wall's own face on it) to `thickness` in: the lawn's
// outline and the shore's are each traced from the land to within a metre, and the lawn can reach out past the shore by that much.
const PARAPET = { height: 0.6, thickness: 0.45, out: 1.0, coping: 0.07, overhang: 0.05, stop: 1.1 };

const over = (m) => {
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  return m;
};
// The raised lawn is drawn in the map's own lawn material, which js/city-grid.js hands over as it makes it (useMapLawn()): the same grass
// at the same place, so there's nothing more to compile, and two lawns 8 cm apart can't be seen to fight far off
let mapLawn = null;
function useMapLawn(material) {
  mapLawn = material;
  if (shared) shared.lawn = material;
}

// One set for every tile, so a new tile compiles nothing; few of them, as a tile draws each once. The paths' surfaces, and the stonework,
// kerbs and iron, are colours in their vertices; which kind each bed is, too (createGardenBedMaterial()).
let shared = null;
function gardenMaterials() {
  if (shared) return shared;
  shared = {
    lawn: mapLawn ?? createParkLawnMaterial(false),
    paths: over(createGardenPathMaterial()),
    beds: over(createGardenBedMaterial([
      { soil: 0x3a2a1e, speckles: [0x3d5f2a, 0x47692f, 0x2f4a22], cover: 0.45 }, { soil: 0xa39783, speckles: [0x7d9a8a, 0x6f8b7c, 0x8a8f5a], cover: 0.35 },
      { soil: 0x3a2a1e, speckles: [0xb0283a, 0xd8708a, 0xe0b030], cover: 0.5 }, { soil: 0x3f3022, speckles: [0x5f6e48, 0x6b7a52, 0x7a5040], cover: 0.45 }
    ])),
    pond: over(createPondMaterial()),
    wall: createSandstoneWallMaterial({ waterLevel: CITY_BOUNDS.waterLevel }),
    stone: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.8 }),
    hedge: new THREE.MeshStandardNodeMaterial({ color: 0x35612f, roughness: 0.9 })
  };
  return shared;
}
// The paths' surfaces: paving, asphalt, gravel, timber, trodden grass, dirt, sand, concrete; and steps, in sandstone
const SURFACES = [0xa59d8f, 0x56575a, 0xb8a582, 0x7d5f42, 0x8a8455, 0x8c6e4c, 0xd2bf94, 0x7f7d79].map(linearHex);
const SANDSTONE = linearHex(0xc4a679), IRON = linearHex(0x1d1e1f);

/**
 * Ground cells with a colour at each vertex: set `tint` before adding to them. With `worn`, a fourth value too, `wear`: 1 for a path laid
 * on the lawn, and how far across a track a vertex is for a track's, 0 to 0.5 (createGardenPathMaterial()).
 */
class TintedCells extends GroundCells {
  constructor(worn = false) {
    super(1e6);
    this.tint = [1, 1, 1];
    this.worn = worn;
    this.wear = 1;
  }
  cell(x, z) {
    const c = super.cell(x, z);
    c.color ||= [];
    if (this.worn) c.colorSize = 4;
    return c;
  }
  vertex(c, x, y, z, nx, ny, nz) {
    c.color.push(...this.tint);
    if (this.worn) c.color.push(this.wear);
    return super.vertex(c, x, y, z, nx, ny, nz);
  }
}

/**
 * The lawn's height under (x, z) as js/city-grid.js draws it, or null off the lawns: each lawn is laid with addSurface() on the height
 * grid's nodes, 20 m apart, and its own edges, so its triangles are straight where the ground bends between the nodes, and on a slope
 * the lawn came up through anything laid on the ground's own height. Any held tile's lawn near `tile`: a lawn's 240 m square can reach
 * over a tile's edge, though it's the other tile's. Each lawn's triangles are made the first time a height is asked of it, and kept
 * while the lawn is (js/drawn-ground.js, which the walker and what's ridden stand on too).
 */
const lawnSurface = (tile) => drawnSurface(LAWNS, tile);
/** The same for the footpaths' paving (js/city-config.js PAVEMENTS), which is laid the same way: for a driveway's crossover */
const pavingSurface = (tile) => drawnSurface(PAVEMENTS, tile);
function drawnSurface(list, tile) {
  const BOX = 32, CELL = 4, NEAR = 300;
  const x0 = tile.ix * TILE - NEAR, x1 = (tile.ix + 1) * TILE + NEAR, z0 = tile.iz * TILE - NEAR, z1 = (tile.iz + 1) * TILE + NEAR;
  const index = new Map();
  for (const rings of list) {
    const lawn = surfaceOf(rings);
    if (lawn.x1 < x0 || lawn.x0 > x1 || lawn.z1 < z0 || lawn.z0 > z1) continue;
    for (let cx = Math.floor(lawn.x0 / BOX); cx <= Math.floor(lawn.x1 / BOX); cx++) {
      for (let cz = Math.floor(lawn.z0 / BOX); cz <= Math.floor(lawn.z1 / BOX); cz++) {
        const key = cx * 100000 + cz;
        (index.get(key) || index.set(key, []).get(key)).push(lawn);
      }
    }
  }
  const heightAt = (x, z) => {
    for (const lawn of index.get(Math.floor(x / BOX) * 100000 + Math.floor(z / BOX)) || []) {
      const y = heightOn(lawn, x, z);
      if (y !== null) return y;
    }
    return null;
  };
  // The triangles themselves, as drawn (without their lift), over a box: [[x, y, z] x 3], each once. For laying something exactly on
  // them, a piece of it in each triangle's plane (js/verge.js)
  heightAt.trianglesIn = (bx0, bz0, bx1, bz1) => {
    const lawns = new Set();
    for (let cx = Math.floor(bx0 / BOX); cx <= Math.floor(bx1 / BOX); cx++) {
      for (let cz = Math.floor(bz0 / BOX); cz <= Math.floor(bz1 / BOX); cz++) {
        for (const lawn of index.get(cx * 100000 + cz) || []) if (!(bx1 < lawn.x0 || bx0 > lawn.x1 || bz1 < lawn.z0 || bz0 > lawn.z1)) lawns.add(lawn);
      }
    }
    const out = new Set();
    for (const lawn of lawns) {
      if (!lawn.tris) buildSurface(lawn);
      // All of it, where the box holds it; or the cells of it in the box
      if (bx0 <= lawn.x0 && bx1 >= lawn.x1 && bz0 <= lawn.z0 && bz1 >= lawn.z1) {
        lawn.all ||= [...new Set([...lawn.tris.values()].flat())];
        for (const t of lawn.all) out.add(t);
        continue;
      }
      for (let ix = Math.floor(Math.max(bx0, lawn.x0) / CELL); ix <= Math.floor(Math.min(bx1, lawn.x1) / CELL); ix++) {
        for (let iz = Math.floor(Math.max(bz0, lawn.z0) / CELL); iz <= Math.floor(Math.min(bz1, lawn.z1) / CELL); iz++) {
          for (const t of lawn.tris.get(ix * 100000 + iz) || []) out.add(t);
        }
      }
    }
    return [...out];
  };
  /** Its surfaces over a box whose triangles aren't made yet, to make one at a time ahead of trianglesIn() (buildSurface()) */
  heightAt.unbuilt = (bx0, bz0, bx1, bz1) => {
    const out = new Set();
    for (let cx = Math.floor(bx0 / BOX); cx <= Math.floor(bx1 / BOX); cx++) {
      for (let cz = Math.floor(bz0 / BOX); cz <= Math.floor(bz1 / BOX); cz++) {
        for (const lawn of index.get(cx * 100000 + cz) || []) if (!lawn.tris && !(bx1 < lawn.x0 || bx0 > lawn.x1 || bz1 < lawn.z0 || bz0 > lawn.z1)) out.add(lawn);
      }
    }
    return [...out];
  };
  return heightAt;
}

const pointsOf = (flat, from = 0) => {
  const out = [];
  for (let i = from; i + 1 < flat.length; i += 2) out.push({ x: flat[i], z: flat[i + 1] });
  return out;
};

/** A polyline with points no further apart than `step` */
function dense(pts, step = STEP) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}

/** Each point's way across a polyline: the mean of its two segments' normals, with its mitre's stretch (no more than 2) */
function across(pts) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const prev = i > 0 ? norm(p.x - a.x, p.z - a.z) : null, next = i < pts.length - 1 ? norm(b.x - p.x, b.z - p.z) : null;
    const d = prev && next ? norm(prev.x + next.x, prev.z + next.z) : prev || next;
    const stretch = prev && next ? Math.min(2, 1 / Math.max(0.5, d.x * next.x + d.z * next.z)) : 1;
    return { x: -d.z * stretch, z: d.x * stretch };
  });
}
function norm(x, z) {
  const L = Math.hypot(x, z) || 1;
  return { x: x / L, z: z / L };
}

/** A strip `width` across along a polyline, `lift` over the height `heightAt` gives at its points: a pond's coping */
function addRibbon(cells, pts, width, lift, heightAt) {
  if (pts.length < 2) return;
  const line = dense(pts);
  const side = across(line);
  const c = cells.cell(line[0].x, line[0].z);
  const h = width / 2;
  let prev = null;
  for (let i = 0; i < line.length; i++) {
    const p = line[i], s = side[i];
    const row = [1, -1].map((k) => {
      const x = p.x + s.x * h * k, z = p.z + s.z * h * k;
      return cells.vertex(c, x, heightAt(x, z) + lift, z, 0, 1, 0);
    });
    // Up: counter-clockwise from above, with z pointing south
    if (prev) c.index.push(prev[0], row[0], prev[1], prev[1], row[0], row[1]);
    prev = row;
  }
}

/**
 * Triangles laid on the ground (x, y, z of each corner, facing up: js/drape.js), into ground cells, a point shared by the triangles that
 * meet at it. `wearOf(x, z)`: a track's wear at each point (TintedCells).
 */
function addLaid(cells, tris, wearOf = null) {
  if (!tris.length) return;
  const c = cells.cell(tris[0], tris[2]);
  const ids = new Map();
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    const key = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
    let id = ids.get(key);
    if (id === undefined) {
      if (wearOf) cells.wear = wearOf(x, z);
      ids.set(key, (id = cells.vertex(c, x, y, z, 0, 1, 0)));
    }
    c.index.push(id);
  }
  if (wearOf) cells.wear = 1;
}

/**
 * A path `width` across along a polyline as flat pieces, one a segment, mitred where it bends as the paths always were (across()): each
 * { ring: [{ x, z } x 4], a, ux, uz, h }, its segment's start, its way along and its half width. A piece whose corners don't make a convex
 * quad (a short segment at a sharp bend) comes as its two triangles that do face up.
 */
function pathPieces(pts, width) {
  const side = across(pts);
  const h = width / 2;
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], sa = side[i - 1], sb = side[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-3) continue;
    const ring = [
      { x: a.x + sa.x * h, z: a.z + sa.z * h }, { x: b.x + sb.x * h, z: b.z + sb.z * h },
      { x: b.x - sb.x * h, z: b.z - sb.z * h }, { x: a.x - sa.x * h, z: a.z - sa.z * h }
    ];
    const seg = { a, ux: (b.x - a.x) / L, uz: (b.z - a.z) / L, h };
    const turns = ring.map((p, k) => {
      const q = ring[(k + 1) % 4], r = ring[(k + 2) % 4];
      return (q.x - p.x) * (r.z - q.z) - (q.z - p.z) * (r.x - q.x);
    });
    if (turns.every((t) => t > 1e-9) || turns.every((t) => t < -1e-9)) out.push({ ring, ...seg });
    else {
      for (const tri of [[ring[0], ring[1], ring[2]], [ring[0], ring[2], ring[3]]]) if (Math.abs(areaOf(tri)) > 1e-6) out.push({ ring: tri, ...seg });
    }
  }
  return out;
}

/** A track's wear at (x, z) on its piece: how far across it, 0 at its left side, a quarter down its middle, a half at its right */
const wearAcross = (piece) => (x, z) => {
  const side = (-(x - piece.a.x) * piece.uz + (z - piece.a.z) * piece.ux) / piece.h;
  return Math.min(0.5, Math.max(0, (1 - side) / 4));
};

// --- The raised lawn -------------------------------------------------------------------------------------------------------------

/** Triangles, x, y, z of each corner in the world's heights, found by 4 m cell: a raised lawn as laid, for what's laid on it in turn */
class LaidSurface {
  constructor() {
    this.cells = new Map();
    this.count = 0;
  }
  add(tris) {
    for (let i = 0; i < tris.length; i += 9) {
      const t = [[tris[i], tris[i + 1], tris[i + 2]], [tris[i + 3], tris[i + 4], tris[i + 5]], [tris[i + 6], tris[i + 7], tris[i + 8]]];
      for (let cx = Math.floor(Math.min(t[0][0], t[1][0], t[2][0]) / 4); cx <= Math.floor(Math.max(t[0][0], t[1][0], t[2][0]) / 4); cx++) {
        for (let cz = Math.floor(Math.min(t[0][2], t[1][2], t[2][2]) / 4); cz <= Math.floor(Math.max(t[0][2], t[1][2], t[2][2]) / 4); cz++) {
          const key = cx * 100000 + cz;
          (this.cells.get(key) || this.cells.set(key, []).get(key)).push(t);
        }
      }
      this.count++;
    }
  }
  trianglesIn(x0, z0, x1, z1) {
    const out = new Set();
    for (let cx = Math.floor(x0 / 4); cx <= Math.floor(x1 / 4); cx++) {
      for (let cz = Math.floor(z0 / 4); cz <= Math.floor(z1 / 4); cz++) for (const t of this.cells.get(cx * 100000 + cz) || []) out.add(t);
    }
    return [...out];
  }
  /** Its top at (x, z), or null off it */
  at(x, z) {
    for (const t of this.cells.get(Math.floor(x / 4) * 100000 + Math.floor(z / 4)) || []) {
      const y = heightInTriangle(t, x, z);
      if (y !== null) return y;
    }
    return null;
  }
}

/** Whether (x, z) is inside a ring of { x, z } */
const insideRing = (ring, x, z) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
};
const boxOf = (pts) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  return { x0, x1, z0, z1 };
};
const onSeam = (a, b) => (a.x === b.x && Math.abs(a.x / SQUARE - Math.round(a.x / SQUARE)) < 1e-9)
  || (a.z === b.z && Math.abs(a.z / SQUARE - Math.round(a.z / SQUARE)) < 1e-9);

const BEND = 0.003; // m the lawn may bend under a kerb's top between two of its points

/** Of the points along an edge `L` m long ({ t: its share along, y }), those where what's between strays BEND or more from straight */
function bends(line, L) {
  if (line.length < 3) return line;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let worst = BEND, at = -1;
    for (let k = i + 1; k < j; k++) {
      const f = (line[k].t - line[i].t) / (line[j].t - line[i].t || 1e-12);
      const off = Math.abs(line[k].y - (line[i].y + (line[j].y - line[i].y) * f));
      if (off >= worst) { worst = off; at = k; }
    }
    if (at >= 0) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return line.filter((_, k) => keep[k]);
}

/**
 * The kerbs along a raised lawn's edges (`rings`, its outline and holes), into `cells` (its tint set): along each, out from the lawn,
 * KERB_WIDTH wide, its top from the lawn's edge out to KERB_PROUD over it, and a face from there down under whatever's beside it. Not along
 * a seam between two squares' pieces. Its top follows the lawn's triangles (`tris`, without their lift), as the raised lawn's edge does, a
 * point at each of their edges where the lawn bends there (bends()). Returns the tops' triangles, x, y, z each corner, for what stands on
 * them.
 */
function addKerbs(cells, rings, tris, below) {
  const c = cells.cell(rings[0][0].x, rings[0][0].z);
  const tops = [];
  // The lawn's triangles by 8 m cell (most are bigger), to find those along each edge
  const near = new Map(), CELL = 8;
  for (const t of tris) {
    for (let cx = Math.floor(Math.min(t[0][0], t[1][0], t[2][0]) / CELL); cx <= Math.floor(Math.max(t[0][0], t[1][0], t[2][0]) / CELL); cx++) {
      for (let cz = Math.floor(Math.min(t[0][2], t[1][2], t[2][2]) / CELL); cz <= Math.floor(Math.max(t[0][2], t[1][2], t[2][2]) / CELL); cz++) {
        const key = cx * 100000 + cz;
        (near.get(key) || near.set(key, []).get(key)).push(t);
      }
    }
  }
  const along = (a, b) => {
    const x0 = Math.floor(Math.min(a.x, b.x) / CELL), x1 = Math.floor(Math.max(a.x, b.x) / CELL);
    const z0 = Math.floor(Math.min(a.z, b.z) / CELL), z1 = Math.floor(Math.max(a.z, b.z) / CELL);
    if (x0 === x1 && z0 === z1) return near.get(x0 * 100000 + z0) || [];
    const out = new Set();
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) for (const t of near.get(cx * 100000 + cz) || []) out.add(t);
    return out;
  };
  const plane = (t) => {
    const [a, b, d] = t;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    const den = ux * vz - uz * vx;
    if (Math.abs(den) < 1e-9) return null;
    const gx = (uy * vz - uz * vy) / den, gz = (ux * vy - uy * vx) / den;
    return (x, z) => a[1] + gx * (x - a[0]) + gz * (z - a[2]);
  };
  for (const [k, ring] of rings.entries()) {
    const n = ring.length;
    if (n < 3) continue;
    // Out from the lawn: off the outline's inside, into a hole's
    const sign = (areaOf(ring) > 0 ? 1 : -1) * (k === 0 ? -1 : 1);
    const edges = ring.map((a, i) => {
      const b = ring[(i + 1) % n];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      return { a, b, L, kept: L > 1e-4 && !onSeam(a, b), ox: L ? ((b.z - a.z) / L) * sign : 0, oz: L ? (-(b.x - a.x) / L) * sign : 0 };
    });
    // Out at each point: mitred between its two edges' ways, as long as both are kerbed
    const outAt = edges.map((e, i) => {
      const p = edges[(i + n - 1) % n];
      if (!p.kept || !e.kept) return e.kept ? { x: e.ox, z: e.oz } : { x: p.ox, z: p.oz };
      let mx = p.ox + e.ox, mz = p.oz + e.oz;
      const L = Math.hypot(mx, mz);
      if (L < 1e-6) return { x: e.ox, z: e.oz };
      mx /= L; mz /= L;
      const stretch = Math.min(2, 1 / Math.max(0.5, mx * e.ox + mz * e.oz));
      return { x: mx * stretch, z: mz * stretch };
    });
    for (const [i, e] of edges.entries()) {
      if (!e.kept) continue;
      const { a, b } = e;
      // Where it crosses the lawn's triangles: each run in one, by the share of the edge along
      const runs = [];
      for (const t of along(a, b)) {
        if (Math.max(t[0][0], t[1][0], t[2][0]) < Math.min(a.x, b.x) - 1e-6 || Math.min(t[0][0], t[1][0], t[2][0]) > Math.max(a.x, b.x) + 1e-6
          || Math.max(t[0][2], t[1][2], t[2][2]) < Math.min(a.z, b.z) - 1e-6 || Math.min(t[0][2], t[1][2], t[2][2]) > Math.max(a.z, b.z) + 1e-6) continue;
        // Cyrus and Beck: the part of a-b inside each of the triangle's three sides
        const ring3 = [{ x: t[0][0], z: t[0][2] }, { x: t[1][0], z: t[1][2] }, { x: t[2][0], z: t[2][2] }];
        const wind = areaOf(ring3) > 0 ? 1 : -1;
        let t0 = 0, t1 = 1;
        for (let j = 0; j < 3 && t0 <= t1; j++) {
          const p = ring3[j], q = ring3[(j + 1) % 3];
          // Inside: as the triangle's winding keeps it, as js/drape.js clipConvex() reckons a side
          const side = (s) => ((q.z - p.z) * (s.x - p.x) - (q.x - p.x) * (s.z - p.z)) * wind;
          const sa = side(a), sb = side(b);
          if (sa < 0 && sb < 0) { t0 = 2; break; }
          if (sa < 0) t0 = Math.max(t0, sa / (sa - sb));
          else if (sb < 0) t1 = Math.min(t1, sa / (sa - sb));
        }
        if (t1 - t0 > 1e-6) runs.push({ t0, t1, y: plane(t) });
      }
      runs.sort((p, q) => p.t0 - q.t0);
      // The lawn's height along it, in stretches where it's on the lawn: a point where it crosses into each triangle, kept where the lawn
      // bends there by BEND or more (a kerb's top through the rest strays from the lawn's edge by less)
      const stretches = [];
      let reached = 0, stretch = null;
      for (const r of runs) {
        if (!r.y || r.t1 <= reached + 1e-6) continue;
        const from = Math.max(r.t0, reached);
        const point = (t) => ({ t, y: r.y(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t) });
        if (!stretch || from > reached + 1e-6) stretches.push((stretch = [point(from)]));
        stretch.push(point(r.t1));
        reached = r.t1;
      }
      const at = (t) => (t <= 1e-9 ? outAt[i] : t >= 1 - 1e-9 ? outAt[(i + 1) % n] : { x: e.ox, z: e.oz });
      for (const line of stretches) {
        const kept = bends(line, e.L);
        const ends = kept.map(({ t, y }) => {
          const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, o = at(t);
          const ox = x + o.x * KERB_WIDTH, oz = z + o.z * KERB_WIDTH;
          return { x, z, ox, oz, top: y + RAISED_TOP, foot: Math.min(y + LAWN_TOP, below(ox, oz)) - KERB_FOOT };
        });
        for (let j = 1; j < ends.length; j++) {
          const p = ends[j - 1], q = ends[j];
          // Its top: the lawn's edge, then out and up to KERB_PROUD over it
          const v = [
            cells.vertex(c, p.x, p.top, p.z, 0, 1, 0), cells.vertex(c, q.x, q.top, q.z, 0, 1, 0),
            cells.vertex(c, q.ox, q.top + KERB_PROUD, q.oz, 0, 1, 0), cells.vertex(c, p.ox, p.top + KERB_PROUD, p.oz, 0, 1, 0)
          ];
          const quad = [{ x: p.x, z: p.z }, { x: q.x, z: q.z }, { x: q.ox, z: q.oz }];
          if (areaOf(quad) >= 0) c.index.push(v[0], v[1], v[2], v[0], v[2], v[3]);
          else c.index.push(v[0], v[2], v[1], v[0], v[3], v[2]);
          tops.push(p.x, p.top, p.z, q.x, q.top, q.z, q.ox, q.top + KERB_PROUD, q.oz, p.x, p.top, p.z, q.ox, q.top + KERB_PROUD, q.oz, p.ox, p.top + KERB_PROUD, p.oz);
          // Its face, out over the path, down under what's there
          addFace(cells, c, [[p.ox, p.foot, p.oz], [q.ox, q.foot, q.oz], [q.ox, q.top + KERB_PROUD, q.oz], [p.ox, p.top + KERB_PROUD, p.oz]], [e.ox, 0, e.oz]);
        }
      }
    }
  }
  return new Float32Array(tops);
}

/**
 * A flat shape (rings: the outer and its holes) laid `lift` over the height `heightAt` gives: triangulated as the lawn is, then cut into
 * pieces no longer than PIECE so that it bends where the lawn under it does
 */
function addDraped(cells, rings, lift, heightAt) {
  const flat = new GroundCells(1e6);
  addSurface(flat, rings, 0);
  const c = cells.cell(rings[0][0].x, rings[0][0].z);
  // Points shared between the pieces, by where they are
  const ids = new Map();
  const point = (x, z) => {
    const key = `${Math.round(x * 1000)},${Math.round(z * 1000)}`;
    let id = ids.get(key);
    if (id === undefined) ids.set(key, (id = cells.vertex(c, x, heightAt(x, z) + lift, z, 0, 1, 0)));
    return id;
  };
  const put = (a, b, d) => {
    // Its longest side halved, until none is longer than PIECE, keeping the way round it faces up
    const sides = [[a, b, d], [b, d, a], [d, a, b]];
    let longest = null, most = PIECE * PIECE;
    for (const t of sides) {
      const l = (t[1][0] - t[0][0]) ** 2 + (t[1][1] - t[0][1]) ** 2;
      if (l > most) { most = l; longest = t; }
    }
    if (longest) {
      const [p, q, r] = longest;
      const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      put(p, m, r);
      put(m, q, r);
      return;
    }
    c.index.push(point(a[0], a[1]), point(b[0], b[1]), point(d[0], d[1]));
  };
  for (const f of flat.cells.values()) {
    const P = f.position, I = f.index;
    for (let i = 0; i < I.length; i += 3) put(...[I[i], I[i + 1], I[i + 2]].map((v) => [P[v * 3], P[v * 3 + 2]]));
  }
}

/** A box along a polyline, `width` across and `height` up from `base` over the height `heightAt` gives: a hedge */
function addWallAlong(cells, pts, width, base, height, heightAt) {
  if (pts.length < 2) return;
  const line = dense(pts, 3);
  const side = across(line);
  const c = cells.cell(line[0].x, line[0].z);
  const h = width / 2;
  const rows = line.map((p, i) => {
    const s = side[i], y = heightAt(p.x, p.z) + base;
    return { l: [p.x + s.x * h, y, p.z + s.z * h], r: [p.x - s.x * h, y, p.z - s.z * h], s };
  });
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    // The two sides, then the top
    for (const [key, sign] of [['l', 1], ['r', -1]]) {
      const n = [a.s.x * sign, 0, a.s.z * sign];
      const v0 = cells.vertex(c, a[key][0], a[key][1] - 0.05, a[key][2], ...n), v1 = cells.vertex(c, b[key][0], b[key][1] - 0.05, b[key][2], ...n);
      const v2 = cells.vertex(c, a[key][0], a[key][1] + height, a[key][2], ...n), v3 = cells.vertex(c, b[key][0], b[key][1] + height, b[key][2], ...n);
      if (sign > 0) c.index.push(v0, v1, v2, v1, v3, v2);
      else c.index.push(v0, v2, v1, v1, v2, v3);
    }
    const t0 = cells.vertex(c, a.l[0], a.l[1] + height, a.l[2], 0, 1, 0), t1 = cells.vertex(c, b.l[0], b.l[1] + height, b.l[2], 0, 1, 0);
    const t2 = cells.vertex(c, a.r[0], a.r[1] + height, a.r[2], 0, 1, 0), t3 = cells.vertex(c, b.r[0], b.r[1] + height, b.r[2], 0, 1, 0);
    c.index.push(t0, t1, t2, t2, t1, t3);
  }
  // Its two ends
  for (const [row, dir] of [[rows[0], -1], [rows[rows.length - 1], 1]]) {
    const n = [row.s.z * dir, 0, -row.s.x * dir];
    const v0 = cells.vertex(c, row.l[0], row.l[1] - 0.05, row.l[2], ...n), v1 = cells.vertex(c, row.r[0], row.r[1] - 0.05, row.r[2], ...n);
    const v2 = cells.vertex(c, row.l[0], row.l[1] + height, row.l[2], ...n), v3 = cells.vertex(c, row.r[0], row.r[1] + height, row.r[2], ...n);
    if (dir > 0) c.index.push(v0, v1, v2, v1, v3, v2);
    else c.index.push(v0, v2, v1, v1, v2, v3);
  }
}

/** A flat four-cornered face ([x, y, z] each, in order round it), turned the way round that faces along `n` */
function addFace(cells, c, corners, n) {
  const ids = corners.map(([x, y, z]) => cells.vertex(c, x, y, z, n[0], n[1], n[2]));
  const [a, b, d] = corners;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
  const facing = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
  if (facing >= 0) c.index.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
  else c.index.push(ids[0], ids[2], ids[1], ids[0], ids[3], ids[2]);
}

/**
 * A sea wall's parapet along the shore `pts`, the land on the side `side` gives (as js/city-grid.js reads a shore's): its sea face from
 * under the water, its land face from the lawn, its top and a coping over both. Returns its colliders, one a
 * straight run, high enough not to be jumped.
 */
function addParapet(cells, pts, side, heightAt) {
  const P = PARAPET;
  // Its line is the shore's, straight between its points: a point every few metres only follows the ground along it
  const line = dense(pts, 4);
  const land = across(line).map((s) => ({ x: s.x * side, z: s.z * side }));
  const c = cells.cell(line[0].x, line[0].z);
  const rows = line.map((p, i) => {
    const n = land[i];
    const at = (d) => [p.x + n.x * d, p.z + n.z * d];
    const [ix, iz] = at(P.thickness);
    const lawn = heightAt(ix, iz) + LAWN_TOP;
    const ground = groundHeight(p.x, p.z);
    const top = Math.max(ground + LAWN_TOP, lawn) + P.height;
    return { n, outer: at(-P.out), inner: at(P.thickness), copeOut: at(-P.out - P.overhang), copeIn: at(P.thickness + P.overhang), foot: CITY_BOUNDS.waterLevel - 0.6, lawn: lawn - 0.05, top };
  });
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    const sea = [-a.n.x, 0, -a.n.z], landward = [a.n.x, 0, a.n.z];
    const quad = (pa, ya0, ya1, pb, yb0, yb1, n) => addFace(cells, c, [[pa[0], ya0, pa[1]], [pb[0], yb0, pb[1]], [pb[0], yb1, pb[1]], [pa[0], ya1, pa[1]]], n);
    quad(a.outer, a.foot, a.top, b.outer, b.foot, b.top, sea);
    quad(a.inner, a.lawn, a.top, b.inner, b.lawn, b.top, landward);
    addFace(cells, c, [[a.outer[0], a.top, a.outer[1]], [b.outer[0], b.top, b.outer[1]], [b.inner[0], b.top, b.inner[1]], [a.inner[0], a.top, a.inner[1]]], [0, 1, 0]);
    // The coping, a little proud of both faces
    const ct = P.coping;
    quad(a.copeOut, a.top, a.top + ct, b.copeOut, b.top, b.top + ct, sea);
    quad(a.copeIn, a.top, a.top + ct, b.copeIn, b.top, b.top + ct, landward);
    addFace(cells, c, [[a.copeOut[0], a.top + ct, a.copeOut[1]], [b.copeOut[0], b.top + ct, b.copeOut[1]], [b.copeIn[0], b.top + ct, b.copeIn[1]], [a.copeIn[0], a.top + ct, a.copeIn[1]]], [0, 1, 0]);
  }
  // Its two ends, where steps or a jetty open it
  for (const [r, k] of [[rows[0], 0], [rows[rows.length - 1], rows.length - 1]]) {
    const next = rows[k === 0 ? 1 : k - 1];
    const dx = r.outer[0] - next.outer[0], dz = r.outer[1] - next.outer[1], L = Math.hypot(dx, dz) || 1;
    const n = [dx / L, 0, dz / L];
    addFace(cells, c, [[r.outer[0], r.foot, r.outer[1]], [r.inner[0], r.foot, r.inner[1]], [r.inner[0], r.top + PARAPET.coping, r.inner[1]], [r.outer[0], r.top + PARAPET.coping, r.outer[1]]], n);
  }
  // Colliders along its own straight runs, standing over the ground as every collider does (the simulation is flat)
  const colliders = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 0.05) continue;
    const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
    // The land side, as across() reckons it
    const nx = -uz * side, nz = ux * side;
    const half = (P.thickness + P.out) / 2, mid = (P.thickness - P.out) / 2;
    const cx = (a.x + b.x) / 2 + nx * mid, cz = (a.z + b.z) / 2 + nz * mid;
    const yaw = Math.atan2(ux, uz), hx = half, hz = L / 2 + 0.05;
    const ex = Math.abs(Math.cos(yaw)) * hx + Math.abs(Math.sin(yaw)) * hz, ez = Math.abs(Math.sin(yaw)) * hx + Math.abs(Math.cos(yaw)) * hz;
    colliders.push({ minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, minY: 0, maxY: P.stop, obb: { cx, cz, hx, hz, cs: Math.cos(yaw), sn: Math.sin(yaw) } });
  }
  return colliders;
}

/** 0 to 1, the same every time for the same place and `k` */
const hashAt = (x, z, k = 0) => {
  const s = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return s - Math.floor(s);
};
/** How far (x, z) is from a ring of { x, z } */
function ringDistance(ring, x, z) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i], dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
    best = Math.min(best, Math.hypot(a.x + dx * t - x, a.z + dz * t - z));
  }
  return best;
}

/**
 * Rocks along a pond's edge (a ring of { x, z }), astride it, each turned along the edge (ROCKS); none reaching within ROCKS.shared of
 * `others`' edges, where two ponds meet and the water runs on between them. Into `cells` (TintedCells), their tones in it.
 */
function addRocks(cells, ring, others, heightAt) {
  const lerp = ([a, b], t) => a + (b - a) * t;
  let next = 0, walked = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-3) continue;
    const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
    for (; next <= walked + L; ) {
      const t = (next - walked) / L, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const r = [1, 2, 3, 4, 5, 6, 7].map((k) => hashAt(x, z, k));
      next += ROCKS.every * (0.7 + 0.6 * r[0]);
      // Astride the edge, a little either way across it, turned a little off it
      const off = (r[1] - 0.5) * 0.3, cx = x - uz * off, cz = z + ux * off;
      const yaw = Math.atan2(ux, uz) + (r[2] - 0.5) * 0.8;
      const w = lerp(ROCKS.w, r[3]), d = lerp(ROCKS.d, r[4]), h = lerp(ROCKS.h, r[5]);
      // Kept off another pond's edge by its own reach (a corner of its foot, pulled out, is within 0.8 of its size from its middle)
      if (others.some((o) => ringDistance(o, cx, cz) < 0.8 * Math.max(w, d) + ROCKS.shared)) continue;
      const y = heightAt(cx, cz) + POND_TOP - ROCKS.under;
      cells.tint = ROCKS.tones[Math.floor(r[6] * ROCKS.tones.length)];
      addRock(cells, cx, cz, yaw, w, d, y, h + ROCKS.under, hashAt(x, z, 8));
      if (r[5] < ROCKS.stacked) {
        // A smaller one on it, off to one side: a rockery
        const s = hashAt(x, z, 9);
        addRock(cells, cx + (s - 0.5) * w * 0.4, cz + (hashAt(x, z, 10) - 0.5) * d * 0.4, yaw + s, w * 0.6, d * 0.6, y + h + ROCKS.under - 0.1, 0.25 + s * 0.35, s);
      }
    }
    walked += L;
  }
}

/**
 * A rock: a block about `w` by `d` at its foot, `h` up from `y`, turned `yaw` about (x, z), narrowing to a top that leans off its middle.
 * Each corner of its foot is pulled in or out, and each of its top's drawn in and lowered, by its own share (from `seed`), so no two are
 * alike. Its sides and top each face their own way, flat.
 */
function addRock(cells, x, z, yaw, w, d, y, h, seed) {
  const c = cells.cell(x, z);
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const at = (u, v, yy) => [x + u * cs + v * sn, yy, z - u * sn + v * cs];
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const r = (k, salt) => hashAt(seed * 7.1 + k, seed * 3.3 - k, salt);
  const foot = corners.map(([u, v], k) => at((u * w * (0.75 + 0.35 * r(k, 13))) / 2, (v * d * (0.75 + 0.35 * r(k, 14))) / 2, y));
  const lean = [(r(0, 15) - 0.5) * w * 0.3, (r(1, 15) - 0.5) * d * 0.3];
  const top = corners.map(([u, v], k) => {
    const inset = 0.35 + 0.4 * r(k, 11), drop = 0.6 + 0.4 * r(k, 12);
    return at(lean[0] + (u * w * inset) / 2, lean[1] + (v * d * inset * (0.7 + 0.5 * r(k, 16))) / 2, y + h * drop);
  });
  const mid = [x, y + h / 2, z];
  // A triangle facing out from the rock's middle
  const tri = (p, q, r) => {
    const e1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], e2 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const out = [(p[0] + q[0] + r[0]) / 3 - mid[0], (p[1] + q[1] + r[1]) / 3 - mid[1], (p[2] + q[2] + r[2]) / 3 - mid[2]];
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) {
      [q, r] = [r, q];
      n = n.map((v) => -v);
    }
    const L = Math.hypot(...n) || 1;
    const ids = [p, q, r].map((v) => cells.vertex(c, v[0], v[1], v[2], n[0] / L, n[1] / L, n[2] / L));
    c.index.push(...ids);
  };
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    tri(foot[i], foot[j], top[i]);
    tri(foot[j], top[j], top[i]);
  }
  tri(top[0], top[1], top[2]);
  tri(top[0], top[2], top[3]);
}

/** An upright box, `w` by `d` and `h` up from `y`, turned `yaw` about (x, z) */
function addBox(cells, x, z, yaw, w, d, y, h) {
  const c = cells.cell(x, z);
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const at = (u, v) => [x + u * cs + v * sn, z - u * sn + v * cs];
  const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([u, v]) => at(u, v));
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
    const n = norm(bz - az, -(bx - ax));
    const v0 = cells.vertex(c, ax, y, az, n.x, 0, n.z), v1 = cells.vertex(c, bx, y, bz, n.x, 0, n.z);
    const v2 = cells.vertex(c, ax, y + h, az, n.x, 0, n.z), v3 = cells.vertex(c, bx, y + h, bz, n.x, 0, n.z);
    c.index.push(v0, v2, v1, v1, v2, v3);
  }
  const top = corners.map(([cx, cz]) => cells.vertex(c, cx, y + h, cz, 0, 1, 0));
  c.index.push(top[0], top[2], top[1], top[0], top[3], top[2]);
}

// A tile's garden in clusters, each drawn as meshes of its own: two gardens in one tile, Hyde Park North and the Domain with College St
// between them, are culled apart, so a view of one (or away from both) doesn't draw the other's. What the garden draws comes in pieces
// whose boxes, CLUSTER_GAP apart or nearer, are one cluster.
const CLUSTER_GAP = 60; // m
// A cluster wider or deeper than this (Centennial Park's fill whole tiles) is drawn in its squares (SQUARE, the raised lawn's), each their
// own meshes culled by distance one by one (SQUARE_CULL): drawn as one, a big park's garden is never far enough off to be left out from
// inside it, and from Centennial Park's middle the low level drew 65,000-77,000 of its triangles (15,000-23,000 in squares). Its details go
// nearer than a small garden's: a kerb or a track's edge is under a pixel long before then, and past the raised lawn's reach the map's
// lawn under it is the same grass, 8 cm down.
const BIG_CLUSTER = 1100; // m
const SQUARE_CULL = { lawn: 400, paths: 700, beds: 500, pond: 1200, stone: 300, hedge: 600, walls: 900 };
/**
 * (x, z) => the key of the cluster of `g`'s garden (x, z) is in: 0 for the first, or off them all; in a big one (BIG_CLUSTER), a string
 * naming the cluster and its square
 */
function gardenClusters(g) {
  const boxes = [];
  const add = (flat, from = 0) => { if (flat.length >= from + 2) boxes.push(boxOf(pointsOf(flat, from))); };
  for (const [, outer] of g.lawns ?? []) add(outer);
  for (const [, outer] of g.plazas ?? []) add(outer);
  for (const p of g.paths) add(p, 3);
  for (const b of g.beds) add(b, 1);
  for (const f of g.ponds) add(f);
  for (const f of g.rockPonds ?? []) add(f);
  for (const h of g.hedges) add(h, 2);
  for (const w of g.seawalls ?? []) add(w, 1);
  for (const [x, z] of g.gates) boxes.push({ x0: x, x1: x, z0: z, z1: z });
  // Joined where they come within the gap, sweeping along x
  boxes.sort((a, b) => a.x0 - b.x0);
  const up = boxes.map((_, i) => i);
  const root = (i) => { while (up[i] !== i) i = up[i] = up[up[i]]; return i; };
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length && boxes[j].x0 <= a.x1 + CLUSTER_GAP; j++) {
      const b = boxes[j];
      if (b.z0 <= a.z1 + CLUSTER_GAP && b.z1 >= a.z0 - CLUSTER_GAP) up[root(j)] = root(i);
    }
  }
  const clusters = new Map();
  for (let i = 0; i < boxes.length; i++) {
    const r = root(i), b = boxes[i], c = clusters.get(r);
    if (!c) clusters.set(r, { ...b });
    else { c.x0 = Math.min(c.x0, b.x0); c.x1 = Math.max(c.x1, b.x1); c.z0 = Math.min(c.z0, b.z0); c.z1 = Math.max(c.z1, b.z1); }
  }
  const list = [...clusters.values()];
  for (const c of list) c.big = c.x1 - c.x0 > BIG_CLUSTER || c.z1 - c.z0 > BIG_CLUSTER;
  if (list.length < 2 && !list[0]?.big) return () => 0;
  return (x, z) => {
    let k = list.findIndex((c) => x >= c.x0 - CLUSTER_GAP && x <= c.x1 + CLUSTER_GAP && z >= c.z0 - CLUSTER_GAP && z <= c.z1 + CLUSTER_GAP);
    if (k < 0) k = 0;
    return list[k].big ? `${k}:${Math.floor(x / SQUARE)},${Math.floor(z / SQUARE)}` : k;
  };
}

/**
 * A tile's garden, into `target` with `buildCells` (js/city-grid.js). Returns colliders for the gates' pillars and the fountains' plinths, as
 * structures' are.
 */
function* buildTileGarden(tile, target, buildCells, wanted = () => true) {
  const g = tile.garden;
  if (!g) return [];
  const mats = gardenMaterials();
  const lawn = new GroundCells(1e6), paths = new TintedCells(true), beds = new TintedCells(), stone = new TintedCells(), pond = new GroundCells(1e6);
  const hedge = new GroundCells(1e6);
  // The ponds' coping, again, for what stands on it: the stone's cells hold the gates' pillars and leaves, and the kerbs' faces, too
  const coping = new TintedCells();
  const walls = new GroundCells(1e6);
  // Each of the tile's gardens its own meshes, culled apart (gardenClusters())
  const keyOf = gardenClusters(g);
  for (const cells of [lawn, paths, beds, stone, pond, hedge, coping, walls]) cells.keyOf = keyOf;
  const colliders = [];
  const lawnAt = lawnSurface(tile), pavingAt = pavingSurface(tile);
  const heightAt = (x, z) => lawnAt(x, z) ?? groundHeight(x, z);
  // The lowest top of the lawn and the paving as drawn at (x, z), for a kerb's face to reach under
  const below = (x, z) => {
    const l = lawnAt(x, z), p = pavingAt(x, z);
    return Math.min(l === null ? Infinity : l + LAWN_TOP, p === null ? Infinity : p + SIDEWALK_TOP);
  };
  // A step at a time, a few milliseconds each
  let since = performance.now();
  const due = () => {
    if (performance.now() - since < 4) return false;
    since = performance.now();
    return true;
  };

  // The lawn's and the paving's triangles under it all made first, one a step (5-20 ms each)
  const boxes = [
    ...(g.lawns ?? []).map(([, outer]) => boxOf(pointsOf(outer))), ...(g.plazas ?? []).map(([, outer]) => boxOf(pointsOf(outer))),
    ...g.beds.map(([, ...ring]) => boxOf(pointsOf(ring))),
    ...[...g.ponds, ...(g.rockPonds ?? [])].map((ring) => boxOf(pointsOf(ring))),
    ...g.paths.map(([, , width, ...line]) => { const b = boxOf(pointsOf(line)); return { x0: b.x0 - width, z0: b.z0 - width, x1: b.x1 + width, z1: b.z1 + width }; })
  ];
  for (const at of [lawnAt, pavingAt]) {
    for (const s of new Set(boxes.flatMap((b) => at.unbuilt(b.x0, b.z0, b.x1, b.z1)))) {
      if (!s.tris) buildSurface(s);
      if (due()) yield;
    }
  }
  // A formal park's raised lawn, laid on the map's lawn's triangles, and the kerbs along its edges
  const raised = new LaidSurface();
  const kerbTops = [];
  for (const [kerb, ...flats] of g.lawns ?? []) {
    const rings = flats.map((f) => pointsOf(f));
    if (rings[0].length < 3 || !wanted(rings[0][0].x, rings[0][0].z)) continue;
    const b = boxOf(rings[0]);
    const tris = lawnAt.trianglesIn(b.x0, b.z0, b.x1, b.z1);
    const laid = [];
    drapePolygon(rings, tris, RAISED_TOP, laid, 0, 0);
    raised.add(laid);
    addLaid(lawn, laid);
    stone.tint = KERB_STONE[kerb] ?? KERB_STONE[0];
    kerbTops.push(addKerbs(stone, rings, tris, below));
    if (due()) yield;
  }
  yield;
  // Paved areas, laid as the paths are, on the lawn's and the paving's triangles at a footpath's height for what they're made of: the
  // raised lawn's kerbs stand along their edges
  for (const [surface, ...flats] of g.plazas ?? []) {
    const rings = flats.map((f) => pointsOf(f));
    if (rings[0].length < 3 || !SURFACES[surface] || !wanted(rings[0][0].x, rings[0][0].z)) continue;
    paths.tint = SURFACES[surface];
    const top = pathTop(0, surface);
    const b = boxOf(rings[0]);
    const laid = [];
    drapePolygon(rings, pavingAt.trianglesIn(b.x0, b.z0, b.x1, b.z1), SIDEWALK_TOP + top - LAWN_TOP, laid, 0, 0);
    drapePolygon(rings, lawnAt.trianglesIn(b.x0, b.z0, b.x1, b.z1), top, laid, 0, 0);
    addLaid(paths, laid);
    if (due()) yield;
  }
  // Beds dug in the raised lawn, cut to it, or laid on the map's lawn where there's none
  for (const [kind, ...ring] of g.beds) {
    const pts = pointsOf(ring);
    if (pts.length < 3 || !wanted(pts[0].x, pts[0].z)) continue;
    beds.tint = [Math.min(3, kind) / 3, 0, 0];
    const b = boxOf(pts);
    const on = raised.trianglesIn(b.x0, b.z0, b.x1, b.z1);
    if (on.length) {
      const laid = [];
      drapePolygon([pts], on, BED_LIFT, laid, 0, 0);
      addLaid(beds, laid);
    } else addDraped(beds, [pts], BED_TOP, heightAt);
    if (due()) yield;
  }
  yield;
  stone.tint = SANDSTONE;
  const fountainOf = (pts) => {
    const mx = pts.reduce((t, p) => t + p.x, 0) / pts.length, mz = pts.reduce((t, p) => t + p.z, 0) / pts.length;
    return (g.fountains ?? []).find(([x, z, r]) => Math.hypot(x - mx, z - mz) < r);
  };
  // A pond's islands (OSM's inner rings, `islands`), holes in its water, edged as its own edge is
  const islands = (g.islands ?? []).map((f) => pointsOf(f)).filter((r) => r.length > 2);
  const islandsIn = (pts) => islands.filter((r) => insideRing(pts, r[0].x, r[0].z));
  // A pond's water laid on the map's lawn's triangles, as the raised lawn is (a neighbour's lawns among them: js/main.js holds a garden
  // tile's neighbours before building it). Cut into PIECE pieces over the ground, as before, a lake of 5 ha was 30,000 triangles.
  const layPond = (rings) => {
    const b = boxOf(rings[0]);
    const laid = [];
    drapePolygon(rings, lawnAt.trianglesIn(b.x0, b.z0, b.x1, b.z1), POND_TOP, laid, 0, 0);
    addLaid(pond, laid);
  };
  for (const ring of g.ponds) {
    const pts = pointsOf(ring);
    if (pts.length < 3 || !wanted(pts[0].x, pts[0].z)) continue;
    const fountain = fountainOf(pts);
    if (fountain) {
      // A fountain's basin: its water up near the top of a granite rim (not stood on: you sit on it, you don't climb it), and a plinth in
      // its middle with a bronze figure on it
      addDraped(pond, [pts], POND_TOP + FOUNTAIN.water, heightAt);
      stone.tint = GRANITE;
      addWallAlong(stone, [...pts, pts[0]], FOUNTAIN.rimWidth, POND_TOP - 0.05, FOUNTAIN.rim + 0.05, heightAt);
      const [x, z, r] = fountain;
      if (r >= FOUNTAIN.plinthFrom) {
        const yaw = Math.atan2(pts[1].x - pts[0].x, pts[1].z - pts[0].z), y = heightAt(x, z) + POND_TOP;
        addBox(stone, x, z, yaw, r * 0.36, r * 0.36, y - 0.05, FOUNTAIN.water + 0.6);
        addBox(stone, x, z, yaw, r * 0.17, r * 0.17, y, 2.9);
        stone.tint = BRONZE;
        addBox(stone, x, z, yaw, 0.7, 0.5, y + 2.9, 3.0);
        colliders.push({ minX: x - r * 0.2, maxX: x + r * 0.2, minZ: z - r * 0.2, maxZ: z + r * 0.2, minY: 0, maxY: 6 });
      }
      stone.tint = SANDSTONE;
      continue;
    }
    const holes = islandsIn(pts);
    layPond([pts, ...holes]);
    // Sandstone round its edge, and its islands'
    for (const r of [pts, ...holes]) {
      addRibbon(stone, [...r, r[0]], COPING.width, POND_TOP + COPING.rise, heightAt);
      addRibbon(coping, [...r, r[0]], COPING.width, POND_TOP + COPING.rise, heightAt);
    }
    if (due()) yield;
  }
  // Ponds edged with rocks, none along where two of them meet and the water runs on between them; round their islands too
  const rocky = (g.rockPonds ?? []).map((ring) => pointsOf(ring));
  for (const pts of rocky) {
    if (pts.length < 3 || !wanted(pts[0].x, pts[0].z)) continue;
    const holes = islandsIn(pts);
    layPond([pts, ...holes]);
    for (const r of [pts, ...holes]) addRocks(stone, r, rocky.filter((o) => o !== pts), heightAt);
    if (due()) yield;
  }
  stone.tint = SANDSTONE;
  yield;
  // The paths, laid on the lawn's and the paving's triangles, a piece a segment: where both are drawn (the paving runs under the lawn's
  // edge) the one on the lawn is on top. A track is worn into the raised lawn, and into the map's lawn off it, where a paved path that
  // crosses it covers it
  for (const [kind, surface, width, ...line] of g.paths) {
    const pts = pointsOf(line);
    if (pts.length < 2 || (surface === 4 && kind !== TRACK) || !SURFACES[surface] || !wanted(pts[0].x, pts[0].z)) continue;
    // Steps in sandstone, whatever OSM says they're made of
    paths.tint = kind === 1 ? SANDSTONE : SURFACES[surface];
    const top = pathTop(kind, surface);
    const laid = [];
    for (const piece of pathPieces(pts, kind === TRACK ? width : width + 2 * UNDER_KERB)) {
      const b = boxOf(piece.ring);
      if (kind === TRACK) {
        const worn = [];
        drape(piece.ring, raised.trianglesIn(b.x0, b.z0, b.x1, b.z1), TRACK_LIFT, worn, 0, 0);
        drape(piece.ring, lawnAt.trianglesIn(b.x0, b.z0, b.x1, b.z1), TRACK_TOP, worn, 0, 0);
        addLaid(paths, worn, wearAcross(piece));
      } else {
        drape(piece.ring, pavingAt.trianglesIn(b.x0, b.z0, b.x1, b.z1), SIDEWALK_TOP + top - LAWN_TOP, laid, 0, 0);
        drape(piece.ring, lawnAt.trianglesIn(b.x0, b.z0, b.x1, b.z1), top, laid, 0, 0);
      }
    }
    addLaid(paths, laid);
    if (due()) yield;
  }
  yield;
  // Hedges stand on the raised lawn where there is one
  const hedgeAt = (x, z) => {
    const y = raised.at(x, z);
    return y === null ? heightAt(x, z) : y - LAWN_TOP;
  };
  for (const [height, width, ...line] of g.hedges) {
    const pts = pointsOf(line);
    if (wanted(pts[0].x, pts[0].z)) addWallAlong(hedge, pts, width, LAWN_TOP, height, hedgeAt);
  }
  for (const [side, ...line] of g.seawalls ?? []) {
    const pts = pointsOf(line);
    if (pts.length > 1 && wanted(pts[0].x, pts[0].z)) colliders.push(...addParapet(walls, pts, side, heightAt));
  }
  // Each gate: two sandstone pillars either side of its path, its iron leaves swung open against them
  for (const [x, z, heading, width] of g.gates) {
    if (!wanted(x, z)) continue;
    const y = heightAt(x, z) + PATH_TOP - 0.02;
    const rx = Math.cos(heading), rz = -Math.sin(heading); // across the path
    for (const side of [-1, 1]) {
      const px = x + rx * side * (width / 2 + 0.28), pz = z + rz * side * (width / 2 + 0.28);
      stone.tint = SANDSTONE;
      addBox(stone, px, pz, heading, 0.55, 0.55, y - 0.1, 2.1);
      addBox(stone, px, pz, heading, 0.68, 0.68, y + 2, 0.14);
      // The leaf, folded back along the path's edge from the pillar
      const leaf = width / 2;
      const fx = Math.sin(heading), fz = Math.cos(heading);
      const lx = x + rx * side * (width / 2 - 0.06) + fx * (leaf / 2 + 0.3), lz = z + rz * side * (width / 2 - 0.06) + fz * (leaf / 2 + 0.3);
      stone.tint = IRON;
      addBox(stone, lx, lz, heading, 0.05, leaf, y + 0.08, 1.6);
      // Heights over the ground, as every collider's (the simulation is flat)
      colliders.push({ minX: px - 0.36, maxX: px + 0.36, minZ: pz - 0.36, maxZ: pz + 0.36, minY: 0, maxY: 2.4 });
    }
  }
  yield;
  // What's walked on, ridden over and driven onto, as drawn: the raised lawn and its kerbs' tops, the paths, beds and the ponds' coping
  setLayer(`garden:${tile.key}`, [trianglesOf(lawn), ...kerbTops, trianglesOf(paths), trianglesOf(beds), trianglesOf(coping)]);
  yield;
  const before = target?.children.length ?? 0;
  // A small cluster's meshes culled at `far`; a big one's squares (string keys, gardenClusters()) at SQUARE_CULL's
  const build = (cells, material, far, near, cast = false) => {
    const whole = { cells: new Map() }, squares = { cells: new Map() };
    for (const [key, c] of cells.cells) (typeof key === 'string' ? squares : whole).cells.set(key, c);
    buildCells(whole, target, material, { cast, cullDistance: far });
    buildCells(squares, target, material, { cast, cullDistance: near });
  };
  build(lawn, mats.lawn, 900, SQUARE_CULL.lawn);
  build(paths, mats.paths, 900, SQUARE_CULL.paths);
  build(beds, mats.beds, 900, SQUARE_CULL.beds);
  build(pond, mats.pond, 1200, SQUARE_CULL.pond);
  build(stone, mats.stone, 600, SQUARE_CULL.stone);
  build(hedge, mats.hedge, 900, SQUARE_CULL.hedge, true);
  build(walls, mats.wall, 900, SQUARE_CULL.walls, true);
  // What's the garden's, by material, for measuring what it costs (__gameDebug.gardenShown(), gardenMeshes())
  const names = new Map(Object.entries(mats).map(([k, v]) => [v, k]));
  for (const mesh of target?.children.slice(before) ?? []) mesh.userData.garden = names.get(mesh.material) ?? true;
  return colliders;
}

export { PATH_TOP, SURFACES as PATH_SURFACES, ROCKS as POND_ROCKS, TRACK, TRACK_TOP, buildTileGarden, gardenMaterials, lawnSurface, pathTop, pavingSurface,
  useMapLawn };
