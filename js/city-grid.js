import { anchorToOrigin } from './world-origin.js';
import { Ready } from './world-jobs.js';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY_BOUNDS } from './city-config.js';
import { TILE, tileKeyAt } from './geodata.js';
import {
  createRoadSurfaceMaterial,
  createSidewalkMaterial,
  createCurbMaterial,
  createWaterMaterial,
  createParkLawnMaterial
} from './tsl-materials.js';
import { groundHeight, groundRoadAt, linkById } from './surfaces.js';
import { GroundCells, SIDEWALK_TOP, addBase, addCurb, addRoadDeck, addSurface, denseRing, pointInPolygonXZ } from './ground-geometry.js';
import { SITE_CUTS } from './model-sites.js';
import { buildStructures } from './structures.js';
import { outsideTunnelMouths } from './tunnel-mouths.js';

// The harbour, the seawalls, the road deck, and every curb island: footpaths, traffic islands and park lawns, all laid
// over the terrain.

// Raised ground beyond the plain footpaths (none yet, but subway-style entrances and terraces can stand on them)
let streetGroundSurfaces = [];
function getStreetGroundHeight(x, z) {
  let height = SIDEWALK_TOP;
  for (const s of streetGroundSurfaces) {
    if (s.height > height && x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ && pointInPolygonXZ(s.poly, x, z)) height = s.height;
  }
  return height;
}

function batchStaticGroupMeshes(rootGroup, excludeMaterials = null) {
  rootGroup.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(rootGroup.matrixWorld).invert();
  const buckets = new Map();

  rootGroup.traverse((obj) => {
    if (!obj.isMesh || obj.isInstancedMesh || !obj.geometry || !obj.material) return;
    if (excludeMaterials && excludeMaterials.has(obj.material)) return;
    const attrs = obj.geometry.attributes;
    if (!attrs.position || !attrs.normal || !attrs.uv) return;
    if (!buckets.has(obj.material)) {
      buckets.set(obj.material, []);
    }
    buckets.get(obj.material).push(obj);
  });

  for (const [mat, meshes] of buckets.entries()) {
    if (meshes.length < 2) continue;
    const geos = [];
    let anyCast = false;
    let anyReceive = false;

    for (const m of meshes) {
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const key of Object.keys(g.attributes)) {
        if (key !== 'position' && key !== 'normal' && key !== 'uv') {
          g.deleteAttribute(key);
        }
      }
      const relMat = new THREE.Matrix4().multiplyMatrices(invRoot, m.matrixWorld);
      g.applyMatrix4(relMat);
      geos.push(g);
      if (m.castShadow) anyCast = true;
      if (m.receiveShadow) anyReceive = true;
      if (m.parent) m.parent.remove(m);
    }

    const merged = mergeGeometries(geos, false);
    if (merged) {
      const batchedMesh = new THREE.Mesh(merged, mat);
      batchedMesh.castShadow = anyCast;
      batchedMesh.receiveShadow = anyReceive;
      rootGroup.add(batchedMesh);
    }
  }
}

/**
 * A simple polygon ([{x, z}], either winding, convex or not) offset inward by d with mitred corners (miters clamped
 * to 3d); null if it collapses
 */
function offsetPolygonInward(pts, d) {
  const n = pts.length;
  if (n < 3) return null;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
  const s = area > 0 ? 1 : -1; // positive area: the inside lies left of each edge, i.e. along (-dz, dx)
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n];
    const q = pts[i];
    const r = pts[(i + 1) % n];
    let ax = q.x - p.x, az = q.z - p.z;
    let bx = r.x - q.x, bz = r.z - q.z;
    const la = Math.hypot(ax, az) || 1e-9;
    const lb = Math.hypot(bx, bz) || 1e-9;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az * s, n1z = ax * s; // inward normals of the two edges
    const n2x = -bz * s, n2z = bx * s;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push({ x: q.x + n1x * d, z: q.z + n1z * d }); continue; }
    mx /= ml; mz /= ml;
    const cos = mx * n1x + mz * n1z; // miter length = d / cos(half angle)
    const len = Math.min(3 * d, d / Math.max(1e-3, cos));
    out.push({ x: q.x + mx * len, z: q.z + mz * len });
  }
  let a2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a2 += out[j].x * out[i].z - out[i].x * out[j].z;
  return a2 * area > 0 && Math.abs(a2) < Math.abs(area) ? out : null;
}

