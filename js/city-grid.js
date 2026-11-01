import { Ready } from './world-jobs.js';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BLOCKS, CITY_BOUNDS, LAWNS, PAVEMENTS, SHORE_RINGS, blockAt } from './city-config.js';
import { GEO } from './geodata.js';
import {
  createRoadSurfaceMaterial,
  createSidewalkMaterial,
  createCurbMaterial,
  createWaterMaterial,
  createParkLawnMaterial
} from './tsl-materials.js';
import { createRoadPaintChunkBuilder } from './road-paint.js';
import { terrainHeight } from './terrain.js';

// The harbour, the seawalls, the road deck, and every curb island: footpaths, traffic islands and park lawns, all laid
// over the terrain.

const SIDEWALK_TOP = 0.22;

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

function pointInPolygonXZ(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

// Ground geometry is built directly on the terrain, in square cells of the city that can be culled on their own
const GROUND_CELL = 700;
class GroundCells {
  constructor() {
    this.cells = new Map();
  }

  cell(x, z) {
    const key = Math.floor(x / GROUND_CELL) * 100000 + Math.floor(z / GROUND_CELL);
    let c = this.cells.get(key);
    if (!c) this.cells.set(key, (c = { position: [], normal: [], uv: [], index: [] }));
    return c;
  }

  vertex(c, x, y, z, nx, ny, nz) {
    c.position.push(x, y, z);
    c.normal.push(nx, ny, nz);
    c.uv.push(x, -z);
    return c.position.length / 3 - 1;
  }

  build(group, material, { cast = false } = {}) {
    for (const c of this.cells.values()) {
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
}

// A ring with extra points, so no edge is longer than `edge`
function denseRing(ring, edge) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / edge));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}

// Flat-topped polygon on the ground. Buildings cover most of a block's middle, so only large ones get points inside
// (as single-point holes, which earcut takes for what they are); around the edge it follows the ground closely.
function addSurface(cells, rings, y, edge = 20, inner = 44) {
  const [outer, ...holes] = rings;
  const contour = denseRing(outer, edge);
  const denseHoles = holes.map((h) => denseRing(h, edge));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of contour) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  if (maxX - minX > inner * 2 && maxZ - minZ > inner * 2) {
    for (let x = Math.ceil(minX / inner) * inner; x < maxX; x += inner) {
      for (let z = Math.ceil(minZ / inner) * inner; z < maxZ; z += inner) {
        if (pointInPolygonXZ(outer, x, z) && !holes.some((h) => pointInPolygonXZ(h, x, z))) denseHoles.push([{ x, z }]);
      }
    }
  }
  const v2 = (p) => new THREE.Vector2(p.x, p.z);
  const shapeContour = contour.map(v2);
  const shapeHoles = denseHoles.map((h) => h.map(v2));
  const points = [...shapeContour, ...shapeHoles.flat()];
  const faces = THREE.ShapeUtils.triangulateShape(shapeContour, shapeHoles);
  const c = cells.cell((minX + maxX) / 2, (minZ + maxZ) / 2);
  const first = c.position.length / 3;
  for (const p of points) cells.vertex(c, p.x, y + terrainHeight(p.x, p.y), p.y, 0, 1, 0);
  for (const [a, b, d] of faces) {
    const ax = points[a].x, az = points[a].y, bx = points[b].x, bz = points[b].y, dx = points[d].x, dz = points[d].y;
    // Up: counter-clockwise from above, with z pointing south
    if ((bx - ax) * (dz - az) - (bz - az) * (dx - ax) < 0) c.index.push(first + a, first + b, first + d);
    else c.index.push(first + a, first + d, first + b);
  }
}

