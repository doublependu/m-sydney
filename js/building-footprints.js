import * as THREE from 'three/webgpu';
import { WALL_KINDS } from './tsl-materials.js';
import { polygonContains } from './building-collision.js';

function partyWallHeight(record, a, b, neighbours) {
  const dx = b.x - a.x, dz = b.y - a.y, length = Math.hypot(dx, dz);
  let height = 0;
  // Sample along the wall so a single touching corner does not blank the entire facade.
  for (const t of [0.15, 0.5, 0.85]) {
    const x = a.x + dx * t - dz / length, z = a.y + dz * t + dx / length;
    let roof = 0;
    for (const n of neighbours) {
      if (n.polygons === record.polygons || n.height <= 0 ||
        x < n.x0 || x > n.x1 || z < n.z0 || z > n.z1) continue;
      if (n.polygons.some(p => polygonContains(p, x, z))) roof = Math.max(roof, n.height);
    }
    if (!roof) return 0;
    height = Math.max(height, roof);
  }
  return height;
}

// One merged facade/roof mesh per 1 km cell. Explicit wall coordinates keep window bays metre-sized on any angle.
// A hipped roof over a simple footprint: the walls' top ring drawn in towards a ridge line. Terracotta or slate by seed.
function addPitchedRoof(roofs, ring, top, seed) {
  const n = ring.length;
  let area = 0, cx = 0, cz = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
    cx += ring[i].x;
    cz += ring[i].y;
  }
  area = Math.abs(area / 2);
  if (n > 14 || area < 25 || area > 900) return false;
  cx /= n;
  cz /= n;
  // Longest edge sets the ridge
  let best = 0, ux = 1, uz = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L > best) { best = L; ux = (b.x - a.x) / L; uz = (b.y - a.y) / L; }
  }
  let lo = Infinity, hi = -Infinity, wide = 0;
  for (const p of ring) {
    const u = (p.x - cx) * ux + (p.y - cz) * uz, v = -(p.x - cx) * uz + (p.y - cz) * ux;
    lo = Math.min(lo, u); hi = Math.max(hi, u); wide = Math.max(wide, Math.abs(v));
  }
  const rise = Math.min(3.4, wide * 0.55);
  const inset = Math.min(wide, (hi - lo) * 0.3);
  const a = { x: cx + ux * (lo + inset), z: cz + uz * (lo + inset) }, b = { x: cx + ux * (hi - inset), z: cz + uz * (hi - inset) };
  const list = seed % 3 < 2 ? roofs.tile : roofs.slate;
  for (let i = 0; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    // Each wall's slope climbs to whichever end of the ridge lies nearer
    const mid = ((p.x + q.x) / 2 - cx) * ux + ((p.y + q.y) / 2 - cz) * uz;
    const r = mid < (lo + hi) / 2 ? a : b;
    list.push(p.x, top, p.y, q.x, top, q.y, r.x, top + rise, r.z);
  }
  list.push(a.x, top + rise, a.z, b.x, top + rise, b.z, b.x, top + rise, b.z);
  return true;
}

const SEAL = 0.3; // how far a wall's foot goes into the ground, so nothing shows between them
const STRIP = 5; // metres: how often a wall's foot follows the ground
const NO_SHOP_ABOVE = 1; // a wall this far above the ground beside it has no shopfront

// The stretch of a wall below its floor, from the floor down to the ground. Each piece is a strip of the wall with kind
// WALL_KINDS.below + (metres of it clear of the ground), which is how the facade knows whether a storey of windows fits.
function addWallFoot(cell, a, b, width, height, base, seed, reverse, groundAt, storey) {
  const nx = -(b.y - a.y) / width, nz = (b.x - a.x) / width;
  const depthAt = (t) => base - groundAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  // A wall with room for a storey under its floor is split at whole window bays, so a bay either has its window or doesn't
  let pieces = Math.max(1, Math.ceil(width / STRIP));
  if (storey && depthAt(0.5) + 1 > storey.height || storey && Math.max(depthAt(0), depthAt(1)) > storey.height) {
    const bays = Math.max(Math.floor(width / storey.width + 0.5), 1);
    pieces = bays;
  }
  let t0 = 0, d0 = depthAt(0);
  for (let i = 1; i <= pieces; i++) {
    const t1 = i / pieces, d1 = depthAt(t1);
    const clear = Math.max(0, Math.min(d0, d1, depthAt((t0 + t1) / 2)));
    const offset = cell.positions.length / 3;
    const ax = a.x + (b.x - a.x) * t0, az = a.y + (b.y - a.y) * t0, bx = a.x + (b.x - a.x) * t1, bz = a.y + (b.y - a.y) * t1;
    const foot0 = base - d0 - SEAL, foot1 = base - d1 - SEAL;
    cell.positions.push(ax, foot0, az, bx, foot1, bz, ax, base, az, bx, base, bz);
    for (let k = 0; k < 4; k++) {
      cell.normals.push(nx, 0, nz);
      cell.boxes.push(width, height, height, seed);
      const along = k % 2 ? t1 : t0;
      const fromTop = k < 2 ? height + base - (k % 2 ? foot1 : foot0) : height;
      cell.walls.push(reverse ? 1 - along : along, fromTop, WALL_KINDS.below + clear);
    }
    cell.indices.push(offset, offset + 1, offset + 2, offset + 2, offset + 1, offset + 3);
    t0 = t1;
    d0 = d1;
  }
}