// Meshes from a GroundCells (js/ground-geometry.js), one per cell
function buildCells(cells, group, material, { cast = false, cullDistance = 0 } = {}) {
  for (const c of cells.cells.values()) {
    if (!c.index.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(c.position, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(c.normal, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(c.uv, 2));
    g.setIndex(c.index);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, material);
    mesh.receiveShadow = true;
    mesh.castShadow = cast;
    mesh.userData.lifted = true;
    if (cullDistance) mesh.userData.cullDistance = cullDistance;
    group.add(mesh);
  }
}

// Distances past which the ground's small parts aren't worth drawing: a kerb is under a pixel by then
const GROUND_CULL = { curbs: 1100, hedges: 900, base: 1600, bollards: 300 };

// A traffic island between a motorway's carriageways is a low concrete separator with yellow-and-black bollards along it
// (Street View pictures of the Harbour Bridge's south end and the Western Distributor northbound), never lawn or hedge (plan 5,
// decision 9). An island is one where
// it's narrow and most of its edge is beside a motorway or its ramps.
const SEPARATOR_WIDTH = 6; // m: its area over its length
function isSeparator(b) {
  if (b.area / Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 1) > SEPARATOR_WIDTH || b.area > 4000) return false;
  let beside = 0, motorway = 0;
  for (const p of denseRing(b.poly, 6)) {
    const road = groundRoadAt(p.x, p.z);
    if (!road) continue;
    beside++;
    if (road.motorway) motorway++;
  }
  return beside >= 3 && motorway >= beside * 0.6;
}
// Bollards along an island's middle, every BOLLARD_STEP m along its longest way across, where it's wide enough to stand one
const BOLLARD_STEP = 8;
function bollardSpots(b) {
  const ux0 = b.maxX - b.minX >= b.maxZ - b.minZ ? 1 : 0, uz0 = 1 - ux0;
  // Its long way, from the outline's spread about its centre
  let sxx = 0, sxz = 0, szz = 0;
  for (const p of b.poly) {
    const dx = p.x - b.cx, dz = p.z - b.cz;
    sxx += dx * dx; sxz += dx * dz; szz += dz * dz;
  }
  const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ux = Number.isFinite(angle) ? Math.cos(angle) : ux0, uz = Number.isFinite(angle) ? Math.sin(angle) : uz0;
  let lo = Infinity, hi = -Infinity;
  for (const p of b.poly) {
    const t = (p.x - b.cx) * ux + (p.z - b.cz) * uz;
    lo = Math.min(lo, t); hi = Math.max(hi, t);
  }
  const out = [];
  for (let t = lo + 1.5; t <= hi - 1.5; t += BOLLARD_STEP) {
    // Where the line across the island at t meets its outline
    const ox = b.cx + ux * t, oz = b.cz + uz * t;
    let a = Infinity, c = -Infinity;
    for (let i = 0, j = b.poly.length - 1; i < b.poly.length; j = i++) {
      const p = b.poly[j], q = b.poly[i];
      const tp = (p.x - ox) * ux + (p.z - oz) * uz, tq = (q.x - ox) * ux + (q.z - oz) * uz;
      if ((tp > 0) === (tq > 0) || tp === tq) continue;
      const f = tp / (tp - tq);
      const across = (p.x + (q.x - p.x) * f - ox) * -uz + (p.z + (q.z - p.z) * f - oz) * ux;
      a = Math.min(a, across); c = Math.max(c, across);
    }
    if (!(c - a > 0.5)) continue;
    const m = (a + c) / 2;
    out.push({ x: ox - uz * m, z: oz + ux * m });
  }
  return out;
}
// A bollard: a post in bands, yellow and black, standing on the island's top
const BOLLARD = { half: 0.09, bands: [[0, 0.3, 0], [0.3, 0.5, 1], [0.5, 0.7, 0], [0.7, 0.9, 1]] }; // [from, to, black?]
function addBollard(yellow, black, x, z) {
  const y0 = groundHeight(x, z) + SIDEWALK_TOP, h = BOLLARD.half;
  for (const [from, to, dark] of BOLLARD.bands) {
    const cells = dark ? black : yellow;
    const c = cells.cell(x, z);
    for (const [nx, nz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const ax = x + (nx - nz) * h, az = z + (nz + nx) * h, bx = x + (nx + nz) * h, bz = z + (nz - nx) * h;
      const v0 = cells.vertex(c, ax, y0 + from, az, nx, 0, nz), v1 = cells.vertex(c, bx, y0 + from, bz, nx, 0, nz);
      const v2 = cells.vertex(c, ax, y0 + to, az, nx, 0, nz), v3 = cells.vertex(c, bx, y0 + to, bz, nx, 0, nz);
      c.index.push(v0, v1, v2, v1, v3, v2);
    }
    if (to === BOLLARD.bands[BOLLARD.bands.length - 1][1]) {
      const v = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([dx, dz]) => cells.vertex(c, x + dx, y0 + to, z + dz, 0, 1, 0));
      c.index.push(v[0], v[2], v[1], v[0], v[3], v[2]);
    }
  }
}

