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
import { groundHeight, linkById } from './surfaces.js';
import { GroundCells, SIDEWALK_TOP, addBase, addCurb, addRoadDeck, addSurface, denseRing, pointInPolygonXZ } from './ground-geometry.js';
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
const GROUND_CULL = { curbs: 1100, hedges: 900, base: 1600 };

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
  const links = tile.links.map((r) => linkById.get(r[0])).filter(Boolean);

  yield* addRoadDeck(road, wanted, links, tile.fills);
  const midOf = (rings) => rings[0][rings[0].length >> 1];
  for (const [i, b] of tile.placedBlocks.entries()) {
    const mid = midOf([b.poly]);
    if (!part(mid.x, mid.z)) continue;
    addCurb(curbs, b.poly);
    for (const hole of b.holes) addCurb(curbs, hole);
    if (b.median) {
      const hedge = Math.min(b.maxX - b.minX, b.maxZ - b.minZ) > 3 && b.area > 60 && offsetPolygonInward(b.poly, 1.1);
      if (hedge) addSurface(hedges, [hedge], SIDEWALK_TOP + 0.4);
    }
    if (i % 8 === 0) yield;
  }
  for (const [i, rings] of tile.placedPavements.entries()) {
    const mid = midOf(rings);
    if (part(mid.x, mid.z)) addSurface(paving, rings, SIDEWALK_TOP);
    if (i % 2 === 0) yield;
  }
  for (const [i, rings] of tile.placedLawns.entries()) {
    const mid = midOf(rings);
    if (part(mid.x, mid.z)) addSurface(lawns, rings, SIDEWALK_TOP + 0.02);
    if (i % 8 === 0) yield;
  }
  yield;
  buildCells(road, target, mats.road);
  buildCells(curbs, target, mats.curb, { cast: true, cullDistance: GROUND_CULL.curbs });
  yield;
  buildCells(paving, target, mats.sidewalk);
  buildCells(lawns, target, mats.lawn);
  buildCells(hedges, target, mats.hedge, { cullDistance: GROUND_CULL.hedges });
  yield;
  if (!last) return [];

  // The base only backs up the surfaces' seams, so it comes last: on the phone it costs too much of the 4 s to load
  yield* addBase(base, inTile, undefined, box);
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