// groundAt: the ground's height under a wall, to stand it on. storey: { width, height } of the facade's window bays.
function* createBuildingFootprintsSteps(material, records, getNeighbours, roofMaterials = null, { groundAt = null, storey = null } = {}) {
  const cells = new Map();
  for (const [index, record] of records.entries()) {
    yield;
    if (!(record.height > 0)) continue;
    const key = Math.floor(record.cx / 1000) + ',' + Math.floor(record.cz / 1000);
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { key, positions: [], normals: [], indices: [], boxes: [], walls: [], roofs: { tile: [], slate: [] } }));
    const height = record.height, base = (record.base ?? 0) + 0.22, top = height + base;
    // A piece standing on another starts this far up. Its floors count from the building's floor all the same.
    const bottom = record.bottom || 0;
    const seed = Math.floor(record.seed ?? index * 29) % 1000 + 0.1 + 0.8 * (record.tone ?? 0.5);
    const neighbours = getNeighbours && height <= 60 && !record.group ? getNeighbours(record) : [];

    for (const polygon of record.polygons) {
      const rings = [polygon.outer, ...(polygon.holes || [])].map((ring, i) => {
        const points = ring.map(p => new THREE.Vector2(p.x, p.z));
        if (points.length > 1 && points[0].equals(points[points.length - 1])) points.pop();
        // Clockwise outer walls face away from the building; courtyard walls face into their holes.
        if (THREE.ShapeUtils.isClockWise(points) !== (i === 0)) points.reverse();
        return points;
      });
      if (rings[0].length < 3) continue;
      rings.forEach((ring, i) => {
        for (let j = 0; j < ring.length; j++) {
          const a = ring[j], b = ring[(j + 1) % ring.length];
          const dx = b.x - a.x, dz = b.y - a.y, width = Math.hypot(dx, dz);
          if (width === 0) continue;
          const offset = cell.positions.length / 3;
          const adjacentHeight = !i && neighbours.length ? partyWallHeight(record, a, b, neighbours) : 0;
          // A shopfront only where the wall meets the pavement
          const meetsGround = !bottom && (!groundAt || base - groundAt((a.x + b.x) / 2, (a.y + b.y) / 2) <= NO_SHOP_ABOVE);
          const kind = i ? WALL_KINDS.rear : adjacentHeight ? WALL_KINDS.lotLine
            : record.storefronts && meetsGround ? WALL_KINDS.shop : WALL_KINDS.front;
          const exposedHeight = adjacentHeight ? Math.max(0, height + 0.22 - adjacentHeight) : height;
          // Match the positive-world-axis tangent used by the shared interior-map view ray.
          const reverse = (Math.abs(dz) >= Math.abs(dx) ? dz : dx) < 0;
          cell.positions.push(a.x, base + bottom, a.y, b.x, base + bottom, b.y, a.x, top, a.y, b.x, top, b.y);
          for (let k = 0; k < 4; k++) {
            cell.normals.push(-dz / width, 0, dx / width);
            // Footprint walls use the box's unused depth for the exposed height above adjoining roofs.
            cell.boxes.push(width, height, exposedHeight, seed);
            cell.walls.push(reverse ? 1 - k % 2 : k % 2, k < 2 ? height - bottom : 0, kind);
          }
          cell.indices.push(offset, offset + 1, offset + 2, offset + 2, offset + 1, offset + 3);
          if (groundAt && !bottom) addWallFoot(cell, a, b, width, height, base, seed, reverse, groundAt, storey);
        }
      });
      if (record.pitched && roofMaterials && rings.length === 1 && addPitchedRoof(cell.roofs, rings[0], top, Math.floor(seed))) continue;
      const triangles = THREE.ShapeUtils.triangulateShape(rings[0], rings.slice(1));
      const points = rings.flat(), offset = cell.positions.length / 3;
      for (const p of points) {
        cell.positions.push(p.x, top, p.y);
        cell.normals.push(0, 1, 0);
        cell.boxes.push(1, height, height, seed);
        cell.walls.push(0, 0, WALL_KINDS.front);
      }
      for (const [a, b, c] of triangles) cell.indices.push(offset + a, offset + c, offset + b);
    }
  }

  const group = new THREE.Group();
  group.name = 'SurveyedBuildings';
  let first;
  for (const cell of cells.values()) {
    yield;
    if (cell.indices.length === 0) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(cell.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(cell.normals, 3));
    geometry.setAttribute('box', new THREE.Float32BufferAttribute(cell.boxes, 4));
    geometry.setAttribute('facadeWall', new THREE.Float32BufferAttribute(cell.walls, 3));
    geometry.setIndex(cell.indices);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'SurveyedBuildingChunk';
    mesh.userData.lifted = true;
    mesh.userData.cell = cell.key;
    mesh.castShadow = mesh.receiveShadow = true;
    // Most cells are too small for scene-culling.js to pick them as big casters on its own: opt in to its stand-ins.
    mesh.userData.shadowStandIn = true;
    if (first) mesh.userData.sharesPipelineWith = first;
    else first = mesh;
    group.add(mesh);
  }
  for (const cell of roofMaterials ? cells.values() : []) {
    for (const [list, roofMaterial] of [[cell.roofs.tile, roofMaterials[0]], [cell.roofs.slate, roofMaterials[1]]]) {
      if (!list.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, roofMaterial);
      mesh.name = 'PitchedRoofs';
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.lifted = true;
      mesh.userData.cell = cell.key;
      group.add(mesh);
    }
  }
  return group;
}

function createBuildingFootprints(material, records, getNeighbours, roofMaterials = null, options = {}) {
  const job = createBuildingFootprintsSteps(material, records, getNeighbours, roofMaterials, options);
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}

export { createBuildingFootprints, createBuildingFootprintsSteps };