// One set of materials for all the tiles, so a new tile compiles nothing
let shared = null;
function groundMaterials() {
  if (shared) return shared;
  shared = {
    road: createRoadSurfaceMaterial(),
    sidewalk: createSidewalkMaterial(),
    curb: createCurbMaterial(),
    lawn: createParkLawnMaterial(false),
    hedge: new THREE.MeshStandardNodeMaterial({ color: 0x3f7a3f, roughness: 0.84 }),
    bollardYellow: new THREE.MeshStandardNodeMaterial({ color: 0xe0b020, roughness: 0.6 }),
    bollardBlack: new THREE.MeshStandardNodeMaterial({ color: 0x1c1c1c, roughness: 0.6 }),
    // Under all of it, a plain dark ground: a seam anywhere shows that, never the harbour
    base: new THREE.MeshStandardNodeMaterial({ color: 0x2c2b29, roughness: 1 }),
    seawall: new THREE.MeshStandardNodeMaterial({ color: 0x8d7a5e, roughness: 0.85, metalness: 0.02 })
  };
  // ...and none of it closing a tunnel's mouth (js/tunnel-mouths.js)
  for (const mat of [shared.curb, shared.sidewalk, shared.lawn, shared.hedge, shared.base]) mat.maskNode = outsideTunnelMouths();
  return shared;
}

