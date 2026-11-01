import { Ready } from './world-jobs.js';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BLOCKS, CITY_BOUNDS, LAWNS, PAVEMENTS, SHORE_RINGS } from './city-config.js';
import {
  createRoadSurfaceMaterial,
  createSidewalkMaterial,
  createCurbMaterial,
  createWaterMaterial,
  createParkLawnMaterial
} from './tsl-materials.js';
import { createRoadPaintChunkBuilder } from './road-paint.js';
import { groundHeight } from './surfaces.js';
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
function buildCells(cells, group, material, { cast = false } = {}) {
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
    group.add(mesh);
  }
}


// `startRadius`: how far around `focus` the ground is built before the first frame; the rest follows behind the game
function* buildCityGrid(scene, lateStage, focus, startRadius = 450) {
  streetGroundSurfaces = [];
  let group = new THREE.Group();
  group.name = 'CityGrid';
  // Nothing in here is needed to start driving, so it joins the scene after the first frame
  const details = new THREE.Group();
  details.name = 'CityGridDetails';

  // Ground footprints that traffic and pedestrians must keep clear of
  const footprints = [];
  for (const b of BLOCKS) if (b.median) footprints.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });

  // 1. The harbour
  const waterMat = createWaterMaterial();
  const waterGeo = new THREE.PlaneGeometry(120000, 120000, 1, 1);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.set(0, CITY_BOUNDS.waterLevel, 0);
  water.userData.lifted = true;
  details.add(water);

  // 2. The road surface, and the curb islands: curbs around every one, paving and lawn on them, a low hedge on the wider
  //    traffic islands. Near the player first.
  const roadMat = createRoadSurfaceMaterial();
  const sidewalkMat = createSidewalkMaterial();
  const curbMat = createCurbMaterial();
  const lawnMat = createParkLawnMaterial(false);
  const hedgeMat = new THREE.MeshStandardNodeMaterial({ color: 0x3f7a3f, roughness: 0.84 });
  const near = (rings) => {
    const p = rings[0][rings[0].length >> 1];
    const dx = p.x - focus.x, dz = p.z - focus.z;
    return dx * dx + dz * dz < startRadius * startRadius;
  };
  const addBlock = (b, cells) => {
    addCurb(cells.curbs, b.poly);
    for (const hole of b.holes) addCurb(cells.curbs, hole);
    if (!b.median) return;
    const hedge = Math.min(b.maxX - b.minX, b.maxZ - b.minZ) > 3 && b.area > 60 && offsetPolygonInward(b.poly, 1.1);
    if (hedge) addSurface(cells.hedges, [hedge], SIDEWALK_TOP + 0.4);
  };
  // Under all of it, a plain dark ground: a seam anywhere shows that, never the harbour
  const baseMat = new THREE.MeshStandardNodeMaterial({ color: 0x2c2b29, roughness: 1 });
  // ...and none of it closing a tunnel's mouth (js/tunnel-mouths.js)
  for (const mat of [curbMat, sidewalkMat, lawnMat, hedgeMat, baseMat]) mat.maskNode = outsideTunnelMouths();
  const newCells = () => ({ road: new GroundCells(), curbs: new GroundCells(), paving: new GroundCells(), lawns: new GroundCells(), hedges: new GroundCells(), base: new GroundCells() });
  const finish = (cells, target) => {
    buildCells(cells.road, target, roadMat);
    buildCells(cells.curbs, target, curbMat, { cast: true });
    buildCells(cells.paving, target, sidewalkMat);
    buildCells(cells.lawns, target, lawnMat);
    buildCells(cells.hedges, target, hedgeMat);
    buildCells(cells.base, target, baseMat);
  };

  const first = newCells();
  const nearFocus = (x, z) => (x - focus.x) ** 2 + (z - focus.z) ** 2 < startRadius * startRadius;
  yield* addRoadDeck(first.road, nearFocus);
  for (const b of BLOCKS) if (near([b.poly])) addBlock(b, first);
  for (const rings of PAVEMENTS) if (near(rings)) addSurface(first.paving, rings, SIDEWALK_TOP);
  for (const rings of LAWNS) if (near(rings)) addSurface(first.lawns, rings, SIDEWALK_TOP + 0.02);
  finish(first, group);

  // Enough to start driving. Everything below arrives behind the game.
  scene.add(group);
  yield new Ready();
  group = details;
  yield;

  const rest = newCells();
  yield* addRoadDeck(rest.road, (x, z) => !nearFocus(x, z));
  // The base only backs up the surfaces' seams, so all of it comes after the first frame: on the phone it costs too much
  // of the 4 s to load, and its own shader with it
  yield* addBase(rest.base, () => true);
  yield;
  for (const [i, b] of BLOCKS.entries()) {
    if (!near([b.poly])) addBlock(b, rest);
    if (i % 8 === 0) yield;
  }
  for (const [i, rings] of PAVEMENTS.entries()) {
    if (!near(rings)) addSurface(rest.paving, rings, SIDEWALK_TOP);
    if (i % 2 === 0) yield;
  }
  for (const [i, rings] of LAWNS.entries()) {
    if (!near(rings)) addSurface(rest.lawns, rings, SIDEWALK_TOP + 0.02);
    if (i % 8 === 0) yield;
  }
  yield;
  buildCells(rest.road, group, roadMat);
  yield;
  buildCells(rest.curbs, group, curbMat, { cast: true });
  yield;
  buildCells(rest.paving, group, sidewalkMat);
  yield;
  buildCells(rest.lawns, group, lawnMat);
  buildCells(rest.hedges, group, hedgeMat);
  buildCells(rest.base, group, baseMat);
  yield;

  // 3. Sandstone seawalls down to the water, where the land ends
  const seawallMat = new THREE.MeshStandardNodeMaterial({ color: 0x8d7a5e, roughness: 0.85, metalness: 0.02 });
  const seawalls = new GroundCells();
  for (const rings of SHORE_RINGS) {
    for (const ring of rings) {
      const pts = denseRing(ring, 30);
      let area = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) area += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
      const side = area > 0 ? 1 : -1;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
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
    }
    yield;
  }
  buildCells(seawalls, group, seawallMat);

  // 4. Every road off the ground: bridges, viaducts and tunnels (js/structures.js)
  const { colliders } = yield* buildStructures(group, roadMat);

  const roadPaint = createRoadPaintChunkBuilder('RoadMarkings');
  lateStage.add(group);
  return { group, footprints, colliders, roadPaint };
}

export { buildCityGrid, getStreetGroundHeight, batchStaticGroupMeshes };