// A curb along a ring: a wall from under the road up to the kerb's top, and a ledge along the footpath's edge
function addCurb(cells, ring, ledge = 0.3) {
  const pts = denseRing(ring, 20);
  const n = pts.length;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
  const side = area > 0 ? 1 : -1; // towards the inside of the ring
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
    const ix = (-dz / L) * side, iz = (dx / L) * side; // inward
    const ya = terrainHeight(a.x, a.z), yb = terrainHeight(b.x, b.z);
    const c = cells.cell(a.x, a.z);
    const v0 = cells.vertex(c, a.x, ya - 0.3, a.z, -ix, 0, -iz);
    const v1 = cells.vertex(c, b.x, yb - 0.3, b.z, -ix, 0, -iz);
    const v2 = cells.vertex(c, a.x, ya + SIDEWALK_TOP + 0.01, a.z, -ix, 0, -iz);
    const v3 = cells.vertex(c, b.x, yb + SIDEWALK_TOP + 0.01, b.z, -ix, 0, -iz);
    const v4 = cells.vertex(c, a.x, ya + SIDEWALK_TOP + 0.01, a.z, 0, 1, 0);
    const v5 = cells.vertex(c, b.x, yb + SIDEWALK_TOP + 0.01, b.z, 0, 1, 0);
    const v6 = cells.vertex(c, a.x + ix * ledge, ya + SIDEWALK_TOP + 0.01, a.z + iz * ledge, 0, 1, 0);
    const v7 = cells.vertex(c, b.x + ix * ledge, yb + SIDEWALK_TOP + 0.01, b.z + iz * ledge, 0, 1, 0);
    if (side > 0) c.index.push(v0, v2, v1, v1, v2, v3, v4, v6, v5, v5, v6, v7);
    else c.index.push(v0, v1, v2, v1, v3, v2, v4, v5, v6, v5, v7, v6);
  }
}

// The road surface: a ribbon down every street, capped at each junction by the circle the curbs were cut with
function* addRoadDeck(cells, wanted) {
  const RG = GEO.roadGraph;
  const reach = new Float32Array(RG.nodes.length / 2);
  const degree = new Uint16Array(reach.length);
  for (const [a, b, , width, , , , , deck] of RG.links) {
    if (deck) continue;
    const r = width / 2 + 0.6; // under the curbs
    reach[a] = Math.max(reach[a], r);
    reach[b] = Math.max(reach[b], r);
    degree[a]++;
    degree[b]++;
  }
  for (let i = 0; i < reach.length; i++) if (degree[i] >= 3) reach[i] += GEO.frame.corner;
  let work = 0;
  for (const [a, b, , width, , , inner, , deck] of RG.links) {
    if (deck || !wanted(RG.nodes[a * 2], RG.nodes[a * 2 + 1])) continue;
    if (++work % 60 === 0) yield;
    const r = width / 2 + 0.6;
    const line = [{ x: RG.nodes[a * 2], z: RG.nodes[a * 2 + 1] }];
    for (let k = 0; k < inner.length; k += 2) line.push({ x: inner[k], z: inner[k + 1] });
    line.push({ x: RG.nodes[b * 2], z: RG.nodes[b * 2 + 1] });
    const pts = [];
    for (let i = 0; i + 1 < line.length; i++) {
      const p = line[i], q = line[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 18));
      for (let k = 0; k < n; k++) pts.push({ x: p.x + ((q.x - p.x) * k) / n, z: p.z + ((q.z - p.z) * k) / n });
    }
    pts.push(line[line.length - 1]);
    const c = cells.cell((line[0].x + line[line.length - 1].x) / 2, (line[0].z + line[line.length - 1].z) / 2);
    let previous = -1;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[Math.max(0, i - 1)], q = pts[Math.min(pts.length - 1, i + 1)];
      const L = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      const nx = -(q.z - p.z) / L, nz = (q.x - p.x) / L;
      const y = terrainHeight(pts[i].x, pts[i].z);
      const left = cells.vertex(c, pts[i].x + nx * r, y, pts[i].z + nz * r, 0, 1, 0);
      cells.vertex(c, pts[i].x - nx * r, y, pts[i].z - nz * r, 0, 1, 0);
      if (previous >= 0) c.index.push(previous, left, previous + 1, previous + 1, left, left + 1);
      previous = left;
    }
  }
  for (let i = 0; i < reach.length; i++) {
    const x = RG.nodes[i * 2], z = RG.nodes[i * 2 + 1];
    if (!reach[i] || !wanted(x, z)) continue;
    if (++work % 60 === 0) yield;
    const ring = [];
    for (let k = 0; k < 18; k++) ring.push({ x: x + Math.cos((k / 18) * Math.PI * 2) * reach[i], z: z + Math.sin((k / 18) * Math.PI * 2) * reach[i] });
    addSurface(cells, [ring], 0, 20);
  }
  for (const flat of GEO.fills) {
    if (!wanted(flat[0], flat[1])) continue;
    if (++work % 60 === 0) yield;
    const ring = [];
    for (let i = 0; i < flat.length; i += 2) ring.push({ x: flat[i], z: flat[i + 1] });
    addSurface(cells, [ring], 0, 20);
  }
}