/** The harbour: one plane under everything */
function buildWater(target) {
  const geometry = new THREE.PlaneGeometry(120000, 120000, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(geometry, createWaterMaterial());
  water.position.set(0, CITY_BOUNDS.waterLevel, 0);
  water.userData.lifted = true;
  water.userData.farAway = true;
  anchorToOrigin(water); // the sea goes with you
  target.add(water);
  return water;
}

// The shore, a segment at a time
const shoreOfTile = (tile) => (tile.shore || []).map(([side, ax, az, bx, bz]) => ({ a: { x: ax, z: az }, b: { x: bx, z: bz }, side }));

/**
 * A tile's ground, into `target`: the road surface and the curb islands: curbs around every one, paving and lawn on them, a
 * low hedge on the wider traffic islands. Part of it if `part` says so, for the first view: `part` picks the ground to build
 * by where it is. The part with `last` set also has what only matters later: the base, the seawalls and the structures.
 * Returns the colliders of any structures.
 */
function* buildTileGround(tile, target, { part = () => true, last = true } = {}) {
  const mats = groundMaterials();
  const box = { x0: tile.ix * TILE, x1: (tile.ix + 1) * TILE, z0: tile.iz * TILE, z1: (tile.iz + 1) * TILE };
  const inTile = (x, z) => x >= box.x0 && x < box.x1 && z >= box.z0 && z < box.z1;
  const wanted = (x, z) => inTile(x, z) && part(x, z);
  const cells = () => new GroundCells(1e6);
  const road = cells(), curbs = cells(), paving = cells(), lawns = cells(), hedges = cells(), base = cells();
  const yellow = cells(), black = cells();
  const separators = [];
  const links = tile.links.map((r) => linkById.get(r[0])).filter(Boolean);

  yield* addRoadDeck(road, wanted, links, tile.fills);
  const midOf = (rings) => rings[0][rings[0].length >> 1];
  // Under a building drawn from a model with rooms below the street (js/model-sites.js), the paving or lawn it stands in has a hole: the
  // model has its own floors there, down to its basement's
  const cuts = SITE_CUTS.filter((c) => c.maxX > box.x0 && c.minX < box.x1 && c.maxZ > box.z0 && c.minZ < box.z1);
  const withCuts = (rings) => {
    let out = rings;
    for (const c of cuts) {
      if (!c.poly.every((q) => pointInPolygonXZ(rings[0], q.x, q.z))) continue;
      if (rings.slice(1).some((h) => c.poly.some((q) => pointInPolygonXZ(h, q.x, q.z)))) continue;
      if (out === rings) out = rings.slice();
      out.push(c.poly);
    }
    return out;
  };
  for (const [i, b] of tile.placedBlocks.entries()) {
    const mid = midOf([b.poly]);
    if (!part(mid.x, mid.z)) continue;
    addCurb(curbs, b.poly);
    for (const hole of b.holes) addCurb(curbs, hole);
    if (isSeparator(b)) {
      separators.push(b);
      for (const p of bollardSpots(b)) addBollard(yellow, black, p.x, p.z);
    } else if (b.median) {
      const hedge = Math.min(b.maxX - b.minX, b.maxZ - b.minZ) > 3 && b.area > 60 && offsetPolygonInward(b.poly, 1.1);
      if (hedge) addSurface(hedges, [hedge], SIDEWALK_TOP + 0.4);
    }
    if (i % 8 === 0) yield;
  }
  for (const [i, rings] of tile.placedPavements.entries()) {
    const mid = midOf(rings);
    if (part(mid.x, mid.z)) addSurface(paving, cuts.length ? withCuts(rings) : rings, SIDEWALK_TOP);
    if (i % 2 === 0) yield;
  }
  // Concrete where a separator's lawn would be
  const onSeparator = (rings) => {
    if (!separators.length) return false;
    const ring = rings[0], x = ring.reduce((t, p) => t + p.x, 0) / ring.length, z = ring.reduce((t, p) => t + p.z, 0) / ring.length;
    return separators.some((b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && pointInPolygonXZ(b.poly, x, z));
  };
  for (const [i, rings] of tile.placedLawns.entries()) {
    const mid = midOf(rings);
    if (part(mid.x, mid.z)) addSurface(onSeparator(rings) ? paving : lawns, cuts.length ? withCuts(rings) : rings, SIDEWALK_TOP + 0.02);
    if (i % 8 === 0) yield;
  }
  yield;
  buildCells(road, target, mats.road);
  buildCells(curbs, target, mats.curb, { cast: true, cullDistance: GROUND_CULL.curbs });
  yield;
  buildCells(paving, target, mats.sidewalk);
  buildCells(lawns, target, mats.lawn);
  buildCells(hedges, target, mats.hedge, { cullDistance: GROUND_CULL.hedges });
  buildCells(yellow, target, mats.bollardYellow, { cullDistance: GROUND_CULL.bollards });
  buildCells(black, target, mats.bollardBlack, { cullDistance: GROUND_CULL.bollards });
  yield;
  if (!last) return [];

  // The base only backs up the surfaces' seams, so it comes last: on the phone it costs too much of the 4 s to load
  // ...and the base under everything goes under its basement too
  const under = cuts.length ? (x, z) => {
    let y = Infinity;
    for (const c of cuts) if (x > c.minX - 20 && x < c.maxX + 20 && z > c.minZ - 20 && z < c.maxZ + 20) y = Math.min(y, c.y);
    return y;
  } : null;
  yield* addBase(base, inTile, undefined, box, under);
  buildCells(base, target, mats.base, { cullDistance: GROUND_CULL.base });
  yield;

  // Sandstone seawalls down to the water, where the land ends
  const seawalls = cells();
  for (const { a, b, side } of shoreOfTile(tile)) {
    const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = ((b.z - a.z) / L) * side, nz = (-(b.x - a.x) / L) * side;
    const c = seawalls.cell(a.x, a.z);
    const v0 = seawalls.vertex(c, a.x, CITY_BOUNDS.waterLevel - 0.6, a.z, nx, 0, nz);
    const v1 = seawalls.vertex(c, b.x, CITY_BOUNDS.waterLevel - 0.6, b.z, nx, 0, nz);
    const v2 = seawalls.vertex(c, a.x, groundHeight(a.x, a.z) + 0.1, a.z, nx, 0, nz);
    const v3 = seawalls.vertex(c, b.x, groundHeight(b.x, b.z) + 0.1, b.z, nx, 0, nz);
    if (side > 0) c.index.push(v0, v1, v2, v1, v3, v2);
    else c.index.push(v0, v2, v1, v1, v2, v3);
  }
  buildCells(seawalls, target, mats.seawall);
  yield;

  // Every road off the ground whose middle is here: bridges, viaducts and tunnels (js/structures.js)
  const home = new Set(tile.home);
  const { colliders } = yield* buildStructures(target, mats.road, links.filter((l) => home.has(l.id)), links, inTile);
  return colliders;
}

export { buildTileGround, buildWater, groundMaterials, getStreetGroundHeight, batchStaticGroupMeshes };