const VIADUCT_RAMP = 140; // m at each end, where a deck comes down to the ground it joins
const viaductClearance = (layer) => 6.5 + (layer - 1) * 5.5; // m of road deck above the ground, per OSM layer
const VIADUCT_MIN_LANE = 240; // m: shorter ramps carry no traffic, the highway cars would only dip in and out

function* buildViaducts(group, roadMat) {
  const decks = new GroundCells();
  const sides = new GroundCells();
  const piers = [];
  const lanes = [];
  const colliders = [];
  for (const { lanes: count, layer, pts: flat } of GEO.viaducts) {
    yield;
    // Evenly spaced stations, the deck easing over the ground beneath it
    const line = [];
    for (let i = 0; i + 3 < flat.length; i += 2) {
      const L = Math.hypot(flat[i + 2] - flat[i], flat[i + 3] - flat[i + 1]);
      if (L < 0.05) continue;
      const n = Math.max(1, Math.ceil(L / 14));
      for (let k = 0; k < n; k++) line.push({ x: flat[i] + ((flat[i + 2] - flat[i]) * k) / n, z: flat[i + 1] + ((flat[i + 3] - flat[i + 1]) * k) / n });
    }
    line.push({ x: flat[flat.length - 2], z: flat[flat.length - 1] });
    const ground = line.map((p) => terrainHeight(p.x, p.z));
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 1; i + 1 < ground.length; i++) ground[i] = (ground[i - 1] + ground[i] * 2 + ground[i + 1]) / 4;
    }
    const along = [0];
    for (let i = 1; i < line.length; i++) along.push(along[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z));
    const total = along[along.length - 1];
    const half = count * 1.8 + 0.8;
    const clearance = viaductClearance(layer);
    const c = decks.cell(line[0].x, line[0].z), f = sides.cell(line[0].x, line[0].z);
    let previous = -1, previousSide = -1, previousSoffit = -1;
    const laneLines = Array.from({ length: count }, () => []);
    line.forEach((p, i) => {
      const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
      const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = -(b.z - a.z) / L, nz = (b.x - a.x) / L;
      const e = Math.min(1, Math.min(along[i], total - along[i]) / VIADUCT_RAMP);
      const ramp = e * e * (3 - 2 * e);
      // Starting just under the ground, so the deck comes up out of it and traffic sinks out of sight at the wrap
      const y = ground[i] - 0.6 + (clearance + 0.6) * ramp;
      const left = decks.vertex(c, p.x + nx * half, y, p.z + nz * half, 0, 1, 0);
      decks.vertex(c, p.x - nx * half, y, p.z - nz * half, 0, 1, 0);
      const wall = 0.9 * ramp, skirt = 1.4 * ramp;
      const s0 = sides.vertex(f, p.x + nx * half, y + wall, p.z + nz * half, nx, 0, nz);
      sides.vertex(f, p.x + nx * half, y - skirt, p.z + nz * half, nx, 0, nz);
      sides.vertex(f, p.x - nx * half, y + wall, p.z - nz * half, -nx, 0, -nz);
      sides.vertex(f, p.x - nx * half, y - skirt, p.z - nz * half, -nx, 0, -nz);
      // The road surface is one-sided: from the street below, this is the deck
      const u0 = sides.vertex(f, p.x + nx * half, y - skirt, p.z + nz * half, 0, -1, 0);
      sides.vertex(f, p.x - nx * half, y - skirt, p.z - nz * half, 0, -1, 0);
      if (previous >= 0) {
        c.index.push(previous, left, previous + 1, previous + 1, left, left + 1);
        f.index.push(previousSide, previousSide + 1, s0, s0, previousSide + 1, s0 + 1, previousSide + 2, s0 + 2, previousSide + 3, previousSide + 3, s0 + 2, s0 + 3);
        // Wound to face down: DoubleSide turns a back face's normal over, which would light this from the sun
        f.index.push(previousSoffit, previousSoffit + 1, u0, previousSoffit + 1, u0 + 1, u0);
      }
      previous = left;
      previousSide = s0;
      previousSoffit = u0;
      if (i % 3 === 0 && ramp > 0.5 && blockAt(p.x, p.z)) {
        piers.push([p.x, terrainHeight(p.x, p.z) - 0.5, p.z, y - skirt]);
        colliders.push({ minX: p.x - 0.9, maxX: p.x + 0.9, minZ: p.z - 0.9, maxZ: p.z + 0.9, minY: 0, maxY: 6 });
      }
      laneLines.forEach((lane, k) => {
        const o = (k - (count - 1) / 2) * 3.5;
        lane.push(new THREE.Vector3(p.x + nx * o, y + 0.02, p.z + nz * o));
      });
    });
    if (total >= VIADUCT_MIN_LANE) for (const pts of laneLines) lanes.push({ pts, speed: 18 });
  }
  decks.build(group, roadMat);
  const concrete = new THREE.MeshStandardNodeMaterial({ color: 0x8b8a84, roughness: 0.9, side: THREE.DoubleSide });
  sides.build(group, concrete, { cast: true });
  if (piers.length) {
    const inst = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8).translate(0, 0.5, 0), concrete, piers.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    piers.forEach(([x, y0, z, top], i) => inst.setMatrixAt(i, m.compose(new THREE.Vector3(x, y0, z), q, new THREE.Vector3(0.8, top - y0, 0.8))));
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.castShadow = true;
    inst.userData.lifted = true;
    group.add(inst);
  }
  return { lanes, colliders };
}

const START_RADIUS = 650; // ground built before the first frame; the rest follows behind the game

function* buildCityGrid(scene, lateStage, focus) {
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
    return dx * dx + dz * dz < START_RADIUS * START_RADIUS;
  };
  const addBlock = (b, cells) => {
    addCurb(cells.curbs, b.poly);
    for (const hole of b.holes) addCurb(cells.curbs, hole);
    if (!b.median) return;
    const hedge = Math.min(b.maxX - b.minX, b.maxZ - b.minZ) > 3 && b.area > 60 && offsetPolygonInward(b.poly, 1.1);
    if (hedge) addSurface(cells.hedges, [hedge], SIDEWALK_TOP + 0.4, 20);
  };
  const newCells = () => ({ road: new GroundCells(), curbs: new GroundCells(), paving: new GroundCells(), lawns: new GroundCells(), hedges: new GroundCells() });
  const finish = (cells, target) => {
    cells.road.build(target, roadMat);
    cells.curbs.build(target, curbMat, { cast: true });
    cells.paving.build(target, sidewalkMat);
    cells.lawns.build(target, lawnMat);
    cells.hedges.build(target, hedgeMat);
  };

  const first = newCells();
  yield* addRoadDeck(first.road, (x, z) => (x - focus.x) ** 2 + (z - focus.z) ** 2 < START_RADIUS * START_RADIUS);
  for (const b of BLOCKS) if (near([b.poly])) addBlock(b, first);
  for (const rings of PAVEMENTS) if (near(rings)) addSurface(first.paving, rings, SIDEWALK_TOP);
  for (const rings of LAWNS) if (near(rings)) addSurface(first.lawns, rings, SIDEWALK_TOP + 0.02, 20, 36);
  finish(first, group);

  // Enough to start driving. Everything below arrives behind the game.
  scene.add(group);
  yield new Ready();
  group = details;
  yield;

  const rest = newCells();
  yield* addRoadDeck(rest.road, (x, z) => (x - focus.x) ** 2 + (z - focus.z) ** 2 >= START_RADIUS * START_RADIUS);
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
    if (!near(rings)) addSurface(rest.lawns, rings, SIDEWALK_TOP + 0.02, 20, 36);
    if (i % 8 === 0) yield;
  }
  yield;
  rest.road.build(group, roadMat);
  yield;
  rest.curbs.build(group, curbMat, { cast: true });
  yield;
  rest.paving.build(group, sidewalkMat);
  yield;
  rest.lawns.build(group, lawnMat);
  rest.hedges.build(group, hedgeMat);
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
        const v2 = seawalls.vertex(c, a.x, terrainHeight(a.x, a.z) + 0.1, a.z, nx, 0, nz);
        const v3 = seawalls.vertex(c, b.x, terrainHeight(b.x, b.z) + 0.1, b.z, nx, 0, nz);
        if (side > 0) c.index.push(v0, v1, v2, v1, v3, v2);
        else c.index.push(v0, v2, v1, v1, v2, v3);
      }
    }
    yield;
  }
  seawalls.build(group, seawallMat);

  // 4. The elevated motorways: scenery, with ambient traffic on their lanes
  const { lanes: highwayLanes, colliders } = yield* buildViaducts(group, roadMat);

  const roadPaint = createRoadPaintChunkBuilder('RoadMarkings');
  lateStage.add(group);
  return { group, footprints, highwayLanes, colliders, roadPaint };
}

export { buildCityGrid, getStreetGroundHeight, batchStaticGroupMeshes };
